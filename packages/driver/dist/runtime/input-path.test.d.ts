/**
 * Tests for the client→tmux input path (tc-kvk).
 *
 * Acceptance criteria:
 *   - Input wire messages produce correct `send-keys -H` on tmux stdin.
 *   - Resize maps to `refresh-client -C WxH`.
 *   - Id mapping: PaneId "p<N>" → tmux target %<N>.
 *   - Command.request messages map to the correct tmux serializer output.
 *   - Unknown / handshake messages are silently ignored (no throw).
 *
 * All tests use a FakeDeps that captures send() / sendBatch() calls — no real
 * tmux process (tc-3si.1).
 */
export {};
//# sourceMappingURL=input-path.test.d.ts.map