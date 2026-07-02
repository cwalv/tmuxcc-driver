/**
 * metrics-http.integration.test.ts — end-to-end tests for the server-proxy's
 * `/metrics` (+ `/info`) HTTP exposition and its THREE enablement paths
 * (tc-44u4.4):
 *
 *   M0. OFF by default — no listener bound, no metrics-http.sock on disk.
 *   M1. Startup flag/env (`metricsAddr` option, fed by --metrics-addr /
 *       TMUXCC_METRICS_ADDR) binds a unix listener; /metrics returns prom text.
 *   M2. Runtime wire toggle (`server-proxy.set-metrics-http`) binds, then
 *       unbinds — the PRIMARY no-restart path — and the off path removes the
 *       socket file.
 *   M3. SIGUSR2 (`toggleMetricsHttp`) binds the secure unix default, toggles
 *       off again.
 *   M4. Security: the unix socket is mode 0600; a non-loopback TCP bind is
 *       refused (result.ok=false), a loopback TCP bind is accepted.
 *   M5. With a live session (tmux), /metrics includes a session-registry
 *       metric namespaced by session="<id>".
 *
 * The wire toggle is driven by a hand-rolled client (per the scope boundary —
 * we do NOT depend on the tc-44u4.3 introspection lib).
 *
 * @module metrics-http.integration.test
 */
export {};
//# sourceMappingURL=metrics-http.integration.test.d.ts.map