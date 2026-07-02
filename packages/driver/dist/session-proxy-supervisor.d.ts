/**
 * SessionProxy supervisor — manages per-session session-proxy runtimes IN-PROCESS.
 *
 * # Responsibility
 *
 * The supervisor owns the lifecycle of per-session session-proxy runtimes:
 *   - Instantiating a session-proxy for a session (if one is not already running)
 *   - Waiting for the session-proxy to finish its bootstrap (start() resolves)
 *   - Reaping session-proxies on session removal or unexpected exit
 *   - Per-name atomicity: concurrent claim requests for the same session name
 *     are serialized so only one session-proxy is ever created
 *
 * # tc-2x3.3 collapse: in-process, single event loop
 *
 * Before tc-2x3 Stage 2 each session-proxy ran in its OWN child process
 * (`child_process.spawn(node, [session-proxy-entry.js, …])`).  The 1 + N + N
 * topology (server-proxy + N session-proxy processes + N tmux clients) cost
 * ~335-600 MB RSS at N=3.  Stage 2 collapses the N session-proxy processes into
 * the server-proxy's own event loop: each session-proxy is now created
 * IN-PROCESS via `createSessionProxy(...)`.  Stage 2 kept the per-session unix
 * socket (each session-proxy bound its own `net.createServer`); tc-4b6k.4 (D5,
 * below) then removed even that, folding every connection onto the ONE broker
 * socket — so the supervisor no longer touches sockets at all.
 *
 * Consequences of the collapse:
 *   - No `--socket-name`/`--session-name`/`--socket-path` argv, no spawn, no
 *     READY-handshake — the session-proxy is just an object we `await .start()`.
 *   - No die-with-parent (tc-2c5): there is no child process to be reparented;
 *     the session-proxy lives and dies with the server-proxy by construction.
 *   - `sessionProxyPid()` reports the server-proxy's own pid — the session-proxy
 *     IS this process now (tc-k6v `server-proxy.info`).
 *   - The old SIGTERM graceful path (detach `-CC`) is preserved as
 *     `_teardownEntry`: `sessionProxy.stop()` closes tmux stdin and waits for
 *     the `-CC` client to exit (≤3 s, then SIGKILL).
 *
 * # tc-4b6k.4 (D5): single-socket wire collapse — no per-session socket
 *
 * Before this bead each session-proxy owned its OWN `net.Server` on a per-session
 * unix socket, and the supervisor carried a whole layer of socket-lifecycle
 * machinery to guard the races that per-session socket rebinding across respawns
 * created (`_socketPathRefCount`, the `_closeServerFdOnly` rename-aside dance,
 * ABA guards on the socket path — the tc-2x3.4 / tc-2x3.6 GAP-1 generations).
 *
 * D5 deletes all of it: there is ONE well-known broker socket. The broker
 * accepts every connection, runs the single handshake, and — on a
 * `session.attach {sessionId}` — hands the transport to `sessionProxy.addClient`.
 * The supervisor no longer creates, binds, restricts, renames, refcounts, or
 * unlinks any socket. `ensureSessionProxy` returns the live `SessionProxy`
 * object; the broker owns the transport handoff. Session lifecycle no longer
 * implies socket lifecycle, so the GAP-1 class ceases to exist rather than being
 * guarded.
 *
 * The genuinely-deep parts of the supervisor survive unchanged: per-name
 * single-flight ensure, the GAP-2 circuit breaker, the registry ABA guard on
 * host death / boundary trip, and lazy respawn.
 *
 * # tc-2x3.6: GAP 2 — repeated-trip circuit breaker
 *
 * A persistent parser/reducer bug trips → the session-proxy is torn down → the
 * extension calls `ensureSessionProxy` (lazy respawn) → the fresh session-proxy
 * immediately re-trips: a hot busy-loop that drives unbounded fd leaks (GAP 1)
 * and floods stderr.
 *
 * The fix: a per-session trip-timestamp log.  When `onFatalError` fires, the
 * supervisor appends the timestamp and checks whether the last
 * `CIRCUIT_BREAKER_TRIP_THRESHOLD` trips all fell within
 * `CIRCUIT_BREAKER_WINDOW_MS`.  If yes, the session is quarantined:
 *   - The sessionId is added to `_quarantinedSessions`.
 *   - A loud stderr message and an extra `session_boundary_quarantined_total`
 *     metric increment signal the event.
 *   - Subsequent calls to `ensureSessionProxy` for that sessionId reject
 *     immediately with a `SessionQuarantineError`.
 *   - `clearQuarantine(sessionId)` removes the quarantine so the extension can
 *     recover after a code fix or manual intervention.
 *
 * Design choices (documented here so reviewers can audit them):
 *   - N = 3 trips, window = 10 s: three rapid successive trips in ten seconds
 *     cannot be explained by transient tmux noise; they indicate a reproducible
 *     code path bug. Configured as module-level constants — easily tunable.
 *   - Quarantine is sticky (no auto-expiry): the supervisor does not know when
 *     the underlying bug is fixed. Auto-expiry would just restart the busy-loop
 *     after a cooldown. The correct recovery path is a new server-proxy binary
 *     (which re-creates the supervisor fresh) or an explicit clearQuarantine().
 *   - The supervisor decides quarantine (not the extension): quarantine is a
 *     structural invariant — the supervisor owns reattach policy end-to-end,
 *     and the extension already treats `ensureSessionProxy` as the only path
 *     into a live session-proxy. Surfacing quarantine as an error there is the
 *     minimum-footprint, legible design.
 *   - Trip log is bounded: we keep at most `CIRCUIT_BREAKER_TRIP_THRESHOLD`
 *     timestamps per session (older entries are trimmed); a quarantined session
 *     never appends again.
 *
 * @module session-proxy-supervisor
 */
