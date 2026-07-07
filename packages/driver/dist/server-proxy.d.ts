/**
 * ServerProxy — the per-socket discovery and lifecycle service (SCHEMA.md Stage 2).
 *
 * # Public API
 *
 * ```ts
 * const serverProxy = createServerProxy({ socketName: "tmuxcc" });
 * await serverProxy.start();
 * // server-proxy is now accepting connections at serverProxy.endpoint()
 * await serverProxy.shutdown();
 * ```
 *
 * # Architecture
 *
 * The server-proxy owns:
 *   1. A unix socket server at `endpoint()` for incoming server-proxy-wire connections
 *   2. A thin tmux -CC watcher (south side) for %sessions-changed notifications
 *   3. A session table mapping session names → { sessionId, tmuxId, ... }
 *   4. A session-proxy supervisor that instantiates/reaps per-session
 *      session-proxies IN-PROCESS, one per claimed session (tc-2x3.3 collapse)
 *   5. A set of connected client transports (fan-out for delta messages)
 *   6. Its own exit policy (tc-3iv, ext-a-design-context.md §6.2):
 *      immediate self-exit when tmux is confirmed gone (watcher EOF + failed
 *      `tmux ls` probe), and an idle-grace self-exit at zero IPC clients for
 *      the full grace period (configurable via `TMUXCC_IDLE_EXIT_MS`, default
 *      5 minutes).  Both exit paths unlink the server-proxy socket file before
 *      reporting exit.
 *
 * # Wire protocol (ServerProxy wire)
 *
 * Each incoming connection:
 *   1. runServerHandshake with "server-proxy.capabilities"
 *   2. Send ServerProxySnapshotMessage (seq=2)
 *   3. Accept ServerProxyCommandRequestMessages and send ServerProxyCommandResponseMessages
 *   4. Fan-out session deltas when south-side state changes
 *
 * # Session ID stability
 *
 * Session IDs are server-proxy-assigned, stable for the lifetime of the server-proxy.
 * A new session ID is minted when a session first appears (from list-sessions
 * or from a session.create command). The same ID is reused for the session's
 * session-proxy and all delta messages.
 *
 * @module server-proxy
 */
