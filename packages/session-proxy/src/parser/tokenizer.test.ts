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
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ControlTokenizer,
  tokenizeBuffer,
  type ControlToken,
  type NotificationToken,
  type BlockBeginToken,
  type BlockBodyToken,
  type BlockEndToken,
  type BlockErrorToken,
} from "./tokenizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

/** Concatenate multiple Uint8Arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Feed bytes to a tokenizer one byte at a time; collect all tokens. */
function feedByteByByte(tok: ControlTokenizer, input: Uint8Array): ControlToken[] {
  const tokens: ControlToken[] = [];
  for (let i = 0; i < input.length; i++) {
    tokens.push(...tok.push(input.subarray(i, i + 1)));
  }
  return tokens;
}

/** Feed bytes in chunks of `size`; collect all tokens. */
function feedInChunks(tok: ControlTokenizer, input: Uint8Array, size: number): ControlToken[] {
  const tokens: ControlToken[] = [];
  for (let i = 0; i < input.length; i += size) {
    tokens.push(...tok.push(input.subarray(i, i + size)));
  }
  return tokens;
}

function assertNotification(
  token: ControlToken | undefined,
  expectedKeyword: string,
  msg?: string,
): NotificationToken {
  assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
  assert.strictEqual(token.kind, "notification", `${msg ?? "token"}: expected notification`);
  const n = token as NotificationToken;
  assert.strictEqual(n.keyword, expectedKeyword, `${msg ?? "token"}: keyword mismatch`);
  return n;
}

function assertBlockBegin(
  token: ControlToken | undefined,
  ts: number,
  cmdNum: number,
  flags: number,
  msg?: string,
): void {
  assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
  assert.strictEqual(token.kind, "block-begin", `${msg ?? "token"}: expected block-begin`);
  const b = token as BlockBeginToken;
  assert.strictEqual(b.timestamp, ts, `${msg ?? "token"}: timestamp`);
  assert.strictEqual(b.commandNumber, cmdNum, `${msg ?? "token"}: commandNumber`);
  assert.strictEqual(b.flags, flags, `${msg ?? "token"}: flags`);
}

function assertBlockBody(token: ControlToken | undefined, expectedBytes: Uint8Array, msg?: string): void {
  assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
  assert.strictEqual(token.kind, "block-body", `${msg ?? "token"}: expected block-body`);
  const b = token as BlockBodyToken;
  assertBytesEqual(b.bytes, expectedBytes, `${msg ?? "token"}.bytes`);
}

function assertBlockEnd(
  token: ControlToken | undefined,
  ts: number,
  cmdNum: number,
  flags: number,
  msg?: string,
): void {
  assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
  assert.strictEqual(token.kind, "block-end", `${msg ?? "token"}: expected block-end`);
  const b = token as BlockEndToken;
  assert.strictEqual(b.timestamp, ts, `${msg ?? "token"}: timestamp`);
  assert.strictEqual(b.commandNumber, cmdNum, `${msg ?? "token"}: commandNumber`);
  assert.strictEqual(b.flags, flags, `${msg ?? "token"}: flags`);
}

function assertBlockError(
  token: ControlToken | undefined,
  ts: number,
  cmdNum: number,
  flags: number,
  msg?: string,
): void {
  assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
  assert.strictEqual(token.kind, "block-error", `${msg ?? "token"}: expected block-error`);
  const b = token as BlockErrorToken;
  assert.strictEqual(b.timestamp, ts, `${msg ?? "token"}: timestamp`);
  assert.strictEqual(b.commandNumber, cmdNum, `${msg ?? "token"}: commandNumber`);
  assert.strictEqual(b.flags, flags, `${msg ?? "token"}: flags`);
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, msg?: string): void {
  assert.strictEqual(actual.length, expected.length, `${msg}: length mismatch (actual=${actual.length}, expected=${expected.length})`);
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(actual[i], expected[i], `${msg}: mismatch at byte ${i}`);
  }
}

/** Assert rawLine starts with the `%keyword` text. */
function assertRawLineStartsWith(rawLine: Uint8Array, prefix: string): void {
  const prefixBytes = enc.encode(prefix);
  assert.ok(
    rawLine.length >= prefixBytes.length,
    `rawLine too short: ${rawLine.length} < ${prefixBytes.length}`,
  );
  for (let i = 0; i < prefixBytes.length; i++) {
    assert.strictEqual(rawLine[i], prefixBytes[i], `rawLine byte ${i} mismatch`);
  }
}

