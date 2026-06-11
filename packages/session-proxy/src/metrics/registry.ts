/**
 * Session-proxy metrics registry (tc-x6l + tc-3si.6).
 *
 * Standalone prom-client registry + counters/histograms for the session-proxy
 * hot path. This module is intentionally free of pipeline/state dependencies
 * so it can be imported by any layer without creating circular deps.
 *
 * # Counters and histograms
 *
 * | Metric | Type | Labels | What it measures |
 * |---|---|---|---|
 * | `topology_events_total` | counter | `kind` | Tmux topology notifications classified by kind (tc-x6l). |
 * | `commands_issued_total` | counter | — | Tmux commands written to the south-side PTY. |
 * | `command_round_trip_seconds` | histogram | `kind` | `host.write(cmd)` → `%end` block latency, per command kind (tc-3si.6 added `kind`). |
 * | `topology_notify_to_delta_seconds` | histogram | `edge` | Coalescer `notify(kind)` arrival → matching delta broadcast, per cycle edge (`leading` \| `trailing`). The single most valuable shape: the user-visible promise from tc-128 (tc-3si.6). |
 * | `deltas_emitted_total` | counter | — | Wire deltas produced by ONE pipeline cycle (coalescer requery or model patch), summed across the lifetime of the session-proxy. Denominator for the fan-out amplification ratio (tc-3si.6). |
 * | `deltas_fanned_out_total` | counter | `client` | Deltas sent to each connected client by connection slot. The numerator for the fan-out amplification ratio. |
 * | `output_bytes_total` | counter | — | Decoded `%output` / `%extended-output` payload bytes, AGGREGATE across all panes (cardinality rule — no per-pane labels) (tc-3si.6). |
 * | `output_frame_size_bytes` | histogram | — | Per-frame payload size for `%output` / `%extended-output`, aggregate (tc-3si.6). |
 * | `session_paused_seconds_total` | counter | — | Wall-clock seconds during which one or more panes in this session were paused for flow control. Reads as a fraction-of-time when differentiated (tc-3si.6). |
 * | `requery_teardown_confirmations_total` | counter | `outcome` | Mass-teardown candidates the engine's confirmation guard evaluated, split into `confirmed` (a real session-end the engine ran a confirming cycle for) and `refuted` (the FIRST candidate disagreed with a confirming requery — a garbage snapshot caught before clients saw it). `outcome=refuted` is an **expected-zero tripwire**: any non-zero value is a correctness bug announcing itself; see tc-3si.2 + observability.md (tc-3si.2). |
 * | `process_*` / `nodejs_*` | various | — | Default process metrics from `prom-client.collectDefaultMetrics()`: event-loop lag, GC, heap, RSS, CPU (tc-3si.6). |
 *
 * # Expected-shape reading guide
 *
 * The metrics are emitted continuously; the diagnostic value comes from
 * comparing the LIVE shape against the design's expected shape. The full
 * table — covering ALL metrics (tc-x6l originals + tc-3si.6's additions),
 * with deviation meanings and alert wiring — lives in
 * `projects/tmuxcc/docs/observability.md`. The short form, repeated here as
 * a working programmer's reference:
 *
 * - **`topology_notify_to_delta_seconds{edge}`** — bimodal BY DESIGN.
 *   `edge="leading"` mode at ~1–2 ms (notify → requery → delta — the
 *   keystone "splits/pane-death served instantly"); `edge="trailing"` mode
 *   bounded by the coalescer ceiling (~1 s; see state-model.md §6).
 *   Leading-mode drift = the keystone regressing. Mass migrating
 *   leading→trailing = quiet-detection broken.
 * - **`command_round_trip_seconds{kind="list-windows"|"list-panes"}`** —
 *   tight modes at ~0.5–1 ms. Per-kind tail fattening = tmux server under
 *   load (cf. tc-gek N=3 finding). The `list-*` RATE is bounded by design
 *   to ≤ ~2× the ceiling per session (each requery issues a `list-windows`
 *   + `list-panes` pair, the coalescer's 1 Hz ceiling caps requeries to
 *   one per second); rate above the bound = ceiling/budget leak.
 * - **`topology_events_total{kind}`** + storm alarm — bursty by nature
 *   (resize drag, automation fan-out). Sustained high rate (the tc-3y8.8
 *   reattach-storm class) is the alarm condition handled separately.
 * - **`output_bytes_total` + `output_frame_size_bytes`** — frame-size mode
 *   large under flood (tmux batches). Tiny-frame mode dominating at high
 *   throughput = pathological chattiness / syscall overhead. Per-byte
 *   allocation is forbidden (see perf.md hot-path audit).
 * - **`deltas_emitted_total` vs `deltas_fanned_out_total`** —
 *   `deltas_fanned_out_total / deltas_emitted_total` should equal the
 *   attached-client count EXACTLY. Below = a client silently skipped (bug
 *   in the serve.ts fan-out); above = duplicate sends. Same algebra holds
 *   for `output_bytes_total` × clients vs per-client sendData byte totals.
 * - **`session_paused_seconds_total`** — should sit near zero except for
 *   genuine firehoses; growth = clients draining too slowly. Correlates
 *   with `flow_panes_paused` (tc-3si.5 tripwire gauge — a separate bead).
 * - **`requery_teardown_confirmations_total{outcome}`** — `outcome="confirmed"`
 *   should match real session-end events (rare, user-driven: kill-session,
 *   tmux server shutdown). `outcome="refuted"` is **expected zero**: any
 *   increment is a garbage list-* snapshot the engine caught before it
 *   could clobber the model (tc-128.4 mis-bind class — pause-ack parsed as
 *   an empty `list-windows` reply, etc.). Each refuted increment ALSO logs
 *   loudly to stderr with the candidate's teardown breakdown so the bug
 *   class stays visible — the guard converts a future catastrophe into a
 *   ~1ms self-heal AND a loud forensic trail. The full row lives in
 *   observability.md (tc-3si.2).
 * - **`nodejs_eventloop_lag_seconds`** (default metrics) — p99 stays in
 *   single-digit milliseconds even under firehose. Growth under flood is
 *   the early warning for the demux doing too much per frame, and becomes
 *   load-bearing after tc-2x3 Stage 2 (one process per server: one
 *   session's firehose contends with every session's latency).
 *
 * # Hot-path cost
 *
 * - `Counter.inc()` / `Histogram.observe()`: no allocation, no GC.
 * - Coalescer `notify()` → `topology_events_total.inc()` + storm-alarm
 *   bump on a `+=`. No timer rescheduling.
 * - Per-cycle `topology_notify_to_delta_seconds.observe()`: one observe
 *   per requery cycle (rate-bounded by the coalescer ceiling — at most
 *   ~1/s in steady state, modulo the leading edge).
 * - Per-frame `output_bytes_total.inc(n)` + `output_frame_size_bytes.observe(n)`:
 *   one increment + one observe per `%output` notification. NO per-byte
 *   work. Validated against `runtime/perf-bench.test.ts` — the hot-path
 *   throughput numbers do not regress.
 * - Storm alarm evaluation: on a timer (default 1 s tick), never per-event.
 * - `collectDefaultMetrics()`: prom-client's own sampler runs on its own
 *   internal timer; cost is amortized and reported as gauge updates, not
 *   per-call work.
 *
 * # Cardinality rule (load-bearing)
 *
 * Labels are bounded: `kind` (tmux notification keywords — a small fixed
 * vocabulary plus `unknown`), `edge` (leading|trailing), `client`
 * (connection slot, bounded by attached-client count). Per-pane labels are
 * FORBIDDEN — the pane id space is unbounded over the lifetime of a
 * session-proxy and would explode the prom-client time-series count.
 * `output_bytes_total` / `output_frame_size_bytes` are deliberately
 * aggregate; a per-pane breakdown belongs in tracing, not metrics.
 *
 * @module metrics/registry
 */

