/**
 * Tests for the %output octal byte codec (tc-8yz).
 *
 * Acceptance criteria:
 *   - All 256 byte values 0x00–0xFF round-trip (encode→decode == original).
 *   - Embedded backslash (0x5C / \134) handled correctly.
 *   - Control chars, NUL, DEL, and non-UTF-8 bytes (e.g. 0xFF) survive as raw bytes.
 *   - Fuzz test: many pseudo-random Uint8Array buffers round-trip byte-identical.
 *   - Realistic %output line decodes correctly.
 *   - parseOutputNotification: paneId extracted, payload decoded.
 */
export {};
//# sourceMappingURL=output-codec.test.d.ts.map