// ---------------------------------------------------------------------------
// DCS intro constant
// ---------------------------------------------------------------------------

const DCS_INTRO = new Uint8Array([0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]);
const ST = new Uint8Array([0x1b, 0x5c]);

// ---------------------------------------------------------------------------
// 1. Simple notification line
// ---------------------------------------------------------------------------

describe("notification: simple line", () => {
  it("emits one notification token for a bare %sessions-changed", () => {
    const input = bytes("%sessions-changed\n");
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 1);
    assertNotification(tokens[0], "sessions-changed");
  });

  it("preserves rawLine bytes (without trailing newline)", () => {
    const input = bytes("%sessions-changed\n");
    const tok = tokenizeBuffer(input);
    const n = tok[0] as NotificationToken;
    assertBytesEqual(n.rawLine, bytes("%sessions-changed"));
  });

  it("%window-add notification", () => {
    const tokens = tokenizeBuffer(bytes("%window-add @1\n"));
    assert.strictEqual(tokens.length, 1);
    assertNotification(tokens[0], "window-add");
    assertRawLineStartsWith((tokens[0] as NotificationToken).rawLine, "%window-add");
  });

  it("%exit notification (single word)", () => {
    const tokens = tokenizeBuffer(bytes("%exit\n"));
    assert.strictEqual(tokens.length, 1);
    assertNotification(tokens[0], "exit");
  });

  it("%pause notification", () => {
    const tokens = tokenizeBuffer(bytes("%pause\n"));
    assertNotification(tokens[0], "pause");
  });

  it("multiple notifications in sequence", () => {
    const input = bytes("%sessions-changed\n%window-add @1\n%layout-change @1 %1\n");
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 3);
    assertNotification(tokens[0], "sessions-changed");
    assertNotification(tokens[1], "window-add");
    assertNotification(tokens[2], "layout-change");
  });
});

// ---------------------------------------------------------------------------
// 2. Full command block: %begin … body … %end
// ---------------------------------------------------------------------------