import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

// ---------------------------------------------------------------------------
// Bounded label vocabularies
// ---------------------------------------------------------------------------

/**
 * Coalescer cycle edges — used as the `edge` label on
 * `topology_notify_to_delta_seconds`. Bimodal by design (state-model.md §6):
 *
 * - `leading`: the first notify after a quiet period fired the cycle
 *   immediately (the keystone — pane-death and splits served instantly).
 * - `trailing`: the notify landed inside the ceiling window; the cycle ran
 *   on the trailing-edge timer (bounded by the ceiling, ~1 s).
 * - `heartbeat`: the slow unconditional cycle fired with no triggering
 *   notification. Its observation is the heartbeat interval itself (the
 *   elapsed time since the heartbeat fired), so it lives in a histogram
 *   bucket far above the leading/trailing modes and does NOT pollute the
 *   latency reading.
 * - `bootstrap`: the initial post-`pipeline.start()` cycle, driven
 *   directly by start() rather than by the coalescer's policy. Not
 *   currently observed on this histogram (the bootstrap latency is the
 *   one-shot start-up cost and is captured by the
 *   `command_round_trip_seconds` for the bootstrap `list-*` pair); kept
 *   as a label value so the coalescer's `CycleMeta.edge` union and this
 *   histogram label vocabulary stay in lockstep.
 */
