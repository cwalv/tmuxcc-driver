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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { encodeFrame, decodeFrame, FrameDecoder, FRAME_MAGIC } from "./framing.js";
import { paneId } from "./ids.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const P0 = paneId("p0");
const P1 = paneId("p1");

/** Feed bytes to a FrameDecoder one byte at a time. */
function feedByteByByte(dec: FrameDecoder, bytes: Uint8Array) {
  const frames = [];
  for (let i = 0; i < bytes.length; i++) {
    const result = dec.push(bytes.subarray(i, i + 1));
    frames.push(...result);
  }
  return frames;
}

/** Assert that two Uint8Arrays have identical content. */
function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, msg?: string): void {
  assert.strictEqual(
    actual.length,
    expected.length,
    `${msg ?? "byte arrays"}: length mismatch (actual=${actual.length}, expected=${expected.length})`,
  );
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(
      actual[i],
      expected[i],
      `${msg ?? "byte arrays"}: mismatch at index ${i}`,
    );
  }
}

// ---------------------------------------------------------------------------
// FRAME_MAGIC
// ---------------------------------------------------------------------------

describe("FRAME_MAGIC", () => {
  it("is 0xCC", () => {
    assert.strictEqual(FRAME_MAGIC, 0xcc);
  });
});

// ---------------------------------------------------------------------------
// encodeFrame / decodeFrame round-trips
// ---------------------------------------------------------------------------

describe("round-trip: typical ASCII payload", () => {
  it("preserves paneId, seq, and payload bytes", () => {
    const payload = new TextEncoder().encode("hello terminal\r\n");
    const frame = encodeFrame(P0, 1, payload);
    const decoded = decodeFrame(frame);

    assert.strictEqual(decoded.paneId as string, "p0");
    assert.strictEqual(decoded.seq, 1);
    assertBytesEqual(decoded.payload, payload, "payload");
  });
});

describe("round-trip: empty payload", () => {
  it("encodes and decodes a zero-length payload correctly", () => {
    const payload = new Uint8Array(0);
    const frame = encodeFrame(P1, 0, payload);
    const decoded = decodeFrame(frame);

    assert.strictEqual(decoded.paneId as string, "p1");
    assert.strictEqual(decoded.seq, 0);
    assert.strictEqual(decoded.payload.length, 0);
  });
});

describe("round-trip: arbitrary / non-UTF-8 bytes in payload", () => {
  it("round-trips the canonical non-UTF-8 acceptance payload byte-for-byte", () => {
    // Explicit bytes from the acceptance criterion: 0xff, 0x00, 0xfe, 0x80, 0x01
    const payload = Uint8Array.from([0xff, 0x00, 0xfe, 0x80, 0x01]);
    const frame = encodeFrame(P0, 42, payload);
    const decoded = decodeFrame(frame);

    assert.strictEqual(decoded.paneId as string, "p0");
    assert.strictEqual(decoded.seq, 42);
    assertBytesEqual(decoded.payload, payload, "non-UTF-8 payload");
  });

  it("round-trips all 256 possible byte values in a single payload", () => {
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;

    const frame = encodeFrame(P0, 7, payload);
    const decoded = decodeFrame(frame);

    assertBytesEqual(decoded.payload, payload, "all-bytes payload");
  });

  it("round-trips a larger random-looking buffer with mixed non-UTF-8 bytes", () => {
    // Build a 4 KB buffer with repeating non-UTF-8 pattern.
    const SIZE = 4096;
    const payload = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      // Alternate high bytes and null bytes — very hostile to string encoders.
      payload[i] = i % 2 === 0 ? 0xff - (i % 128) : 0x00;
    }

    const frame = encodeFrame(P0, 99, payload);
    const decoded = decodeFrame(frame);

    assert.strictEqual(decoded.payload.length, SIZE);
    assertBytesEqual(decoded.payload, payload, "large non-UTF-8 payload");
  });
});

describe("round-trip: high sequence number (uint32 boundary)", () => {
  it("handles seq=0xFFFFFFFF (uint32 max)", () => {
    const payload = new Uint8Array([0x01, 0x02]);
    const SEQ_MAX = 0xffffffff;
    const frame = encodeFrame(P0, SEQ_MAX, payload);
    const decoded = decodeFrame(frame);
    assert.strictEqual(decoded.seq, SEQ_MAX);
    assertBytesEqual(decoded.payload, payload);
  });
});

describe("round-trip: paneId with multi-byte UTF-8 characters", () => {
  it("encodes and decodes a paneId containing multi-byte codepoints", () => {
    // Use a paneId string that encodes to more than 1 byte per character in UTF-8.
    const id = paneId("pane-€-1"); // € is U+20AC, 3 bytes in UTF-8
    const payload = new Uint8Array([0xab, 0xcd]);
    const frame = encodeFrame(id, 3, payload);
    const decoded = decodeFrame(frame);

    assert.strictEqual(decoded.paneId as string, "pane-€-1");
    assert.strictEqual(decoded.seq, 3);
    assertBytesEqual(decoded.payload, payload);
  });
});

