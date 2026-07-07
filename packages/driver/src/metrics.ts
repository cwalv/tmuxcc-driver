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
 * per-session `SessionProxyRegistry` (packages/driver/src/metrics/).
 *
 * # Debug surface (tc-x6l)
 *
 * `ServerProxyMetrics.metricsText()` returns the Prometheus text exposition
 * for this registry. It is included in the `server-proxy.info` response payload
 * under `ServerProxyInfoPayload.metricsText`.
 *
 * @module server-proxy/metrics
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

// ---------------------------------------------------------------------------
// Bucket choices — single source of truth so tests can refer to them.
// ---------------------------------------------------------------------------

/**
 * Buckets for `rpc_round_trip_seconds{kind}` (tc-bn7d), in seconds.
 *
 * This is the APPLICATION leg of the wire protocol — the whole `_handleCommand`
 * await chain (`ensureSessionProxy`, `createSession`, tmux spawn, …), NOT just
 * the south-side tmux command round-trip (that is `command_round_trip_seconds`,
 * which reads ~1 ms even while this reads the full claim latency). The buckets
 * span the <1 ms read-only fast path (`server-proxy.info`, `session.topology`)
 * up to the multi-second activation stall the tc-jlyi RCA chased (a
 * `session.claim` that took ~6.7 s while the tmux leg stayed healthy).
 */
const RPC_RTT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

/**
 * Buckets for `socketfeed_time_in_queue_seconds` (tc-edf8), in seconds.
 *
 * How long a control/data message sat waiting on the socket-transport drain
 * promise (write()==false → 'drain' event). EXPECT near-empty in steady state
 * (writes complete synchronously into the kernel send buffer); a fattening tail
 * means the remote VS Code end cannot drain fast enough (backpressured
 * consumer). The top bucket (5 s) is the wedge-precursor threshold — sustained
 * queue waits above ~1 s precede the flow controller pausing tmux.
 */
const TIME_IN_QUEUE_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5];

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the server-proxy metrics registry.
 *
 * One instance per server-proxy process. Kept in the ServerProxyImpl and
 * included in `server-proxy.info` responses.
 */
