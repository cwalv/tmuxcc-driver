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
 * | `requery_cycles_total` | counter | `trigger` | Coalescer-fired (or bootstrap-fired) requery cycles, attributed to the trigger edge (`leading` \| `trailing` \| `heartbeat` \| `bootstrap` \| `reconnect`). EXPECT `leading` dominant in interactive use, `trailing` only in bursts, `heartbeat` a steady 1/heartbeatMs metronome. `trailing >> leading` = sustained churn (tc-3si.5). |
 * | `requery_heartbeat_changes_total` | counter | — | Heartbeat cycles whose diff contained ≥1 delta. **Expected-zero tripwire**: every increment means a topology change reached us with NO triggering notification (event-vocabulary gap / dropped notification); the heartbeat self-healed but the upstream stream is silently lossy. ALERT on sustained nonzero (tc-3si.5). |
 * | `requery_round_trip_seconds` | histogram | — | `list-windows` / `list-panes` round-trip latency observed at the engine's submit closure (requery-only, separate from `command_round_trip_seconds`). EXPECT tight unimodal ~1 ms. Tail fattening = the "requery is cheap" premise (state-model.md §5) eroding (tc-3si.5). |
 * | `requery_budget_exhausted_total` | counter | — | Convergence budget exhausted inside `RequeryEngine._runCycles`. **Expected-zero tripwire** unless the storm alarm is also tripping (the legitimate sustained-storm cause). Exhaustion without a storm = convergence pathology (mid-flight rearm storm sourced inside the proxy, not from tmux); ALERT (tc-3si.5). |
 * | `requery_failed_cycles_total` | counter | `reason` | Cycles the engine marked `failed: true` (model untouched, dirty re-armed), attributed by `reason` (`error` = `%error` from a `list-*` reply; `budget` = convergence budget exhausted; mirrors `requery_budget_exhausted_total` for `budget`). **Expected-zero tripwire**: clustered at session teardown only. Steady-state failures = the coalescer's retry path being exercised continuously (tc-3si.5). |
 * | `correlator_unsolicited_blocks_total` | counter | — | `%end` / `%error` blocks closed with NO pending slot to bind them to (`flags=0` startup blocks are excluded — they're a protocol fixture, not a slot regression). **Expected-zero tripwire** once tc-3si.1's atomic slot+write lands. Any non-zero value is a slot-less write regressing — the flow-load-F4 class announcing itself BEFORE corruption (tc-3si.5). ALERT. |
 * | `correlator_pending_slots` | gauge | — | Current depth of the correlator's FIFO `_pending` queue (registered slots awaiting `%end`). EXPECT 0–2 during normal command flow; aging past seconds = tmux never answered = wedge precursor (tc-3si.5). |
 * | `correlator_pending_slot_max_age_seconds` | gauge | — | Age (now − registration time) of the oldest pending slot, in seconds. EXPECT sub-second; `> 1 s` = an outstanding command tmux has not acknowledged (tc-3si.5). |
 * | `output_pretopology_dropped_bytes_total` | counter | `provenance` | Bytes dropped by the output-demux's bounded pre-topology buffer. `provenance=owned`: the pane was eventually bound to the model (the F4 symptom — we dropped bytes for a pane we own; **expected-zero tripwire**, ALERT). `provenance=foreign`: the pane was never bound (legitimate under bind-on-provenance — bytes that belonged to another tmux client's pane that recapture-on-bind will cover) (tc-3si.5). |
 * | `flow_panes_paused` | gauge | — | Number of panes currently paused by the flow controller (FIFO refcount-style — pairs with `session_paused_seconds_total`). EXPECT returns to 0 after every firehose drains; drift = a pane stuck gated, "the terminal went dead" symptom (tc-3si.5). |
 * | `flow_pane_pauses_total` | counter | — | Total pane pause transitions (0→paused). Balances with `flow_pane_resumes_total` over time. Imbalance = a pane stuck paused (tc-3si.5). |
 * | `flow_pane_resumes_total` | counter | — | Total pane resume transitions (paused→0). Balances with `flow_pane_pauses_total` over time. Imbalance = paused panes leak (tc-3si.5). |
 * | `flow_drain_clamped_total` | counter | — | Times `noteDrained`'s clamp-at-zero clipped — a drain credit exceeded the buffered total. **Expected-zero tripwire**: every increment is an FC-1 accounting bug (double credit / drain-for-dead-pane) the clamp would otherwise absorb into silent drift. ALERT (tc-d7i). |
 * | `flow_bytes_while_paused_total` | counter | — | Bytes accounted while the pane was already paused — the FC-5 in-flight window (output tmux flushed before honoring the pause). EXPECT small bounded bursts at each pause edge (~one socket flush, observed ~2730-byte chunks in tc-cbh); sustained growth = tmux not honoring `refresh-client -A pause` (tc-d7i). |
 * | `flow_commands_failed_total` | counter | `kind` | `%error` replies to flow-control `refresh-client -A` commands (`kind=pause\|continue`). **Expected-zero tripwire**; `kind=continue` is the worst UX failure in this plane — tmux keeps holding the pane's output (frozen terminal) with no other witness. Correlator rejections at teardown are NOT counted. ALERT (tc-d7i). |
 * | `resyncs_total` | counter | `cause` | Resync events handled by `serve.ts`, attributed by `cause` (`gap`: the client detected a seq gap and asked for a snapshot — legitimate under packet loss / drop tests; `escalation`: a second resync request from the same client within a short window — the previous snapshot didn't heal the gap). EXPECT ~0 on in-process transports (in-memory pairs are lossless); `escalation` is **expected-zero tripwire** universally — it means the wire's sequence invariant is broken (tc-3si.5). ALERT on escalation. |
 * | `deltas_per_cycle` | histogram | — | Wire-delta count per pipeline cycle (coalescer cycle, bootstrap, patch). EXPECT small (1–5) in steady state; spikes only at bootstrap / reconnect. Steady large batches = a diff-instability (a flapping field producing spurious deltas) (tc-3si.5). |
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

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

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

/**
 * Trigger label vocabulary for `requery_cycles_total` (tc-3si.5).
 *
 * Mirrors `CycleEdge` and adds `reconnect`. `reconnect` is not currently
 * emitted (this pipeline collapses bootstrap and reconnect into the engine's
 * prev-model diff path), but is reserved in the vocabulary so future runtime
 * code that wants to differentiate first-attach vs. mid-session re-attach can
 * land without altering the metric's label cardinality.
 *
 * Cardinality: 5 values, fully closed.
 */
export type RequeryTrigger = CycleEdge | "reconnect";

/**
 * `output_pretopology_dropped_bytes_total` provenance label values (tc-3si.5).
 *
 * - `owned`: the pane that the dropped bytes were addressed to was EVENTUALLY
 *   bound to the topology model (the demux later saw `notifyPaneBound` for
 *   it). Bytes for a pane we own went into the bounded staging buffer and
 *   were thrown away — the F4 symptom we used to log via `console.warn`.
 *   Expected-zero tripwire.
 * - `foreign`: the pane was never bound (bind-on-provenance, tc-zna.9 —
 *   another tmux client's pane, or a transient short-lived pane). Drops are
 *   legitimate; recapture-on-bind covers the rare case the pane is later
 *   bound (no test path currently does this, so the foreign credit stays).
 *
 * Cardinality: 2 values, fully closed.
 */
export type Provenance = "owned" | "foreign";

/**
 * `requery_failed_cycles_total` reason label values (tc-3si.5).
 *
 * - `error`: the cycle's `list-*` reply was `%error` from tmux — the engine
 *   re-armed dirty and the coalescer's failed-path scheduled a retry at the
 *   next ceiling boundary.
 * - `budget`: convergence budget (`CYCLE_BUDGET`) was exhausted — sustained
 *   mid-flight notification storm or a teardown candidate tripped on the
 *   final allowed cycle and never reached the confirmation step.
 *
 * Cardinality: 2 values, fully closed.
 */
export type RequeryFailureReason = "error" | "budget";

/**
 * `resyncs_total` cause label values (tc-3si.5).
 *
 * - `gap`: the client detected a sequence gap and asked for a fresh
 *   snapshot. Legitimate under lossy transports.
 * - `escalation`: a second resync request from the same client landed
 *   within `RESYNC_ESCALATION_WINDOW_MS` of the previous one — the
 *   previous snapshot did not heal the gap. Expected-zero tripwire: the
 *   client's "resync, then close on persistent gap" state machine should
 *   have closed instead of asking again. An escalation either means the
 *   client's gap detector is broken, or our snapshot itself was corrupt.
 *
 * Cardinality: 2 values, fully closed.
 */
export type ResyncCause = "gap" | "escalation";

/**
 * `flow_commands_failed_total` kind label values (tc-d7i).
 *
 * The flow controller's two fire-and-forget `refresh-client -A` commands.
 * `continue` failures are the worst case: tmux keeps holding the pane's
 * output — a frozen terminal if no later resume succeeds.
 *
 * Cardinality: 2 values, fully closed.
 */
export type FlowCommandKind = "pause" | "continue";

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

  // ---- tc-3si.5: premise-watching + tripwire counters ---------------------

  /**
   * Increment `requery_cycles_total{trigger}` (tc-3si.5).
   *
   * Called once per pipeline-level requery cycle. Bootstrap is reported as
   * `trigger="bootstrap"`; coalescer-driven cycles forward their `CycleMeta.edge`
   * verbatim. The trigger distribution validates the §6 economics
   * continuously — leading dominant in interactive use, heartbeat as a
   * steady metronome, trailing only during bursts.
   */
  incRequeryCycle(trigger: RequeryTrigger): void;

  /**
   * Increment `requery_heartbeat_changes_total` (tc-3si.5).
   *
   * Called when a `trigger="heartbeat"` cycle's diff contained ≥1 delta —
   * i.e. tmux state changed without a triggering notification. This is the
   * "dropped notification / event-vocabulary gap" signal. Expected-zero
   * tripwire: every increment is silently lossy upstream, and ALSO loud-
   * logged to stderr by the caller (storm-alarm-style alert path).
   *
   * `deltaCount` is the count of deltas the heartbeat carried; passed so the
   * alert sink can include it in the forensic log line.
   */
  incRequeryHeartbeatChange(deltaCount: number): void;

  /**
   * Observe a single requery-cycle round-trip latency sample (tc-3si.5).
   *
   * Called once per `list-windows` / `list-panes` write inside the engine's
   * submit closure. The histogram is separate from `command_round_trip_seconds`
   * so the requery-only sample population isn't diluted by user-driven
   * command latencies. EXPECT tight unimodal ~1 ms; tail fattening erodes
   * the "requery is cheap" premise (state-model.md §5).
   *
   * @param seconds - Duration from `host.write(list-*)` to `%end` receipt.
   */
  observeRequeryRoundTrip(seconds: number): void;

  /**
   * Increment `requery_budget_exhausted_total` (tc-3si.5).
   *
   * Called by the engine when `_runCycles` exits via budget exhaustion —
   * sustained mid-flight rearm storm or a teardown candidate tripped on the
   * very last allowed cycle. Expected-zero tripwire (the legitimate path is
   * a coincident storm alarm); the caller ALSO loud-logs to stderr.
   */
  incRequeryBudgetExhausted(): void;

  /**
   * Increment `requery_failed_cycles_total{reason}` (tc-3si.5).
   *
   * Called by the engine when a `requery()` call returns `failed: true`,
   * attributed by reason (`error` = a `%error` reply from tmux on a
   * `list-*`; `budget` = convergence budget exhausted — the same condition
   * `incRequeryBudgetExhausted` was incremented for, kept on the same
   * surface so a reader sees both totals at once). Expected-zero tripwire:
   * clustered at session teardown only.
   */
  incRequeryFailedCycle(reason: RequeryFailureReason): void;

  /**
   * Increment `correlator_unsolicited_blocks_total` (tc-3si.5).
   *
   * Called by `CommandCorrelator` when a `%end` / `%error` block closes with
   * no pending slot to bind to (the `_pending` FIFO was empty). Excludes
   * `flags=0` startup blocks — those are a tmux protocol fixture, not a
   * slot regression.
   *
   * Expected-zero tripwire once tc-3si.1 lands (atomic slot+write makes
   * a slot-less reply structurally impossible). Any increment is the
   * flow-load-F4 class announcing itself BEFORE corruption.
   */
  incCorrelatorUnsolicitedBlock(): void;

  /**
   * Update the `correlator_pending_slots` gauge to the current FIFO depth
   * AND update `correlator_pending_slot_max_age_seconds` to the oldest
   * slot's age, in seconds (or 0 when the queue is empty). Called from the
   * correlator on every register / resolve, AND polled on a metrics-read
   * path (the gauges' values are read at exposition time). Hot-path cost:
   * two `Gauge.set` calls (no allocation).
   */
  setCorrelatorPending(depth: number, oldestAgeSeconds: number): void;

  /**
   * Increment `output_pretopology_dropped_bytes_total{provenance}` (tc-3si.5).
   *
   * Called by the output-demux when bytes are dropped from the bounded
   * per-pane staging buffer. `provenance` is determined by whether the pane
   * is later bound (`owned`) or never bound (`foreign`); the demux defers
   * crediting until that decision is made — see the demux's
   * `_pendingDroppedBytes` map. Hot-path cost: one `Counter.inc(bytes)`,
   * called only at decision time (bind / close), never per-byte.
   */
  incPretopologyDroppedBytes(bytes: number, provenance: Provenance): void;

  /**
   * Increment `flow_pane_pauses_total` and bump `flow_panes_paused` by 1
   * (tc-3si.5). Called by the per-session adapter that tracks the flow
   * controller's pause set. Pairs with `notePanePauseExited`.
   */
  notePanePauseEntered(): void;

  /**
   * Increment `flow_pane_resumes_total` and decrement `flow_panes_paused`
   * by 1 — clamped to 0 to defend against spurious resume notifications
   * for panes the gauge wasn't tracking (tc-3si.5).
   */
  notePanePauseExited(): void;

  /**
   * Increment `flow_drain_clamped_total` (tc-d7i).
   *
   * Called (via the flow controller's metrics hooks) when `noteDrained`'s
   * clamp-at-zero clipped — a drain credit exceeded the buffered total.
   * Expected-zero tripwire: every increment is an FC-1 accounting bug
   * (double credit / drain-for-dead-pane) that the clamp would otherwise
   * absorb into silent drift. The wiring caller ALSO loud-logs to stderr.
   */
  noteFlowDrainClamped(): void;

  /**
   * Increment `flow_bytes_while_paused_total` by `bytes` (tc-d7i).
   *
   * Bytes accounted while the pane was already paused — the FC-5 in-flight
   * window (output tmux flushed before honoring the pause command).
   * EXPECT small bounded bursts right after each pause edge (~one socket
   * flush); sustained growth = tmux is not honoring the pause command
   * (lost or failed `refresh-client -A pause`).
   */
  noteFlowBytesWhilePaused(bytes: number): void;

  /**
   * Increment `flow_commands_failed_total{kind}` (tc-d7i).
   *
   * A flow-control pause/continue `refresh-client -A` reply came back
   * `%error`. Expected-zero tripwire; `kind="continue"` is the worst UX
   * failure in the flow plane — tmux keeps holding the pane's output
   * (permanently frozen terminal) and this counter is its only witness.
   * Correlator rejections at session teardown are deliberately NOT
   * counted. The wiring caller ALSO loud-logs to stderr.
   */
  noteFlowCommandFailed(kind: FlowCommandKind): void;

  /**
   * Increment `resyncs_total{cause}` (tc-3si.5).
   *
   * Called by `ControlServer.handleResyncRequest` after deciding whether
   * this is a fresh `gap` request or an `escalation` (a second request from
   * the same client within the escalation window). `escalation` is an
   * expected-zero tripwire and is ALSO loud-logged to stderr.
   */
  incResync(cause: ResyncCause): void;

  /**
   * Increment `pane_notify_total{kind}` (tc-76m8.1). One increment per
   * `pane.notify` the escape scanner emits (AFTER rate limiting), by kind.
   * The observability numerator for the S9 attention pipeline.
   */
  incPaneNotify(kind: string): void;

  /**
   * Increment `pane_notify_dropped_total{kind}` (tc-76m8.1). One increment per
   * `pane.notify` DROPPED by the driver-side rate limiter, by kind. For Tier-1
   * kinds (`bell`, `osc9`) this is an EXPECTED-ZERO tripwire — a real storm or
   * a bug — and the wiring caller ALSO loud-logs to stderr. Tier-2 kinds
   * (`progress`, `cmd-exit`) drop as routine coalescing; those rows are
   * expected non-zero.
   */
  incPaneNotifyDropped(kind: string): void;

  /**
   * Observe a single per-cycle delta count sample on the `deltas_per_cycle`
   * histogram (tc-3si.5). Called at the same site as `incDeltasEmitted`
   * (every pipeline-level cycle, coalescer or patch). EXPECT small (1–5)
   * in steady state; spikes only at bootstrap / reconnect.
   *
   * Zero-delta cycles (heartbeat no-ops, patches that found no observable
   * change) ARE observed under bucket 0 so the histogram captures
   * "no-change rate" too — a flapping diff that emits and then withdraws
   * a delta shows up as alternating 0 / 1 samples.
   */
  observeDeltasPerCycle(count: number): void;

  /**
   * Increment `session_boundary_trips_total` (tc-2x3.4).
   *
   * Called by the session-proxy supervisor's per-session error boundary
   * handler whenever the pipeline's `onFatalError` fires — i.e. the
   * tokenizer / parser / reducer / _dispatchEvent stack threw an unhandled
   * exception that the error boundary caught.
   *
   * This is an **expected-zero tripwire** in steady state: every increment
   * means a parser/reducer bug surfaced at runtime and the session was
   * recycled.  It is NOT counted on intentional teardowns (reapSessionProxy /
   * SIGTERM graceful path) or on tmux-exit–triggered host.onExit paths.
   *
   * Surfaced via `session-proxy.info` in the same `metricsText` block as all
   * other counters.
   */
  incBoundaryTrip(): void;

  /**
   * Increment `session_boundary_quarantined_total` (tc-m2y8).
   *
   * Called by the supervisor's circuit breaker when a session crosses the
   * repeated-trip quarantine threshold (`CIRCUIT_BREAKER_TRIP_THRESHOLD`
   * boundary trips within `CIRCUIT_BREAKER_WINDOW_MS`) and is blocked from
   * re-spawning until `clearQuarantine()` is called. The companion of
   * `incBoundaryTrip`: trips is the per-session accumulator, quarantined is the
   * broker-level alarm (N rapid trips crossed the threshold — the session is
   * now in quarantine).
   *
   * Surfaced via `session-proxy.info` in the same `metricsText` block.
   *
   * **Expected-zero tripwire**: any non-zero value means a repeated
   * parser/reducer bug reached the quarantine threshold; the caller ALSO
   * loud-logs the `CIRCUIT BREAKER OPEN` line to stderr.
   */
  incBoundaryQuarantine(): void;

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

/**
 * Buckets for `requery_round_trip_seconds` (tc-3si.5). Tighter at the bottom
 * than `command_round_trip_seconds` because the bead's EXPECTATION is
 * "tight unimodal ~1 ms" — bucket resolution at 0.5 / 1 / 2 ms lets a
 * fattening tail be visible in a session-proxy.info read at a glance.
 */
const REQUERY_RTT_BUCKETS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];

