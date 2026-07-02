/**
 * Unit tests for OscTitleSniffer (tc-2mn8).
 *
 * Coverage:
 *   - OSC-0 and OSC-2 both update pane_title.
 *   - BEL (0x07) terminator.
 *   - ST (ESC \, i.e. 0x1B 0x5C) terminator.
 *   - A sequence split across two %output chunks (cross-chunk buffering).
 *   - Non-title OSC numbers (1, 4, 8, 52, …) are ignored / passed through.
 *   - Embedded OSC bytes do not corrupt surrounding terminal output.
 *   - Empty title (shell cleared it) is a valid update.
 *   - Multiple sequences in a single chunk: last one wins (both fire).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OscTitleSniffer } from "./osc-title-sniffer.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ESC = 0x1b;
const BEL = 0x07;
const ST_BS = 0x5c; // \ (second byte of ESC \)
/** Encode a plain string to Uint8Array (UTF-8). */
function enc(s) {
    return new TextEncoder().encode(s);
}
/**
 * Build a byte array from a mix of strings and raw byte arrays.
 * Strings are UTF-8 encoded; Uint8Arrays are included verbatim.
 */
function bytes(...parts) {
    const chunks = [];
    for (const part of parts) {
        if (typeof part === "string") {
            chunks.push(new TextEncoder().encode(part));
        }
        else if (Array.isArray(part)) {
            chunks.push(new Uint8Array(part));
        }
        else {
            chunks.push(part);
        }
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
        out.set(c, pos);
        pos += c.length;
    }
    return out;
}
/** Build an OSC sequence with BEL terminator. */
function osc(ps, text) {
    return bytes([ESC, 0x5d], `${ps};${text}`, [BEL]);
}
/** Build an OSC sequence with ST (ESC \) terminator. */
function oscST(ps, text) {
    return bytes([ESC, 0x5d], `${ps};${text}`, [ESC, ST_BS]);
}
// ---------------------------------------------------------------------------
// OSC-0 and OSC-2 both update pane_title
// ---------------------------------------------------------------------------
describe("OscTitleSniffer – OSC-0 and OSC-2", () => {
    it("OSC-0 with BEL: updates title", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(0, "my shell title");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "my shell title");
    });
    it("OSC-2 with BEL: updates title", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(2, "window title");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "window title");
    });
    it("OSC-1 (icon name only): does NOT update title", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(1, "icon name");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-1 should not produce a title update");
    });
    it("OSC-4 (color palette): does NOT update title", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(4, "0;rgb:00/00/00");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-4 should not produce a title update");
    });
    it("OSC-8 (hyperlink): does NOT update title", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(8, ";;https://example.com");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-8 should not produce a title update");
    });
    it("OSC-52 (clipboard): does NOT update title", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(52, "c;Y2xpcGJvYXJk");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-52 should not produce a title update");
    });
});
// ---------------------------------------------------------------------------
// BEL terminator
// ---------------------------------------------------------------------------
describe("OscTitleSniffer – BEL terminator", () => {
    it("recognises BEL (0x07) as string terminator", () => {
        const sniffer = new OscTitleSniffer();
        // Manually construct: ESC ] 0 ; title BEL
        const input = bytes([ESC, 0x5d, 0x30, 0x3b], "hello", [BEL]);
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "hello");
    });
    it("plain terminal output after BEL is passed through", () => {
        const sniffer = new OscTitleSniffer();
        const input = bytes(osc(2, "title"), "$ prompt");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "title");
        // The plain bytes after the OSC sequence should be in passthrough.
        const passthroughStr = new TextDecoder().decode(result.passthrough);
        assert.equal(passthroughStr, "$ prompt");
    });
});
// ---------------------------------------------------------------------------
// ST (ESC \) terminator
// ---------------------------------------------------------------------------
describe("OscTitleSniffer – ESC-backslash (ST) terminator", () => {
    it("recognises ESC \\ (0x1B 0x5C) as string terminator", () => {
        const sniffer = new OscTitleSniffer();
        const input = oscST(2, "xterm title");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "xterm title");
    });
    it("OSC-0 with ST: updates title", () => {
        const sniffer = new OscTitleSniffer();
        const input = oscST(0, "icon + window");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "icon + window");
    });
    it("plain bytes after ST are passed through", () => {
        const sniffer = new OscTitleSniffer();
        const input = bytes(oscST(2, "T"), "ABC");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "T");
        assert.equal(new TextDecoder().decode(result.passthrough), "ABC");
    });
});
// ---------------------------------------------------------------------------
// Cross-chunk buffering: sequence split across two %output chunks
// ---------------------------------------------------------------------------
describe("OscTitleSniffer – cross-chunk buffering", () => {
    it("handles OSC-2 with BEL split across two chunks", () => {
        const sniffer = new OscTitleSniffer();
        // Chunk 1: ESC ] 2 ; hel  (no terminator yet)
        const chunk1 = bytes([ESC, 0x5d, 0x32, 0x3b], "hel");
        // Chunk 2: lo BEL  (terminator arrives here)
        const chunk2 = bytes("lo", [BEL]);
        const r1 = sniffer.feed(chunk1);
        assert.equal(r1.updatedTitle, null, "no title yet after chunk 1");
        const r2 = sniffer.feed(chunk2);
        assert.equal(r2.updatedTitle, "hello");
    });
    it("handles OSC-2 with ST split across two chunks (ESC in chunk 1, \\ in chunk 2)", () => {
        const sniffer = new OscTitleSniffer();
        // Chunk 1: ESC ] 2 ; split ESC
        const chunk1 = bytes([ESC, 0x5d, 0x32, 0x3b], "split", [ESC]);
        // Chunk 2: \  (the backslash that completes the ST)
        const chunk2 = bytes([ST_BS]);
        const r1 = sniffer.feed(chunk1);
        assert.equal(r1.updatedTitle, null, "no title yet after chunk 1");
        const r2 = sniffer.feed(chunk2);
        assert.equal(r2.updatedTitle, "split");
    });
    it("handles BEL split — intro in chunk 1, BEL alone in chunk 2", () => {
        const sniffer = new OscTitleSniffer();
        const full = osc(0, "split-title");
        // Split just before the BEL byte (last byte)
        const chunk1 = full.subarray(0, full.length - 1);
        const chunk2 = full.subarray(full.length - 1);
        const r1 = sniffer.feed(chunk1);
        assert.equal(r1.updatedTitle, null);
        const r2 = sniffer.feed(chunk2);
        assert.equal(r2.updatedTitle, "split-title");
    });
    it("handles OSC Ps split — digits spanning two chunks", () => {
        const sniffer = new OscTitleSniffer();
        // Chunk 1: ESC ]
        const chunk1 = bytes([ESC, 0x5d]);
        // Chunk 2: 2 ; my-title BEL
        const chunk2 = bytes([0x32, 0x3b], "my-title", [BEL]);
        const r1 = sniffer.feed(chunk1);
        assert.equal(r1.updatedTitle, null);
        const r2 = sniffer.feed(chunk2);
        assert.equal(r2.updatedTitle, "my-title");
    });
    it("handles a sequence split right after the ESC byte", () => {
        const sniffer = new OscTitleSniffer();
        // Chunk 1: just ESC
        const r1 = sniffer.feed(bytes([ESC]));
        assert.equal(r1.updatedTitle, null);
        // Chunk 2: ] 2 ; title BEL
        const r2 = sniffer.feed(bytes([0x5d, 0x32, 0x3b], "title", [BEL]));
        assert.equal(r2.updatedTitle, "title");
    });
});
// ---------------------------------------------------------------------------
// Non-title OSC numbers are passed through (not stripped)
// ---------------------------------------------------------------------------
describe("OscTitleSniffer – non-title OSC numbers passed through", () => {
    it("OSC-1 followed by OSC-2 in same chunk: only OSC-2 fires; OSC-1 passes through", () => {
        const sniffer = new OscTitleSniffer();
        const osc1 = osc(1, "icon-name");
        const osc2 = osc(2, "real-title");
        const input = bytes(osc1, osc2);
        const result = sniffer.feed(input);
        // The title from OSC-2 should win; OSC-1 should not emit a title.
        assert.equal(result.updatedTitle, "real-title");
        // OSC-1 passes through verbatim; OSC-2 (title) is stripped.
        assert.deepEqual(result.passthrough, osc1);
    });
    it("non-title OSC bytes pass through unchanged alongside surrounding text", () => {
        const sniffer = new OscTitleSniffer();
        // OSC-8 (hyperlink): must pass through byte-for-byte; must NOT update title.
        const osc8 = osc(8, ";;url");
        const input = bytes("pre", osc8, "post");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-8 should not produce a title");
        const expected = bytes("pre", osc8, "post");
        assert.deepEqual(result.passthrough, expected);
    });
});
// ---------------------------------------------------------------------------
// Passthrough correctness: OSC bytes don't corrupt surrounding output
// ---------------------------------------------------------------------------
describe("OscTitleSniffer – passthrough correctness", () => {
    it("plain bytes around an OSC are passed through unchanged", () => {
        const sniffer = new OscTitleSniffer();
        const input = bytes("BEFORE", osc(2, "title"), "AFTER");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "title");
        const passthroughStr = new TextDecoder().decode(result.passthrough);
        assert.equal(passthroughStr, "BEFOREAFTER");
    });
    it("no OSC in chunk: returns same Uint8Array (no copy)", () => {
        const sniffer = new OscTitleSniffer();
        const input = enc("no escape sequences here");
        const result = sniffer.feed(input);
        // Fast path: same reference (no allocation).
        assert.equal(result.passthrough, input);
        assert.equal(result.updatedTitle, null);
    });
    it("multiple OSC-2 in one chunk: second title wins, all OSC stripped from passthrough", () => {
        const sniffer = new OscTitleSniffer();
        const input = bytes(osc(2, "first"), enc("mid"), osc(2, "second"));
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "second");
        const passthroughStr = new TextDecoder().decode(result.passthrough);
        assert.equal(passthroughStr, "mid");
    });
    it("non-ESC bytes including 0x07 (BEL) in plain text don't trigger OSC parsing", () => {
        // BEL in plain text is fine — we only treat it as a terminator when we're
        // already inside an OSC. Outside an OSC it should pass through.
        //
        // Wait — actually BEL in IDLE state IS passed through as a plain byte.
        // The sniffer only intercepts ESC to enter OSC. BEL alone in IDLE is transparent.
        const sniffer = new OscTitleSniffer();
        const input = bytes("hello", [BEL], "world");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null);
        // BEL passes through as-is in IDLE mode.
        assert.deepEqual(Array.from(result.passthrough), [
            ...Array.from(enc("hello")),
            BEL,
            ...Array.from(enc("world")),
        ]);
    });
    it("ESC followed by a non-OSC character is flushed to passthrough", () => {
        // ESC not followed by ] should emit the ESC as passthrough (not OSC).
        const sniffer = new OscTitleSniffer();
        // ESC [A (cursor up — a common ANSI escape, NOT an OSC)
        const input = bytes([ESC, 0x5b, 0x41], "text");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null);
        // All bytes should pass through (ESC [ A are ANSI CSI, not OSC).
        const passthroughStr = new TextDecoder().decode(result.passthrough);
        assert.equal(passthroughStr, "\x1b[Atext");
    });
    it("empty title (empty string after ;) is a valid title update", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(2, ""); // ESC ] 2 ; BEL
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "");
    });
    it("title with spaces and special characters is preserved", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(0, "~/projects/my-app — zsh");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "~/projects/my-app — zsh");
    });
    it("UTF-8 title characters are decoded correctly", () => {
        const sniffer = new OscTitleSniffer();
        // A title with a non-ASCII character (e.g. emojis or accented chars)
        const input = osc(2, "résumé");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "résumé");
    });
    it("multiple chunks with plain terminal output between sessions: state is preserved", () => {
        const sniffer = new OscTitleSniffer();
        // First OSC-2 completes in chunk 1.
        const r1 = sniffer.feed(bytes(osc(2, "initial"), "$ "));
        assert.equal(r1.updatedTitle, "initial");
        assert.equal(new TextDecoder().decode(r1.passthrough), "$ ");
        // Then a split title: chunk 2 has the intro, chunk 3 has the ending.
        const r2 = sniffer.feed(bytes([ESC, 0x5d, 0x32, 0x3b], "new-ti"));
        assert.equal(r2.updatedTitle, null);
        const r3 = sniffer.feed(bytes("tle", [BEL], "# "));
        assert.equal(r3.updatedTitle, "new-title");
        assert.equal(new TextDecoder().decode(r3.passthrough), "# ");
    });
});
// ---------------------------------------------------------------------------
// Regression tests (tc-2mn8 review findings)
// ---------------------------------------------------------------------------
describe("OscTitleSniffer – regression: non-title OSC passthrough (Bug 1)", () => {
    it("OSC-52 complete sequence: exact input bytes in passthrough, updatedTitle===null", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(52, "c;Y2xpcGJvYXJk"); // clipboard read/write
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-52 must not update title");
        assert.deepEqual(result.passthrough, input, "OSC-52 must pass through byte-for-byte");
    });
    it("OSC-8 complete sequence: exact input bytes in passthrough, updatedTitle===null", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(8, ";;https://example.com"); // hyperlink
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-8 must not update title");
        assert.deepEqual(result.passthrough, input, "OSC-8 must pass through byte-for-byte");
    });
    it("OSC-4 complete sequence: exact input bytes in passthrough, updatedTitle===null", () => {
        const sniffer = new OscTitleSniffer();
        const input = osc(4, "0;rgb:ff/00/00"); // color palette
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null, "OSC-4 must not update title");
        assert.deepEqual(result.passthrough, input, "OSC-4 must pass through byte-for-byte");
    });
    it("non-title OSC with ST (ESC \\) terminator: exact input bytes in passthrough", () => {
        const sniffer = new OscTitleSniffer();
        const input = oscST(8, ";;https://st-example.com");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, null);
        assert.deepEqual(result.passthrough, input, "OSC-8 with ST must pass through byte-for-byte");
    });
    it("non-title OSC split across two chunks: concatenated passthrough == concatenated input", () => {
        const sniffer = new OscTitleSniffer();
        const full = osc(52, "c;dGVzdA==");
        // Split after the intro (after `ESC ] 5 2 ;`)
        const splitAt = 5; // ESC ] 5 2 ;  = 5 bytes
        const chunk1 = full.subarray(0, splitAt);
        const chunk2 = full.subarray(splitAt);
        const r1 = sniffer.feed(chunk1);
        assert.equal(r1.updatedTitle, null);
        const r2 = sniffer.feed(chunk2);
        assert.equal(r2.updatedTitle, null);
        // Concatenated passthrough must equal the full input.
        const combined = bytes(r1.passthrough, r2.passthrough);
        assert.deepEqual(combined, full, "split non-title OSC passthrough must equal original");
    });
});
describe("OscTitleSniffer – regression: out buffer sizing (Bug 2)", () => {
    it("split ESC then passthrough: no byte lost across chunk boundary", () => {
        const sniffer = new OscTitleSniffer();
        // chunk1 ends with a lone ESC (buffered, not yet emitted)
        const chunk1 = bytes("x", [ESC]);
        // chunk2 continues with CSI sequence — ESC was NOT an OSC opener
        const chunk2 = bytes([0x5b, 0x30, 0x6d], " hi"); // [0m hi
        const r1 = sniffer.feed(chunk1);
        const r2 = sniffer.feed(chunk2);
        // Concat passthrough must equal "x" + ESC + "[0m hi" — no bytes dropped
        const combined = bytes(r1.passthrough, r2.passthrough);
        const expected = bytes("x", [ESC, 0x5b, 0x30, 0x6d], " hi");
        assert.deepEqual(combined, expected, "no bytes must be dropped across chunk boundary");
    });
    it("split ESC then large passthrough: all bytes survive when chunk2 > chunk1", () => {
        const sniffer = new OscTitleSniffer();
        // chunk1: lone ESC (1 byte buffered)
        const chunk1 = bytes([ESC]);
        // chunk2: non-OSC continuation + lots of text
        const longText = "A".repeat(200);
        const chunk2 = bytes([0x5b, 0x41], longText); // [A (cursor up) then text
        const r1 = sniffer.feed(chunk1);
        const r2 = sniffer.feed(chunk2);
        const combined = bytes(r1.passthrough, r2.passthrough);
        const expected = bytes([ESC, 0x5b, 0x41], longText);
        assert.deepEqual(combined, expected);
    });
});
describe("OscTitleSniffer – regression: existing title behavior preserved (Bug 1 & 2)", () => {
    it("OSC-0 still stripped from passthrough and still updates title", () => {
        const sniffer = new OscTitleSniffer();
        const input = bytes("pre", osc(0, "shell title"), "post");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "shell title");
        assert.equal(new TextDecoder().decode(result.passthrough), "prepost");
    });
    it("OSC-2 still stripped from passthrough and still updates title", () => {
        const sniffer = new OscTitleSniffer();
        const input = bytes("A", osc(2, "win title"), "B");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "win title");
        assert.equal(new TextDecoder().decode(result.passthrough), "AB");
    });
    it("OSC-2 with ST still stripped and still updates title", () => {
        const sniffer = new OscTitleSniffer();
        const input = oscST(2, "st-title");
        const result = sniffer.feed(input);
        assert.equal(result.updatedTitle, "st-title");
        assert.equal(result.passthrough.length, 0);
    });
});
// Integration-style tests (paneTitle in model+projection) live in
// src/state/pane-title.test.ts to avoid the parser-no-wire boundary
// restriction (src/parser/ must not import from src/wire/).
//# sourceMappingURL=osc-title-sniffer.test.js.map