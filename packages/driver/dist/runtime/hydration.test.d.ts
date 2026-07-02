/**
 * tc-5quo — clear-then-replay hydration tests.
 *
 * Coverage:
 *
 *   (A) `lfToCrlf` byte-level: LF→CRLF, CRLF preserved, lone CR preserved,
 *       no-LF source returned unchanged, empty source.
 *
 *   (B) `hydrateTransport` unit-level (with a fake pipeline + fake
 *       transport):
 *         1. Each pane in the input gets ONE sendData with
 *            CLEAR_AND_SCROLLBACK prefix + capture body (LF→CRLF).
 *         2. Order: clear-prefix bytes precede the replayed body in the
 *            SAME sendData call (single combined frame).
 *         3. Multiple panes → multiple sendData calls, one per pane.
 *         4. `pipeline.send` is invoked twice per pane: the canonical
 *            capture-pane command, then the display-message grid-facts read
 *            (tc-w3ir.2 structured reconstruction).
 *         5. Per-pane error (rejected Promise / ok=false reply) is
 *            swallowed; sibling panes still hydrate.
 *         6. Empty pane list → no sendData calls, no pipeline.send calls.
 *
 *   (C) `hydrateTransport` invariants the bead pins:
 *         I1. Pre-existing buffer content is wiped (CLEAR escape sent),
 *             so any pre-disconnect terminal content cannot duplicate
 *             after hydration.
 *         I2. The replayed body matches the capture body byte-for-byte
 *             after LF→CRLF.  Output produced during disconnection lives
 *             in tmux's history and reaches the client via the replay.
 *
 *   (D) Integration: drive the full assembly's `addClient` against a fake
 *       host, verifying that after addClient resolves and the hydration
 *       fires, the recording transport observes (clear + replay) bytes
 *       for the bootstrapped pane.
 *
 * @module runtime/hydration.test
 */
export {};
//# sourceMappingURL=hydration.test.d.ts.map