describe("command block: %begin / body / %end", () => {
  it("emits block-begin, block-body×2, block-end in order", () => {
    const input = bytes(
      "%begin 1234567890 42 0\nfirst line\nsecond line\n%end 1234567890 42 0\n",
    );
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 4, `expected 4 tokens, got ${tokens.length}`);
    assertBlockBegin(tokens[0], 1234567890, 42, 0, "begin");
    assertBlockBody(tokens[1], bytes("first line"), "body[0]");
    assertBlockBody(tokens[2], bytes("second line"), "body[1]");
    assertBlockEnd(tokens[3], 1234567890, 42, 0, "end");
  });

  it("parses timestamp, commandNumber, flags correctly", () => {
    const input = bytes("%begin 1717000000 7 1\noutput\n%end 1717000000 7 1\n");
    const tokens = tokenizeBuffer(input);
    // 3 tokens: begin, one body line, end
    assert.strictEqual(tokens.length, 3);
    assertBlockBegin(tokens[0], 1717000000, 7, 1);
    assertBlockBody(tokens[1], bytes("output"), "body");
    assertBlockEnd(tokens[2], 1717000000, 7, 1);
  });

  it("empty body block (no lines between begin and end)", () => {
    const input = bytes("%begin 100 1 0\n%end 100 1 0\n");
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 2);
    assertBlockBegin(tokens[0], 100, 1, 0);
    assertBlockEnd(tokens[1], 100, 1, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. %error variant
// ---------------------------------------------------------------------------

describe("command block: %error", () => {
  it("emits block-error on %error terminator", () => {
    const input = bytes(
      "%begin 9999 3 0\nbad command\n%error 9999 3 0\n",
    );
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 3);
    assertBlockBegin(tokens[0], 9999, 3, 0, "begin");
    assertBlockBody(tokens[1], bytes("bad command"), "body");
    assertBlockError(tokens[2], 9999, 3, 0, "error");
  });
});

// ---------------------------------------------------------------------------
// 4. Body line starting with % inside a block → block-body, NOT notification
// ---------------------------------------------------------------------------

describe("block-body: % line inside block is not a notification", () => {
  it("a line starting with % inside a block becomes block-body", () => {
    const input = bytes(
      "%begin 500 2 0\n%output %1 some text\n%end 500 2 0\n",
    );
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 3);
    assertBlockBegin(tokens[0], 500, 2, 0, "begin");
    // The %output line inside the block is body, NOT a notification
    assert.strictEqual(tokens[1]!.kind, "block-body", "body line starting with % is block-body");
    assertBlockEnd(tokens[2], 500, 2, 0, "end");
    // Check the bytes are the raw line
    assertBytesEqual(
      (tokens[1] as BlockBodyToken).bytes,
      bytes("%output %1 some text"),
    );
  });

  it("multiple % body lines inside a block", () => {
    const input = bytes(
      "%begin 1 1 0\n%session-changed\n%window-add @99\n%end 1 1 0\n",
    );
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 4);
    assertBlockBegin(tokens[0], 1, 1, 0);
    assert.strictEqual(tokens[1]!.kind, "block-body");
    assert.strictEqual(tokens[2]!.kind, "block-body");
    assertBlockEnd(tokens[3], 1, 1, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. DCS wrapper
// ---------------------------------------------------------------------------

describe("DCS wrapper", () => {
  it("emits dcs-open at start, dcs-close at ST, correct inner tokens", () => {
    const inner = bytes("%sessions-changed\n");
    const input = concat(DCS_INTRO, inner, ST);
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 3, `expected 3 tokens (dcs-open, notification, dcs-close), got ${tokens.length}`);
    assert.strictEqual(tokens[0]!.kind, "dcs-open");
    assertNotification(tokens[1], "sessions-changed");
    assert.strictEqual(tokens[2]!.kind, "dcs-close");
  });

  it("full block inside DCS wrapper", () => {
    const inner = bytes("%begin 42 1 0\nline\n%end 42 1 0\n");
    const input = concat(DCS_INTRO, inner, ST);
    const tokens = tokenizeBuffer(input);
    // dcs-open, begin, body, end, dcs-close
    assert.strictEqual(tokens.length, 5);
    assert.strictEqual(tokens[0]!.kind, "dcs-open");
    assertBlockBegin(tokens[1], 42, 1, 0);
    assertBlockBody(tokens[2], bytes("line"));
    assertBlockEnd(tokens[3], 42, 1, 0);
    assert.strictEqual(tokens[4]!.kind, "dcs-close");
  });

  it("bare lines (no DCS wrapper) parse correctly", () => {
    // No \x1bP1000p prefix — just raw control lines
    const input = bytes("%sessions-changed\n%exit\n");
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 2);
    assertNotification(tokens[0], "sessions-changed");
    assertNotification(tokens[1], "exit");
  });

  it("discards bytes after ST", () => {
    const inner = bytes("%pause\n");
    const trailing = bytes("some garbage after close\n");
    const input = concat(DCS_INTRO, inner, ST, trailing);
    const tokens = tokenizeBuffer(input);
    // dcs-open, notification, dcs-close — trailing bytes discarded
    assert.strictEqual(tokens.length, 3);
    assert.strictEqual(tokens[0]!.kind, "dcs-open");
    assertNotification(tokens[1], "pause");
    assert.strictEqual(tokens[2]!.kind, "dcs-close");
  });
});

// ---------------------------------------------------------------------------
// 6. Streaming: byte-by-byte and awkward offsets
// ---------------------------------------------------------------------------

describe("streaming: identical tokens regardless of chunk size", () => {
  // Build a reference input with DCS, a notification, a full block
  const reference = concat(
    DCS_INTRO,
    bytes("%sessions-changed\n"),
    bytes("%begin 1717 5 0\nbody line\n%end 1717 5 0\n"),
    ST,
  );

  function getExpected(): ControlToken[] {
    return tokenizeBuffer(reference);
  }

  function assertSameTokens(actual: ControlToken[], expected: ControlToken[], label: string): void {
    assert.strictEqual(actual.length, expected.length, `${label}: token count mismatch`);
    for (let i = 0; i < expected.length; i++) {
      const a = actual[i]!;
      const e = expected[i]!;
      assert.strictEqual(a.kind, e.kind, `${label}: token[${i}].kind`);
      if (a.kind === "block-begin" || a.kind === "block-end" || a.kind === "block-error") {
        const ab = a as BlockBeginToken;
        const eb = e as BlockBeginToken;
        assert.strictEqual(ab.timestamp, eb.timestamp, `${label}: token[${i}].timestamp`);
        assert.strictEqual(ab.commandNumber, eb.commandNumber, `${label}: token[${i}].commandNumber`);
        assert.strictEqual(ab.flags, eb.flags, `${label}: token[${i}].flags`);
      }
      if (a.kind === "notification") {
        assert.strictEqual(
          (a as NotificationToken).keyword,
          (e as NotificationToken).keyword,
          `${label}: token[${i}].keyword`,
        );
      }
      if (a.kind === "block-body") {
        assertBytesEqual(
          (a as BlockBodyToken).bytes,
          (e as BlockBodyToken).bytes,
          `${label}: token[${i}].bytes`,
        );
      }
    }
  }

  it("byte-by-byte feed produces same tokens as one-shot", () => {
    const expected = getExpected();
    const tokens = feedByteByByte(new ControlTokenizer(), reference);
    assertSameTokens(tokens, expected, "byte-by-byte");
  });

  it("chunk size 3 produces same tokens", () => {
    const expected = getExpected();
    const tokens = feedInChunks(new ControlTokenizer(), reference, 3);
    assertSameTokens(tokens, expected, "chunks-3");
  });

  it("chunk size 7 (DCS intro size) produces same tokens", () => {
    const expected = getExpected();
    const tokens = feedInChunks(new ControlTokenizer(), reference, 7);
    assertSameTokens(tokens, expected, "chunks-7");
  });

  it("chunk size 11 (mid-DCS-intro or mid-line) produces same tokens", () => {
    const expected = getExpected();
    const tokens = feedInChunks(new ControlTokenizer(), reference, 11);
    assertSameTokens(tokens, expected, "chunks-11");
  });

  it("single-chunk feed equals reference", () => {
    const expected = getExpected();
    const tokens = new ControlTokenizer().push(reference);
    assertSameTokens(tokens, expected, "single-chunk");
  });

  it("feeding at offset splits DCS intro across two calls", () => {
    // Split exactly in the middle of the DCS intro (4 bytes + 3 bytes)
    const expected = getExpected();
    const tok = new ControlTokenizer();
    const tokens = [
      ...tok.push(reference.subarray(0, 4)),   // partial DCS intro
      ...tok.push(reference.subarray(4)),       // rest
    ];
    assertSameTokens(tokens, expected, "split-dcs-intro");
  });

  it("feeding split mid-begin line", () => {
    // Split inside the %begin line (just past DCS_INTRO + "%beg")
    const expected = getExpected();
    const splitAt = DCS_INTRO.length + 4; // "%beg"
    const tok = new ControlTokenizer();
    const tokens = [
      ...tok.push(reference.subarray(0, splitAt)),
      ...tok.push(reference.subarray(splitAt)),
    ];
    assertSameTokens(tokens, expected, "split-mid-begin");
  });
});

// ---------------------------------------------------------------------------
// 7. Non-UTF-8 bytes preserved
// ---------------------------------------------------------------------------

describe("non-UTF-8 bytes", () => {
  it("block-body with non-UTF-8 bytes is preserved exactly", () => {
    // A block body line containing raw bytes [0x80, 0xff, 0x00, 0xfe]
    const nonUtf8 = new Uint8Array([0x80, 0xff, 0x00, 0xfe]);
    const input = concat(
      bytes("%begin 1 1 0\n"),
      nonUtf8,
      bytes("\n"),
      bytes("%end 1 1 0\n"),
    );
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 3);
    assertBlockBegin(tokens[0], 1, 1, 0);
    assert.strictEqual(tokens[1]!.kind, "block-body");
    assertBytesEqual((tokens[1] as BlockBodyToken).bytes, nonUtf8, "non-UTF-8 body bytes");
    assertBlockEnd(tokens[2], 1, 1, 0);
  });

  it("notification rawLine preserves non-UTF-8 payload bytes", () => {
    // %output with octal-escaped bytes (tmux encodes as octal in the protocol,
    // but here we test that arbitrary bytes in the raw line are preserved)
    const prefix = bytes("%output %1 ");
    const payload = new Uint8Array([0x80, 0xc3, 0x28, 0xfe]); // invalid UTF-8 sequences
    const input = concat(prefix, payload, bytes("\n"));
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 1);
    assertNotification(tokens[0], "output");
    const rawLine = (tokens[0] as NotificationToken).rawLine;
    // rawLine should be the full line: prefix + payload
    const expectedRaw = concat(prefix, payload);
    assertBytesEqual(rawLine, expectedRaw, "rawLine with non-UTF-8 payload");
  });
});

// ---------------------------------------------------------------------------
// 8. CRLF line endings
// ---------------------------------------------------------------------------

describe("CRLF line endings", () => {
  it("notification with \\r\\n ending: CR stripped from rawLine", () => {
    const input = bytes("%sessions-changed\r\n");
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 1);
    assertNotification(tokens[0], "sessions-changed");
    // rawLine should NOT contain \r
    const rawLine = (tokens[0] as NotificationToken).rawLine;
    assertBytesEqual(rawLine, bytes("%sessions-changed"), "rawLine strips CR");
  });

  it("block with \\r\\n endings: all CR stripped", () => {
    const input = bytes("%begin 1 1 0\r\nbody\r\n%end 1 1 0\r\n");
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 3);
    assertBlockBegin(tokens[0], 1, 1, 0);
    assertBlockBody(tokens[1], bytes("body"), "body without CR");
    assertBlockEnd(tokens[2], 1, 1, 0);
  });

  it("mixed LF and CRLF endings", () => {
    const input = bytes("%sessions-changed\n%window-add @1\r\n");
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 2);
    assertNotification(tokens[0], "sessions-changed");
    assertNotification(tokens[1], "window-add");
  });
});

