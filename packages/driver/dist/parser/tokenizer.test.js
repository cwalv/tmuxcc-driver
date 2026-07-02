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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ControlTokenizer, tokenizeBuffer, } from "./tokenizer.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
function bytes(s) {
    return enc.encode(s);
}
/** Concatenate multiple Uint8Arrays. */
function concat(...parts) {
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
function feedByteByByte(tok, input) {
    const tokens = [];
    for (let i = 0; i < input.length; i++) {
        tokens.push(...tok.push(input.subarray(i, i + 1)));
    }
    return tokens;
}
/** Feed bytes in chunks of `size`; collect all tokens. */
function feedInChunks(tok, input, size) {
    const tokens = [];
    for (let i = 0; i < input.length; i += size) {
        tokens.push(...tok.push(input.subarray(i, i + size)));
    }
    return tokens;
}
function assertNotification(token, expectedKeyword, msg) {
    assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
    assert.strictEqual(token.kind, "notification", `${msg ?? "token"}: expected notification`);
    const n = token;
    assert.strictEqual(n.keyword, expectedKeyword, `${msg ?? "token"}: keyword mismatch`);
    return n;
}
function assertBlockBegin(token, ts, cmdNum, flags, msg) {
    assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
    assert.strictEqual(token.kind, "block-begin", `${msg ?? "token"}: expected block-begin`);
    const b = token;
    assert.strictEqual(b.timestamp, ts, `${msg ?? "token"}: timestamp`);
    assert.strictEqual(b.commandNumber, cmdNum, `${msg ?? "token"}: commandNumber`);
    assert.strictEqual(b.flags, flags, `${msg ?? "token"}: flags`);
}
function assertBlockBody(token, expectedBytes, msg) {
    assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
    assert.strictEqual(token.kind, "block-body", `${msg ?? "token"}: expected block-body`);
    const b = token;
    assertBytesEqual(b.bytes, expectedBytes, `${msg ?? "token"}.bytes`);
}
function assertBlockEnd(token, ts, cmdNum, flags, msg) {
    assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
    assert.strictEqual(token.kind, "block-end", `${msg ?? "token"}: expected block-end`);
    const b = token;
    assert.strictEqual(b.timestamp, ts, `${msg ?? "token"}: timestamp`);
    assert.strictEqual(b.commandNumber, cmdNum, `${msg ?? "token"}: commandNumber`);
    assert.strictEqual(b.flags, flags, `${msg ?? "token"}: flags`);
}
function assertBlockError(token, ts, cmdNum, flags, msg) {
    assert.ok(token, `${msg ?? "token"}: expected token, got undefined`);
    assert.strictEqual(token.kind, "block-error", `${msg ?? "token"}: expected block-error`);
    const b = token;
    assert.strictEqual(b.timestamp, ts, `${msg ?? "token"}: timestamp`);
    assert.strictEqual(b.commandNumber, cmdNum, `${msg ?? "token"}: commandNumber`);
    assert.strictEqual(b.flags, flags, `${msg ?? "token"}: flags`);
}
function assertBytesEqual(actual, expected, msg) {
    assert.strictEqual(actual.length, expected.length, `${msg}: length mismatch (actual=${actual.length}, expected=${expected.length})`);
    for (let i = 0; i < expected.length; i++) {
        assert.strictEqual(actual[i], expected[i], `${msg}: mismatch at byte ${i}`);
    }
}
/** Assert rawLine starts with the `%keyword` text. */
function assertRawLineStartsWith(rawLine, prefix) {
    const prefixBytes = enc.encode(prefix);
    assert.ok(rawLine.length >= prefixBytes.length, `rawLine too short: ${rawLine.length} < ${prefixBytes.length}`);
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
        const n = tok[0];
        assertBytesEqual(n.rawLine, bytes("%sessions-changed"));
    });
    it("%window-add notification", () => {
        const tokens = tokenizeBuffer(bytes("%window-add @1\n"));
        assert.strictEqual(tokens.length, 1);
        assertNotification(tokens[0], "window-add");
        assertRawLineStartsWith(tokens[0].rawLine, "%window-add");
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
        const input = bytes("%begin 1234567890 42 0\nfirst line\nsecond line\n%end 1234567890 42 0\n");
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
        const input = bytes("%begin 9999 3 0\nbad command\n%error 9999 3 0\n");
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
        const input = bytes("%begin 500 2 0\n%output %1 some text\n%end 500 2 0\n");
        const tokens = tokenizeBuffer(input);
        assert.strictEqual(tokens.length, 3);
        assertBlockBegin(tokens[0], 500, 2, 0, "begin");
        // The %output line inside the block is body, NOT a notification
        assert.strictEqual(tokens[1].kind, "block-body", "body line starting with % is block-body");
        assertBlockEnd(tokens[2], 500, 2, 0, "end");
        // Check the bytes are the raw line
        assertBytesEqual(tokens[1].bytes, bytes("%output %1 some text"));
    });
    it("multiple % body lines inside a block", () => {
        const input = bytes("%begin 1 1 0\n%session-changed\n%window-add @99\n%end 1 1 0\n");
        const tokens = tokenizeBuffer(input);
        assert.strictEqual(tokens.length, 4);
        assertBlockBegin(tokens[0], 1, 1, 0);
        assert.strictEqual(tokens[1].kind, "block-body");
        assert.strictEqual(tokens[2].kind, "block-body");
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
        assert.strictEqual(tokens[0].kind, "dcs-open");
        assertNotification(tokens[1], "sessions-changed");
        assert.strictEqual(tokens[2].kind, "dcs-close");
    });
    it("full block inside DCS wrapper", () => {
        const inner = bytes("%begin 42 1 0\nline\n%end 42 1 0\n");
        const input = concat(DCS_INTRO, inner, ST);
        const tokens = tokenizeBuffer(input);
        // dcs-open, begin, body, end, dcs-close
        assert.strictEqual(tokens.length, 5);
        assert.strictEqual(tokens[0].kind, "dcs-open");
        assertBlockBegin(tokens[1], 42, 1, 0);
        assertBlockBody(tokens[2], bytes("line"));
        assertBlockEnd(tokens[3], 42, 1, 0);
        assert.strictEqual(tokens[4].kind, "dcs-close");
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
        assert.strictEqual(tokens[0].kind, "dcs-open");
        assertNotification(tokens[1], "pause");
        assert.strictEqual(tokens[2].kind, "dcs-close");
    });
});
// ---------------------------------------------------------------------------
// 6. Streaming: byte-by-byte and awkward offsets
// ---------------------------------------------------------------------------
describe("streaming: identical tokens regardless of chunk size", () => {
    // Build a reference input with DCS, a notification, a full block
    const reference = concat(DCS_INTRO, bytes("%sessions-changed\n"), bytes("%begin 1717 5 0\nbody line\n%end 1717 5 0\n"), ST);
    function getExpected() {
        return tokenizeBuffer(reference);
    }
    function assertSameTokens(actual, expected, label) {
        assert.strictEqual(actual.length, expected.length, `${label}: token count mismatch`);
        for (let i = 0; i < expected.length; i++) {
            const a = actual[i];
            const e = expected[i];
            assert.strictEqual(a.kind, e.kind, `${label}: token[${i}].kind`);
            if (a.kind === "block-begin" || a.kind === "block-end" || a.kind === "block-error") {
                const ab = a;
                const eb = e;
                assert.strictEqual(ab.timestamp, eb.timestamp, `${label}: token[${i}].timestamp`);
                assert.strictEqual(ab.commandNumber, eb.commandNumber, `${label}: token[${i}].commandNumber`);
                assert.strictEqual(ab.flags, eb.flags, `${label}: token[${i}].flags`);
            }
            if (a.kind === "notification") {
                assert.strictEqual(a.keyword, e.keyword, `${label}: token[${i}].keyword`);
            }
            if (a.kind === "block-body") {
                assertBytesEqual(a.bytes, e.bytes, `${label}: token[${i}].bytes`);
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
            ...tok.push(reference.subarray(0, 4)), // partial DCS intro
            ...tok.push(reference.subarray(4)), // rest
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
        const input = concat(bytes("%begin 1 1 0\n"), nonUtf8, bytes("\n"), bytes("%end 1 1 0\n"));
        const tokens = tokenizeBuffer(input);
        assert.strictEqual(tokens.length, 3);
        assertBlockBegin(tokens[0], 1, 1, 0);
        assert.strictEqual(tokens[1].kind, "block-body");
        assertBytesEqual(tokens[1].bytes, nonUtf8, "non-UTF-8 body bytes");
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
        const rawLine = tokens[0].rawLine;
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
        const rawLine = tokens[0].rawLine;
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
        const input = bytes("%begin 100 1 0\nfirst\n%end 100 1 0\n" +
            "%begin 200 2 0\nsecond\n%end 200 2 0\n");
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
        const input = bytes("%begin 1 1 0\na\n%end 1 1 0\n" +
            "%sessions-changed\n" +
            "%begin 2 2 0\nb\n%end 2 2 0\n");
        const tokens = tokenizeBuffer(input);
        assert.strictEqual(tokens.length, 7);
        assert.strictEqual(tokens[0].kind, "block-begin");
        assert.strictEqual(tokens[1].kind, "block-body");
        assert.strictEqual(tokens[2].kind, "block-end");
        assert.strictEqual(tokens[3].kind, "notification");
        assert.strictEqual(tokens[4].kind, "block-begin");
        assert.strictEqual(tokens[5].kind, "block-body");
        assert.strictEqual(tokens[6].kind, "block-end");
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
            assert.strictEqual(fromHelper[i].kind, fromPush[i].kind);
        }
    });
});
// ---------------------------------------------------------------------------
// 12. Block-aware ST suppression (tc-44u4)
//
// Regression matrix for the permanent-wedge bug: the tokenizer used to scan
// EVERY INSIDE-state byte for the DCS String Terminator (ESC `\`), including
// block-body bytes. `capture-pane -e` preserves raw escapes and tmux does NOT
// octal-escape command-block bodies (only %output, control.c:639), so a raw
// ESC `\` landing in a %begin…%end body was misread as the envelope-closing
// ST: the tokenizer emitted dcs-close, entered AFTER_DCS, and silently
// discarded the entire rest of the control stream forever.
//
// Invariant (oracle): block bodies are OPAQUE. iTerm2's TmuxGateway.m reads the
// stream line-by-line, tracks %begin/%end (currentCommand_), and appends body
// data with `[currentCommandData_ appendData:data]` (TmuxGateway.m:798) — it
// never byte-scans block-body content for the ST. tmux's real closing ST only
// ever arrives at top level (block depth 0) after all control lines, never
// mid-block, so suppressing ST detection inside a block is safe and complete.
// ---------------------------------------------------------------------------
const ESC = new Uint8Array([0x1b]);
const ESC_BACKSLASH = new Uint8Array([0x1b, 0x5c]); // raw DCS ST in a body
const LF_BYTE = 0x0a;
/** Assert no token in the stream is a dcs-close (the wedge signature). */
function assertNoDcsClose(tokens, label) {
    for (let i = 0; i < tokens.length; i++) {
        assert.notStrictEqual(tokens[i].kind, "dcs-close", `${label}: unexpected dcs-close at token[${i}] (premature ST → wedge)`);
    }
}
// --- A. Core regression: the live wedge ---
describe("tc-44u4 A: raw ESC-backslash in block body must not close the DCS", () => {
    it("A1. body-with-raw-ESC-backslash recovers; block-end + trailing %output survive", () => {
        const input = concat(bytes("%begin 100 1 0\n"), bytes("before"), ESC_BACKSLASH, bytes("after\n"), bytes("%end 100 1 0\n"), bytes("%output %1 hello\n"));
        const tokens = tokenizeBuffer(input);
        assertNoDcsClose(tokens, "A1");
        assert.strictEqual(tokens.length, 4, `A1: expected 4 tokens, got ${tokens.length}`);
        assertBlockBegin(tokens[0], 100, 1, 0, "A1.begin");
        assertBlockBody(tokens[1], concat(bytes("before"), ESC_BACKSLASH, bytes("after")), "A1.body");
        assertBlockEnd(tokens[2], 100, 1, 0, "A1.end");
        assertNotification(tokens[3], "output", "A1.trailing");
    });
    it("A2. ESC-backslash as the LAST bytes of the body still recovers", () => {
        const input = concat(bytes("%begin 100 1 0\n"), bytes("trailing"), ESC_BACKSLASH, bytes("\n"), bytes("%end 100 1 0\n"), bytes("%output %1 x\n"));
        const tokens = tokenizeBuffer(input);
        assertNoDcsClose(tokens, "A2");
        assert.strictEqual(tokens.length, 4);
        assertBlockBody(tokens[1], concat(bytes("trailing"), ESC_BACKSLASH), "A2.body");
        assertBlockEnd(tokens[2], 100, 1, 0, "A2.end");
        assertNotification(tokens[3], "output", "A2.trailing");
    });
    it("A3. ESC-backslash as the FIRST bytes of the body still recovers", () => {
        const input = concat(bytes("%begin 100 1 0\n"), ESC_BACKSLASH, bytes("leading\n"), bytes("%end 100 1 0\n"), bytes("%output %1 x\n"));
        const tokens = tokenizeBuffer(input);
        assertNoDcsClose(tokens, "A3");
        assert.strictEqual(tokens.length, 4);
        assertBlockBody(tokens[1], concat(ESC_BACKSLASH, bytes("leading")), "A3.body");
        assertBlockEnd(tokens[2], 100, 1, 0, "A3.end");
        assertNotification(tokens[3], "output", "A3.trailing");
    });
});
// --- B. Adversarial block-body payloads (each opaque; block-end emitted) ---
describe("tc-44u4 B: adversarial block-body payloads stay opaque", () => {
    /** Run a body payload through a full block and assert exact body + recovery. */
    function runBody(label, body) {
        const input = concat(bytes("%begin 7 1 0\n"), body, bytes("\n"), bytes("%end 7 1 0\n"), bytes("%output %1 ok\n"));
        const tokens = tokenizeBuffer(input);
        assertNoDcsClose(tokens, label);
        assert.strictEqual(tokens.length, 4, `${label}: expected 4 tokens, got ${tokens.length}`);
        assertBlockBegin(tokens[0], 7, 1, 0, `${label}.begin`);
        assertBlockBody(tokens[1], body, `${label}.body`);
        assertBlockEnd(tokens[2], 7, 1, 0, `${label}.end`);
        assertNotification(tokens[3], "output", `${label}.trailing`);
        return tokens;
    }
    it("B4. bare ESC with no following backslash, then arbitrary bytes", () => {
        runBody("B4", concat(ESC, bytes("Xnot-an-st")));
    });
    it("B5. ESC followed by a non-backslash byte (a CSI: ESC [ 0 m)", () => {
        runBody("B5", concat(ESC, bytes("[0m")));
    });
    it("B6. a full nested DCS-looking sequence in the body (ESC P … ESC \\)", () => {
        runBody("B6", concat(bytes("\x1bP1000pcaptured"), ESC_BACKSLASH));
    });
    it("B7. an OSC with ST terminator in the body (ESC ] 0 ; title ESC \\)", () => {
        runBody("B7", concat(bytes("\x1b]0;title"), ESC_BACKSLASH));
    });
    it("B8. an OSC with BEL terminator (ESC ] 0 ; title BEL)", () => {
        runBody("B8", concat(bytes("\x1b]0;title"), new Uint8Array([0x07])));
    });
    it("B9. kitty-protocol leak in the body (ESC [ 99;5u)", () => {
        runBody("B9", bytes("\x1b[99;5u"));
    });
    it("B10. multiple ESC-backslash occurrences in one body → all opaque, single block-end", () => {
        runBody("B10", concat(ESC_BACKSLASH, bytes("a"), ESC_BACKSLASH, bytes("b"), ESC_BACKSLASH));
    });
    it("B11. literal %end/%begin/%output text mid-line is not misparsed", () => {
        // Not at line start → block-body, never a notification/guard. (%-guards are
        // only recognised when % is the FIRST byte of a line.)
        runBody("B11", bytes("see %end and %begin and %output inline"));
    });
    it("B12. body containing 0xCC (data-frame disambiguator) and 0x00", () => {
        runBody("B12", new Uint8Array([0x61, 0xcc, 0x00, 0x62]));
    });
});
// --- C. Chunk-boundary / streaming robustness ---
describe("tc-44u4 C: chunk-boundary robustness (state machine resumable)", () => {
    it("C13. ESC and backslash split across two writes INSIDE a block body → opaque", () => {
        const tok = new ControlTokenizer();
        const tokens = [];
        tokens.push(...tok.push(bytes("%begin 1 1 0\nbody")));
        tokens.push(...tok.push(ESC)); // ESC arrives alone
        tokens.push(...tok.push(concat(new Uint8Array([0x5c]), bytes("more\n")))); // backslash + rest
        tokens.push(...tok.push(bytes("%end 1 1 0\n")));
        tokens.push(...tok.push(bytes("%output %1 ok\n")));
        assertNoDcsClose(tokens, "C13");
        assert.strictEqual(tokens.length, 4);
        assertBlockBody(tokens[1], concat(bytes("body"), ESC_BACKSLASH, bytes("more")), "C13.body");
        assertBlockEnd(tokens[2], 1, 1, 0, "C13.end");
        assertNotification(tokens[3], "output", "C13.trailing");
    });
    it("C14. ESC and backslash split across two writes at TOP LEVEL → real dcs-close", () => {
        const tok = new ControlTokenizer();
        const tokens = [];
        tokens.push(...tok.push(concat(DCS_INTRO, bytes("%pause\n"))));
        tokens.push(...tok.push(ESC)); // ESC of the closing ST, alone
        tokens.push(...tok.push(new Uint8Array([0x5c]))); // backslash completes ST
        assert.strictEqual(tokens.length, 3);
        assert.strictEqual(tokens[0].kind, "dcs-open");
        assertNotification(tokens[1], "pause", "C14");
        assert.strictEqual(tokens[2].kind, "dcs-close", "C14: top-level ST split across writes closes");
    });
    it("C15. %begin / %end markers split across writes → block still bounded", () => {
        const tok = new ControlTokenizer();
        const tokens = [];
        tokens.push(...tok.push(bytes("%beg")));
        tokens.push(...tok.push(bytes("in 1 1 0\n")));
        tokens.push(...tok.push(concat(bytes("x"), ESC_BACKSLASH, bytes("y\n"))));
        tokens.push(...tok.push(bytes("%en")));
        tokens.push(...tok.push(bytes("d 1 1 0\n")));
        tokens.push(...tok.push(bytes("%output %1 ok\n")));
        assertNoDcsClose(tokens, "C15");
        assert.strictEqual(tokens.length, 4);
        assertBlockBegin(tokens[0], 1, 1, 0, "C15.begin");
        assertBlockBody(tokens[1], concat(bytes("x"), ESC_BACKSLASH, bytes("y")), "C15.body");
        assertBlockEnd(tokens[2], 1, 1, 0, "C15.end");
        assertNotification(tokens[3], "output", "C15.trailing");
    });
    it("C16. DCS intro split byte-by-byte across writes → still opens", () => {
        const tok = new ControlTokenizer();
        const tokens = feedByteByByte(tok, concat(DCS_INTRO, bytes("%pause\n")));
        assert.strictEqual(tokens[0].kind, "dcs-open", "C16: byte-split DCS intro opens");
        assertNotification(tokens[1], "pause", "C16");
    });
});
// --- D. Real DCS close still works (no over-suppression) ---
describe("tc-44u4 D: real top-level DCS close still recognised", () => {
    it("D17. top-level clean closing ST → dcs-close + trailing bytes discarded", () => {
        const input = concat(DCS_INTRO, bytes("%pause\n"), ST, bytes("garbage\n"));
        const tokens = tokenizeBuffer(input);
        assert.strictEqual(tokens.length, 3);
        assert.strictEqual(tokens[0].kind, "dcs-open");
        assertNotification(tokens[1], "pause", "D17");
        assert.strictEqual(tokens[2].kind, "dcs-close");
    });
    it("D18. full session: DCS + several blocks + %output + top-level closing ST", () => {
        const input = concat(DCS_INTRO, bytes("%begin 1 1 0\n"), bytes("a"), ESC_BACKSLASH, // raw ST in body 1 — must stay opaque
        bytes("\n"), bytes("%end 1 1 0\n"), bytes("%output %1 mid\n"), bytes("%begin 2 2 0\nplain\n%end 2 2 0\n"), bytes("%sessions-changed\n"), ST);
        const tokens = tokenizeBuffer(input);
        assert.strictEqual(tokens.length, 10, `D18: expected 10 tokens, got ${tokens.length}`);
        assert.strictEqual(tokens[0].kind, "dcs-open", "D18[0]");
        assertBlockBegin(tokens[1], 1, 1, 0, "D18.begin1");
        assertBlockBody(tokens[2], concat(bytes("a"), ESC_BACKSLASH), "D18.body1");
        assertBlockEnd(tokens[3], 1, 1, 0, "D18.end1");
        assertNotification(tokens[4], "output", "D18.output");
        assertBlockBegin(tokens[5], 2, 2, 0, "D18.begin2");
        assertBlockBody(tokens[6], bytes("plain"), "D18.body2");
        assertBlockEnd(tokens[7], 2, 2, 0, "D18.end2");
        assertNotification(tokens[8], "sessions-changed", "D18.sessions-changed");
        assert.strictEqual(tokens[9].kind, "dcs-close", "D18: closing ST after all control lines");
    });
    it("D19. block opened then closed, THEN a top-level ESC-backslash → real close", () => {
        // Proves suppression is scoped to inside-block only; block state returns to
        // OUTSIDE after %end so the subsequent top-level ST is recognised.
        const input = concat(DCS_INTRO, bytes("%begin 1 1 0\n"), ESC_BACKSLASH, // opaque (inside block)
        bytes("\n"), bytes("%end 1 1 0\n"), ST);
        const tokens = tokenizeBuffer(input);
        assert.strictEqual(tokens.length, 5);
        assert.strictEqual(tokens[0].kind, "dcs-open");
        assertBlockBegin(tokens[1], 1, 1, 0, "D19.begin");
        assertBlockBody(tokens[2], ESC_BACKSLASH, "D19.body");
        assertBlockEnd(tokens[3], 1, 1, 0, "D19.end");
        assert.strictEqual(tokens[4].kind, "dcs-close", "D19: top-level ST after block closes DCS");
    });
});
// --- E. Property / fuzz: random bodies opaque + recovery preserved ---
describe("tc-44u4 E: fuzz — random block bodies stay opaque + recovery preserved", () => {
    // Deterministic LCG so failures are reproducible without a seed dependency.
    function makeRng(seed) {
        let s = seed >>> 0;
        return () => {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            return s;
        };
    }
    it("200 random bodies of arbitrary bytes: opaque body, block-end, trailing %output", () => {
        const rng = makeRng(0xc0ffee);
        for (let iter = 0; iter < 200; iter++) {
            // Random body length 0..63; bytes biased to include ESC, 0x5c, % and NUL.
            const len = rng() % 64;
            const body = new Uint8Array(len);
            for (let j = 0; j < len; j++) {
                const r = rng() % 16;
                body[j] =
                    r === 0 ? 0x1b : // ESC (to provoke MAYBE_ST)
                        r === 1 ? 0x5c : // backslash (to provoke ST completion)
                            r === 2 ? 0x25 : // '%'
                                r === 3 ? 0x00 : // NUL
                                    r === 4 ? 0xcc : // data-frame disambiguator
                                        (rng() % 256);
            }
            // A body line may not itself contain LF (LF terminates the line); strip
            // any to keep this a single-line body, matching the invariant under test.
            const oneLine = body.filter((b) => b !== LF_BYTE);
            const input = concat(bytes("%begin 1 1 0\n"), oneLine, bytes("\n"), bytes("%end 1 1 0\n"), bytes("%output %1 ok\n"));
            const tokens = tokenizeBuffer(input);
            assertNoDcsClose(tokens, `E.fuzz[${iter}]`);
            assert.strictEqual(tokens.length, 4, `E.fuzz[${iter}]: expected 4 tokens, got ${tokens.length}`);
            assertBlockBegin(tokens[0], 1, 1, 0, `E.fuzz[${iter}].begin`);
            assertBlockBody(tokens[1], oneLine, `E.fuzz[${iter}].body`);
            assertBlockEnd(tokens[2], 1, 1, 0, `E.fuzz[${iter}].end`);
            assertNotification(tokens[3], "output", `E.fuzz[${iter}].trailing`);
        }
    });
});
//# sourceMappingURL=tokenizer.test.js.map