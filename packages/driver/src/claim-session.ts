/**
 * Session claim/activate path with phase-typed states (tc-4b6k.8).
 *
 * Extracts `_claimSession`/`_doClaimSession` from server-proxy.ts and models
 * the claim/activate lifecycle as an explicit discriminated union of phases
 * (FP: description vs execution).  The `ClaimPhase` union is the description —
 * typed data capturing what ran and how long each leg took — while execution
 * builds a `ClaimTiming` record as it progresses and emits it via
 * `ClaimSessionContext.onClaimComplete` instead of scattered timing variables.
 *
 * This module is the natural home for tc-is5w's
 * `sessionproxy_claim_to_snapshot_seconds{phase}` histogram: the observer
 * receives a structured `ClaimTiming` record (typed phase durations, not raw
 * `_phaseClaimEnd` / `_phaseEnd` numbers scattered through the execution body)
 * and can call `histogram.observe({ phase }, durationSeconds)` without parsing
 * log lines.
 *
 * @module claim-session
 */

import { phaseLog, phaseNow } from "./runtime/phase-timing.js";
import type { SessionId } from "@tmuxcc/protocol";
import { createSession, setSessionMarker } from "./tmux-south.js";
import type { TmuxCapabilityMap } from "./tmux-capabilities.js";

// ---------------------------------------------------------------------------
// Phase types — the discriminated union (description)
// ---------------------------------------------------------------------------

/**
 * One timed phase of the claim/activate state machine.
 *
 *   - `"claim"`: resolve the session in the server-proxy table — refresh,
 *     create-if-absent, set the `@tmuxcc 1` marker.  Everything that happens
 *     before `ensureSessionProxy` is called.
 *   - `"ensure"`: start the in-process session-proxy and wait for readiness
 *     (`ensureSessionProxy`).
 *
 * Together they describe the full claim-to-ready lifetime as typed data rather
 * than timing variables scattered through the execution body.  The tc-is5w
 * histogram reads `durationMs` from each phase variant without parsing log
 * lines — the "description" side of FP description vs execution.
 */
export type ClaimPhase =
  | { readonly kind: "claim"; readonly durationMs: number }
  | { readonly kind: "ensure"; readonly durationMs: number };

/**
 * Completed timing record emitted by the execution body on a successful claim.
 *
 * Built incrementally as each phase settles.  `ClaimSessionContext.onClaimComplete`
 * receives this record — it is the single hook for both the dev-gated `phaseLog`
 * line (emitted inside this module before `onClaimComplete` fires) and tc-is5w's
 * production histogram observations.
 *
 * Phase order: `phases[0].kind === "claim"`, `phases[1].kind === "ensure"`.
 */
export interface ClaimTiming {
  readonly session: string;
  readonly sessionId: SessionId;
  readonly created: boolean;
  /** Ordered phase records: "claim" at index 0, "ensure" at index 1. */
  readonly phases: readonly ClaimPhase[];
  readonly totalMs: number;
}

// ---------------------------------------------------------------------------
// Claim result
// ---------------------------------------------------------------------------

/**
 * Result returned by `SessionClaimer.claim`.
 *
 * Matches the pre-extraction `{ sessionId, created }` shape returned by
 * `_claimSession` so callers in server-proxy.ts need no type changes.
 */
export interface ClaimSessionResult {
  readonly sessionId: SessionId;
  /** Whether THIS claim minted the tmux session (tc-3y8.2). */
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// Context — dependency injection from server-proxy.ts
// ---------------------------------------------------------------------------

/**
 * Minimal session-entry data the claimer produces and returns to
 * `registerSession` callers.  The full `SessionEntry` (with tmuxId,
 * windowCount, enriched fields) lives in server-proxy.ts — only the identity
 * fields needed by the claim path are surfaced here.
 */
export interface ClaimSessionEntry {
  readonly sessionId: SessionId;
  readonly name: string;
}

/**
 * Dependencies injected from `ServerProxyImpl` into `createSessionClaimer`.
 *
 * All callbacks close over the server-proxy's live state so the claimer sees
 * consistent snapshots without duplicating server-proxy fields.  The context
 * object is safe to build in the constructor — every callback is a closure
 * that is only invoked during `start()` or later (never during construction).
 */
export interface ClaimSessionContext {
  /** tmux socket name passed to south-side calls. */
  readonly socketName: string;

  /**
   * Current tmux capability map.  Accessed lazily via function so the context
   * can be wired in the constructor — before `start()` runs the capability
   * probe — without capturing a stale `null`.
   */
  getCapabilities(): TmuxCapabilityMap | undefined;

  /**
   * Coalesced session-table refresh.
   * Delegates to `ServerProxyImpl._refreshSessions()`.
   */
  refreshSessions(): Promise<void>;

  /**
   * Look up a session entry by name.
   * Returns `undefined` when the session is not in the server-proxy table.
   */
  lookupByName(name: string): ClaimSessionEntry | undefined;