// ---------------------------------------------------------------------------
// 9. Sequential blocks
// ---------------------------------------------------------------------------

describe("sequential command blocks", () => {
  it("two consecutive blocks emit correct token sequence", () => {
    const input = bytes(
      "%begin 100 1 0\nfirst\n%end 100 1 0\n" +
      "%begin 200 2 0\nsecond\n%end 200 2 0\n",
    );
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 6);
    assertBlockBegin(tokens[0], 100, 1, 0, "begin[0]");
    assertBlockBody(tokens[1], bytes("first"), "body[0]");
    assertBlockEnd(tokens[2], 100, 1, 0, "end[0]");
    assertBlockBegin(tokens[3], 200, 2, 0, "begin[1]");
    assertBlockBody(tokens[4], bytes("second"), "body[1]");
    assertBlockEnd(tokens[5], 200, 2, 0, "end[1]");
  });

  it("notification between two blocks", () => {
    const input = bytes(
      "%begin 1 1 0\na\n%end 1 1 0\n" +
      "%sessions-changed\n" +
      "%begin 2 2 0\nb\n%end 2 2 0\n",
    );
    const tokens = tokenizeBuffer(input);
    assert.strictEqual(tokens.length, 7);
    assert.strictEqual(tokens[0]!.kind, "block-begin");
    assert.strictEqual(tokens[1]!.kind, "block-body");
    assert.strictEqual(tokens[2]!.kind, "block-end");
    assert.strictEqual(tokens[3]!.kind, "notification");
    assert.strictEqual(tokens[4]!.kind, "block-begin");
    assert.strictEqual(tokens[5]!.kind, "block-body");
    assert.strictEqual(tokens[6]!.kind, "block-end");
  });
});

