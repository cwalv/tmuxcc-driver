/**
 * socket-transport.mux.test.ts — tc-3y8.9 regression: exact-boundary demux of
 * the multiplexed control/data stream.
 *
 * # The bug (tc-3y8.9, root cause of the dead live-delta path)
 *
 * A single unix socket carries both planes:
 *   - data frames:    [0xCC][u32be SEQ][u32be PAYLEN][u16be IDLEN][PANEID][PAYLOAD]
 *   - control plane:  [u32be LEN][JSON + "\n"]   (LEN first byte is 0x00, never 0xCC)
 *
 * TCP/unix-socket reads do not respect write boundaries: one 'data' event can
 * contain [data frame][control message] (coalescing under load), and a single
 * data frame can SPAN two 'data' events (large frame or kernel chunking).
 *
 * The old `_processBuffer` had no exact frame-boundary tracking on the data
 * plane: on seeing a leading 0xCC it fed the ENTIRE buffer to FrameDecoder and
 * cleared `_buf`.  Two failure modes followed:
 *
 *   (A) [frame][control] coalesced in one chunk → FrameDecoder consumed the
 *       frames, then saw the control LEN prefix (0x00 ≠ 0xCC magic) and threw
 *       → transport closed with "data-plane framing error".  The control
 *       message (e.g. a pane.opened delta) was lost with the connection.
 *
 *   (B) A data frame split across two 'data' events → the continuation chunk's
 *       first byte is arbitrary terminal-output payload, not 0xCC → routed to
 *       the CONTROL branch → its first 4 bytes misread as a u32be JSON length
 *       (printable ASCII ⇒ ~540 MB) → `_buf.length < totalLen` forever →
 *       inbound processing SILENTLY stalled while the socket stayed open.
 *       Outbound sends kept working, so commands still reached tmux while
 *       every session-proxy→client delta vanished: exactly the tc-3y8.9 symptom
 *       (bootstrap snapshot delivered — it precedes data-plane traffic — but
 *       live pane.opened/closed deltas never arrive).
 *
 * These tests pin the fixed contract: the demux must track exact byte
 * boundaries for BOTH planes, deliver every message regardless of how the
 * stream is chunked or interleaved, and keep the transport open.
 *
 * @module socket-transport.mux.test
 */
export {};
//# sourceMappingURL=socket-transport.mux.test.d.ts.map