/**
 * metrics-http.test.ts — unit tests for the `/metrics` (+ `/info`) HTTP
 * exposition's bind parsing and listener lifecycle (tc-44u4.4).
 *
 * No tmux required — drives the HTTP surface directly with a stub provider.
 *
 * Covers:
 *   - bind-spec parsing: the secure unix default, explicit `unix:/path`,
 *     loopback TCP, and the REFUSAL of a non-loopback TCP host;
 *   - the unix-socket bind is mode 0600 under the 0700 runtime-dir chain;
 *   - `/metrics` and `/info` render; unknown paths → 404; non-GET → 405;
 *   - close() unbinds and removes the managed unix socket file.
 *
 * @module metrics-http.test
 */
export {};
//# sourceMappingURL=metrics-http.test.d.ts.map