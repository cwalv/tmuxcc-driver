/**
 * Tests for the runtime pipeline — tc-128.4 (replaces tc-4fo).
 *
 * The per-event reducer + BootstrapCoordinator were retired in tc-128.4; the
 * topology pipeline is now the requery-driven engine + coalescer. These tests
 * exercise the new pipeline as a BLACK BOX: feed bootstrap-shape list-* reply
 * blocks plus notifications, observe the model and onModelChange signal.
 *
 * # tc-3y8 disposition (recorded in close comment)
 *
 *   - Golden capture replay (tc-4fo's Suite 1, Suite 2, Suite 5, Suite 6
 *     under the previous design) — DELETED. The golden capture was assembled
 *     by the per-event reducer interpreting %session-changed / %window-add /
 *     %layout-change to BUILD the model; with the model now sourced from
 *     `list-*` replies (which the golden capture doesn't carry in
 *     BOOTSTRAP_* format), those tests encoded reducer-internal mechanics
 *     and cannot pass as black-box tests of the new pipeline.
 *   - tc-fx4/tc-3y8.9 "%window-add reconcile injects window name + layout"
 *     — DELETED. The new pipeline does NOT issue a targeted list-windows
 *     reconcile in response to %window-add; the coalescer fires a full
 *     session-scoped requery instead. The bug class is structurally
 *     impossible (the engine never trusts event content) so the test no
 *     longer has a thing to assert.
 *   - "%unlinked-window-add is ignored" — RE-PLUMBED below as a session-
 *     scoped requery assertion. With `sessionName` set, the engine's list-*
 *     commands are targeted `-t =<name>` and the unlinked window naturally
 *     never appears.
 *   - "bootstrap notifications buffered and replayed" / "live notifications
 *     after bootstrap" — RE-PLUMBED below: post-bootstrap notifications
 *     fire a requery; the test feeds updated list-* replies and asserts the
 *     resulting delta.
 *
 * @module runtime/pipeline.test
 */
export {};
//# sourceMappingURL=pipeline.test.d.ts.map