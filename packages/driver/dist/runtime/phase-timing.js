// ---------------------------------------------------------------------------
// Phase timing (tc-is5w — phase-split activation instrument)
//
// Dev-gated, per-activation, per-leg timing of the full session activation
// path (server-proxy._doClaimSession → first snapshot to the connecting
// client).  When TMUXCC_PHASE_TIMING is set (to any non-empty value), each
// instrumented leg appends ONE structured line to process.stderr, tagged
// `[tc-is5w]`.  When the var is unset the helpers are a no-op — zero cost in
// production (a single boolean check, no allocation, no clock read).  This
// follows the TMUXCC_WIRE_TRACE precedent in tmux-host.ts.
//
// WHY stderr lines (not a prom-client histogram): the motivating use is RCA
// attribution of a RARE multi-second activation tail (tc-jlyi).  A histogram
// aggregates and loses the per-activation, per-leg attribution this needs —
// "which leg owned the 6-7 s on THIS activation".  A per-activation stderr
// line preserves it, and auto-lands in <runtime>/<socket>/server-proxy.log via
// the existing stderr mirror (collected to test/e2e/trace/<cid>-server-proxy.log
// by tc-mbu3.1).  See the tc-is5w decision note.
//
// The activation path crosses TWO packages (server-proxy owns claim/ensure;
// session-proxy owns bootstrap/snapshot) and TWO trigger events (the claim,
// and the later client-connect that drives addClient).  Rather than thread a
// single consolidated line across that boundary, each leg emits its own
// self-contained line keyed by `session`/`sessionId`; a reader greps
// `[tc-is5w] session=<name>` and reads each leg:
//
//   [tc-is5w] phase=claim    session=<name> sessionId=<id> claim_ms=<>  ensure_ms=<>     total_ms=<>
//   [tc-is5w] phase=bootstrap session=<name>               bootstrap_ms=<> attempts=<n>  outcome=<ok|failed>
//   [tc-is5w] phase=snapshot  session=<name>               snapshot_ms=<>
//
// bootstrap nests INSIDE the claim line's ensure_ms (the bootstrap-requery runs
// during `await sessionProxy.start()` inside the ensure span), so a reader can
// derive ensure-overhead = ensure_ms − bootstrap_ms and attribute any stall to
// the owning leg.  snapshot fires on the separate client-connect event.
// ---------------------------------------------------------------------------
/** True when TMUXCC_PHASE_TIMING is set to a non-empty value. Read once. */
export const PHASE_TIMING_ENABLED = (process.env["TMUXCC_PHASE_TIMING"] ?? "") !== "";
/**
 * Emit one `[tc-is5w]` phase line to stderr. No-op when phase timing is
 * disabled. Never throws — instrumentation must not perturb the host (mirrors
 * tmux-host.ts wireTrace's swallow-everything contract).
 */
export function phaseLog(fields) {
    if (!PHASE_TIMING_ENABLED)
        return;
    try {
        let line = "[tc-is5w]";
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined)
                continue;
            line += ` ${key}=${value}`;
        }
        process.stderr.write(`${line}\n`);
    }
    catch {
        // Instrumentation must never interfere with activation.
    }
}
/**
 * Wall-clock millisecond stamp for span measurement. A thin wrapper over
 * `Date.now()` (per the tc-is5w brief — spans, not high-resolution profiling)
 * so call sites read intent, not mechanism.
 */
export function phaseNow() {
    return Date.now();
}
//# sourceMappingURL=phase-timing.js.map