  /**
   * Register a just-created tmux session in the server-proxy table, broadcast
   * `sessions.added`, and update the sessions-active gauge.
   *
   * Callers have already verified (via `lookupByName`) that the name is absent;
   * this is the side-effecting "publish" step that must only be called after
   * that check.  Returns the registered entry.
   */
  registerSession(tmuxId: string, name: string): ClaimSessionEntry;

  /**
   * Ensure the in-process session-proxy is running for the session.
   * Delegates to `supervisor.ensureSessionProxy(sessionId, name, socketName)`.
   */
  ensureSessionProxy(sessionId: SessionId, name: string): Promise<void>;

  /**
   * Called once on a successful claim with the complete phase-typed timing
   * record.
   *
   * The natural attachment point for tc-is5w's
   * `sessionproxy_claim_to_snapshot_seconds{phase}` histogram — the record
   * supplies typed, structured durations rather than raw timing-variable values
   * that would require log-line parsing.  The dev-gated `phaseLog` call is
   * emitted by this module (in `doClaimSession`) before `onClaimComplete`
   * fires, so the callback is for production metrics only.
   */
  onClaimComplete(timing: ClaimTiming): void;
}

// ---------------------------------------------------------------------------
// SessionClaimer
// ---------------------------------------------------------------------------

/**
 * Per-name single-flight claim manager (tc-3y8.2).
 *
 * Exposes `claim` (initiate or join an in-flight claim) and `isInFlight`
 * (check whether a claim is currently in progress for a given name — used by
 * `session.create` and `session.createUnique` to detect name-in-use races).
 */
export interface SessionClaimer {
  /**
   * Claim a named session and return its stable `sessionId`.
   *
   * If a claim for `name` is already in flight, the returned promise joins
   * that in-flight claim and always resolves with `created: false` (tc-3y8.2:
   * only the initiating claim reports `created: true`).
   *
   * tc-gjdx.2: `env` is forwarded to `createSession` when provided and the
   * session must be created (not already present).  Requires tmux >= 3.2
   * (`newSessionEnvFlag`); throws with `code: "tmux.capability-required"` when
   * the probed version does not support it.  Ignored (not an error) if the
   * session already exists and `env` would have been a no-op.
   */
  claim(name: string, env?: Record<string, string>): Promise<ClaimSessionResult>;

