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
import { createSession, setSessionMarker } from "./tmux-south.js";
/**
 * Create the per-server-proxy session claimer.
 *
 * The returned `SessionClaimer` owns the per-name claim-lock table (previously
 * `ServerProxyImpl._claimLocks`) and executes the claim/activate path with the
 * supplied context dependencies.  One instance is created per
 * `ServerProxyImpl` in its constructor and lives for the server-proxy's
 * lifetime.
 */
export function createSessionClaimer(ctx) {
    /**
     * Per-name claim locks: maps session name → in-flight claim promise.
     * Concurrent claims for the same name share this promise (tc-3y8.2).
     * Previously `ServerProxyImpl._claimLocks`.
     */
    const claimLocks = new Map();
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
    async function doClaimSession(name, env) {
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
                const { tmuxId } = await createSession(ctx.socketName, name, ctx.getCapabilities(), env);
                created = true;
                entry = ctx.lookupByName(name);
                if (!entry) {
                    // No race winner ahead of us — register the just-created session.
                    // Broadcasts sessions.added so connected clients see it immediately
                    // (the same broadcast _refreshSessions would emit on the next tick).
                    entry = ctx.registerSession(tmuxId, name);
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const code = err instanceof Object && "code" in err
                    ? err.code
                    : undefined;
                if (msg.toLowerCase().includes("duplicate")) {
                    // Race: another process created it between our check and create —
                    // we attached to that process's session; `created` stays false.
                    await ctx.refreshSessions();
                    entry = ctx.lookupByName(name);
                    if (!entry) {
                        throw Object.assign(new Error(`session.create race: ${msg}`), { code: "internal" });
                    }
                }
                else if (code === "tmux.capability-required") {
                    // tc-gjdx.2: capability-required errors (e.g. env on tmux < 3.2) must
                    // propagate with their original code so the server-proxy can surface
                    // a specific error to the client — don't re-wrap as tmux.unavailable.
                    throw err;
                }
                else {
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
        const timing = {
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
            claim_ms: timing.phases[0].durationMs,
            ensure_ms: timing.phases[1].durationMs,
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
        claim(name, env) {
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
        isInFlight(name) {
            return claimLocks.has(name);
        },
    };
}
//# sourceMappingURL=claim-session.js.map