export type CycleEdge = "leading" | "trailing" | "heartbeat" | "bootstrap";

// ---------------------------------------------------------------------------
// Registry (non-default so it doesn't pollute Node.js process-wide metrics)
// ---------------------------------------------------------------------------

/**
 * A metrics registry scoped to one session-proxy instance.
 *
 * Using a non-default registry ensures multiple in-process session-proxies
 * (tests, integration setups) get independent counter sets and don't
 * accidentally cross-pollinate.
 */
export interface SessionProxyRegistry {
  /**
   * Increment the per-kind topology event counter.
   *
   * This is the call that goes on the hot path (every topology notification).
   * It is safe to call with `undefined` kind — it records under the label
   * value `"unknown"` so no allocation or branch on the fast path.
   *
   * @param kind - tmux notification kind (e.g. "layout-change", "window-add").
   *               Comes from `NotificationEvent.kind` or the coalescer's
   *               `TopologyEventKind`.
   */
  incTopologyEvent(kind: string | undefined): void;

  /**
   * Increment the commands-issued counter.
   *
   * Called once per command written to the south-side host. May be called
   * from the input-path or from pipeline bootstrap.
   */
  incCommandsIssued(): void;

  /**
   * Increment the deltas-fanned-out counter.
   *
   * Called by the serve layer for each delta sent to a specific client.
   * `clientLabel` is an opaque per-connection label (e.g. "c1", "c2") — not
   * a persistent identity, just enough to attribute fan-out volume per slot.
   */
  incDeltasFannedOut(clientLabel: string): void;

  /**
   * Increment the deltas-emitted counter by the number of deltas produced
   * in ONE pipeline cycle (a requery commit or a model patch).
   *
   * Called once per pipeline-level model change — NOT per-client and NOT
   * per-delta. The ratio
   *
   *     `deltas_fanned_out_total / deltas_emitted_total`
   *
   * MUST equal the attached-client count in steady state (one emit per
   * cycle, fanned out to N clients); deviation is the fan-out tripwire.
   *
   * `count` may be zero for no-op cycles (heartbeat, patch that the diff
   * found equivalent); zero-count cycles still increment by zero so the
   * caller does not need to branch.
   */
  incDeltasEmitted(count: number): void;

  /**
   * Observe one command round-trip latency sample, attributed to the
   * command's `kind` (the first whitespace-delimited token of the command
   * line, e.g. `"list-windows"`, `"list-panes"`, `"set-option"`).
   *
   * The kind label vocabulary is bounded by the tmux command set we
   * actually issue: list-*, set-option, refresh-client, send-keys,
   * attach-session, select-pane, split-window, new-window, kill-pane,
   * kill-window, rename-window. Unknown commands fall under the literal
   * `"unknown"` label.
   *
   * @param seconds - Duration from `host.write(cmd)` to `%end` receipt, in seconds.
   * @param kind    - Command kind, used as the histogram label.
   */
  observeCommandRoundTrip(seconds: number, kind: string): void;