  /**
   * Whether a claim for `name` is currently in flight.
   *
   * Used by `session.create` and `session.createUnique` to detect concurrent
   * in-flight claims as "name in use" before they issue their own claim
   * (tc-3y8.2).
   */
  isInFlight(name: string): boolean;
}

/**
 * Create the per-server-proxy session claimer.
 *
 * The returned `SessionClaimer` owns the per-name claim-lock table (previously
 * `ServerProxyImpl._claimLocks`) and executes the claim/activate path with the
 * supplied context dependencies.  One instance is created per
 * `ServerProxyImpl` in its constructor and lives for the server-proxy's
 * lifetime.
 */
export function createSessionClaimer(ctx: ClaimSessionContext): SessionClaimer {
  /**
   * Per-name claim locks: maps session name → in-flight claim promise.
   * Concurrent claims for the same name share this promise (tc-3y8.2).
   * Previously `ServerProxyImpl._claimLocks`.
   */
  const claimLocks = new Map<string, Promise<ClaimSessionResult>>();

  /**
   * Execute the claim/activate path for `name`.
   *
   * The two phases (FP description vs execution):
   *   1. "claim" — refresh the session table, create the tmux session if
   *      absent, set the `@tmuxcc 1` marker.
   *   2. "ensure" — start the in-process session-proxy and wait for readiness.
   *
   * On completion, builds a `ClaimTiming` record, emits the dev-gated
   * `phaseLog` line, and calls `ctx.onClaimComplete(timing)` — the tc-is5w
   * histogram hook.
   */
  async function doClaimSession(name: string, env?: Record<string, string>): Promise<ClaimSessionResult> {
    // tc-is5w: record t0 at claim entry for the "claim" phase timer.
    const t0 = phaseNow();

    // Refresh session list from tmux.
    await ctx.refreshSessions();

    let entry = ctx.lookupByName(name);

    // tc-3y8.2: whether THIS claim minted the tmux session (vs attaching to a
    // pre-existing one).  Reported to the client as the authority for
    // create-time-only behaviour (profile apply).
    let created = false;

    if (!entry) {
      // Session doesn't exist — create it.
      //
      // tc-zcqr: `createSession` returns the new tmux session id directly via
      // `new-session -P -F '#{session_id}'`.  We inject the new entry via
      // `ctx.registerSession` synchronously rather than relying on a follow-up
      // `tmux list-sessions` to learn the id — that round-trip can fail
      // transiently (the watcher's -CC attach + supervisor's session-proxy spawn
      // contend for the tmux server's response budget in this window) and
      // silently produced "Session 'X' not found after creation".
      try {
        // tc-4b6k.12: pass capability state so createSession can gate
        // version-sensitive operations (e.g. scroll-on-clear on tmux 3.3+).
        // tc-gjdx.2: env is forwarded so new-session can inject -e NAME=value
        // flags; createSession gates env on the newSessionEnvFlag capability
        // (tmux >= 3.2) and throws loud if the flag is absent.
        const { tmuxId } = await createSession(
          ctx.socketName,
          name,
          ctx.getCapabilities(),
          env,
        );
        created = true;
        entry = ctx.lookupByName(name);
        if (!entry) {
          // No race winner ahead of us — register the just-created session.
          // Broadcasts sessions.added so connected clients see it immediately
          // (the same broadcast _refreshSessions would emit on the next tick).
          entry = ctx.registerSession(tmuxId, name);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof Object && "code" in err
          ? (err as { code: unknown }).code
          : undefined;
        if (msg.toLowerCase().includes("duplicate")) {
          // Race: another process created it between our check and create —
          // we attached to that process's session; `created` stays false.
          await ctx.refreshSessions();
          entry = ctx.lookupByName(name);
          if (!entry) {
            throw Object.assign(new Error(`session.create race: ${msg}`), { code: "internal" });
          }
        } else if (code === "tmux.capability-required") {
          // tc-gjdx.2: capability-required errors (e.g. env on tmux < 3.2) must
          // propagate with their original code so the server-proxy can surface
          // a specific error to the client — don't re-wrap as tmux.unavailable.
          throw err;
        } else {
          throw Object.assign(new Error(`tmux.unavailable: ${msg}`), { code: "tmux.unavailable" });
        }
      }
    }

    // tc-w61: mark-on-attach — ensure the @tmuxcc 1 marker is set on the
    // session before starting the session-proxy.  For sessions created by
    // createSession() above, the marker was already set inside createSession();
    // this call is effectively a no-op in that case (idempotent).  For
    // pre-existing sessions that tmuxcc is claiming for the first time (e.g. a
    // session the user manually created then attached via tmuxcc.attachToSession),
    // this stamps them as tmuxcc-managed so they will appear in
    // listTmuxccSessions on subsequent invocations.
    await setSessionMarker(ctx.socketName, entry.name);

    // tc-is5w: "claim" phase ends here — record its duration before the ensure
    // leg begins.
    const claimEnd = phaseNow();

    // D5 (tc-4b6k.4): ensure the session-proxy is running (warm before claim
    // returns — the READY-before-claim contract).  The client then binds a
    // connection with `session.attach {sessionId}`; there is no endpoint.
    await ctx.ensureSessionProxy(entry.sessionId, entry.name);

    const t1 = phaseNow();

    // Build the phase-typed timing record — the "description" side: what ran
    // and how long, as typed data rather than raw timing variables.
    const timing: ClaimTiming = {
      session: entry.name,
      sessionId: entry.sessionId,
      created,
      phases: [
        { kind: "claim", durationMs: claimEnd - t0 },
        { kind: "ensure", durationMs: t1 - claimEnd },
      ],
      totalMs: t1 - t0,
    };

    // tc-is5w: dev-gated phase line — behavior-preserving from the previous
    // `phaseLog` call in `_doClaimSession`.  The `ClaimTiming` record is the
    // source of truth; `phaseLog` reads from it rather than from the old raw
    // `_phaseClaimEnd`/`_phaseEnd` variables.
    phaseLog({
      phase: "claim",
      session: timing.session,
      sessionId: timing.sessionId,
      created: timing.created,
      claim_ms: timing.phases[0]!.durationMs,
      ensure_ms: timing.phases[1]!.durationMs,
      total_ms: timing.totalMs,
    });

    // tc-is5w: production hook — the natural home for the per-phase histogram.
    // The observer calls histogram.observe({ phase: "claim" }, durationMs/1000)
    // and histogram.observe({ phase: "ensure" }, durationMs/1000) from the
    // typed `timing.phases` array rather than parsing log lines.  The
    // server-proxy's implementation is a no-op until tc-is5w wires the
    // histogram.
    ctx.onClaimComplete(timing);

    return { sessionId: entry.sessionId, created };
  }

  return {
    claim(name: string, env?: Record<string, string>): Promise<ClaimSessionResult> {
      const inFlight = claimLocks.get(name);
      if (inFlight) {
        // Joined claim: by the time this resolves the session exists; this
        // caller did not create it (tc-3y8.2: only the initiating claim
        // reports `created: true`).
        // tc-gjdx.2: env is applied only at creation time; a joined claim
        // discards it (the session is already being created by the initiator).
        return inFlight.then((r) => ({ ...r, created: false }));
      }

      const promise = doClaimSession(name, env).finally(() => {
        // Only remove the lock if it's still THIS promise (not a newer one).
        if (claimLocks.get(name) === promise) {
          claimLocks.delete(name);
        }
      });

      claimLocks.set(name, promise);
      return promise;
    },

    isInFlight(name: string): boolean {
      return claimLocks.has(name);
    },
  };
}
