/**
 * Unit tests for the session-proxy metrics registry (tc-x6l).
 *
 * Verifies that counters increment correctly and that the text exposition
 * contains the expected metric names.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionProxyRegistry } from "./registry.js";

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

  it("observeCommandRoundTrip adds to histogram", async () => {
    const reg = createSessionProxyRegistry();

    reg.observeCommandRoundTrip(0.005); // 5 ms
    reg.observeCommandRoundTrip(0.010); // 10 ms

    const text = await reg.metrics();
    assert.ok(
      text.includes("command_round_trip_seconds"),
      "text should contain command_round_trip_seconds histogram",
    );
    assert.ok(
      text.includes("command_round_trip_seconds_count"),
      "text should contain histogram count",
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
