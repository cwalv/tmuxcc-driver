/**
 * Tests for data-plane binary frame format (tc-2mq).
 *
 * Coverage:
 *   - Round-trip: encodeFrame → decodeFrame for typical payloads.
 *   - Arbitrary / non-UTF-8 bytes in payload (the explicit acceptance criterion).
 *   - Empty payload.
 *   - Large payload.
 *   - Streaming / partial delivery via FrameDecoder.
 *     - Byte-by-byte feeding.
 *     - Feeding at awkward mid-header and mid-payload offsets.
 *   - Multiple concatenated frames in a single chunk.
 *   - Magic-byte mismatch detection.
 *   - FRAME_MAGIC constant value.
 *   - paneId with multi-byte UTF-8 characters (IDLEN field).
 */
export {};
//# sourceMappingURL=framing.test.d.ts.map