import type { SessionProxy } from "./runtime/session-proxy.js";
/**
 * Thrown by `ensureSessionProxy` when the session has been quarantined by the
 * circuit breaker (>= CIRCUIT_BREAKER_TRIP_THRESHOLD boundary trips within
 * CIRCUIT_BREAKER_WINDOW_MS).
 *
 * The caller (typically the server-proxy's session.claim handler) should
 * surface this to the extension as a non-retriable error.  Recovery requires
 * either a fresh server-proxy process (new supervisor) or an explicit call to
 * `clearQuarantine(sessionId)`.
 */
export declare class SessionQuarantineError extends Error {
    readonly sessionId: string;
    readonly tripCount: number;
    readonly windowMs: number;
    constructor(sessionId: string, tripCount: number, windowMs: number);
}
/**
 * Exit details passed to the crash handler.  The cause is always a bound tmux
 * host death (via `host.onExit` or `host.onError`) — there is no child process
 * exit code or signal.
 */
export interface SessionProxyExitInfo {
    /** Session name the session-proxy was bound to (for logging). */
    sessionName: string;
}
/**
 * Called when a session-proxy exits UNEXPECTEDLY (ext-a §6.3 "Crash while the
 * server-proxy lives").  Intentional reaps (reapSessionProxy / reapAll) set the
 * entry's `tornDown` flag before tearing down and therefore never reach this
 * handler.  By the time the handler runs, the supervisor has already reaped the
 * sessionId → session-proxy registry entry, so the next ensureSessionProxy() for
 * the session creates a fresh session-proxy.
 *
 * tc-2x3.3: the canonical unexpected-exit trigger is now the bound tmux session
 * dying (`host.onExit`) — there is no separate process to crash.  Per-session
 * error boundaries (a session pipeline throwing should be survivable, with a
 * trip counter / fault injection) are tc-2x3.4, NOT here.
 */