// ---------------------------------------------------------------------------
// Frame header layout — spot-check field offsets in the raw bytes
// ---------------------------------------------------------------------------

describe("frame header byte layout", () => {
  it("starts with magic byte 0xCC at offset 0", () => {
    const frame = encodeFrame(P0, 1, new Uint8Array([0x41]));
    assert.strictEqual(frame[0], 0xcc, "magic at offset 0");
  });

  it("encodes seq as uint32 big-endian at offsets 1–4", () => {
    const SEQ = 0x01020304;
    const frame = encodeFrame(P0, SEQ, new Uint8Array(0));
    const view = new DataView(frame.buffer);
    assert.strictEqual(view.getUint32(1, false), SEQ, "seq big-endian at offset 1");
  });

  it("encodes payLen as uint32 big-endian at offsets 5–8", () => {
    const payload = new Uint8Array(7);
    const frame = encodeFrame(P0, 0, payload);
    const view = new DataView(frame.buffer);
    assert.strictEqual(view.getUint32(5, false), 7, "payLen at offset 5");
  });

  it("encodes idLen as uint16 big-endian at offsets 9–10", () => {
    // "p0" encodes to 2 UTF-8 bytes.
    const frame = encodeFrame(P0, 0, new Uint8Array(0));
    const view = new DataView(frame.buffer);
    assert.strictEqual(view.getUint16(9, false), 2, "idLen at offset 9");
  });

  it("places paneId bytes starting at offset 11", () => {
    const frame = encodeFrame(P0, 0, new Uint8Array(0));
    // "p0" → [0x70, 0x30]
    assert.strictEqual(frame[11], 0x70, "paneId[0] at offset 11");
    assert.strictEqual(frame[12], 0x30, "paneId[1] at offset 12");
  });
});

// ---------------------------------------------------------------------------
// FrameDecoder — streaming
// ---------------------------------------------------------------------------

describe("FrameDecoder: basic round-trip", () => {
  it("decodes a single frame delivered in one chunk", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeFrame(P0, 10, payload);

    const dec = new FrameDecoder();
    const frames = dec.push(encoded);

    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0]!.paneId as string, "p0");
    assert.strictEqual(frames[0]!.seq, 10);
    assertBytesEqual(frames[0]!.payload, payload, "single-chunk payload");
  });
});

describe("FrameDecoder: byte-by-byte delivery", () => {
  it("reassembles a frame fed one byte at a time", () => {
    const payload = Uint8Array.from([0xff, 0x00, 0xfe, 0x80, 0x01]);
    const encoded = encodeFrame(P0, 5, payload);

    const dec = new FrameDecoder();
    const frames = feedByteByByte(dec, encoded);

    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0]!.seq, 5);
    assertBytesEqual(frames[0]!.payload, payload, "byte-by-byte payload");
  });

  it("reassembles multiple frames fed one byte at a time", () => {
    const p1 = Uint8Array.from([0x01, 0x02]);
    const p2 = Uint8Array.from([0xfe, 0xff]);
    const enc1 = encodeFrame(P0, 0, p1);
    const enc2 = encodeFrame(P1, 1, p2);
    const combined = new Uint8Array(enc1.length + enc2.length);
    combined.set(enc1, 0);
    combined.set(enc2, enc1.length);

    const dec = new FrameDecoder();
    const frames = feedByteByByte(dec, combined);

    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0]!.paneId as string, "p0");
    assert.strictEqual(frames[1]!.paneId as string, "p1");
    assertBytesEqual(frames[0]!.payload, p1, "frame 0 payload");
    assertBytesEqual(frames[1]!.payload, p2, "frame 1 payload");
  });
});