/**
 * Buckets for `deltas_per_cycle` (tc-3si.5). Bead EXPECTATION is "small
 * (1–5) steady state; spikes only at bootstrap/reconnect". Buckets cover
 * the steady-state shape with high resolution AND the bootstrap-sized
 * spikes without inflating cardinality.
 */
const DELTAS_PER_CYCLE_BUCKETS = [0, 1, 2, 5, 10, 25, 50, 100, 250, 1000];

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

  // tc-3si.5: per-trigger requery cycle attribution. Bounded by RequeryTrigger
  // (5 values). Premise-watching counter — the shape of `leading` vs.
  // `trailing` vs. `heartbeat` validates state-model.md §6 continuously.
  const requeryCyclesTotal = new Counter({
    name: "requery_cycles_total",
    help:
      "Pipeline-level requery cycles, attributed to the trigger edge. " +
      "EXPECT leading dominant in interactive use; trailing only in bursts; " +
      "heartbeat a steady 1/heartbeatMs metronome.",
    labelNames: ["trigger"],
    registers: [reg],
  });

  // tc-3si.5: heartbeat changes — expected-zero tripwire. A heartbeat cycle
  // that found a real model change means a topology change reached us
  // without a triggering notification (event-vocabulary gap / dropped
  // notification). The caller ALSO loud-logs to stderr.
  const requeryHeartbeatChangesTotal = new Counter({
    name: "requery_heartbeat_changes_total",
    help:
      "Heartbeat cycles whose diff contained ≥1 delta — a topology change with no triggering notification. " +
      "Expected-zero tripwire.",
    registers: [reg],
  });

  // tc-3si.5: requery-only round-trip latency (separate from general
  // command RTT so the per-kind sample population stays interpretable).
  const requeryRoundTripSeconds = new Histogram({
    name: "requery_round_trip_seconds",
    help:
      "Round-trip latency for list-windows / list-panes commands issued by the requery engine, in seconds. " +
      "EXPECT tight unimodal ~1 ms; tail fattening = the 'requery is cheap' premise eroding.",
    buckets: REQUERY_RTT_BUCKETS,
    registers: [reg],
  });

  // tc-3si.5: convergence-budget exhaustion — expected-zero tripwire unless
  // the storm alarm is also tripping. Exhaustion in isolation is a
  // convergence pathology, not a tmux-side storm. Caller loud-logs.
  const requeryBudgetExhaustedTotal = new Counter({
    name: "requery_budget_exhausted_total",
    help:
      "RequeryEngine convergence-budget exhaustions. Expected-zero tripwire unless coincident with a storm alarm.",
    registers: [reg],
  });

  // tc-3si.5: failed-cycle counter, attributed by reason. Expected-zero
  // tripwire (clustered at teardown only — see observability.md).
  const requeryFailedCyclesTotal = new Counter({
    name: "requery_failed_cycles_total",
    help:
      "RequeryEngine cycles that returned failed:true, by reason. " +
      "Expected-zero tripwire: clustered at session teardown only.",
    labelNames: ["reason"],
    registers: [reg],
  });

  // tc-3si.5: correlator unsolicited-block counter. Expected-zero once
  // tc-3si.1's atomic slot+write makes slot-less replies structurally
  // impossible; any non-zero value is the flow-load-F4 class announcing
  // itself BEFORE corruption. Caller loud-logs.
  const correlatorUnsolicitedBlocksTotal = new Counter({
    name: "correlator_unsolicited_blocks_total",
    help:
      "Reply blocks closed with no pending slot to bind (excludes flags=0 startup blocks). " +
      "Expected-zero tripwire — slot-less write regression (the flow-load-F4 pre-corruption signal).",
    registers: [reg],
  });

  // tc-3si.5: correlator FIFO discipline — the live depth of registered
  // slots awaiting %end, plus the oldest slot's age. EXPECT 0–2 slots, sub-
  // second age in steady state; aging past seconds = tmux never answered.
  const correlatorPendingSlots = new Gauge({
    name: "correlator_pending_slots",
    help:
      "Current depth of the correlator's FIFO _pending queue. " +
      "EXPECT 0–2 in steady state; growth = a command tmux has not replied to.",
    registers: [reg],
  });

  const correlatorPendingSlotMaxAgeSeconds = new Gauge({
    name: "correlator_pending_slot_max_age_seconds",
    help:
      "Age of the oldest pending slot in the correlator FIFO, in seconds (0 when queue empty). " +
      "EXPECT sub-second; > 1 s = a wedge precursor.",
    registers: [reg],
  });

  // tc-3si.5: pretopology-buffer drops counter. Provenance-labelled so
  // `owned` (the F4 symptom — a pane we own had bytes thrown away) is a
  // separate, expected-zero tripwire from `foreign` (legitimate under
  // bind-on-provenance).
  const outputPretopologyDroppedBytesTotal = new Counter({
    name: "output_pretopology_dropped_bytes_total",
    help:
      "Bytes dropped by the output-demux's pre-topology bounded staging buffer, by provenance. " +
      "provenance=owned is an expected-zero tripwire (the F4 symptom).",
    labelNames: ["provenance"],
    registers: [reg],
  });

  // tc-3si.5: flow-control pause gauge + totals. Pairs with
  // `session_paused_seconds_total` (the time-paused area-under-the-curve).
  // The gauge should return to 0 after every firehose drains; the
  // pauses/resumes totals should balance over the lifetime.
  const flowPanesPaused = new Gauge({
    name: "flow_panes_paused",
    help:
      "Number of panes currently paused by the flow controller. " +
      "EXPECT returns to 0 between firehoses; persistent non-zero = a pane stuck gated.",
    registers: [reg],
  });

  const flowPanePausesTotal = new Counter({
    name: "flow_pane_pauses_total",
    help: "Total 0→paused transitions across all panes (paired with flow_pane_resumes_total).",
    registers: [reg],
  });

  const flowPaneResumesTotal = new Counter({
    name: "flow_pane_resumes_total",
    help: "Total paused→0 transitions across all panes (paired with flow_pane_pauses_total).",
    registers: [reg],
  });

  // tc-d7i: flow-control invariant tripwires. These witness the FC-N
  // contract clauses (flow-control.ts module header) that depend on real
  // tmux timing and therefore cannot be deterministically unit-asserted:
  // the clamp (FC-1), the in-flight window (FC-5), and the fire-and-forget
  // command replies that were previously swallowed entirely.
  const flowDrainClampedTotal = new Counter({
    name: "flow_drain_clamped_total",
    help:
      "Times noteDrained's clamp-at-zero clipped (drain credit exceeded buffered bytes). " +
      "Expected-zero tripwire: every increment is an accounting bug the clamp absorbed.",
    registers: [reg],
  });

  const flowBytesWhilePausedTotal = new Counter({
    name: "flow_bytes_while_paused_total",
    help:
      "Bytes accounted while the pane was already paused (the FC-5 in-flight window). " +
      "EXPECT small bursts at pause edges; sustained growth = tmux not honoring pause.",
    registers: [reg],
  });

  const flowCommandsFailedTotal = new Counter({
    name: "flow_commands_failed_total",
    help:
      "%error replies to flow-control refresh-client pause/continue commands, by kind. " +
      "Expected-zero tripwire: kind=continue means a pane stays frozen until a later resume succeeds.",
    labelNames: ["kind"],
    registers: [reg],
  });

  // tc-3si.5: resync counter, by cause. `gap` is legitimate under lossy
  // transports; `escalation` is an expected-zero tripwire that means a
  // second resync from the same client landed inside the escalation
  // window — the previous snapshot did not heal the gap. Caller loud-logs.
  const resyncsTotal = new Counter({
    name: "resyncs_total",
    help:
      "Resync events handled by the control-plane server, by cause. " +
      "cause=escalation is an expected-zero tripwire — the previous snapshot did not heal the gap.",
    labelNames: ["cause"],
    registers: [reg],
  });

  // tc-76m8.1 (S9): pane.notify pipeline counters. `total` is the emit
  // numerator; `dropped` is the rate-limiter drop counter. kind is bounded
  // vocabulary (osc9|bell|progress|cmd-exit) — no per-pane label (cardinality
  // rule). The bell/osc9 rows of `dropped` are expected-zero tripwires (caller
  // loud-logs); progress/cmd-exit drops are routine coalescing.
  const paneNotifyTotal = new Counter({
    name: "pane_notify_total",
    help: "Pane attention/status notifications emitted by the escape scanner, by kind (post rate-limit).",
    labelNames: ["kind"],
    registers: [reg],
  });

  const paneNotifyDroppedTotal = new Counter({
    name: "pane_notify_dropped_total",
    help:
      "Pane notifications dropped by the driver-side rate limiter, by kind. " +
      "kind=bell|osc9 (Tier-1) is an expected-zero tripwire; kind=progress|cmd-exit is routine coalescing.",
    labelNames: ["kind"],
    registers: [reg],
  });

  // tc-2x3.4: per-session error boundary trip counter.
  //
  // Incremented by the supervisor's onFatalError handler whenever the
  // pipeline's tokenizer / parser / reducer / _dispatchEvent stack threw an
  // unhandled exception that the error boundary caught, was logged, and
  // triggered a teardown + lazy reattach of this session.
  //
  // Expected-zero tripwire in steady state: any increment is a parser/reducer
  // bug announcing itself.  Steady-state non-zero = a reproducible parse path
  // is corrupted; sessions are recycling on every notification arrival.
  const sessionBoundaryTripsTotal = new Counter({
    name: "session_boundary_trips_total",
    help:
      "Per-session pipeline exception boundary trips (tc-2x3.4). " +
      "Each increment = an unhandled parser/reducer/pipeline exception was caught; the session was recycled. " +
      "Expected-zero tripwire — steady-state non-zero means a reproducible parse bug is recycling the session.",
    registers: [reg],
  });

  // tc-m2y8: circuit-breaker quarantine counter — the companion to
  // session_boundary_trips_total. trips is the per-session accumulator;
  // quarantined is the broker-level alarm (the supervisor's circuit breaker
  // saw CIRCUIT_BREAKER_TRIP_THRESHOLD rapid trips and now blocks re-spawn
  // until clearQuarantine()). Expected-zero tripwire; the caller loud-logs
  // the CIRCUIT BREAKER OPEN line.
  const sessionBoundaryQuarantinedTotal = new Counter({
    name: "session_boundary_quarantined_total",
    help:
      "Per-session circuit-breaker quarantine events (tc-m2y8). " +
      "Each increment = the session crossed the repeated-boundary-trip threshold and was quarantined " +
      "(ensureSessionProxy rejects until clearQuarantine). " +
      "Expected-zero tripwire — companion of session_boundary_trips_total.",
    registers: [reg],
  });

  // tc-3si.5: per-cycle delta-count distribution. Complements
  // deltas_emitted_total (rate) by showing the SHAPE — small steady
  // (1–5) vs. bootstrap spikes vs. flapping diffs (alternating 0/N).
  const deltasPerCycle = new Histogram({
    name: "deltas_per_cycle",
    help:
      "Wire-delta count per pipeline cycle. " +
      "EXPECT small (1–5) steady state; spikes only at bootstrap/reconnect; " +
      "steady large batches = diff instability.",
    buckets: DELTAS_PER_CYCLE_BUCKETS,
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

    // ---- tc-3si.5: premise-watching + tripwire counters -------------------

    incRequeryCycle(trigger: RequeryTrigger): void {
      requeryCyclesTotal.inc({ trigger });
    },

    incRequeryHeartbeatChange(_deltaCount: number): void {
      // The delta count is purely a parameter for the caller's loud-log
      // line; the counter itself just increments by 1.
      requeryHeartbeatChangesTotal.inc();
    },

    observeRequeryRoundTrip(seconds: number): void {
      requeryRoundTripSeconds.observe(seconds);
    },

    incRequeryBudgetExhausted(): void {
      requeryBudgetExhaustedTotal.inc();
    },

    incRequeryFailedCycle(reason: RequeryFailureReason): void {
      requeryFailedCyclesTotal.inc({ reason });
    },

    incCorrelatorUnsolicitedBlock(): void {
      correlatorUnsolicitedBlocksTotal.inc();
    },

    setCorrelatorPending(depth: number, oldestAgeSeconds: number): void {
      correlatorPendingSlots.set(depth);
      correlatorPendingSlotMaxAgeSeconds.set(oldestAgeSeconds);
    },

    incPretopologyDroppedBytes(bytes: number, provenance: Provenance): void {
      if (bytes <= 0) return;
      outputPretopologyDroppedBytesTotal.inc({ provenance }, bytes);
    },

    notePanePauseEntered(): void {
      flowPanePausesTotal.inc();
      flowPanesPaused.inc();
    },

    notePanePauseExited(): void {
      flowPaneResumesTotal.inc();
      // Defensive clamp at 0 — the per-pane mirror set in the caller already
      // dedupes spurious resumes, but the gauge must never go negative.
      // prom-client's Gauge doesn't expose its current value cheaply, so we
      // use dec() and rely on the caller's pause-set guard for correctness;
      // the test for the spurious-resume case (registry.test.ts) verifies the
      // gauge stays non-negative through the mirror, not by inspecting it
      // directly. (A future hardening could read `flowPanesPaused.get()` but
      // that path is async in prom-client v15+.)
      flowPanesPaused.dec();
    },

    noteFlowDrainClamped(): void {
      flowDrainClampedTotal.inc();
    },

    noteFlowBytesWhilePaused(bytes: number): void {
      if (bytes <= 0) return;
      flowBytesWhilePausedTotal.inc(bytes);
    },

    noteFlowCommandFailed(kind: FlowCommandKind): void {
      flowCommandsFailedTotal.inc({ kind });
    },

    incResync(cause: ResyncCause): void {
      resyncsTotal.inc({ cause });
    },

    incPaneNotify(kind: string): void {
      paneNotifyTotal.inc({ kind });
    },

    incPaneNotifyDropped(kind: string): void {
      paneNotifyDroppedTotal.inc({ kind });
    },

    incBoundaryTrip(): void {
      sessionBoundaryTripsTotal.inc();
    },

    incBoundaryQuarantine(): void {
      sessionBoundaryQuarantinedTotal.inc();
    },

    observeDeltasPerCycle(count: number): void {
      // Zero is a meaningful sample (heartbeat no-op, idempotent patch); it
      // lands in bucket 0. Negative inputs are defensive no-ops.
      if (count < 0) return;
      deltasPerCycle.observe(count);
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
