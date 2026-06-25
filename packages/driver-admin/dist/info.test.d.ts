/**
 * info.test.ts — Layer A unit coverage for the server-proxy command-correlation
 * helper (tc-44u4.3).
 *
 * `fetchServerProxyInfo` / `fetchSessionProxyInfo` open REAL unix sockets via
 * `@tmuxcc/server-proxy`, so they need a live driver to exercise end-to-end —
 * that belongs to an integration/e2e layer, not a unit test (there is no mock
 * driver socket).  What IS unit-testable without a live driver is the
 * request/response correlation contract, which `runServerProxyCommand` owns and
 * which an in-memory transport pair drives exactly: correlationId echo,
 * ok-payload extraction, `ok:false` error propagation, and transport-close
 * rejection.
 */
export {};
//# sourceMappingURL=info.test.d.ts.map