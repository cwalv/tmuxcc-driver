# Observability — expected-shape table for tmuxcc metrics

> Reference doc for the runtime metrics emitted by the session-proxy and
> server-proxy processes. This is the **authoritative expected-shape
> table** for all counters and histograms: each row pairs a metric with
> the shape the design says it should have in healthy steady state, and
> documents what a deviation means diagnostically.
>
> Cross-references: `state-model.md` §5 (event-rate structure) and §6
> (requery-on-event policy) — the rate analyses these expectations derive
> from; `perf.md` — point-in-time measured benchmark numbers (vs the
> continuous expectations here).
>
> Implementation: tc-x6l (originals: per-kind counters + storm alarm) and
> tc-3si.6 (this addition: latency / throughput histograms + process
> health). Tripwire counters live in tc-3si.5 (separate bead — that bead's
> rows are added under "Tripwires" once it lands).

---

## 1. How to read this doc

Every metric below is documented with five facts:

| Column | What it means |
|---|---|
| **Metric** | The Prometheus metric name (and labels). |
| **Where emitted** | The code site that increments / observes. |
| **Expected shape** | What healthy steady state looks like, and *why* (referring to the upstream design decision). |
| **Deviation = what?** | What a departure from the expected shape diagnoses — the specific bug or condition the metric distinguishes. |
| **Alert wiring** | Whether the metric has a tripwire (tc-3si.5) or is read-only diagnostic. |

The diagnostic value comes from comparing the **live shape** against the
**design's expected shape**. None of the metrics in this doc are
self-judging — read them with this table.

## 2. Cardinality rule

Labels are bounded:

- `kind` — tmux notification keyword OR tmux command verb (small fixed
  vocabulary plus `unknown`).
