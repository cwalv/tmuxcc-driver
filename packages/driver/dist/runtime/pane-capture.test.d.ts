/**
 * tc-295a.11 (W3.3) — pane.capture driver tests.
 *
 * Tests the `captureText` helper (hydration.ts) and the full pane.capture
 * command path wired in session-proxy.ts.
 *
 * Coverage:
 *   1. captureText — live pane: returns { ok: true, text } containing the
 *      scrollback bytes decoded as UTF-8 (no LF→CRLF).
 *   2. captureText — pane not found (ok=false from pipeline): returns { ok: false }.
 *   3. captureText — pipeline rejects (host dead): returns { ok: false }.
 *   4. captureText — invalid PaneId format: returns { ok: false }.
 *   5. pane.capture command.request — live pane: command.response ok=true with text.
 *   6. pane.capture command.request — vanished pane (absent from model):
 *      command.response ok=false code="pane.not-found" (FAIL-LOUD).
 *   7. pane.capture command.request — pane closes mid-capture (pipeline ok=false):
 *      command.response ok=false code="pane.not-found" (FAIL-LOUD).
 *
 * Tests 1–4 are unit tests against captureText directly.
 * Tests 5–7 exercise the full session-proxy.ts addClient onControl path via
 * the createSessionProxy integration harness (fake TmuxHost).
 *
 * @module runtime/pane-capture.test
 */
export {};
//# sourceMappingURL=pane-capture.test.d.ts.map