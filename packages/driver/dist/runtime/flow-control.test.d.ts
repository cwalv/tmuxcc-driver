/**
 * Tests for flow-control coordinator (tc-1ho).
 *
 * Acceptance: Under a high-output flood, the session-proxy throttles via pause mode
 * without dropping or corrupting bytes.
 *
 * Strategy:
 *   - Use a fake `send` callback that captures issued commands (tc-3si.1).
 *   - Use a real createOutputDemux() with createInMemoryTransportPair() to
 *     assert client-side byte delivery is byte-exact.
 *   - Drive the controller directly (onPaneBytes / noteDrained /
 *     onPauseNotification / onContinueNotification) — no real tmux needed.
 *
 * @module runtime/flow-control.test
 */
export {};
//# sourceMappingURL=flow-control.test.d.ts.map