  /**
   * Observe one topology notify-to-delta latency sample, attributed to the
   * coalescer cycle edge that produced it.
   *
   * This is the single most valuable runtime shape (tc-3si.6): the
   * `notify()` → broadcast distance is exactly what the tc-128 design
   * promises is bimodal — leading-edge near zero (the user-visible "splits
   * served instantly" guarantee), trailing-edge bounded by the ceiling.
   * Drift in either mode is a regression in the keystone.
   *
   * @param seconds - Notify timestamp → delta-broadcast timestamp.
   * @param edge    - `"leading"` | `"trailing"` | `"heartbeat"`.
   */
  observeNotifyToDelta(seconds: number, edge: CycleEdge): void;

  /**
   * Increment the aggregate output-bytes counter.
   *
   * Called by the pipeline for every decoded `%output` / `%extended-output`
   * payload. Aggregate — no per-pane label (cardinality rule). This is the
   * denominator for the fan-out amplification ratio
   * `bytes_out / bytes_in == attached-client count`.
   *
   * @param bytes - Decoded payload byte length.
   */
  incOutputBytes(bytes: number): void;

  /**
   * Observe one output frame size sample.
   *
   * Aggregate (no per-pane label). The histogram distinguishes large
   * batched frames (tmux's default flood behaviour) from a tiny-frame mode,
   * which dominating at high throughput is the pathological-chattiness /
   * syscall-overhead diagnostic.
   *
   * @param bytes - Decoded payload byte length for this single frame.
   */
  observeOutputFrameSize(bytes: number): void;

  /**
   * Note that a pane has transitioned into a paused state. Increments the
   * "panes paused" counter; if this is the FIRST pane paused (counter went
   * 0 → 1), start accumulating wall time into `session_paused_seconds_total`.
   *
   * Aggregate across all panes (no per-pane label — cardinality rule); the
   * resulting counter measures fraction-of-time-this-session-was-paused
   * when differentiated. High values = clients draining too slowly.
   */
  notePauseEntered(): void;

  /**
   * Note that a pane has transitioned out of a paused state. If this drops
   * the panes-paused count to zero, accumulate the wall time since the
   * first pause into `session_paused_seconds_total`.
   */
  notePauseExited(): void;

  /**
   * Increment the requery teardown-confirmation counter for one cycle's
   * outcome (tc-3si.2).
   *
   * `outcome="confirmed"`: a mass-teardown candidate (≥ threshold of the
   * previous model's panes or windows would be closed) survived a
   * confirming requery cycle — the session-end is real and the teardown is
   * served. Expected to match real, user-driven session-end events (rare).
   *
   * `outcome="refuted"`: a mass-teardown candidate was DISAGREED with by
   * the confirming requery — the first snapshot was garbage (the tc-128.4
   * mis-bind class). Expected steady-state value: ZERO. Any non-zero value
   * is a correctness bug announcing itself; this method's caller also logs
   * loudly to stderr (the storm-alarm-style alert path) so the bug class
   * stays visible operationally even when the guard absorbs the symptom.
   */
  incTeardownConfirmation(outcome: "confirmed" | "refuted"): void;

  /**
   * Render the full registry as Prometheus text exposition format.
   * Returns a Promise<string> to match prom-client's async API.
   */
  metrics(): Promise<string>;

  /**
   * Stop background resources owned by this registry — currently the
   * `prom-client.collectDefaultMetrics` sampler timer. Idempotent.
   */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Bucket choices — single source of truth so tests can refer to them.
// ---------------------------------------------------------------------------

/**
 * Buckets for command round-trip latency, in seconds. Sized for tmux:
 * - <1 ms: trivial `list-*` round-trips (the design's ~0.5-1 ms baseline).
 * - 1-50 ms: typical commands, storms, light contention.
 * - 100 ms-1 s: tmux server under load (the tc-gek N=3 finding: ~350-400 ms
 *   when the server is CPU-bound).
 */
const COMMAND_RTT_BUCKETS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];

/**
 * Buckets for `topology_notify_to_delta_seconds`. The histogram is
 * expected to be BIMODAL: a leading-edge mode at ~1-2 ms and a trailing-
 * edge mode near the ceiling (~1 s). The buckets straddle both modes with
 * resolution at each end.
 */