- `edge` — `leading` | `trailing` | `heartbeat`.
- `client` — connection slot (`c1`, `c2`, …). Slots are a reusable pool:
  released on disconnect, reused by the next connect, so cardinality is
  bounded by the max **concurrent** client count (a monotonic mint would
  grow one label per reconnect for the proxy's lifetime).

Per-pane labels are **forbidden**: the pane id space is unbounded over
the lifetime of a session-proxy and would explode the prom-client
time-series count. Output metrics are aggregate; a per-pane breakdown
belongs in tracing, not metrics.

## 3. Session-proxy registry

Emitted from `packages/session-proxy/src/metrics/registry.ts`; surfaced
via the `session-proxy.info` debug command (the `metricsText` field of
`SessionProxyInfoPayload`). Per-counter rationale lives in the JSDoc of
the registry module.

### 3.1 Topology classification + storm

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `topology_events_total{kind}` | `runtime/session-proxy.ts` via `pipeline.onTopologyNotify` hook (the coalescer's classification choke point). | Bursty per `state-model.md` §5: ~60/s resize drag (<1 s), ~10–100/s title churn (<2 s), ~100–500/s agent fan-out (<5 s). Sustained rate near 0 in steady state. | Sustained high rate = the tc-3y8.8 reattach-storm class (~8000/s × minutes). Handled by the storm alarm — see §3.5. Per-kind distribution attributes which notification is responsible. | Storm alarm (`tc-x6l`) trips at 2500 events / 5 s window. |
| `commands_issued_total` | `pipeline.ts` (the slotted command writer + the engine submit closure). | Tracks the rate at which the session-proxy talks to tmux. Steady state: ~2 commands/s (a coalescer cycle is `list-windows` + `list-panes`) plus input bursts. | Sudden silence = control plane stalled (no requeries firing — coalescer wedged); sudden inflation = command storm (input mis-routed). | None — read-only diagnostic. |

### 3.2 Command round-trip latency

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `command_round_trip_seconds{kind}` | `pipeline.ts` — both the requery engine's `submit` closure and `_writeSlottedCommand` time the round-trip from `host.write(cmd)` to `%end` arrival. | Per-kind tight mode at ~0.5–1 ms for `list-windows` / `list-panes` (the design's baseline; see `perf.md`). Other commands (`set-option`, `refresh-client`, `send-keys`) typically <5 ms. **Rate bound**: `list-*` count ≤ ~2× ceiling per session per second (each requery issues a pair; the coalescer caps requeries to 1/s in steady state). | Per-kind **tail fattening** = tmux server under load (cf. tc-gek N=3 finding: when the tmux server goes CPU-bound, every command latency stretches to ~350–400 ms). **Rate above the bound** for `list-*` = ceiling/budget leak — the coalescer is firing more than 1 Hz, which is a regression in tc-128.2 policy. | None — read-only diagnostic. Tripwire bead (tc-3si.5) may add a rate-ceiling alarm. |

### 3.3 Topology notify-to-delta latency (the keystone)

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `topology_notify_to_delta_seconds{edge}` | `pipeline.ts` — observed at the moment the coalescer's `onDeltas` fires, with `edge` set from the coalescer's `CycleMeta`. | **Bimodal by design.** `edge="leading"` mode at ~1–2 ms (notify → requery → delta — the user-visible keystone "splits/pane-death served instantly"). `edge="trailing"` mode bounded by the ceiling (~1 s). `edge="heartbeat"` lands in a high bucket at the heartbeat interval (default 30 s) — distinguishable from the latency modes by being far above them. | **Leading-mode drift up** = the tc-128 keystone regressing (notification → requery → delta is no longer instant). **Mass migrating leading→trailing** = quiet-detection broken (the coalescer thinks it's always in a storm window). **Trailing mode above ceiling** = the engine's convergence budget is being exhausted / list-* round-trips are slow (correlate with `command_round_trip_seconds`). | None — read-only diagnostic. The single most valuable runtime shape; tc-3si.5 may add a tripwire on leading-mode median. |

### 3.4 Content-plane throughput

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `output_bytes_total` | `pipeline.ts` `_dispatchEvent` after `decodeOutputPayload`. **Aggregate** — no per-pane label (cardinality rule). | Tracks total bytes the session-proxy has decoded from tmux. Sustained ~MB/s under firehose, ~0/s in steady state. | Sudden silence under load = the tokenizer / decoder stalled. The pipeline hot-path performance budget is documented in `perf.md`. | None — read-only diagnostic. |
| `output_frame_size_bytes` | Same call site as `output_bytes_total`. | Bimodal-ish: large mode (tmux batches `%output` into multi-KiB frames under flood) + a smaller mode of typical interactive (~tens of bytes per keystroke echo). | **Tiny-frame mode dominating at high throughput** = pathological chattiness / syscall overhead — the pty bridge is reading a byte at a time instead of batching. Correlates with `nodejs_eventloop_lag_seconds` rising (the demux is doing too much per frame). | None — read-only diagnostic. |
| `deltas_emitted_total` | `pipeline.ts` — incremented by the wire-delta count of each emitted cycle (coalescer requery, patchModel, bootstrap). | One value per pipeline cycle; sums into a rate that mirrors topology activity. The denominator of the fan-out amplification ratio. | See `deltas_fanned_out_total` row below. | None. |
| `deltas_fanned_out_total{client}` | `runtime/serve.ts` per delta sent to each client (the connection's `cN` slot label). | **Invariant**: `deltas_fanned_out_total / deltas_emitted_total == attached-client count` (each cycle's deltas are sent to every attached client). | **Ratio below client count** = a client is silently being skipped (bug in serve.ts fan-out). **Ratio above client count** = duplicate sends (subscription leak). Same algebra works for the bytes side: `output_bytes_total × clients` should equal the sum of per-client `sendData` byte totals. | None — read-only diagnostic. Tripwire bead (tc-3si.5) may add a ratio-drift alarm. |
| `session_paused_seconds_total` | `runtime/session-proxy.ts` accumulates wall time across the union of paused panes (refcount-style); the registry holds the accumulator. | Near zero except for genuine firehoses (`yes > /dev/null`, `cat large.log`). When non-zero, differentiating gives the **fraction of time the session was flow-controlled**. | High and growing = clients draining too slowly (the session-proxy is throttling tmux because the client side isn't keeping up). Correlates with the `flow_panes_paused` gauge from tc-3si.5 (separate bead). | None — read-only diagnostic. |
| `requery_teardown_confirmations_total{outcome}` | `state/requery.ts` — `RequeryEngineImpl._runCycles` calls `metrics.incTeardownConfirmation(...)` when a mass-teardown candidate is either confirmed by a follow-up cycle or refuted by it. | `outcome="confirmed"` matches the real session-end rate — rare, user-driven (`kill-session`, tmux server shutdown). `outcome="refuted"` is **expected zero** — the design's bet is that the only path to a mass-teardown-shaped candidate is a genuine session end. | `outcome="refuted"` non-zero = a future regression of the tc-128.4 mis-bind class (a garbage `list-windows` reply that looked empty, e.g. a pause-ack body parsed into the requery slot). The guard already absorbed it — clients never saw the spurious teardown — but the counter announces the bug. Each refuted increment is ALSO loud-logged to stderr with a per-class breakdown for forensics. `outcome="confirmed"` inflating without matching session-end activity = the teardown-fraction threshold is set too low for legitimate large window/pane churn (rare; tune `teardownThreshold`). | **Has alert wiring** — `outcome="refuted"` logs loudly to stderr (storm-alarm-style) on every increment. tc-3si.2 (this row). |

### 3.5 Storm alarm

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| (No prom-client counter; alarm logs to stderr.) | `metrics/storm-alarm.ts` (tc-x6l) — sliding-window rate over `topology_events_total`. Default threshold 2500 events / 5 s. | Never trips in normal operation. Legitimate bursts top out at ~500/s for <5 s. | A trip = sustained topology-event rate well above legitimate burst ceilings — almost always pathological. The log line names the dominant kind for attribution. | **Has alert wiring** — logs to stderr; the per-window kind breakdown is included in `session-proxy.info` for forensics. |

### 3.6 Process health (default metrics)

Emitted by `prom-client.collectDefaultMetrics()`. All `process_*` /
`nodejs_*` standard names — the table here just calls out the ones with
load-bearing diagnostic value for tmuxcc.

| Metric | Expected shape | Deviation = what? |
|---|---|---|
| `nodejs_eventloop_lag_seconds` | p99 single-digit milliseconds, even under firehose (the perf-bench numbers in `perf.md` demonstrate ~200 MB/s headroom). | **Growth under flood** = the demux is doing too much per frame — early warning before any user-visible symptom. Becomes load-bearing after tc-2x3 Stage 2: one process per server means one session's firehose contends with every session's latency. |
| `nodejs_heap_size_used_bytes` / `process_resident_memory_bytes` | Stable in steady state (the pipeline has no per-byte allocation, and the scrollback store evicts at its cap). | Growth without bound = a leak. Cross-check the scrollback cap (`tc-fx2`) and per-pane staging buffer (`output-demux.ts`, 128 KiB cap). |
| `nodejs_gc_duration_seconds` | Short pauses, infrequent. | Long / frequent GC = allocation pressure — correlate with `output_frame_size_bytes` (tiny-frame chattiness) and `nodejs_heap_size_used_bytes`. |
| `process_cpu_user_seconds_total` | Linear growth proportional to activity. | The session-proxy going CPU-bound on its own (independent of tmux's CPU) = the demux / tokenizer is the bottleneck — opportunity for the `perf.md` improvements. |

### 3.7 Tripwires (tc-3si.5)

Tripwires differ from the **shapes to read** above: their VALUE is a
documented expectation, and the runtime reads them itself and (for the
expected-zero ones) takes action. Every expected-zero row below is wired
into the storm-alarm-style alert path (loud stderr line + a per-counter
hook in the metrics registry), so a regression announces itself without
a metric reader attached.

#### 3.7.1 Premise-watching (requery plane)

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `requery_cycles_total{trigger}` | `pipeline.ts` — incremented once per coalescer-fired cycle (forwarded `CycleMeta.edge`) AND once per bootstrap commit (`trigger="bootstrap"`). Trigger vocabulary: `leading` \| `trailing` \| `heartbeat` \| `bootstrap` \| `reconnect` (the last is reserved for future use — this pipeline collapses reconnect into the engine's prev-model diff path). | `leading` dominant in interactive use; `heartbeat` a steady metronome (= session-uptime / heartbeatMs); `trailing` only during bursts; `bootstrap` exactly once per session. | `trailing >> leading` = sustained churn (a foreground process producing topology-affecting notifications faster than the 1 Hz ceiling). `heartbeat` rate ≠ uptime/heartbeatMs = the heartbeat timer is misarming (regression of tc-3si.11). | None for the counter itself — it's a shape to read. The expected-zero companion is `requery_heartbeat_changes_total`. |
| `requery_heartbeat_changes_total` | `pipeline.ts` — incremented when a `meta.edge === "heartbeat"` cycle's `result.deltas.length > 0`. | **Expected zero.** A heartbeat that finds a change means tmux state changed without a triggering notification — the heartbeat self-healed, but the upstream notification stream is silently lossy (event-vocabulary gap or dropped notification). | Any non-zero value = the dropped-notification class announcing itself. The model is correct (the heartbeat fixed it) but the notification path needs a fix. | **Has alert wiring** — every increment is loud-logged to stderr with the delta count for forensics. tc-3si.5 expected-zero tripwire. |
| `requery_round_trip_seconds` | `pipeline.ts` — observed at the requery engine's `submit` closure wrapper, once per `list-windows` / `list-panes` write. Separate from `command_round_trip_seconds{kind}` so the requery-only sample population stays interpretable (a fattening tail is visible without filtering). | Tight unimodal at ~1 ms (state-model.md §5's design baseline). | Tail fattening = the "requery is cheap" premise eroding (cf. tc-gek N=3 finding: tmux server under load stretches all command latencies). Cross-check against `command_round_trip_seconds{kind="list-*"}` — they should be near-identical (same code path, different label scope). | None — read-only diagnostic. |
| `requery_budget_exhausted_total` | `state/requery.ts` `RequeryEngineImpl._runCycles` — incremented when the convergence loop exits via budget exhaustion (sustained mid-flight rearm storm OR a teardown candidate tripped on the final allowed cycle). | **Expected zero** unless the storm alarm is also tripping (the legitimate sustained-storm cause). | Exhaustion in isolation = a convergence pathology (self-sourced rearm storm — the proxy is dirtying itself mid-flight, not tmux). | **Has alert wiring** — every increment is loud-logged to stderr by the engine, independent of whether metrics are wired. tc-3si.5 expected-zero tripwire. |
| `requery_failed_cycles_total{reason}` | `state/requery.ts` — incremented on every `failed: true` return, with `reason=error` (a `%error` `list-*` reply) or `reason=budget` (the budget-exhaustion path; the same incident bumps `requery_budget_exhausted_total` on its dedicated surface). | **Expected zero,** clustered at session teardown only. | Steady-state failures = the coalescer's retry path being exercised continuously (the tmux server is unhealthy for `error`, or convergence is pathological for `budget`). | tc-3si.5. The refuted teardown path (`requery_teardown_confirmations_total{outcome="refuted"}`) does NOT bump this counter — it owns its own surface. |

#### 3.7.2 Correlator FIFO discipline

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `correlator_unsolicited_blocks_total` | `parser/correlator.ts` — incremented when a `%end` / `%error` block closes with no pending slot (excludes `flags=0` startup blocks). Wired through `pipeline.ts`'s correlator option. | **Expected zero** once tc-3si.1's atomic slot+write makes a slot-less reply structurally impossible. | Any increment = a slot-less command-write path has regressed. Pre-corruption signal of the flow-load-F4 class (the next slot's reply mis-binds). The runtime build-time dependency-cruiser rule (tc-3si.1) catches the static case; this counter catches the dynamic case. | **Has alert wiring** — every increment is loud-logged to stderr by `pipeline.ts`. tc-3si.5 expected-zero tripwire. |
| `correlator_pending_slots` | `parser/correlator.ts` — gauge written on every register / resolve edge, AND polled via `pipeline.refreshCorrelatorPendingGauge()` at `session-proxy.info` read time to refresh the age field. | 0–2 slots in steady state (input bursts can transiently spike). | Growth above ~5 = commands tmux has not replied to. Pair with `correlator_pending_slot_max_age_seconds` for the wedge-precursor diagnosis. | None — read-only diagnostic; the AGE companion below is the alarm signal. |
| `correlator_pending_slot_max_age_seconds` | Same site as the depth gauge. | Sub-second in steady state. | **Read-stall signature (tc-44u4 wedge family):** age climbing 1:1 with wall-clock WHILE `output_bytes_total` and `deltas_emitted_total` are frozen (reply/read path dead) AND `commands_issued_total` keeps climbing (write path alive) = the control-stream parser is stalled or silently discarding input. The tc-44u4 root cause was the tokenizer entering `AFTER_DCS` on a raw ESC-backslash inside a `capture-pane` block body and discarding the rest of the control stream; fix: tc-44u4.1 (tokenizer). Any `max_age` above a few seconds with frozen output counters is this class until proven otherwise. Cross-ref obs-gap beads tc-edf8, tc-mbu3. | **Alert recommended** — set an alert on `correlator_pending_slot_max_age_seconds > 5` (a few seconds); sub-second in normal operation means any sustained climb is unambiguous. Correlate with `output_bytes_total` and `deltas_emitted_total` frozen + `commands_issued_total` climbing to confirm the read-stall signature vs. a simple tmux-unresponsive wedge (cf. tc-gek). |

#### 3.7.3 Content plane

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `output_pretopology_dropped_bytes_total{provenance}` | `runtime/output-demux.ts` — accumulator per unknown pane; settled to `owned` on `notifyPaneBound` (the F4 symptom — bytes for a pane we own were thrown away) or `foreign` on `notifyPaneClosed` without a bind (legitimate under bind-on-provenance, tc-zna.9). | `provenance="owned"` **expected zero.** `provenance="foreign"` legitimate under bind-on-provenance. | `owned > 0` = the staging buffer cap (128 KiB) is too small for the actual bind delay; bytes for a pane we own are lost. Recapture-on-bind covers visible content but the stream is lossy. Replaces the previous `console.warn`-only diagnostic. | **Has alert wiring** — every `owned` increment is loud-logged to stderr by `session-proxy.ts`. tc-3si.5 expected-zero tripwire. |
| `flow_panes_paused` | `runtime/session-proxy.ts` — incremented on every fresh `%pause` (mirror set guards against duplicate notifications), decremented on `%continue`. Complement of `session_paused_seconds_total` (which measures *fraction* of session time paused). | Returns to 0 between firehoses. | Persistent non-zero with no firehose = a pane stuck gated (the "terminal went dead" symptom). | None — read-only diagnostic; balance against `flow_pane_pauses_total` / `flow_pane_resumes_total`. |
| `flow_pane_pauses_total` / `flow_pane_resumes_total` | Same site. | Balance over time (resumes == pauses in steady state). | Imbalance = paused panes leak. | None. |
| `flow_drain_clamped_total` | `runtime/flow-control.ts` `noteDrained` via the controller's metrics hooks (tc-d7i) — fires when the clamp-at-zero clipped (a drain credit exceeded the buffered total). | **Expected zero.** The clamp exists as a defensive guard, not a code path. | Any increment = an FC-1 accounting bug (double drain credit, drain for a dead pane) that the clamp would otherwise absorb into silent drift — the counter converts the absorbed bug into a witness. | **Has alert wiring** — every increment is loud-logged to stderr by `session-proxy.ts`. tc-d7i expected-zero tripwire. |
| `flow_bytes_while_paused_total` | `runtime/flow-control.ts` `onPaneBytes` via metrics hooks (tc-d7i) — bytes accounted while the pane was already paused. | Small bounded burst right after each pause edge: the FC-5 in-flight window (output tmux flushed before honoring `refresh-client -A pause`; observed as ~2730-byte chunks in tc-cbh). Roughly one socket flush per pause; zero between pauses. | **Sustained growth while a pane is paused** = tmux is not honoring the pause command (lost write, failed command, or a tmux version without pause support) — backpressure is then demux-gate-only and proxy memory grows with the firehose. Correlate with `flow_commands_failed_total{kind="pause"}`. | None — read-only diagnostic (expected non-zero in bursts; a rate alarm would need a per-pause baseline). |
| `flow_commands_failed_total{kind}` | `runtime/flow-control.ts` `_sendFlowCommand` via metrics hooks (tc-d7i) — a pause/continue `refresh-client -A` reply came back `%error`. Correlator rejections at session teardown are deliberately NOT counted. | **Expected zero** on both kinds. | `kind="continue"` = the worst UX failure in the flow plane: tmux keeps holding the pane's output — a **permanently frozen terminal** if no later resume succeeds, previously with no witness anywhere (the send was fire-and-forget). `kind="pause"` = the pane was never paused tmux-side; memory bounds degrade to demux-gating only. | **Has alert wiring** — every increment is loud-logged to stderr by `session-proxy.ts`. tc-d7i expected-zero tripwire. |
| `resyncs_total{cause}` | `runtime/serve.ts` `handleResyncRequest` — incremented on every received `resync.request`, classified as `gap` (fresh: previous resync from this client was > 30 s ago or never) or `escalation` (a second resync from the same client within 30 s — the previous snapshot did NOT heal the gap). | **In-process / in-memory transports: expected zero on both.** Production sockets: `gap` legitimate under packet loss; `escalation` **expected zero universally**. | `escalation > 0` = either the wire's sequence invariant is broken (the snapshot itself was corrupt) or the client's gap detector is misfiring. | **Has alert wiring** — every `escalation` increment is loud-logged to stderr by `serve.ts`. tc-3si.5 expected-zero tripwire. |
| `deltas_per_cycle` | `pipeline.ts` — observed at the SAME site as `deltas_emitted_total` (coalescer cycles, bootstrap, patch). Zero-delta samples ARE recorded (the no-change rate is itself diagnostic). | Small (1–5) in steady state; one large spike at bootstrap. | Steady large batches = diff instability (a flapping field producing spurious deltas). Alternating 0/N samples = a value that flaps on/off every cycle. | None — read-only diagnostic. |

#### 3.7.4 Session error boundary

| Metric | Where emitted | Expected shape | Deviation = what? | Alert wiring |
|---|---|---|---|---|
| `session_boundary_trips_total` | `session-proxy-supervisor.ts` `onFatalError` (tc-2x3.4) — incremented on `entry.sessionProxy.metrics` each time the pipeline's tokenizer / parser / reducer / `_dispatchEvent` stack throws an unhandled exception that the error boundary catches; the session is then torn down + lazily respawned. NOT counted on intentional reap (SIGTERM / `reapSessionProxy`) or on tmux-exit paths. | **Expected zero.** | Any increment = a parser/reducer bug surfaced at runtime and recycled the session. Steady-state non-zero = a reproducible parse path is corrupted (sessions recycle on every notification arrival). | **Has alert wiring** — every trip loud-logs to stderr with session attribution (tc-2x3.4). |
| `session_boundary_quarantined_total` | `session-proxy-supervisor.ts` circuit breaker (tc-m2y8) — incremented on `entry.sessionProxy.metrics` inside the `if (shouldQuarantine)` block when `CIRCUIT_BREAKER_TRIP_THRESHOLD` boundary trips fall within `CIRCUIT_BREAKER_WINDOW_MS`. The **companion** of `session_boundary_trips_total`: trips is the per-session accumulator, quarantined is the broker-level alarm. | **Expected zero.** | Any increment = N rapid boundary trips crossed the quarantine threshold and the session is now blocked (`ensureSessionProxy` rejects until `clearQuarantine`). The underlying parser/reducer bug must be fixed before re-enabling the session. | **Has alert wiring** — every quarantine loud-logs the `CIRCUIT BREAKER OPEN` line to stderr (tc-2x3.6 / tc-m2y8). |

## 4. Server-proxy registry

Emitted from `packages/server-proxy/src/metrics.ts`; surfaced via the
`server-proxy.info` debug command (the `metricsText` field of
`ServerProxyInfoPayload`). Same `collectDefaultMetrics` set as the
session-proxy.

| Metric | Where emitted | Expected shape | Deviation = what? |
|---|---|---|---|
| `server_proxy_commands_total{kind}` | `server-proxy.ts` per accepted command (`session.claim`, `session.create`, `session.destroy`, `server-proxy.info`, …). | Tracks client-side traffic to the server-proxy. | Sudden silence = no clients connecting; high rate of `session.create` = client retry loop. |
| `server_proxy_connections_total` / `server_proxy_connections_active` | Per IPC connection accept / close. | `active` should match the user's number of connected VS Code windows + any debug clients. | `active` growing without bound = connection leak (client not calling close). |
| `server_proxy_sessions_active` | Updated on session create / destroy. | Matches the user's session count. | Tracks lifecycle correctness — useful when correlating session leaks with idle timer behavior. |
| `rpc_round_trip_seconds{kind}` | `server-proxy.ts` `_handleCommand` — `Date.now()` at entry (just after `incCommand`) to a `finally` after the response is dispatched, so every exit path (success, unknown-command, error) records one sample. The **application leg** of the wire protocol (the whole handler await chain), labelled by command kind (the bounded `server_proxy_commands_total` vocabulary). | Read-only commands (`server-proxy.info`, `session.topology`) <1 ms; a healthy `session.claim` tens of ms; activation-heavy claims up to seconds when tmux is cold. | **Distinct from the tmux-leg `command_round_trip_seconds`** (session-proxy registry, which reads ~1 ms even mid-stall). A `session.claim` reading multi-second here while the tmux leg stays ~1 ms = the tc-jlyi activation stall: the time is in `ensureSessionProxy` / tmux spawn, not the south-side. The two numbers together localize the stall in one read. |
| `server_proxy_self_exit_total{reason}` | `server-proxy.ts` `_selfExit` — incremented at the start, before shutdown. `reason` ∈ {`idle`, `tmux-gone`} (`ServerProxySelfExitReason`). Promoted from the previously on-wire-only (`server-proxy.exiting`) / logged reason. | `idle` matches the user closing all clients (after the idle-exit hysteresis); `tmux-gone` matches a conclusive `tmux` death. | A `tmux-gone` self-exit with no corresponding user kill = an unexpected tmux server death; a high `idle` rate = clients churning connections (reconnect loop). Survives in `metricsText` so a sibling broker / a late `server-proxy.info` can read the cause. |
| `server_proxy_watcher_eof_total{verdict}` | `server-proxy.ts` `_onWatcherEof` — once per acted-on `-CC` watcher EOF, after the `probeTmuxLiveness` verdict (`alive` \| `inconclusive` \| `gone`). Placed after the shutdown-during-probe guard so a teardown mid-probe is not counted. | `gone` only on real tmux death (rare); `alive` = the watcher process itself died while tmux lives; `inconclusive` = the probe lost its budget under load. | A rising `inconclusive` rate = host under load (the `tmux ls` probe spawn keeps timing out) — the conservative never-self-exit-on-a-guess path is doing work. Frequent `alive` = the watcher keeps dying young (signal/OOM); pair with `server_proxy_watcher_respawns_total`. |
| `server_proxy_watcher_respawns_total` | `server-proxy.ts` `_scheduleWatcherRespawn` — incremented when the respawn timer fires and actually spawns a replacement watcher (not at schedule time — a broker that shuts down inside the backoff window never respawns). One event type, no label. | ~0 in steady state. | Steady non-zero = watcher churn (the watcher keeps EOFing and being replaced); correlate with `server_proxy_watcher_eof_total{verdict}` to attribute the cause (host load vs. watcher death). |
| `socketfeed_sendcontrol_queue_depth` | `socket-transport.ts` drain path (tc-edf8) — `+1` per send that hits `write()==false` and is enqueued onto the shared drain promise, `-n` when the `'drain'` event (or `close`) releases n waiting sends. **Aggregate** across every transport the broker owns (broker IPC socket + per-session client sockets). | **0 in steady state** — writes complete into the kernel send buffer synchronously. | A standing non-zero depth = the remote VS Code end is backpressured (consumer-limited). Bursty depth with short drains = concurrent backpressure windows (bursty writes). Distinguishes a slow producer from a backpressured consumer when read alongside `socketfeed_time_in_queue_seconds` and `nodejs_eventloop_lag_seconds`. |
| `socketfeed_time_in_queue_seconds` | Same drain path — observed once per enqueued send at the `'drain'` that releases it (the window-open → drain wall time). Unlabelled (aggregate). | Near-empty; sub-ms when it fires at all. | A fattening tail = the consumer can't drain fast enough — a **wedge precursor**. Surfaces the backpressure BEFORE `session_paused_seconds_total` grows (which only fires AFTER the flow controller has already paused tmux). The 5 s top bucket is the wedge-precursor threshold. |
| `nodejs_eventloop_lag_seconds` (default) | prom-client sampler. | p99 single-digit ms. The server-proxy is one process per machine post-tc-2x3 — its event-loop lag is the cross-cutting health signal for the whole tmuxcc supervisor. | Growth = something on the supervisor path is blocking (a `cpu` callback in a hook, an OS-level fork stall). |

## 5. Reading the metrics

In a live session: connect to the session-proxy's IPC socket and issue a
`session-proxy.info` command (the `metricsText` field carries the full
Prometheus text exposition). For the server-proxy, the equivalent is
`server-proxy.info` against the well-known `tmuxcc` socket.

The integration / e2e suites exercise `session-proxy.info` to verify the
exposition is well-formed and contains the expected metric families — see
the `integration.test.ts` / `e2e-smoke.test.ts` suites for the assertion
shape.

## 6. Adding rows to this table

When a new counter or histogram is added to either registry, **the row
goes here first** — the registry module's JSDoc references this doc as
the single source of truth for expected shapes. Both the metric's
implementation comment and this doc's row should say the same thing
about *why* the shape is what it is and *what* a deviation diagnoses;
divergence between the two means one of them is out of date.

Tripwire counters (the alarm side, tc-3si.5 and any successors) belong
in a separate **Tripwires** section that bead will introduce. The
distinction is: the rows above are **shapes to read** — observable
state-of-the-world; tripwires are **shapes the runtime reads itself and
acts on** — alarms.
