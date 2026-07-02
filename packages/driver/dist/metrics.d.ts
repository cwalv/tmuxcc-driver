/**
 * Server-proxy metrics registry (tc-x6l + tc-3si.6).
 *
 * Thin prom-client registry for the server-proxy process itself — tracks
 * server-level counters that the session-proxy registry doesn't own:
 *
 *   - `server_proxy_commands_total{kind}` — server-proxy wire commands received
 *     (session.claim, session.create, session.destroy, server-proxy.info, …).
 *   - `server_proxy_connections_total` — total IPC connections accepted
 *     (raw socket-level, pre-handshake).
 *   - `server_proxy_connections_active` — current open connection count
 *     (gauge — incremented on connect, decremented on close).
 *   - `server_proxy_sessions_active` — current session count (gauge).
 *   - `process_*` / `nodejs_*` (tc-3si.6) — default process metrics from
 *     `prom-client.collectDefaultMetrics()`: event-loop lag, GC pause,
 *     heap, RSS, CPU. The server-proxy is one process per machine (post
 *     tc-2x3); event-loop lag here is the cross-cutting health signal for
 *     the whole tmuxcc supervisor.
 *
 * This module is intentionally small. Per-session topology metrics live in the
 * per-session `SessionProxyRegistry` (packages/session-proxy/src/metrics/).
 *
 * # Debug surface (tc-x6l)
 *
 * `ServerProxyMetrics.metricsText()` returns the Prometheus text exposition
 * for this registry. It is included in the `server-proxy.info` response payload
 * under `ServerProxyInfoPayload.metricsText`.
 *
 * @module server-proxy/metrics
 */
/** Server-proxy-level metrics handle (tc-x6l). */
export interface ServerProxyMetrics {
    /**
     * Increment the command counter for the given command kind.
     * @param kind - The `ServerProxyCommand.kind` value (e.g. "session.claim").
     */
    incCommand(kind: string): void;
    /**
     * Observe one full application-leg RPC round-trip latency sample (tc-bn7d),
     * attributed to the command's `kind`.
     *
     * Timed across the ENTIRE `_handleCommand` body — from entry (just after
     * `incCommand`) to the response being dispatched — so it captures every
     * `await` in the broker handler (`ensureSessionProxy`, `createSession`, tmux
     * spawn, the bootstrap requery, …). This is the "smoking gun" the tc-jlyi
     * RCA lacked: `command_round_trip_seconds{kind="list-*"}` (the south-side
     * tmux leg) read ~1 ms while the claim was stalled ~6.7 s in the application
     * layer; that gap pointed directly at `ensureSessionProxy`, not tmux.
     *
     * The `kind` vocabulary matches `server_proxy_commands_total{kind}` — a
     * small fixed enum (`session.claim`, `session.create`, `session.createUnique`,
     * `session.destroy`, `server-proxy.info`, `pane.attach`, `session.topology`)
     * — so cardinality stays bounded.
     *
     * @param seconds - Duration from `_handleCommand` entry to response dispatch.
     * @param kind    - The `ServerProxyCommand.kind` value, used as the label.
     */
    observeRpcRoundTrip(seconds: number, kind: string): void;
    /**
     * Increment `server_proxy_self_exit_total{reason}` (tc-m2y8).
     *
     * Called once at the start of `_selfExit`, before shutdown runs. The
     * `reason` matches the `ServerProxySelfExitReason` vocabulary
     * (`"idle"` | `"tmux-gone"`) — a closed 2-value enum. Promotes the
     * previously log-only / on-wire-only self-exit reason into a counter that
     * survives in `metricsText` across the broker's lifetime.
     */
    incSelfExit(reason: string): void;
    /**
     * Increment `server_proxy_watcher_eof_total{verdict}` (tc-m2y8).
     *
     * Called once per `-CC` watcher EOF, after the `probeTmuxLiveness` verdict
     * is known. The `verdict` vocabulary matches the probe's return value
     * (`"alive"` | `"inconclusive"` | `"gone"`) — a closed 3-value enum. The
     * distribution shows how often the watcher dies young (`alive`), how often
     * the probe loses its budget under load (`inconclusive`), and how often
     * tmux is conclusively gone (`gone` — the only self-exit-triggering verdict).
     */
    incWatcherEof(verdict: string): void;
    /**
     * Increment `server_proxy_watcher_respawns_total` (tc-m2y8).
     *
     * Called when the respawn timer fires and actually spawns a replacement
     * `-CC` watcher (the `alive` / `inconclusive` recovery path and the
     * `--persist-through-tmux-gone` re-poll path). One event type — no label.
     * A steady non-zero rate = the watcher keeps dying and being replaced
     * (host load / repeated EOFs), correlate with `server_proxy_watcher_eof_total`.
     */
    incWatcherRespawn(): void;
    /**
     * Adjust `socketfeed_sendcontrol_queue_depth` by `delta` (tc-edf8).
     *
     * The gauge counts messages currently waiting on a socket-transport drain
     * promise (write()==false, awaiting the 'drain' event), AGGREGATE across
     * every transport the broker owns. `delta` is `+1` when a send is enqueued
     * onto the drain wait and `-n` when a drain resolves n waiting messages.
     *
     * EXPECT 0 in steady state (writes complete into the kernel send buffer
     * synchronously). A non-zero standing depth = the remote VS Code end is
     * backpressuring; bursty depth with short drains = concurrent backpressure
     * windows. Distinguishes a slow producer from a backpressured consumer when
     * read alongside `socketfeed_time_in_queue_seconds` and event-loop lag.
     */
    addSocketFeedQueueDepth(delta: number): void;
    /**
     * Observe one `socketfeed_time_in_queue_seconds` sample (tc-edf8).
     *
     * The elapsed time a single message waited from `write()==false` until the
     * drain event that released it — observed once per message at drain
     * resolution. Measures how long the producer was stalled waiting for the
     * consumer (the remote VS Code end) to drain.
     *
     * @param seconds - Time the message spent waiting on the drain promise.
     */
    observeSocketFeedTimeInQueue(seconds: number): void;
    /** Increment the total connections accepted counter. */
    incConnectionAccepted(): void;
    /** Increment the active connection gauge (on connect). */
    incConnectionActive(): void;
    /** Decrement the active connection gauge (on close). */
    decConnectionActive(): void;
    /** Set the active sessions gauge (replaces the previous value). */
    setSessionsActive(count: number): void;
    /**
     * Return the Prometheus text exposition for this registry.
     * Returns a Promise<string> to match prom-client's async API.
     */
    metricsText(): Promise<string>;
    /**
     * Stop background resources owned by this registry — currently the
     * prom-client default-metrics sampler (tc-3si.6). Idempotent. Safe to
     * call from a teardown path (no-op if already stopped).
     */
    stop(): void;
}
/**
 * Create the server-proxy metrics registry.
 *
 * One instance per server-proxy process. Kept in the ServerProxyImpl and
 * included in `server-proxy.info` responses.
 */
export declare function createServerProxyMetrics(): ServerProxyMetrics;
//# sourceMappingURL=metrics.d.ts.map