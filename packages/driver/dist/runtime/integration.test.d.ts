/**
 * SessionProxy integration test — full runtime end-to-end (tc-93a).
 *
 * Covers the E4 acceptance: drive the full assembled session-proxy and assert
 * wire output (snapshot/deltas/frames), input round-trip, resize, and
 * flow control.
 *
 * # Harness split
 *
 * ## Fake-tmux harness (deterministic, always runs)
 *
 * Uses a ScriptedHost that wraps fake-tmux.js (a hermetic fixture that emits
 * canned tmux -CC control-mode bytes in response to stdin commands) together
 * with the buildBootstrapStream helper from pipeline.test to drive the full
 * pipeline end-to-end without real tmux.  This covers:
 *
 *   T1. Snapshot on connect         — client receives SnapshotMessage (seq=1)
 *                                     with sessions/windows/panes populated.
 *   T2. Deltas on activity          — driving a %layout-change notification
 *                                     produces a delta with the right seq.
 *   T3. %output → data frames       — pane bytes reach the client data-plane
 *                                     byte-exact, tagged with the right PaneId.
 *   T4. Input round-trip            — client InputMessage → host.write() carries
 *                                     the expected send-keys -H command.
 *   T5. Resize                      — client ResizeRequestMessage → host.write()
 *                                     carries refresh-client -C WxH.
 *   T6. Flow control                — high-output flood triggers pause; drain
 *                                     triggers resume; no bytes are dropped.
 *
 * ## Real-tmux harness (guarded smoke test, skipped if tmux absent)
 *
 * Uses createTmuxHost (real tmux 3.4 via the PTY bridge) + the full
 * createSessionProxy assembly.  Verifies:
 *
 *   R1. Snapshot on connect (real session: 1 window, 1 pane minimum).
 *   R2. Some pane output arrives on the client data plane (echo round-trip).
 *   R3. Clean teardown (no leaked tmux servers).
 *
 * Each real-tmux test uses a unique `-L <socket>` to prevent cross-test
 * interference.  `after()` always issues `tmux -L <socket> kill-server`.
 *
 * @module runtime/integration.test
 */
export {};
//# sourceMappingURL=integration.test.d.ts.map