/**
 * Unit tests for the server-proxy metrics registry.
 *
 * Verifies that the registry's counters / gauges / histograms increment and
 * observe correctly and that the text exposition (the `metricsText` field of
 * the `server-proxy.info` payload) contains the expected metric families.
 *
 * Covers the tc-mbu3 driver-observability additions:
 *   - tc-bn7d: rpc_round_trip_seconds{kind}
 *   - tc-m2y8: server_proxy_self_exit_total{reason},
 *              server_proxy_watcher_eof_total{verdict},
 *              server_proxy_watcher_respawns_total
 *   - tc-edf8: socketfeed_sendcontrol_queue_depth,
 *              socketfeed_time_in_queue_seconds
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServerProxyMetrics } from "./metrics.js";

describe("ServerProxyMetrics", () => {
  it("incCommand increments the per-kind counter and appears in exposition", async () => {
    const m = createServerProxyMetrics();

    m.incCommand("session.claim");
    m.incCommand("session.claim");
    m.incCommand("server-proxy.info");

    const text = await m.metricsText();
    assert.ok(text.includes("server_proxy_commands_total"));
    assert.ok(
      text.match(/kind="session\.claim"\} 2/),
      `session.claim should be 2; got:\n${text}`,
    );
    assert.ok(text.includes('kind="server-proxy.info"'));

    m.stop();
  });

  // ---- tc-bn7d: rpc_round_trip_seconds{kind} -----------------------------

  it("observeRpcRoundTrip records the application-leg histogram, by kind (tc-bn7d)", async () => {
    const m = createServerProxyMetrics();

    // A fast read-only command and a slow activation stall — the two ends of
    // the bucket layout. The slow sample is exactly the tc-jlyi smoking gun:
    // the application leg reads seconds while the tmux leg would read ~1 ms.
    m.observeRpcRoundTrip(0.0008, "server-proxy.info"); // 0.8 ms read-only
    m.observeRpcRoundTrip(6.7, "session.claim"); // 6.7 s activation stall
    m.observeRpcRoundTrip(0.05, "session.claim"); // 50 ms healthy claim

    const text = await m.metricsText();
    assert.ok(
      text.includes("rpc_round_trip_seconds"),
      "text should contain rpc_round_trip_seconds histogram",
    );
    assert.ok(
      text.includes("rpc_round_trip_seconds_count"),
      "text should contain histogram count",
    );
    assert.ok(
      text.includes('kind="session.claim"'),
      "text should contain kind=session.claim label",
    );
    assert.ok(
      text.includes('kind="server-proxy.info"'),
      "text should contain kind=server-proxy.info label",
    );
    // Two session.claim observations landed on that kind's count.
    assert.ok(
      text.match(/rpc_round_trip_seconds_count\{kind="session\.claim"\} 2/),
      `session.claim count should be 2; got:\n${text}`,
    );
    // The 6.7 s sample lands in the +Inf bucket but not in the 5 s bucket — the
    // multi-second activation stall is captured, not clipped.
    assert.ok(
      text.match(/rpc_round_trip_seconds_bucket\{le="5",kind="session\.claim"\} 1/),
      `only the 50 ms sample should be <=5 s; got:\n${text}`,
    );

    m.stop();
  });

  // ---- tc-m2y8: broker lifecycle counters --------------------------------

  it("incSelfExit attributes the designed self-exit by reason (tc-m2y8)", async () => {
    const m = createServerProxyMetrics();

    m.incSelfExit("idle");
    m.incSelfExit("tmux-gone");
    m.incSelfExit("idle");

    const text = await m.metricsText();
    assert.ok(text.includes("server_proxy_self_exit_total"));
    assert.ok(
      text.match(/server_proxy_self_exit_total\{reason="idle"\} 2/),
      `idle self-exits should be 2; got:\n${text}`,
    );
    assert.ok(
      text.match(/server_proxy_self_exit_total\{reason="tmux-gone"\} 1/),
      `tmux-gone self-exits should be 1; got:\n${text}`,
    );

    m.stop();
  });

  it("incWatcherEof attributes each EOF by probe verdict (tc-m2y8)", async () => {
    const m = createServerProxyMetrics();

    m.incWatcherEof("alive");
    m.incWatcherEof("inconclusive");
    m.incWatcherEof("inconclusive");
    m.incWatcherEof("gone");

    const text = await m.metricsText();
    assert.ok(text.includes("server_proxy_watcher_eof_total"));
    assert.ok(text.match(/verdict="alive"\} 1/));
    assert.ok(text.match(/verdict="inconclusive"\} 2/));
    assert.ok(text.match(/verdict="gone"\} 1/));

    m.stop();
  });

  it("incWatcherRespawn counts respawns (no label) (tc-m2y8)", async () => {
    const m = createServerProxyMetrics();

    m.incWatcherRespawn();
    m.incWatcherRespawn();
    m.incWatcherRespawn();

    const text = await m.metricsText();
    assert.ok(
      text.match(/server_proxy_watcher_respawns_total 3/),
      `respawns should be 3; got:\n${text}`,
    );
    // No label on this counter (one event type).
    assert.ok(
      !/server_proxy_watcher_respawns_total\{/.test(text),
      "watcher respawns counter must be unlabelled",
    );

    m.stop();
  });

  // ---- tc-edf8: socketfeed backpressure ----------------------------------

  it("addSocketFeedQueueDepth aggregates and returns to zero (tc-edf8)", async () => {
    const m = createServerProxyMetrics();

    // Two concurrent backpressured senders, then a drain resolves both.
    m.addSocketFeedQueueDepth(1);
    m.addSocketFeedQueueDepth(1);
    let text = await m.metricsText();
    assert.ok(
      text.match(/socketfeed_sendcontrol_queue_depth 2/),
      `queue depth should be 2 while backpressured; got:\n${text}`,
    );

    // Drain resolves both waiters: gauge returns to 0.
    m.addSocketFeedQueueDepth(-2);
    text = await m.metricsText();
    assert.ok(
      text.match(/socketfeed_sendcontrol_queue_depth 0/),
      `queue depth should return to 0 after drain; got:\n${text}`,
    );
    // A zero delta is a no-op (no throw, no change).
    m.addSocketFeedQueueDepth(0);

    m.stop();
  });

  it("observeSocketFeedTimeInQueue records the per-send wait histogram (tc-edf8)", async () => {
    const m = createServerProxyMetrics();

    m.observeSocketFeedTimeInQueue(0.002); // 2 ms — typical
    m.observeSocketFeedTimeInQueue(0.002);
    m.observeSocketFeedTimeInQueue(1.5); // 1.5 s — a wedge precursor

    const text = await m.metricsText();
    assert.ok(text.includes("socketfeed_time_in_queue_seconds"));
    assert.ok(text.includes("socketfeed_time_in_queue_seconds_count"));
    assert.ok(
      text.match(/socketfeed_time_in_queue_seconds_count 3/),
      `should have 3 observations; got:\n${text}`,
    );
    // No labels (aggregate across all transports).
    assert.ok(
      !/socketfeed_time_in_queue_seconds_count\{/.test(text),
      "time-in-queue histogram must be unlabelled (aggregate)",
    );

    m.stop();
  });

  it("default metrics (event-loop lag, CPU, heap) are present (tc-3si.6)", async () => {
    const m = createServerProxyMetrics();

    const text = await m.metricsText();
    assert.ok(
      text.includes("nodejs_eventloop_lag_seconds") ||
        text.includes("nodejs_eventloop_lag"),
      "default metrics should include eventloop lag",
    );
    assert.ok(
      text.includes("process_cpu_user_seconds_total") ||
        text.includes("process_cpu_seconds_total"),
      "default metrics should include process CPU",
    );

    m.stop();
  });

  it("multiple registries are isolated (no cross-contamination)", async () => {
    const m1 = createServerProxyMetrics();
    const m2 = createServerProxyMetrics();

    m1.incWatcherRespawn();
    m1.incWatcherRespawn();

    const t1 = await m1.metricsText();
    const t2 = await m2.metricsText();
    assert.ok(t1.match(/server_proxy_watcher_respawns_total 2/));
    assert.ok(!t2.match(/server_proxy_watcher_respawns_total 2/));

    m1.stop();
    m2.stop();
  });
});