// ---------------------------------------------------------------------------
// 10. Incremental API: multi-call accumulation
// ---------------------------------------------------------------------------

describe("incremental push: partial lines buffered", () => {
  it("feeds line in two halves; token appears after newline", () => {
    const tok = new ControlTokenizer();

    // First half: no newline yet → no tokens
    const tokens1 = tok.push(bytes("%sessions-cha"));
    assert.strictEqual(tokens1.length, 0, "no tokens before newline");

    // Second half: newline arrives → token emitted
    const tokens2 = tok.push(bytes("nged\n"));
    assert.strictEqual(tokens2.length, 1);
    assertNotification(tokens2[0], "sessions-changed");
  });

  it("multiple tokens returned from single push when multiple lines present", () => {
    const tok = new ControlTokenizer();
    const tokens = tok.push(bytes("%exit\n%pause\n%continue\n"));
    assert.strictEqual(tokens.length, 3);
    assertNotification(tokens[0], "exit");
    assertNotification(tokens[1], "pause");
    assertNotification(tokens[2], "continue");
  });
});

// ---------------------------------------------------------------------------
// 11. tokenizeBuffer convenience helper
// ---------------------------------------------------------------------------

describe("tokenizeBuffer", () => {
  it("single-shot tokenize matches incremental push", () => {
    const input = bytes("%sessions-changed\n%begin 5 1 0\nok\n%end 5 1 0\n");
    const fromHelper = tokenizeBuffer(input);
    const fromPush = new ControlTokenizer().push(input);
    assert.strictEqual(fromHelper.length, fromPush.length);
    for (let i = 0; i < fromHelper.length; i++) {
      assert.strictEqual(fromHelper[i]!.kind, fromPush[i]!.kind);
    }
  });
});