import type { MetricsHttpStatePayload, SpawnInfo } from "@tmuxcc/protocol";
import type { TmuxCapabilityMap } from "./tmux-capabilities.js";
/** Options for createServerProxy. */
export interface ServerProxyOptions {
    /**
     * tmux socket name (passed as `-L <socketName>`).
     * Required — no default to prevent accidental attachment to user's tmux.
     */
    socketName: string;
    /**
     * Override the runtime directory for server-proxy + session-proxy sockets.
     * Default: $XDG_RUNTIME_DIR/tmuxcc or /tmp/tmuxcc-<uid>.
     */
    runtimeDir?: string;
    /**
     * Idle self-exit hysteresis (tc-3iv, §6.2): when the server-proxy has had
     * zero IPC clients for this long, it self-exits.  Default 5 minutes —
     * sized for human-scale close+reopen workflows (reload-window gaps are
     * sub-second).  Tests inject a short value instead of literally waiting
     * 5 minutes; the entry-point reads `TMUXCC_IDLE_EXIT_MS` from the
     * environment as a deployment-time knob.
     */
    idleExitMs?: number;
    /**
     * Absolute path of this server-proxy process's log file, when the entry point
     * has installed stderr→file mirroring (tc-k6v).  Reported verbatim in
     * `server-proxy.info` responses so debug clients can locate the log without
     * out-of-band knowledge.  Omit for in-process/programmatic server-proxies
     * (`server-proxy.info` then reports `logPath: null`).
     */
    logPath?: string;
    /**
     * Provenance stamp passed by the spawner at spawn time (tc-7aqb.2).
     *
     * Set by the extension via `--spawn-info '<json>'`; absent for programmatic
     * in-process server-proxies.  The driver holds it opaquely and echoes it via
     * `server-proxy.info` — it NEVER branches on its contents.
     */
    spawnInfo?: SpawnInfo;
    /**
     * tc-295a.41 (test-harness affordance): when true, the broker does NOT
     * self-exit with reason "tmux-gone".  By default (`false`/undefined — the
     * production behavior, unchanged) a watcher EOF + a `tmux ls` probe that finds
     * no tmux server triggers `_selfExit("tmux-gone")` and removes the socket.
     * A long-lived embedded broker shared across a whole integration-test run
     * (Layer A `runTest.ts`) instead wants to STAY UP through transient
     * empty-server windows — session-churning specs momentarily empty the tmux
     * server, and a self-exit there would wedge every later spec with a dropped
     * server-proxy socket.  With this flag set, a tmux-gone watcher EOF re-enters
     * watcher poll mode (waiting for a session to reappear) rather than exiting;
     * the idle self-exit and all other lifecycle behavior are unchanged.  The
     * production entry point never sets this.
     */
    persistThroughTmuxGone?: boolean;
    /**
     * tc-44u4.4: bind the `/metrics` (+ `/info`) HTTP exposition at startup.
     *
     * OFF BY DEFAULT (undefined ⇒ no listener bound).  Set by the entry point
     * from `--metrics-addr` / `TMUXCC_METRICS_ADDR` for monitored / always-on
     * deployments.  Accepts the same vocabulary as the wire toggle's `bind`:
     * `"unix"` / `"unix:/abs/path.sock"` (secure default — unix socket 0600) or
     * `"127.0.0.1:<port>"` (loopback TCP, single-user/trusted-host tradeoff —
     * never the implicit default).  An invalid/non-loopback spec fails startup.
     *
     * The runtime `server-proxy.set-metrics-http` toggle and SIGUSR2 can flip it
     * on/off later regardless of this start-time value.
     */
    metricsAddr?: string;
    /**
     * tc-i1pg: server-side handshake timeout.  A connection that connects but
     * never sends `client.capabilities` within this window is closed so that
     * `server.close()` is not blocked indefinitely during shutdown — specifically
     * the idle-exit and tmux-gone self-exit paths that no launcher SIGKILL covers.
     *
     * Default 10 s (well beyond any legitimate client startup latency).  Tests
     * inject a shorter value to keep suite time bounded.  The entry point reads
     * `TMUXCC_HANDSHAKE_TIMEOUT_MS` for deployment-time adjustment.
     */
    handshakeTimeoutMs?: number;
    /**
     * Test-harness affordance (tc-u4ny.2): when set, bypasses the live
     * {@link probeTmuxCapabilities} call in `start()` and uses this map instead.
     * The synthesised capability state reports version `"override"` and
     * `belowFloor: false`.  The production entry point never sets this.
     */
    capabilitiesOverride?: TmuxCapabilityMap;
}
/**
 * Why the server-proxy self-exited (tc-3iv, §6.2):
 *   - "tmux-gone": the thin `-CC` watcher EOFed AND the `tmux ls` probe
 *     confirmed the tmux server is gone.
 *   - "idle": zero IPC clients for the full hysteresis window.
 */
export type ServerProxySelfExitReason = "tmux-gone" | "idle";
/**
 * Thrown by `start()` when a LIVE broker already owns the server-proxy socket
 * (tc-kyq4.1).
 *
 * The unix-socket bind is the cross-process single-flight lock: of two brokers
 * racing to serve one socket name (e.g. two VS Code windows that both probed
 * the socket as unreachable within the spawn latency), exactly one wins the
 * `listen()` and the other gets EADDRINUSE on a still-live socket.  The loser
 * raises this instead of clobbering the winner's socket file — the spawn-side
 * root-cause fix for the tc-i0zk "broker alive but server-proxy.sock missing"
 * wedge, where an orphaned double-spawn loser's later idle-exit unlinked the
 * winner's socket.
 *
 * The entry point (`server-proxy-entry.ts`) maps this to a clean `exit(0)`: the
 * loser never bound or owned the socket, so there is nothing to unlink and the
 * winner is untouched.  The launcher re-probes and reuses the winner.
 */
