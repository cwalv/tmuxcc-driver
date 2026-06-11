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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodeOutputPayload,
  encodeOutputPayload,
  parseOutputNotification,
} from "./output-codec.js";

import type { NotificationToken } from "./tokenizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a JS string as raw ASCII bytes (for constructing test payloads). */
function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Build a NotificationToken with the given rawLine (as ASCII string). */
function notifToken(keyword: string, rawLine: Uint8Array): NotificationToken {
  return { kind: "notification", keyword, rawLine };
}

// ---------------------------------------------------------------------------
// 1. All 256 byte values round-trip
// ---------------------------------------------------------------------------

describe("all 256 byte values round-trip", () => {
  it("encode→decode preserves every byte 0x00–0xFF", () => {
    const all256 = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all256[i] = i;

    const encoded = encodeOutputPayload(all256);
    const decoded = decodeOutputPayload(encoded);

    assert.strictEqual(decoded.length, 256, "decoded length should be 256");
    for (let i = 0; i < 256; i++) {
      assert.strictEqual(
        decoded[i],
        i,
        `byte 0x${i.toString(16).padStart(2, "0")} should round-trip`,
      );
    }
  });

  it("each byte individually round-trips", () => {
    for (let b = 0; b <= 0xff; b++) {
      const raw = new Uint8Array([b]);
      const decoded = decodeOutputPayload(encodeOutputPayload(raw));
      assert.strictEqual(decoded.length, 1);
      assert.strictEqual(
        decoded[0],
        b,
        `byte 0x${b.toString(16).padStart(2, "0")} should round-trip individually`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Encoding rules match tmux exactly
// ---------------------------------------------------------------------------

describe("encoder matches tmux escaping rule", () => {
  it("encodes NUL (0x00) as \\000", () => {
    const enc = encodeOutputPayload(new Uint8Array([0x00]));
    assert.deepStrictEqual(enc, ascii("\\000"));
  });

  it("encodes backslash (0x5C) as \\134", () => {
    const enc = encodeOutputPayload(new Uint8Array([0x5c]));
    assert.deepStrictEqual(enc, ascii("\\134"));
  });

  it("encodes LF (0x0a) as \\012", () => {
    const enc = encodeOutputPayload(new Uint8Array([0x0a]));
    assert.deepStrictEqual(enc, ascii("\\012"));
  });

  it("encodes 0x1F as \\037 (last control char)", () => {
    const enc = encodeOutputPayload(new Uint8Array([0x1f]));
    assert.deepStrictEqual(enc, ascii("\\037"));
  });

  it("passes 0x20 (space) through literally", () => {
    const enc = encodeOutputPayload(new Uint8Array([0x20]));
    assert.deepStrictEqual(enc, new Uint8Array([0x20]));
  });

  it("passes 0x7F (DEL) through literally — NOT escaped", () => {
    // tmux: u_char comparison; 0x7F >= ' ' (0x20), so literal.
    const enc = encodeOutputPayload(new Uint8Array([0x7f]));
    assert.deepStrictEqual(enc, new Uint8Array([0x7f]));
  });

  it("passes 0xFF (high byte) through literally — NOT escaped", () => {
    const enc = encodeOutputPayload(new Uint8Array([0xff]));
    assert.deepStrictEqual(enc, new Uint8Array([0xff]));
  });

  it("passes 0x80–0xFE through literally", () => {
    for (let b = 0x80; b <= 0xfe; b++) {
      const enc = encodeOutputPayload(new Uint8Array([b]));
      assert.strictEqual(enc.length, 1, `0x${b.toString(16)} should be literal`);
      assert.strictEqual(enc[0], b);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Decoder: specific cases
// ---------------------------------------------------------------------------

describe("decoder: specific cases", () => {
  it("decodes \\000 → 0x00 (NUL)", () => {
    const dec = decodeOutputPayload(ascii("\\000"));
    assert.deepStrictEqual(dec, new Uint8Array([0x00]));
  });

  it("decodes \\134 → 0x5C (backslash)", () => {
    const dec = decodeOutputPayload(ascii("\\134"));
    assert.deepStrictEqual(dec, new Uint8Array([0x5c]));
  });

  it("decodes \\012 → 0x0A (LF)", () => {
    const dec = decodeOutputPayload(ascii("\\012"));
    assert.deepStrictEqual(dec, new Uint8Array([0x0a]));
  });

  it("decodes \\377 → 0xFF", () => {
    const dec = decodeOutputPayload(ascii("\\377"));
    assert.deepStrictEqual(dec, new Uint8Array([0xff]));
  });

  it("passes 0xFF literal through", () => {
    // tmux emits high bytes literally; decoder must pass them through.
    const dec = decodeOutputPayload(new Uint8Array([0xff]));
    assert.deepStrictEqual(dec, new Uint8Array([0xff]));
  });

  it("passes 0x7F literal through", () => {
    const dec = decodeOutputPayload(new Uint8Array([0x7f]));
    assert.deepStrictEqual(dec, new Uint8Array([0x7f]));
  });

  it("decodes mixed literal + escaped sequence", () => {
    // 'A' 0x41 literal, then '\\012' (LF), then 'Z' 0x5A literal
    const payload = ascii("A\\012Z");
    const dec = decodeOutputPayload(payload);
    assert.deepStrictEqual(dec, new Uint8Array([0x41, 0x0a, 0x5a]));
  });

  it("decodes consecutive octal sequences", () => {
    // \\000\\001\\002 → [0,1,2]
    const payload = ascii("\\000\\001\\002");
    const dec = decodeOutputPayload(payload);
    assert.deepStrictEqual(dec, new Uint8Array([0, 1, 2]));
  });

  it("decodes empty payload → empty Uint8Array", () => {
    const dec = decodeOutputPayload(new Uint8Array(0));
    assert.strictEqual(dec.length, 0);
  });

  it("malformed escape: backslash at end of payload — emits backslash literally", () => {
    const payload = new Uint8Array([0x5c]); // lone backslash
    const dec = decodeOutputPayload(payload);
    assert.deepStrictEqual(dec, new Uint8Array([0x5c]));
  });

  it("malformed escape: backslash + 2 digits — emits backslash + literals", () => {
    // This shouldn't occur in well-formed tmux output; we just don't crash.
    const payload = ascii("\\12Z");
    const dec = decodeOutputPayload(payload);
    // backslash emitted as 0x5C, then '1','2','Z' pass through
    assert.deepStrictEqual(dec, new Uint8Array([0x5c, 0x31, 0x32, 0x5a]));
  });
});

// ---------------------------------------------------------------------------
// 4. Realistic %output line
// ---------------------------------------------------------------------------

describe("realistic %output line decode", () => {
  it("decodes hello<space>world\\<LF> payload", () => {
    // tmux emits: %output %1 hello\040world\134\012
    // Payload part (after "%output %1 "): hello\040world\134\012
    // Expected decoded: "hello world\<newline>" = [h,e,l,l,o, ,w,o,r,l,d,\,\n]
    const payload = ascii("hello\\040world\\134\\012");
    const dec = decodeOutputPayload(payload);

    const expected = new Uint8Array([
      // h  e  l  l  o
      0x68, 0x65, 0x6c, 0x6c, 0x6f,
      // ' ' (0x20 = octal 040)
      0x20,
      // w  o  r  l  d
      0x77, 0x6f, 0x72, 0x6c, 0x64,
      // '\' (0x5C = octal 134)
      0x5c,
      // LF (0x0A = octal 012)
      0x0a,
    ]);

    assert.deepStrictEqual(dec, expected);
  });

  it("does not convert non-UTF-8 byte 0xFF to string (stays as 0xFF)", () => {
    // tmux emits 0xFF literally in the payload.
    const payload = new Uint8Array([0x41, 0xff, 0x42]); // A <0xFF> B
    const dec = decodeOutputPayload(payload);
    assert.deepStrictEqual(dec, new Uint8Array([0x41, 0xff, 0x42]));
    // Verify this would be invalid UTF-8 if coerced:
    // 0xFF is never a valid UTF-8 byte — this would corrupt if decoded as string.
    assert.strictEqual(dec[1], 0xff, "0xFF byte must survive as raw byte, not be mangled");
  });
});

// ---------------------------------------------------------------------------
// 5. parseOutputNotification helper
// ---------------------------------------------------------------------------

describe("parseOutputNotification", () => {
  it("extracts paneId and decoded bytes from a %output line", () => {
    // %output %3 hello\012world
    const rawLine = ascii("%output %3 hello\\012world");
    const result = parseOutputNotification(notifToken("output", rawLine));

    assert.ok(result !== null, "should not return null");
    assert.strictEqual(result.paneId, 3);
    // hello + LF + world
    const expected = new Uint8Array([
      0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a, 0x77, 0x6f, 0x72, 0x6c, 0x64,
    ]);
    assert.deepStrictEqual(result.bytes, expected);
  });

  it("handles pane ID with multiple digits", () => {
    const rawLine = ascii("%output %42 A");
    const result = parseOutputNotification(notifToken("output", rawLine));
    assert.ok(result !== null);
    assert.strictEqual(result.paneId, 42);
    assert.deepStrictEqual(result.bytes, new Uint8Array([0x41])); // 'A'
  });

  it("decodes backslash in %output line", () => {
    const rawLine = ascii("%output %1 \\134");
    const result = parseOutputNotification(notifToken("output", rawLine));
    assert.ok(result !== null);
    assert.deepStrictEqual(result.bytes, new Uint8Array([0x5c]));
  });

  it("handles empty payload", () => {
    const rawLine = ascii("%output %1 ");
    const result = parseOutputNotification(notifToken("output", rawLine));
    assert.ok(result !== null);
    assert.strictEqual(result.bytes.length, 0);
  });

  it("parses %extended-output line", () => {
    // %extended-output %7 12345 : hello\012
    const rawLine = ascii("%extended-output %7 12345 : hello\\012");
    const result = parseOutputNotification(notifToken("extended-output", rawLine));
    assert.ok(result !== null, "should not return null");
    assert.strictEqual(result.paneId, 7);
    const expected = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]);
    assert.deepStrictEqual(result.bytes, expected);
  });

  it("returns null for malformed line (missing paneId sigil)", () => {
    const rawLine = ascii("%output 5 payload");
    const result = parseOutputNotification(notifToken("output", rawLine));
    assert.strictEqual(result, null);
  });

  it("non-UTF-8 byte 0xFF in payload survives through parseOutputNotification", () => {
    // Build a rawLine containing a literal 0xFF byte in the payload region.
    const prefix = ascii("%output %1 ");
    const payload = new Uint8Array([0xff, 0x41]); // 0xFF then 'A'
    const rawLine = new Uint8Array(prefix.length + payload.length);
    rawLine.set(prefix);
    rawLine.set(payload, prefix.length);

    const result = parseOutputNotification(notifToken("output", rawLine));
    assert.ok(result !== null);
    assert.deepStrictEqual(result.bytes, new Uint8Array([0xff, 0x41]));
  });
});

// ---------------------------------------------------------------------------
// 6. Fuzz test: deterministic pseudo-random round-trips
// ---------------------------------------------------------------------------

describe("fuzz: pseudo-random buffers round-trip", () => {
  /**
   * Tiny deterministic LCG (Linear Congruential Generator).
   * Parameters from Knuth (MMIX): multiplier=6364136223846793005,
   * but we keep it 32-bit for simplicity.
   * state = (state * 1664525 + 1013904223) & 0xFFFFFFFF  (Numerical Recipes)
   */
  function makeLcg(seed: number): () => number {
    let state = seed >>> 0;
    return function nextByte(): number {
      state = ((Math.imul(state, 1664525) + 1013904223) | 0) >>> 0;
      return state & 0xff;
    };
  }

  it("1000 random buffers (varied sizes, seed 0xdeadbeef) all round-trip", () => {
    const nextByte = makeLcg(0xdeadbeef);
    let failures = 0;
    const MAX_LEN = 256;

    for (let trial = 0; trial < 1000; trial++) {
      // Pseudo-random buffer length: 0–255 bytes.
      const len = nextByte() % (MAX_LEN + 1);
      const raw = new Uint8Array(len);
      for (let i = 0; i < len; i++) raw[i] = nextByte();

      const decoded = decodeOutputPayload(encodeOutputPayload(raw));
      if (decoded.length !== raw.length) {
        failures++;
        continue;
      }
      for (let i = 0; i < raw.length; i++) {
        if (decoded[i] !== raw[i]) {
          failures++;
          break;
        }
      }
    }

    assert.strictEqual(failures, 0, `${failures} round-trip failures in fuzz run`);
  });

  it("buffers with all control chars and backslash clusters round-trip", () => {
    // Stress the regions that trigger octal escaping: control chars + 0x5C.
    const escapedBytes = new Uint8Array(
      Array.from({ length: 32 }, (_, i) => i) // 0x00–0x1F
        .concat([0x5c]) // backslash
        .flatMap((b) => [b, b, b]), // repeat 3× each
    );

    const decoded = decodeOutputPayload(encodeOutputPayload(escapedBytes));
    assert.deepStrictEqual(decoded, escapedBytes);
  });

  it("buffers composed only of high bytes (0x80–0xFF) round-trip", () => {
    // These are NOT escaped by tmux (unsigned comparison), so they pass
    // through the encoder as literals and the decoder echoes them back.
    const highBytes = new Uint8Array(128);
    for (let i = 0; i < 128; i++) highBytes[i] = 0x80 + i; // 0x80–0xFF

    const decoded = decodeOutputPayload(encodeOutputPayload(highBytes));
    assert.deepStrictEqual(decoded, highBytes);
  });
});
