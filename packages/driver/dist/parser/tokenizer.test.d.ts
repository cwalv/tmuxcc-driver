/**
 * Tests for the tmux -CC control-mode line tokenizer (tc-ckw).
 *
 * Coverage:
 *   - Simple notification line → one `notification` token.
 *   - Full command block: %begin … body lines … %end → correct token sequence.
 *   - %error variant → block-error token.
 *   - Body line starting with `%` inside a block → block-body, NOT notification.
 *   - DCS wrapper (\x1bP1000p … \x1b\) → stripped, inner tokens correct.
 *   - Streaming: identical token sequence when fed byte-by-byte and at awkward offsets.
 *   - Non-UTF-8 bytes in block-body → preserved as raw bytes.
 *   - Non-UTF-8 bytes in %output payload (rawLine) → preserved.
 *   - \r\n line endings handled (CR stripped).
 *   - Multiple notifications in sequence.
 *   - Nested/sequential blocks.
 *   - DCS open/close tokens.
 *   - Bare lines (no DCS wrapper) parse correctly.
 *   - Guard field parsing: timestamp, commandNumber, flags.
 *   - Empty body block.
 *   - Malformed guard line fallback.
 *   - Block-aware ST suppression (tc-44u4): raw ESC `\` (and other ST-bearing
 *     escapes) inside a %begin…%end body stay opaque and never close the DCS;
 *     real top-level closing ST still recognised; chunk-boundary resumability.
 */
export {};
//# sourceMappingURL=tokenizer.test.d.ts.map