export function createServerProxyMetrics(): ServerProxyMetrics {
  const reg = new Registry();

  const commandsTotal = new Counter({
    name: "server_proxy_commands_total",
    help: "Total server-proxy wire commands received, by command kind.",
    labelNames: ["kind"],
    registers: [reg],
  });

  // tc-bn7d: application-leg RPC round-trip latency, keyed by command kind.
  // Distinct from the session-proxy's tmux-leg `command_round_trip_seconds`:
  // this times the whole `_handleCommand` await chain, so a slow activation
  // (ensureSessionProxy / tmux spawn) is visible even when the tmux leg reads
  // ~1 ms. The `kind` label reuses the bounded `server_proxy_commands_total`
  // vocabulary (a small closed enum — cardinality rule).
  const rpcRoundTripSeconds = new Histogram({
    name: "rpc_round_trip_seconds",
    help:
      "Time from server-proxy _handleCommand entry to response dispatch, in seconds, by command kind. " +
      "The application leg (the whole broker handler incl. ensureSessionProxy / tmux spawn) — " +
      "distinct from the tmux-leg command_round_trip_seconds.",
    labelNames: ["kind"],
    buckets: RPC_RTT_BUCKETS,
    registers: [reg],
  });

  // tc-m2y8: broker lifecycle counters (promoted from log-only).
  //
  // server_proxy_self_exit_total{reason}: the broker's designed quiescence —
  // previously the reason was only sent on-wire (server-proxy.exiting) and
  // logged, never counted. reason ∈ {idle, tmux-gone} (ServerProxySelfExitReason).
  const selfExitTotal = new Counter({
    name: "server_proxy_self_exit_total",
    help:
      "Server-proxy designed self-exits, by reason (idle | tmux-gone). " +
      "Promoted from the log-only / on-wire-only exit reason — counts the designed-quiescence events.",
    labelNames: ["reason"],
    registers: [reg],
  });

  // server_proxy_watcher_eof_total{verdict}: each -CC watcher EOF, attributed
  // by the probeTmuxLiveness verdict (alive | inconclusive | gone). Only `gone`
  // is terminal; `alive`/`inconclusive` re-spawn the watcher (see below).
  const watcherEofTotal = new Counter({
    name: "server_proxy_watcher_eof_total",
    help:
      "Watcher (-CC) EOFs, by probeTmuxLiveness verdict (alive | inconclusive | gone). " +
      "Only verdict=gone is terminal (self-exit / re-poll); alive/inconclusive re-spawn the watcher.",
    labelNames: ["verdict"],
    registers: [reg],
  });

  // server_proxy_watcher_respawns_total: respawn timer fired and spawned a
  // replacement watcher. One event type — no label. Steady non-zero = watcher
  // churn (host load); pair with server_proxy_watcher_eof_total.
  const watcherRespawnsTotal = new Counter({
    name: "server_proxy_watcher_respawns_total",
    help:
      "Watcher (-CC) respawns — the respawn timer fired and spawned a replacement watcher. " +
      "Steady non-zero = watcher churn; correlate with server_proxy_watcher_eof_total.",
    registers: [reg],
  });

  // tc-edf8: socket-transport backpressure observability (aggregate across all
  // transports the broker owns). The transport's drain path (write()==false ->
  // shared drain promise -> 'drain' event) is the only witness to a
  // backpressured consumer before the flow controller pauses tmux.
  //
  // queue_depth: messages currently waiting on a drain promise. EXPECT 0 in
  // steady state; a standing non-zero depth = the remote VS Code end can't keep
  // up. Inc/dec semantics (not set) so concurrent transports aggregate.
  const socketFeedQueueDepth = new Gauge({
    name: "socketfeed_sendcontrol_queue_depth",
    help:
      "Messages currently waiting on a socket-transport drain promise (write()==false, awaiting 'drain'), " +
      "aggregate across all transports. EXPECT 0 in steady state; standing non-zero = backpressured consumer.",
    registers: [reg],
  });

  // time_in_queue: per-message wait from write()==false to the releasing
  // 'drain' event, observed once per message. Distinguishes a slow producer
  // (queue stays shallow, drains fast) from a backpressured consumer (long
  // waits) — the wedge precursor the only-other signal (session_paused_seconds)
  // fires AFTER the flow controller has already paused tmux.
  const socketFeedTimeInQueueSeconds = new Histogram({
    name: "socketfeed_time_in_queue_seconds",
    help:
      "Time a socket-transport message waited from write()==false to the releasing 'drain' event, in seconds. " +
      "EXPECT near-empty; a fattening tail = the remote VS Code end is backpressured (a wedge precursor).",
    buckets: TIME_IN_QUEUE_BUCKETS,
    registers: [reg],
  });

  const connectionsTotal = new Counter({
    name: "server_proxy_connections_total",
    help: "Total IPC connections accepted (raw socket-level, pre-handshake).",
    registers: [reg],
  });

  const connectionsActive = new Gauge({
    name: "server_proxy_connections_active",
    help: "Current number of open IPC connections.",
    registers: [reg],
  });

  const sessionsActive = new Gauge({
    name: "server_proxy_sessions_active",
    help: "Current number of sessions in the server-proxy session table.",
    registers: [reg],
  });

  // tc-3si.6: process health (event-loop lag, GC pause, heap, RSS, CPU).
  // Load-bearing for the post-tc-2x3 one-process-per-machine model: the
  // server-proxy event-loop lag is the cross-cutting health signal.
  const defaultMetricsTimer = collectDefaultMetrics({ register: reg });

  return {
    incCommand(kind: string): void {
      commandsTotal.inc({ kind });
    },

    observeRpcRoundTrip(seconds: number, kind: string): void {
      rpcRoundTripSeconds.observe({ kind }, seconds);
    },

    incSelfExit(reason: string): void {
      selfExitTotal.inc({ reason });
    },

    incWatcherEof(verdict: string): void {
      watcherEofTotal.inc({ verdict });
    },

    incWatcherRespawn(): void {
      watcherRespawnsTotal.inc();
    },

    addSocketFeedQueueDepth(delta: number): void {
      if (delta === 0) return;
      socketFeedQueueDepth.inc(delta);
    },

    observeSocketFeedTimeInQueue(seconds: number): void {
      socketFeedTimeInQueueSeconds.observe(seconds);
    },

    incConnectionAccepted(): void {
      connectionsTotal.inc();
    },

    incConnectionActive(): void {
      connectionsActive.inc();
    },

    decConnectionActive(): void {
      connectionsActive.dec();
    },

    setSessionsActive(count: number): void {
      sessionsActive.set(count);
    },

    async metricsText(): Promise<string> {
      return reg.metrics();
    },

    stop(): void {
      // Stop the prom-client default-metrics sampler timer if one was
      // returned (older prom-client versions return void; newer return a
      // Timeout handle that we must clear so the server-proxy can shut
      // down without leaking timers).
      if (defaultMetricsTimer !== undefined && defaultMetricsTimer !== null) {
        clearInterval(defaultMetricsTimer as ReturnType<typeof setInterval>);
      }
    },
  };
}