const NOTIFY_TO_DELTA_BUCKETS = [
  0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1,
  0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 5.0,
];

/**
 * Buckets for `output_frame_size_bytes`. Tmux's default `%output` chunk
 * size is on the order of single KiB; storms tend to batch larger; tiny
 * frames (<64 B) are the chattiness signal.
 */
const OUTPUT_FRAME_BUCKETS = [
  16, 64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576,
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh `SessionProxyRegistry` with isolated prom-client counters.
 *
 * Each session-proxy instance should create exactly one registry at startup and
 * keep it for the lifetime of the session. Pass the registry handle down to
 * the pipeline wiring (or inject it into components as needed).
 */
export function createSessionProxyRegistry(): SessionProxyRegistry {
  const reg = new Registry();

  // Per-kind topology event counter.
  // tc-x6l: the `kind` label is the tmux notification keyword stripped of the
  // leading `%` (e.g. "layout-change", "window-add", "window-close").  We
  // strip `%` in incTopologyEvent() so callers can pass `event.kind` directly
  // (the parser already strips `%` — `event.kind === "layout-change"`, not
  // `"%layout-change"`).
  const topologyEventsTotal = new Counter({
    name: "topology_events_total",
    help: "Total topology notification events classified by kind.",
    labelNames: ["kind"],
    registers: [reg],
  });

  const commandsIssuedTotal = new Counter({
    name: "commands_issued_total",
    help: "Total tmux commands written to the south-side PTY.",
    registers: [reg],
  });

  const deltasFannedOutTotal = new Counter({
    name: "deltas_fanned_out_total",
    help: "Total model-change deltas sent to connected clients, by connection slot.",
    labelNames: ["client"],
    registers: [reg],
  });

  // tc-3si.6: denominator of the fan-out amplification ratio.
  // `deltas_fanned_out_total / deltas_emitted_total == attached-client count`
  // is the structural invariant; deviation diagnoses a fan-out bug.
  const deltasEmittedTotal = new Counter({
    name: "deltas_emitted_total",
    help: "Total wire deltas produced by pipeline cycles (one per requery/patch cycle, summed).",
    registers: [reg],
  });

  // tc-3si.6: command round-trip latency histogram, keyed by command kind.
  // The bead requires per-kind tight modes (list-* ~0.5-1ms expected); the
  // kind label keeps cardinality bounded to the tmux command vocabulary we
  // actually emit (a small fixed set, see KNOWN_COMMAND_KINDS in
  // metrics/index.ts's `classifyCommand`).
  const commandRoundTripSeconds = new Histogram({
    name: "command_round_trip_seconds",
    help: "Time from tmux command write to %end receipt, in seconds, by command kind.",
    labelNames: ["kind"],
    buckets: COMMAND_RTT_BUCKETS,
    registers: [reg],
  });

  // tc-3si.6: the user-visible latency promise from tc-128.
  // EXPECT bimodal — leading-mode ~1-2 ms, trailing-mode bounded by ceiling.
  const topologyNotifyToDeltaSeconds = new Histogram({
    name: "topology_notify_to_delta_seconds",
    help:
      "Time from coalescer.notify() to matching model-change broadcast, in seconds. " +
      "Bimodal by design: edge=leading at ~1-2ms (the keystone), edge=trailing bounded by the ceiling.",
    labelNames: ["edge"],
    buckets: NOTIFY_TO_DELTA_BUCKETS,
    registers: [reg],
  });

  // tc-3si.6: content-plane throughput (aggregate; cardinality rule).
  const outputBytesTotal = new Counter({
    name: "output_bytes_total",
    help: "Total decoded %output and %extended-output payload bytes (aggregate across all panes).",
    registers: [reg],
  });

  const outputFrameSizeBytes = new Histogram({
    name: "output_frame_size_bytes",
    help:
      "Per-frame payload size for %output and %extended-output (aggregate). " +
      "Large mode under flood = tmux batching; tiny-frame mode at high throughput = pathological chattiness.",
    buckets: OUTPUT_FRAME_BUCKETS,
    registers: [reg],
  });

  // tc-3si.6: paused-time fraction per session. Aggregate counter; the
  // accumulator runs only when ≥1 pane is paused (a single timestamp +
  // refcount, see PauseTracker below — no per-pane state in metrics).
  const sessionPausedSecondsTotal = new Counter({
    name: "session_paused_seconds_total",
    help:
      "Total wall-clock seconds during which ≥1 pane in this session was paused for flow control. " +
      "High values = clients draining too slowly.",
    registers: [reg],
  });

  // tc-3si.2: requery teardown-confirmation outcomes. Splits into
  // `confirmed` (a mass-teardown candidate passed the confirming requery —
  // session-end is real, rare and user-driven) and `refuted` (the FIRST
  // candidate disagreed with the confirming requery — the garbage-snapshot
  // mis-bind class caught before clients saw a catastrophic teardown).
  // `outcome="refuted"` is an EXPECTED-ZERO tripwire — any increment is a
  // correctness bug surfacing through the guard, and is ALSO logged loudly
  // to stderr by the caller (engine driver). See observability.md (tc-3si.2).
  const requeryTeardownConfirmationsTotal = new Counter({
    name: "requery_teardown_confirmations_total",
    help:
      "Mass-teardown candidates evaluated by the requery engine's confirmation guard, by outcome. " +
      "outcome=confirmed: a confirming requery agreed (real session-end, rare). " +
      "outcome=refuted: a confirming requery DISAGREED (garbage first snapshot — expected-zero tripwire).",
    labelNames: ["outcome"],
    registers: [reg],
  });

  // tc-3si.6: process health (event-loop lag, GC pause, heap, CPU). The
  // prom-client sampler manages its own timers and tags samples with
  // gauges; calling collectDefaultMetrics({ register }) is idempotent only
  // when ALL registrations land on disjoint registry instances — fine here
  // because every session-proxy creates a fresh `reg` above. The handle is
  // stored on _defaultMetricsTimer so stop() can clear it.
  const defaultMetricsTimer = collectDefaultMetrics({ register: reg });

  // tc-3si.6: paused-time accumulator. We hold the start timestamp of the
  // current "≥1 pane paused" interval (or null when no pane is paused) and
  // a refcount. On the 0→1 transition we capture `now`; on the 1→0 we
  // accumulate `now - start` into the counter. Refcount lives in this
  // closure so callers cannot accidentally over- or under-decrement; the
  // caller's job is just "I paused a pane" / "I resumed a pane".
  let pausedCount = 0;
  let pausedSince: number | null = null;
  // Use Date.now in seconds for compatibility with the registry's logical
  // wall clock; the accumulator delta is what's reported, not the
  // absolute. (Tests can substitute a clock; the production path is
  // straightforward.)
  const nowSeconds = (): number => Date.now() / 1000;

  return {
    incTopologyEvent(kind: string | undefined): void {
      topologyEventsTotal.inc({ kind: kind ?? "unknown" });
    },

    incCommandsIssued(): void {
      commandsIssuedTotal.inc();
    },

    incDeltasFannedOut(clientLabel: string): void {
      deltasFannedOutTotal.inc({ client: clientLabel });
    },

    incDeltasEmitted(count: number): void {
      if (count <= 0) return;
      deltasEmittedTotal.inc(count);
    },

    observeCommandRoundTrip(seconds: number, kind: string): void {
      commandRoundTripSeconds.observe({ kind }, seconds);
    },

    observeNotifyToDelta(seconds: number, edge: CycleEdge): void {
      topologyNotifyToDeltaSeconds.observe({ edge }, seconds);
    },

    incOutputBytes(bytes: number): void {
      if (bytes <= 0) return;
      outputBytesTotal.inc(bytes);
    },

    observeOutputFrameSize(bytes: number): void {
      if (bytes <= 0) return;
      outputFrameSizeBytes.observe(bytes);
    },

    incTeardownConfirmation(outcome: "confirmed" | "refuted"): void {
      requeryTeardownConfirmationsTotal.inc({ outcome });
    },

    notePauseEntered(): void {
      if (pausedCount === 0) {
        pausedSince = nowSeconds();
      }
      pausedCount++;
    },

    notePauseExited(): void {
      if (pausedCount === 0) {
        // Defensive: spurious resume notification without a matching
        // pause (e.g. tmux unsolicited %continue for a pane we never
        // tracked). Ignore — counter stays at 0.
        return;
      }
      pausedCount--;
      if (pausedCount === 0 && pausedSince !== null) {
        const elapsed = nowSeconds() - pausedSince;
        pausedSince = null;
        if (elapsed > 0) {
          sessionPausedSecondsTotal.inc(elapsed);
        }
      }
    },

    async metrics(): Promise<string> {
      return reg.metrics();
    },

    stop(): void {
      // Stop the prom-client default-metrics sampler timer if one was
      // returned (older prom-client versions return void; newer return a
      // Timeout handle).
      if (defaultMetricsTimer !== undefined && defaultMetricsTimer !== null) {
        // The handle is a Node.js Timeout that the prom-client sampler
        // installs with `setInterval`; clearing it stops the periodic
        // sampling so a disposed session-proxy does not leak a timer.
        clearInterval(defaultMetricsTimer as ReturnType<typeof setInterval>);
      }
      // If a pause was open when stop() is called, flush the partial
      // interval so we don't lose the time-paused accounting on shutdown.
      if (pausedSince !== null && pausedCount > 0) {
        const elapsed = nowSeconds() - pausedSince;
        if (elapsed > 0) {
          sessionPausedSecondsTotal.inc(elapsed);
        }
        pausedSince = null;
        pausedCount = 0;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Command-kind classification (bounded label vocabulary)
// ---------------------------------------------------------------------------

/**
 * The set of tmux commands the session-proxy actually issues today, used
 * to bound the `kind` label vocabulary on `command_round_trip_seconds`.
 * Any command not in this set is recorded under `"unknown"`.
 *
 * Keeping the vocabulary closed is the cardinality rule's enforcement
 * point: a stray user-supplied command (e.g. via `command.request` →
 * `tmux.exec`) cannot inflate the metric's time-series count.
 *
 * EXTEND ME when a new tmux command starts going through the requery/
 * input-path slotted writer. The list mirrors the calls in
 * `runtime/pipeline.ts`, `runtime/input-path.ts`, `runtime/flow-control.ts`,
 * `runtime/session-proxy.ts`, and `state/bootstrap.ts`.
 */
const KNOWN_COMMAND_KINDS: ReadonlySet<string> = new Set([
  "list-windows",
  "list-panes",
  "set-option",
  "refresh-client",
  "send-keys",
  "attach-session",
  "select-pane",
  "split-window",
  "new-window",
  "kill-pane",
  "kill-window",
  "kill-session",
  "rename-window",
  "resize-pane",
]);

/**
 * Classify a tmux command line into its kind label for
 * `command_round_trip_seconds`. Bounded vocabulary — see
 * `KNOWN_COMMAND_KINDS`. Returns `"unknown"` for anything else.
 *
 * The classifier looks at the FIRST whitespace-delimited token of the
 * command line — tmux command syntax is `<verb> [args...]`, so this is
 * unambiguous. Newlines and trailing whitespace are tolerated. An empty
 * input returns `"unknown"`.
 *
 * Hot-path cost: one `indexOf` + one `Set.has`; no allocation beyond a
 * single substring slice (V8 sliced-string, no copy).
 */
export function classifyCommand(command: string): string {
  if (command.length === 0) return "unknown";
  // The command may have leading whitespace (rare); strip a leading space
  // band cheaply without a regex by walking from index 0.
  let start = 0;
  while (start < command.length && command.charCodeAt(start) === 0x20) start++;
  let end = start;
  while (end < command.length) {
    const c = command.charCodeAt(end);
    // Stop on whitespace or newline.
    if (c === 0x20 || c === 0x0a || c === 0x09) break;
    end++;
  }
  if (end === start) return "unknown";
  const kind = command.slice(start, end);
  return KNOWN_COMMAND_KINDS.has(kind) ? kind : "unknown";
}
