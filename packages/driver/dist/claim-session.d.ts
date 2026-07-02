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
import type { SessionId } from "@tmuxcc/protocol";
import type { TmuxCapabilityMap } from "./tmux-capabilities.js";
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
export type ClaimPhase = {
    readonly kind: "claim";
    readonly durationMs: number;
} | {
    readonly kind: "ensure";
    readonly durationMs: number;
};
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
     */
    claim(name: string): Promise<ClaimSessionResult>;
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
export declare function createSessionClaimer(ctx: ClaimSessionContext): SessionClaimer;
//# sourceMappingURL=claim-session.d.ts.map