export type SessionProxyCrashHandler = (sessionId: string, info: SessionProxyExitInfo) => void;
export interface SessionProxySupervisor {
    /**
     * Ensure a session-proxy is running for the given session and return the live
     * {@link SessionProxy} object (D5, tc-4b6k.4).
     *
     * If a session-proxy for `sessionId` is already running, returns it
     * immediately. If not, creates one IN-PROCESS and waits for it to finish
     * bootstrapping (`sessionProxy.start()` has resolved). The caller (the broker)
     * then hands each attaching connection's transport to `sessionProxy.addClient`.
     *
     * Per-name atomicity: concurrent calls for the same `sessionId` share the
     * same in-flight creation promise — only one session-proxy is ever created.
     */
    ensureSessionProxy(sessionId: string, sessionName: string, socketName: string): Promise<SessionProxy>;
    /**
     * PID of the process serving the session-proxy for `sessionId`, or `null`
     * when no session-proxy is running (never claimed, reaped, or crashed) or its
     * creation is still in-flight (tc-k6v `server-proxy.info`).  Read-only; never
     * blocks on creation.
     *
     * tc-2x3.3: the session-proxy now runs IN-PROCESS, so a live entry reports
     * the server-proxy's own pid (`process.pid`) — the session-proxy IS this
     * process.
     */
    sessionProxyPid(sessionId: string): number | null;
    /**
     * Whether a session-proxy for `sessionId` is live — a ready entry OR an
     * in-flight creation (tc-hfxb.18.4).  Unlike {@link sessionProxyPid} (which
     * returns null for an in-flight creation), this is true for the WHOLE window
     * from `ensureSessionProxy` being called through ready, until the entry is
     * reaped or its creation rejects.
     *
     * A live session-proxy holds a live `tmux -CC` connection to its session, so
     * the session provably exists in the tmux server — it CANNOT have "left".  The
     * reconciliation removal path uses this to reject spurious `sessions.removed`
     * broadcasts: a transient `list-sessions` that momentarily omits a live
     * session (an empty or partial list during cold-boot `-CC` churn) must not
     * remove it.  The genuine-gone path is unaffected: when a tmux session is
     * truly killed its `-CC` client EOFs, the session-proxy exits, and the
     * supervisor reaps this entry FIRST — so by the time reconciliation runs,
     * `hasSessionProxy` is already false and removal proceeds correctly.
     */
    hasSessionProxy(sessionId: string): boolean;
    /**
     * Collect the Prometheus text exposition of every READY session-proxy's
     * metrics registry, paired with its session id (tc-44u4.4).
     *
     * Used by the `/metrics` HTTP surface (and the same merge path) to namespace
     * each session's `topology_*` / `correlator_*` / `flow_*` families under a
     * `session="<id>"` label.  In-flight creations (Promise entries) are skipped
     * — they have no live registry yet.  Returns one entry per ready session, in
     * registry order; an empty array when no session-proxies are running.
     */
    sessionMetricsTexts(): Promise<Array<{
        sessionId: string;
        text: string;
    }>>;
    /**
     * Number of live session-proxies — both ready entries and in-flight
     * creations.  Used by the idle-exit policy (tc-eqgp): the server-proxy must
     * never idle-exit while it has live session-proxies, because those represent
     * active VS Code terminals whose data path (EDH ↔ session-proxy over
     * per-session sockets) is invisible to the server-proxy's own IPC client
     * count.  An in-flight creation counts too — a claim is in progress and
     * tearing the server-proxy down out from under it would cascade-kill that
     * nascent terminal too.
     */
    aliveCount(): number;
    /**
     * Register a callback fired whenever the alive count changes (creation
     * registered, ready entry recorded, entry reaped, or unexpected exit).  The
     * handler receives the new count.  Used by the server-proxy to re-check the
     * idle policy when the last session-proxy goes away (tc-eqgp).
     */
    onAliveCountChange(handler: (count: number) => void): void;
    /**
     * Tear down the session-proxy for a session (if running). Called on session removal.
     */
    reapSessionProxy(sessionId: string): void;
    /**
     * Tear down all running session-proxies. Called on server-proxy shutdown.
     */
    reapAll(): void;
    /**
     * Register a handler called when a session-proxy exits unexpectedly.
     */
    onCrash(handler: SessionProxyCrashHandler): void;
    /**
     * Clear the circuit-breaker quarantine for `sessionId` so that a subsequent
     * `ensureSessionProxy` call can reattach the session.
     *
     * This does NOT create a new session-proxy — it only removes the quarantine
     * flag.  The next `ensureSessionProxy` call will trigger a fresh creation.
     *
     * Also clears the trip-timestamp log for the session so the window restarts
     * from zero.
     *
     * Idempotent: calling on a non-quarantined session is a no-op.
     */
    clearQuarantine(sessionId: string): void;
    /**
     * Return the set of currently quarantined session IDs (a snapshot — the
     * returned Set is a copy).  Useful for diagnostics / server-proxy.info.
     */
    quarantinedSessions(): ReadonlySet<string>;
}
/**
 * Options for `createSessionProxySupervisor`.
 */
export interface SessionProxySupervisorOptions {
    /**
     * Optional topology-notification observer forwarded into each created
     * session-proxy's `onTopologyNotify` option.
     *
     * Intended uses:
     *   - Supervisor-level topology observability (e.g. aggregate metrics).
     *   - Fault injection in tests: throwing from this callback exercises the
     *     per-session error boundary and the circuit-breaker trip path end-to-end,
     *     without test seams in the supervisor's production logic.
     *
     * The callback receives the notification kind string (e.g. "window-add",
     * "layout-change") — same as `SessionProxyOptions.onTopologyNotify`.
     * Exceptions thrown here propagate into the pipeline's error boundary
     * (onFatalError), which is the correct fault-injection path for circuit-
     * breaker tests.
     */
    onTopologyNotify?: (kind: string) => void;
}
export declare function createSessionProxySupervisor(opts?: SessionProxySupervisorOptions): SessionProxySupervisor;
//# sourceMappingURL=session-proxy-supervisor.d.ts.map