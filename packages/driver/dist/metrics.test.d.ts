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
export {};
//# sourceMappingURL=metrics.test.d.ts.map