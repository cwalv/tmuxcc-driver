/**
 * session-error-boundary.test.ts — tc-2x3.4 per-session error boundary proof.
 *
 * # What this proves
 *
 * In the tc-2x3.3 collapsed topology, ONE process hosts ALL sessions in ONE
 * event loop.  Without an error boundary, an unhandled exception in session
 * A's parser/reducer/pipeline would propagate out of the Node.js PTY data
 * event and crash the whole process, killing every session.
 *
 * tc-2x3.4 adds a try/catch error boundary inside the pipeline's host.onData
 * handler.  On a caught exception the boundary:
 *   1. Stops the broken pipeline (no further processing on the broken stack).
 *   2. Calls opts.onFatalError so the caller can reap this session's entry.
 *   3. (Supervisor) increments session_boundary_trips_total on the session's
 *      metrics registry.
 *
 * # Fault-injection method
 *
 * `SessionProxyOptions.onTopologyNotify` is forwarded into the pipeline's
 * `_dispatchEvent` and runs INSIDE the host.onData try/catch.  If it throws,
 * the exception is caught by the error boundary — a real, in-production-code
 * path, not a synthetic bypass.
 *
 * We inject the fault by wiring a `onTopologyNotify` hook on session A that
 * throws on first call.  We then trigger a real tmux topology notification
 * (new-window in session A) to fire the fault path naturally.
 *
 * # Session B uninterrupted proof
 *
 * Session B has its own separate session-proxy with its own pipeline and its own
 * error boundary.  After A's fault fires, we trigger a topology notification in
 * session B (new-window) and assert that B's `onTopologyNotify` fires — proving
 * B kept operating and the process stayed up.
 *
 * # Acceptance criteria (bead tc-2x3.4)
 *
 * A1. Session A's onFatalError fires after the poison notification.
 * A2. Session B's onTopologyNotify fires after A's fault (process survived).
 * A3. session_boundary_trips_total on session A's registry increments by 1.
 * A4. The process does NOT crash (if it did, B's notification would never fire).
 *
 * # Requires real tmux
 *
 * Real tmux 3.4 is on PATH in this repo's test environment.  The suite skips
 * cleanly on environments without tmux.
 *
 * @module session-error-boundary.test
 */
export {};
//# sourceMappingURL=session-error-boundary.test.d.ts.map