export declare class ServerProxyAlreadyRunningError extends Error {
    readonly socketPath: string;
    /** Stable discriminator for cross-module `instanceof`-free checks. */
    readonly code = "server-proxy.already-running";
    constructor(socketPath: string);
}
/** The server-proxy handle returned by createServerProxy. */
export interface ServerProxyHandle {
    /**
     * Start the serverProxy: create the unix socket, begin accepting connections,
     * and start the tmux watcher.
     */
    start(): Promise<void>;
    /**
     * Gracefully shut down: stop accepting connections, disconnect all clients,
     * reap all session-proxies, and remove the server-proxy socket file.
     */
    shutdown(): Promise<void>;
    /**
     * The server-proxy's unix socket path. Only valid after start() resolves.
     */
    endpoint(): string;
    /**
     * Number of currently open IPC connections to the server-proxy socket.
     *
     * "Client" means any open Unix-domain socket connection — counted at the
     * raw socket level, before (and regardless of) the wire handshake.  It does
     * NOT mean "has bound a terminal" or "has claimed a session"; a
     * connected-but-idle client keeps the server-proxy alive.
     */
    readonly connectedClientCount: number;
    /**
     * Register a callback invoked after the server-proxy has self-exited: shutdown is
     * complete and the server-proxy socket file is already unlinked when the callback
     * runs.  The entry point wires this to `process.exit(0)`.
     *
     * Self-exit triggers (§6.2):
     *   - The thin `-CC` watcher EOFs and the 1 s `tmux ls` probe fails
     *     (tmux genuinely gone) → immediate exit, reason "tmux-gone".
     *   - Zero IPC clients for the full `idleExitMs` window (default 5 min,
     *     configurable via `TMUXCC_IDLE_EXIT_MS`) → reason "idle".
     *
     * If the watcher EOFs but the probe succeeds (the watcher process itself
     * was killed while tmux lives), the server-proxy re-spawns the watcher and does
     * NOT exit.
     */
    onSelfExit(cb: (reason: ServerProxySelfExitReason) => void): void;
    /**
     * Enable (bind) or disable (unbind) the `/metrics` (+ `/info`) HTTP
     * exposition at runtime, returning the resulting listener state (tc-44u4.4).
     *
     * The PRIMARY no-restart enablement path — the wire
     * `server-proxy.set-metrics-http` command and the SIGUSR2 handler both route
     * here.  Idempotent: enabling when already bound at the SAME address is a
     * no-op; enabling at a DIFFERENT address rebinds; disabling when not bound
     * returns the unbound state.
     *
     * `bind` selects the address when `enabled` is true (`undefined` ⇒ the
     * secure unix-socket default).  Rejects with code `"metrics.bind-invalid"`
     * on a non-loopback TCP host or unparseable spec, and propagates a bind
     * failure (`EADDRINUSE`, permission) — callers map these to a wire error.
     */
    setMetricsHttp(enabled: boolean, bind?: string): Promise<MetricsHttpStatePayload>;
    /**
     * Toggle the metrics-HTTP exposition: bind the secure unix-socket default if
     * currently unbound, unbind if currently bound (tc-44u4.4).
     *
     * The SIGUSR2 fallback semantics — a no-client/no-tooling diagnostic switch
     * (`kill -USR2 <serverProxyPid>`).  When enabling, it always uses the secure
     * unix-socket default (never TCP — a signal carries no address).  Returns
     * the resulting state.
     */
    toggleMetricsHttp(): Promise<MetricsHttpStatePayload>;
    /** Current metrics-HTTP listener state (tc-44u4.4). */
    metricsHttpState(): MetricsHttpStatePayload;
}
/**
 * Create a server-proxy for the given tmux socket.
 *
 * ```ts
 * const serverProxy = createServerProxy({ socketName: "tmuxcc" });
 * await serverProxy.start();
 * console.log("server-proxy at", serverProxy.endpoint());
 * // ... use the server-proxy ...
 * await serverProxy.shutdown();
 * ```
 *
 * Lifecycle (tc-3iv, §6.2): the server-proxy does not manage its own auto-spawn —
 * that is the launcher's job — but it DOES self-manage exit:
 *   - watcher EOF + failed 1 s `tmux ls` probe → immediate self-exit
 *     (tmux genuinely gone; mirrors tmux's own `exit-empty on` semantics)
 *   - watcher EOF + successful probe → re-spawn the watcher, keep serving
 *   - zero IPC clients for `idleExitMs` (default 5 min) → self-exit
 * Register `onSelfExit` to observe; both paths complete shutdown() — which
 * unlinks the server-proxy socket file — before listeners run.  There is no
 * auto-restart layer: server-proxy crashes are bugs to fix, not UX to smooth over.
 * tc-2x3.3: session-proxies now run IN-PROCESS, so a server-proxy crash takes
 * them with it by construction — there are no orphan processes to reap and no
 * die-with-parent watchdog.  Recovery is launcher → fresh server-proxy → fresh
 * in-process session-proxies on next session.claim → fresh `-CC attach` to the
 * surviving tmux sessions.
 */
export declare function createServerProxy(opts: ServerProxyOptions): ServerProxyHandle;
//# sourceMappingURL=server-proxy.d.ts.map