/**
 * Unit tests for the session-proxy metrics registry (tc-x6l).
 *
 * Verifies that counters increment correctly and that the text exposition
 * contains the expected metric names.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionProxyRegistry, classifyCommand } from "./registry.js";

describe("SessionProxyRegistry", () => {
  it("incTopologyEvent increments the counter and appears in text exposition", async () => {
    const reg = createSessionProxyRegistry();

    reg.incTopologyEvent("layout-change");
    reg.incTopologyEvent("layout-change");
    reg.incTopologyEvent("window-add");

    const text = await reg.metrics();
    assert.ok(
      text.includes("topology_events_total"),
      "text should contain topology_events_total",
    );
    // The Prometheus text for a counter with label kind="layout-change" value 2.
    assert.ok(
      text.includes('kind="layout-change"') && text.match(/kind="layout-change"\} 2/),
      `text should show layout-change=2; got:\n${text}`,
    );
    assert.ok(
      text.includes('kind="window-add"'),
      "text should contain window-add counter",
    );

    reg.stop();
  });

  it("undefined kind is recorded as 'unknown'", async () => {
    const reg = createSessionProxyRegistry();

    reg.incTopologyEvent(undefined);
    reg.incTopologyEvent(undefined);

    const text = await reg.metrics();
    assert.ok(
      text.includes('kind="unknown"'),
      "undefined kind should appear as 'unknown' label",
    );

    reg.stop();
  });

  it("incCommandsIssued increments counter", async () => {
    const reg = createSessionProxyRegistry();

    reg.incCommandsIssued();
    reg.incCommandsIssued();
    reg.incCommandsIssued();

    const text = await reg.metrics();
    assert.ok(
      text.includes("commands_issued_total"),
      "text should contain commands_issued_total",
    );
    assert.ok(
      text.match(/commands_issued_total \d+/),
      "commands_issued_total should have a numeric value",
    );

    reg.stop();
  });

  it("incDeltasFannedOut increments per-client counter", async () => {
    const reg = createSessionProxyRegistry();

    reg.incDeltasFannedOut("c1");
    reg.incDeltasFannedOut("c1");
    reg.incDeltasFannedOut("c2");

    const text = await reg.metrics();
    assert.ok(
      text.includes("deltas_fanned_out_total"),
      "text should contain deltas_fanned_out_total",
    );
    assert.ok(
      text.includes('client="c1"'),
      "text should contain c1 client label",
    );

    reg.stop();
  });

  it("observeCommandRoundTrip adds to histogram and labels by kind", async () => {
    const reg = createSessionProxyRegistry();

    reg.observeCommandRoundTrip(0.005, "list-windows"); // 5 ms
    reg.observeCommandRoundTrip(0.010, "list-panes"); // 10 ms
    reg.observeCommandRoundTrip(0.002, "list-windows"); // 2 ms — same kind, second bucket

    const text = await reg.metrics();
    assert.ok(
      text.includes("command_round_trip_seconds"),
      "text should contain command_round_trip_seconds histogram",
    );
    assert.ok(
      text.includes("command_round_trip_seconds_count"),
      "text should contain histogram count",
    );
    assert.ok(
      text.includes('kind="list-windows"'),
      "text should contain kind=list-windows label",
    );
    assert.ok(
      text.includes('kind="list-panes"'),
      "text should contain kind=list-panes label",
    );

    reg.stop();
  });

  it("observeNotifyToDelta records the edge label", async () => {
    const reg = createSessionProxyRegistry();

    reg.observeNotifyToDelta(0.002, "leading"); // 2 ms — leading mode
    reg.observeNotifyToDelta(0.95, "trailing"); // ~ceiling — trailing mode
    reg.observeNotifyToDelta(30, "heartbeat"); // way above modes — heartbeat

    const text = await reg.metrics();
    assert.ok(
      text.includes("topology_notify_to_delta_seconds"),
      "text should contain topology_notify_to_delta_seconds histogram",
    );
    assert.ok(
      text.includes('edge="leading"'),
      "text should contain edge=leading label",
    );
    assert.ok(
      text.includes('edge="trailing"'),
      "text should contain edge=trailing label",
    );
    assert.ok(
      text.includes('edge="heartbeat"'),
      "text should contain edge=heartbeat label",
    );

    reg.stop();
  });

  it("incDeltasEmitted increments the counter by the given amount", async () => {
    const reg = createSessionProxyRegistry();

    reg.incDeltasEmitted(3);
    reg.incDeltasEmitted(2);
    reg.incDeltasEmitted(0); // no-op
    reg.incDeltasEmitted(-1); // defensive no-op

    const text = await reg.metrics();
    assert.ok(
      text.includes("deltas_emitted_total"),
      "text should contain deltas_emitted_total",
    );
    assert.ok(
      text.match(/deltas_emitted_total 5/),
      `deltas_emitted_total should be 5; got:\n${text}`,
    );

    reg.stop();
  });

  it("incOutputBytes + observeOutputFrameSize: aggregate, no per-pane labels", async () => {
    const reg = createSessionProxyRegistry();

    reg.incOutputBytes(1024);
    reg.observeOutputFrameSize(1024);
    reg.incOutputBytes(64);
    reg.observeOutputFrameSize(64);

    const text = await reg.metrics();
    assert.ok(
      text.includes("output_bytes_total"),
      "text should contain output_bytes_total",
    );
    assert.ok(
      text.match(/output_bytes_total 1088/),
      `output_bytes_total should be 1088; got:\n${text}`,
    );
    assert.ok(
      text.includes("output_frame_size_bytes"),
      "text should contain output_frame_size_bytes histogram",
    );
    // No per-pane label — assert no pane="..." label is present on any of
    // these aggregate metrics.
    assert.ok(
      !/output_bytes_total\{[^}]*pane=/.test(text) &&
        !/output_frame_size_bytes\{[^}]*pane=/.test(text),
      "aggregate metrics must not carry a `pane` label (cardinality rule)",
    );

    reg.stop();
  });

  it("notePauseEntered/Exited refcount and accumulator are well-formed", async () => {
    const reg = createSessionProxyRegistry();

    // Two simultaneous pauses then two resumes: counter should accumulate
    // wall time spanning the entire interval (refcount-style), not double-
    // count overlapping intervals.
    reg.notePauseEntered();
    reg.notePauseEntered();
    // No real sleep — but the metric is on a real Date.now() clock; sample
    // exposition just to verify the metric exists. The unit tests for the
    // wall-time accounting are in the wiring layer, where the system
    // clock is the relevant thing being measured.
    reg.notePauseExited();
    reg.notePauseExited();
    // Spurious extra resume — must not under-flow the refcount.
    reg.notePauseExited();

    const text = await reg.metrics();
    assert.ok(
      text.includes("session_paused_seconds_total"),
      "text should contain session_paused_seconds_total",
    );

    reg.stop();
  });

  it("default metrics (event-loop lag, GC, heap) are present in exposition", async () => {
    const reg = createSessionProxyRegistry();

    // collectDefaultMetrics() is registered at factory time; the metrics
    // appear in the exposition immediately (prom-client emits the
    // registered metric definitions even before the first sample).
    const text = await reg.metrics();

    // Spot-check a few of the well-known default-metric names. prom-client
    // names are stable across versions for these (process_*, nodejs_*).
    assert.ok(
      text.includes("nodejs_eventloop_lag_seconds") ||
        text.includes("nodejs_eventloop_lag"),
      "default metrics should include eventloop lag (load-bearing for tc-2x3)",
    );
    assert.ok(
      text.includes("process_cpu_user_seconds_total") ||
        text.includes("process_cpu_seconds_total"),
      "default metrics should include process CPU",
    );
    assert.ok(
      text.includes("nodejs_heap_size_total_bytes") ||
        text.includes("nodejs_heap_size_used_bytes"),
      "default metrics should include heap size",
    );

    reg.stop();
  });

  it("classifyCommand: bounded vocabulary; unknown commands collapse to 'unknown'", () => {
    // Known kinds — round-trip exactly.
    assert.equal(classifyCommand("list-windows -a"), "list-windows");
    assert.equal(classifyCommand("list-panes -s -t =foo"), "list-panes");
    assert.equal(
      classifyCommand("set-option -g monitor-bell on"),
      "set-option",
    );
    assert.equal(
      classifyCommand("refresh-client -A '%1:pause'"),
      "refresh-client",
    );
    assert.equal(classifyCommand("send-keys -t %1 hello"), "send-keys");
    assert.equal(
      classifyCommand("attach-session -t mysession"),
      "attach-session",
    );
    assert.equal(classifyCommand("kill-pane -t %1"), "kill-pane");

    // Unknown kinds — collapsed to "unknown" (cardinality rule).
    assert.equal(classifyCommand("display-message foo"), "unknown");
    assert.equal(classifyCommand("source-file ~/.tmux.conf"), "unknown");

    // Edge cases.
    assert.equal(classifyCommand(""), "unknown");
    assert.equal(classifyCommand("   "), "unknown");
    // Leading whitespace is tolerated.
    assert.equal(classifyCommand("  list-windows -a"), "list-windows");
    // A trailing newline doesn't bleed into the kind.
    assert.equal(classifyCommand("list-windows\n"), "list-windows");
  });

  // ---- tc-3si.5: premise-watching + tripwire counters --------------------

  it("incRequeryCycle records per-trigger attribution", async () => {
    const reg = createSessionProxyRegistry();

    reg.incRequeryCycle("leading");
    reg.incRequeryCycle("leading");
    reg.incRequeryCycle("leading");
    reg.incRequeryCycle("trailing");
    reg.incRequeryCycle("heartbeat");
    reg.incRequeryCycle("bootstrap");

    const text = await reg.metrics();
    assert.ok(text.includes("requery_cycles_total"));
    assert.ok(
      text.match(/trigger="leading"\} 3/),
      `leading should be 3; got:\n${text}`,
    );
    assert.ok(text.includes('trigger="trailing"'));
    assert.ok(text.includes('trigger="heartbeat"'));
    assert.ok(text.includes('trigger="bootstrap"'));

    reg.stop();
  });

  it("incRequeryHeartbeatChange increments the expected-zero tripwire", async () => {
    const reg = createSessionProxyRegistry();

    // Caller passes the delta count for the log line, but the counter just
    // increments by 1 per incident.
    reg.incRequeryHeartbeatChange(2);
    reg.incRequeryHeartbeatChange(5);

    const text = await reg.metrics();
    assert.ok(text.includes("requery_heartbeat_changes_total"));
    assert.ok(
      text.match(/requery_heartbeat_changes_total 2/),
      `expected 2 heartbeat-change incidents; got:\n${text}`,
    );

    reg.stop();
  });

  it("observeRequeryRoundTrip records a unimodal-shaped histogram (no labels)", async () => {
    const reg = createSessionProxyRegistry();

    reg.observeRequeryRoundTrip(0.0008); // 0.8 ms — the expected mode
    reg.observeRequeryRoundTrip(0.0011); // 1.1 ms
    reg.observeRequeryRoundTrip(0.0014); // 1.4 ms

    const text = await reg.metrics();
    assert.ok(text.includes("requery_round_trip_seconds"));
    assert.ok(text.includes("requery_round_trip_seconds_count"));
    // No `kind` or other label allowed — it is unlabelled by design.
    assert.ok(
      !/requery_round_trip_seconds_count\{[^}]*kind=/.test(text),
      "requery_round_trip_seconds must be unlabelled (cardinality rule)",
    );

    reg.stop();
  });

  it("incRequeryBudgetExhausted + incRequeryFailedCycle: distinct counter surfaces", async () => {
    const reg = createSessionProxyRegistry();

    // Exhaustion path: both counters bump (the engine wires them together).
    reg.incRequeryBudgetExhausted();
    reg.incRequeryFailedCycle("budget");
    // Error path: only the failed-cycle counter bumps.
    reg.incRequeryFailedCycle("error");
    reg.incRequeryFailedCycle("error");

    const text = await reg.metrics();
    assert.ok(text.includes("requery_budget_exhausted_total"));
    assert.ok(text.match(/requery_budget_exhausted_total 1/));
    assert.ok(text.includes('reason="budget"'));
    assert.ok(text.includes('reason="error"'));
    assert.ok(text.match(/reason="error"\} 2/));

    reg.stop();
  });

  it("incCorrelatorUnsolicitedBlock is an expected-zero tripwire (counts on increment only)", async () => {
    const reg = createSessionProxyRegistry();

    reg.incCorrelatorUnsolicitedBlock();
    reg.incCorrelatorUnsolicitedBlock();

    const text = await reg.metrics();
    assert.ok(text.includes("correlator_unsolicited_blocks_total"));
    assert.ok(text.match(/correlator_unsolicited_blocks_total 2/));

    reg.stop();
  });

  it("setCorrelatorPending writes both gauges atomically", async () => {
    const reg = createSessionProxyRegistry();

    reg.setCorrelatorPending(0, 0); // initial / empty state
    let text = await reg.metrics();
    assert.ok(text.includes("correlator_pending_slots 0"));
    assert.ok(text.includes("correlator_pending_slot_max_age_seconds 0"));

    reg.setCorrelatorPending(3, 0.42);
    text = await reg.metrics();
    assert.ok(text.includes("correlator_pending_slots 3"));
    assert.ok(text.match(/correlator_pending_slot_max_age_seconds 0\.42/));

    reg.stop();
  });

  it("incPretopologyDroppedBytes records bytes by provenance (the F4 tripwire)", async () => {
    const reg = createSessionProxyRegistry();

    // The F4 symptom: bytes for a pane WE OWN were dropped.
    reg.incPretopologyDroppedBytes(1024, "owned");
    reg.incPretopologyDroppedBytes(512, "owned");
    // Legitimate foreign-pane drops.
    reg.incPretopologyDroppedBytes(8192, "foreign");
    // Defensive: zero / negative are no-ops.
    reg.incPretopologyDroppedBytes(0, "owned");
    reg.incPretopologyDroppedBytes(-1, "foreign");

    const text = await reg.metrics();
    assert.ok(text.includes("output_pretopology_dropped_bytes_total"));
    assert.ok(
      text.match(/provenance="owned"\} 1536/),
      `owned should be 1536; got:\n${text}`,
    );
    assert.ok(
      text.match(/provenance="foreign"\} 8192/),
      `foreign should be 8192; got:\n${text}`,
    );

    reg.stop();
  });

  it("notePanePauseEntered/Exited drives gauge + totals; totals balance over time", async () => {
    const reg = createSessionProxyRegistry();

    reg.notePanePauseEntered();
    reg.notePanePauseEntered();
    let text = await reg.metrics();
    assert.ok(text.includes("flow_panes_paused 2"));

    reg.notePanePauseExited();
    text = await reg.metrics();
    assert.ok(text.includes("flow_panes_paused 1"));

    reg.notePanePauseExited();
    text = await reg.metrics();
    assert.ok(text.includes("flow_panes_paused 0"));
    assert.ok(text.match(/flow_pane_pauses_total 2/));
    assert.ok(text.match(/flow_pane_resumes_total 2/));

    reg.stop();
  });

  it("incResync attributes by cause; escalation is the expected-zero tripwire", async () => {
    const reg = createSessionProxyRegistry();

    reg.incResync("gap");
    reg.incResync("gap");
    reg.incResync("escalation");

    const text = await reg.metrics();
    assert.ok(text.includes("resyncs_total"));
    assert.ok(text.match(/cause="gap"\} 2/));
    assert.ok(text.match(/cause="escalation"\} 1/));

    reg.stop();
  });

  it("observeDeltasPerCycle: zero-delta cycles are observed (the no-change rate)", async () => {
    const reg = createSessionProxyRegistry();

    reg.observeDeltasPerCycle(0); // heartbeat no-op
    reg.observeDeltasPerCycle(0);
    reg.observeDeltasPerCycle(3); // typical steady state
    reg.observeDeltasPerCycle(150); // bootstrap-ish spike
    reg.observeDeltasPerCycle(-1); // defensive no-op

    const text = await reg.metrics();
    assert.ok(text.includes("deltas_per_cycle"));
    assert.ok(text.includes("deltas_per_cycle_count"));
    // 4 observations landed (the -1 was dropped); the count should reflect that.
    assert.ok(
      text.match(/deltas_per_cycle_count 4/),
      `expected 4 observations after one defensive no-op; got:\n${text}`,
    );

    reg.stop();
  });

  it("multiple registries are isolated (no cross-contamination)", async () => {
    const reg1 = createSessionProxyRegistry();
    const reg2 = createSessionProxyRegistry();

    reg1.incTopologyEvent("layout-change");
    reg1.incTopologyEvent("layout-change");
    // reg2 gets no increments.

    const text1 = await reg1.metrics();
    const text2 = await reg2.metrics();

    // reg1 has layout-change=2.
    assert.ok(
      text1.match(/kind="layout-change"\} 2/),
      "reg1 should have layout-change=2",
    );
    // reg2 should NOT show layout-change (no observations).
    // prom-client omits counters with 0 value unless explicitly initialised.
    // Either way, reg2 must not have count 2.
    assert.ok(
      !text2.match(/kind="layout-change"\} 2/),
      "reg2 should not be contaminated by reg1",
    );

    reg1.stop();
    reg2.stop();
  });
});