describe("FrameDecoder: awkward chunk splits", () => {
  it("handles a split in the middle of the fixed header", () => {
    const payload = new Uint8Array([0xab]);
    const encoded = encodeFrame(P0, 1, payload);

    // Split at byte 4 (inside SEQ field)
    const dec = new FrameDecoder();
    const part1 = dec.push(encoded.subarray(0, 4));
    const part2 = dec.push(encoded.subarray(4));

    assert.strictEqual(part1.length, 0, "no frames from partial header");
    assert.strictEqual(part2.length, 1, "one frame after rest of bytes");
    assertBytesEqual(part2[0]!.payload, payload, "split-at-4 payload");
  });

  it("handles a split between the paneId field and payload", () => {
    const payload = new Uint8Array([0xcc, 0xdd]); // 0xCC is also the magic byte — intentionally tricky
    const encoded = encodeFrame(P0, 2, payload);

    // "p0" is 2 bytes, so paneId ends at offset 11+2=13; split there.
    const dec = new FrameDecoder();
    const part1 = dec.push(encoded.subarray(0, 13));
    const part2 = dec.push(encoded.subarray(13));

    const frames = [...part1, ...part2];
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0]!.seq, 2);
    assertBytesEqual(frames[0]!.payload, payload, "split-at-id/payload boundary");
  });

  it("handles a split inside the payload", () => {
    const payload = new Uint8Array(20).fill(0xbb);
    const encoded = encodeFrame(P0, 3, payload);

    // Split halfway through the payload.
    const mid = Math.floor(encoded.length / 2);
    const dec = new FrameDecoder();
    const part1 = dec.push(encoded.subarray(0, mid));
    const part2 = dec.push(encoded.subarray(mid));

    const frames = [...part1, ...part2];
    assert.strictEqual(frames.length, 1);
    assertBytesEqual(frames[0]!.payload, payload, "split-in-payload");
  });

  it("handles the second frame arriving in many tiny chunks", () => {
    const p1 = new Uint8Array([0x01]);
    const p2 = new Uint8Array(10).fill(0xaa);
    const enc1 = encodeFrame(P0, 0, p1);
    const enc2 = encodeFrame(P1, 1, p2);

    // Deliver frame 1 all at once, frame 2 one byte at a time.
    const dec = new FrameDecoder();
    const first = dec.push(enc1);
    const rest = feedByteByByte(dec, enc2);

    assert.strictEqual(first.length, 1);
    assert.strictEqual(rest.length, 1);
    assert.strictEqual(first[0]!.paneId as string, "p0");
    assert.strictEqual(rest[0]!.paneId as string, "p1");
    assertBytesEqual(rest[0]!.payload, p2, "second frame tiny-chunk payload");
  });
});

describe("FrameDecoder: multiple frames in one chunk", () => {
  it("returns all frames when two complete frames arrive in a single push", () => {
    const frames_to_encode = [
      { id: P0, seq: 0, payload: new Uint8Array([0x01, 0x02]) },
      { id: P1, seq: 1, payload: new Uint8Array([0x03, 0x04, 0x05]) },
      { id: P0, seq: 2, payload: new Uint8Array([0xff]) },
    ];

    const parts = frames_to_encode.map((f) => encodeFrame(f.id, f.seq, f.payload));
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }

    const dec = new FrameDecoder();
    const decoded = dec.push(combined);

    assert.strictEqual(decoded.length, 3);
    assert.strictEqual(decoded[0]!.paneId as string, "p0");
    assert.strictEqual(decoded[0]!.seq, 0);
    assert.strictEqual(decoded[1]!.paneId as string, "p1");
    assert.strictEqual(decoded[1]!.seq, 1);
    assert.strictEqual(decoded[2]!.paneId as string, "p0");
    assert.strictEqual(decoded[2]!.seq, 2);
    assertBytesEqual(decoded[0]!.payload, frames_to_encode[0]!.payload);
    assertBytesEqual(decoded[1]!.payload, frames_to_encode[1]!.payload);
    assertBytesEqual(decoded[2]!.payload, frames_to_encode[2]!.payload);
  });
});

describe("FrameDecoder: empty chunk is a no-op", () => {
  it("returns no frames for an empty push", () => {
    const dec = new FrameDecoder();
    const result = dec.push(new Uint8Array(0));
    assert.strictEqual(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("decodeFrame: error on bad magic", () => {
  it("throws RangeError when the frame does not start with 0xCC", () => {
    const payload = new Uint8Array([0x01]);
    const frame = encodeFrame(P0, 0, payload);
    // Corrupt the magic byte.
    frame[0] = 0x00;

    assert.throws(() => decodeFrame(frame), RangeError);
  });
});

describe("decodeFrame: error on truncated buffer", () => {
  it("throws RangeError when the buffer is too short for the header", () => {
    assert.throws(() => decodeFrame(new Uint8Array(5)), RangeError);
  });

  it("throws RangeError when the buffer is too short for the declared payload", () => {
    const payload = new Uint8Array(100);
    const frame = encodeFrame(P0, 0, payload);
    // Truncate after the header.
    assert.throws(() => decodeFrame(frame.subarray(0, 15)), RangeError);
  });
});

describe("FrameDecoder: error on bad magic in stream", () => {
  it("throws RangeError when a frame in the stream has a bad magic byte", () => {
    const good = encodeFrame(P0, 0, new Uint8Array([1]));
    const bad = encodeFrame(P0, 1, new Uint8Array([2]));
    // Corrupt bad frame's magic.
    bad[0] = 0x00;

    const combined = new Uint8Array(good.length + bad.length);
    combined.set(good, 0);
    combined.set(bad, good.length);

    const dec = new FrameDecoder();
    // First push yields good frame fine.
    const first = dec.push(good);
    assert.strictEqual(first.length, 1);
    // Second push (the bad frame) should throw.
    assert.throws(() => dec.push(bad), RangeError);
  });
});

describe("encodeFrame: error on paneId too long", () => {
  it("throws RangeError when UTF-8 encoding of paneId exceeds 65535 bytes", () => {
    // 'a' repeated 65536 times — just over the uint16 limit.
    const longId = paneId("a".repeat(65536));
    assert.throws(() => encodeFrame(longId, 0, new Uint8Array(0)), RangeError);
  });
});
