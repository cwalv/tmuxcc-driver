/**
 * Tests for the outbound tmux command serializer (tc-zb6).
 *
 * Acceptance criterion: "Emitted commands are valid tmux syntax;
 * send-keys -H encodes arbitrary bytes correctly."
 *
 * Test strategy:
 *   - Exact string assertions on all command functions.
 *   - Round-trip test for send-keys -H: parse hex tokens back to bytes and
 *     verify they match the original Uint8Array.
 *   - Edge cases: NUL byte, 0xFF, C0 control chars, 0x7F, multi-byte sequence.
 *   - Quoting: window name with a space → single-quoted in output.
 */
export {};
//# sourceMappingURL=commands.test.d.ts.map