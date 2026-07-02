/**
 * Unit tests for the pane attention/status escape scanner (tc-76m8.1, S9).
 *
 * Covers the AC: sequences split across chunk boundaries, notifications
 * interleaved with plain output, the recognizer set (OSC 9 / 777 / BEL /
 * ConEmu 9;4 / OSC 633;D), the passthrough-never-lossy contract (a BEL that
 * terminates a title/DCS is NOT miscounted as a bell), and the bounded state
 * machine (over-long unterminated sequences abort rather than buffer forever).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PaneNotifyScanner, parseOscContent, type PaneNotifyDetection } from "./notify-scanner.js";

// ---------------------------------------------------------------------------
// Byte builders
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const BEL = 0x07;

/** Concatenate strings (ASCII) and raw byte numbers into a Uint8Array. */
function seq(...parts: Array<string | number>): Uint8Array {
  const bytes: number[] = [];
  for (const p of parts) {
    if (typeof p === "number") bytes.push(p);
    else for (const ch of p) bytes.push(ch.charCodeAt(0));
  }
  return Uint8Array.from(bytes);
}

/** Scan a single chunk and return the detections. */
function scanOnce(chunk: Uint8Array): PaneNotifyDetection[] {
  return new PaneNotifyScanner().scan(chunk);
}

// ---------------------------------------------------------------------------
// Recognizers
// ---------------------------------------------------------------------------

describe("notify-scanner: recognizers", () => {
  it("standalone BEL → bell", () => {
    const d = scanOnce(seq("done", BEL));
    assert.deepEqual(d, [{ kind: "bell" }]);
  });

  it("OSC 9 desktop notification (BEL-terminated) → osc9 with body", () => {
    const d = scanOnce(seq(ESC, "]9;Build finished", BEL));
    assert.deepEqual(d, [{ kind: "osc9", payload: { message: "Build finished", source: "osc9" } }]);
  });

  it("OSC 9 notification (ESC\\ ST-terminated) → osc9", () => {
    const d = scanOnce(seq(ESC, "]9;hello", ESC, "\\"));
    assert.deepEqual(d, [{ kind: "osc9", payload: { message: "hello", source: "osc9" } }]);
  });

  it("OSC 9 body may contain semicolons", () => {
    const d = scanOnce(seq(ESC, "]9;a;b;c", BEL));
    assert.deepEqual(d, [{ kind: "osc9", payload: { message: "a;b;c", source: "osc9" } }]);
  });

  it("OSC 777 notify;title;body → osc9 with title + message (source osc777)", () => {
    const d = scanOnce(seq(ESC, "]777;notify;agent;needs input", BEL));
    assert.deepEqual(d, [
      { kind: "osc9", payload: { message: "needs input", title: "agent", source: "osc777" } },
    ]);
  });

  it("OSC 777 non-notify sub-command → ignored", () => {
    assert.deepEqual(scanOnce(seq(ESC, "]777;precmd;stuff", BEL)), []);
  });

  it("ConEmu OSC 9;4;1;<pr> → progress set", () => {
    const d = scanOnce(seq(ESC, "]9;4;1;42", BEL));
    assert.deepEqual(d, [{ kind: "progress", payload: { progressState: "set", progress: 42 } }]);
  });

  it("ConEmu OSC 9;4;0 → progress remove (no percentage)", () => {
    const d = scanOnce(seq(ESC, "]9;4;0", BEL));
    assert.deepEqual(d, [{ kind: "progress", payload: { progressState: "remove" } }]);
  });

  it("ConEmu OSC 9;4;3 → indeterminate (no percentage)", () => {
    const d = scanOnce(seq(ESC, "]9;4;3", BEL));
    assert.deepEqual(d, [{ kind: "progress", payload: { progressState: "indeterminate" } }]);
  });

  it("ConEmu progress clamps out-of-range percentage to 0..100", () => {
    assert.deepEqual(scanOnce(seq(ESC, "]9;4;2;250", BEL)), [
      { kind: "progress", payload: { progressState: "error", progress: 100 } },
    ]);
  });

  it("OSC 9 body literally '4;text' (not a valid state digit) → osc9 notification, not progress", () => {
    const d = scanOnce(seq(ESC, "]9;4;text", BEL));
    // "4;t" — 't' is not a 0..4 state digit, so this is a plain notification body.
    assert.deepEqual(d, [{ kind: "osc9", payload: { message: "4;text", source: "osc9" } }]);
  });

  it("OSC 633;D;1 → cmd-exit with exitCode", () => {
    const d = scanOnce(seq(ESC, "]633;D;1", BEL));
    assert.deepEqual(d, [{ kind: "cmd-exit", payload: { exitCode: 1 } }]);
  });

  it("OSC 633;D (no code) → cmd-exit with no exitCode", () => {
    const d = scanOnce(seq(ESC, "]633;D", BEL));
    assert.deepEqual(d, [{ kind: "cmd-exit" }]);
  });

  it("OSC 633 non-D sub-command (e.g. prompt-start A) → ignored", () => {
    assert.deepEqual(scanOnce(seq(ESC, "]633;A", BEL)), []);
  });
});

// ---------------------------------------------------------------------------
// Passthrough-never-lossy: a BEL/ST that terminates another sequence is not a bell
// ---------------------------------------------------------------------------

describe("notify-scanner: title/string terminators are not miscounted", () => {
  it("OSC 0 title (BEL-terminated) emits NO bell (BEL is the OSC terminator)", () => {
    assert.deepEqual(scanOnce(seq(ESC, "]0;my title", BEL)), []);
  });

  it("OSC 2 title (ESC\\-terminated) emits nothing", () => {
    assert.deepEqual(scanOnce(seq(ESC, "]2;win", ESC, "\\")), []);
  });

  it("OSC 8 hyperlink emits nothing", () => {
    assert.deepEqual(scanOnce(seq(ESC, "]8;;https://x", BEL)), []);
  });

  it("OSC 1337 (iTerm2 proprietary) is consumed, emits nothing", () => {
    assert.deepEqual(scanOnce(seq(ESC, "]1337;SetMark", BEL)), []);
  });

  it("DCS with an embedded BEL emits NO bell (STRING state consumes it)", () => {
    // ESC P <data> BEL — a BEL inside a DCS string is the terminator, not a bell.
    assert.deepEqual(scanOnce(seq(ESC, "P1;2;3q", BEL)), []);
  });

  it("APC string (ESC _ … ESC\\) emits nothing", () => {
    assert.deepEqual(scanOnce(seq(ESC, "_tmux;stuff", ESC, "\\")), []);
  });

  it("a CSI sequence is ignored, and a following BEL is still a real bell", () => {
    const d = scanOnce(seq(ESC, "[0m", BEL));
    assert.deepEqual(d, [{ kind: "bell" }]);
  });
});

// ---------------------------------------------------------------------------
// Interleaving + ordering
// ---------------------------------------------------------------------------

describe("notify-scanner: interleaved with output", () => {
  it("plain output around a bell and an OSC 9 yields both, in order", () => {
    const chunk = seq(
      "hello world\n",
      BEL,
      "more output ",
      ESC, "]9;ping", BEL,
      " trailing",
    );
    assert.deepEqual(scanOnce(chunk), [
      { kind: "bell" },
      { kind: "osc9", payload: { message: "ping", source: "osc9" } },
    ]);
  });

  it("multiple bells in one chunk each emit", () => {
    assert.deepEqual(scanOnce(seq(BEL, "x", BEL, "y", BEL)), [
      { kind: "bell" },
      { kind: "bell" },
      { kind: "bell" },
    ]);
  });

  it("pure plain output yields no detections (fast path)", () => {
    assert.deepEqual(scanOnce(seq("just some normal text with ; and ] but no escapes")), []);
  });
});

// ---------------------------------------------------------------------------
// Chunk-boundary splits (the streaming contract)
// ---------------------------------------------------------------------------

describe("notify-scanner: chunk-boundary splits", () => {
  it("OSC 9 split after ESC ] is reassembled across two chunks", () => {
    const scanner = new PaneNotifyScanner();
    assert.deepEqual(scanner.scan(seq(ESC, "]9;par")), []);
    assert.deepEqual(scanner.scan(seq("tial", BEL)), [
      { kind: "osc9", payload: { message: "partial", source: "osc9" } },
    ]);
  });

  it("split at every single byte still yields exactly one detection", () => {
    const full = seq(ESC, "]777;notify;t;body", BEL);
    const scanner = new PaneNotifyScanner();
    const all: PaneNotifyDetection[] = [];
    for (let i = 0; i < full.length; i++) {
      all.push(...scanner.scan(full.subarray(i, i + 1)));
    }
    assert.deepEqual(all, [
      { kind: "osc9", payload: { message: "body", title: "t", source: "osc777" } },
    ]);
  });

  it("ESC\\ terminator split across the ESC and the backslash is recognised", () => {
    const scanner = new PaneNotifyScanner();
    assert.deepEqual(scanner.scan(seq(ESC, "]9;hi", ESC)), []);
    assert.deepEqual(scanner.scan(seq("\\")), [
      { kind: "osc9", payload: { message: "hi", source: "osc9" } },
    ]);
  });

  it("a bell split from its surrounding output emits once at the right chunk", () => {
    const scanner = new PaneNotifyScanner();
    assert.deepEqual(scanner.scan(seq("abc")), []);
    assert.deepEqual(scanner.scan(seq(BEL)), [{ kind: "bell" }]);
    assert.deepEqual(scanner.scan(seq("def")), []);
  });
});

// ---------------------------------------------------------------------------
// Bounded state machine
// ---------------------------------------------------------------------------

describe("notify-scanner: bounded (no unbounded buffering)", () => {
  it("an over-long unterminated OSC aborts, and a later valid sequence still works", () => {
    const scanner = new PaneNotifyScanner();
    // 8 KiB of OSC content with no terminator — exceeds the 4 KiB bound.
    const huge = new Uint8Array(8 * 1024).fill(0x41); // 'A'
    scanner.scan(seq(ESC, "]9;"));
    scanner.scan(huge); // must not throw / must not grow unbounded
    // The aborted OSC leaves the scanner able to recognise a fresh signal.
    assert.deepEqual(scanner.scan(seq(BEL)), [{ kind: "bell" }]);
    assert.deepEqual(scanner.scan(seq(ESC, "]9;ok", BEL)), [
      { kind: "osc9", payload: { message: "ok", source: "osc9" } },
    ]);
  });

  it("ESC ESC re-arms without emitting", () => {
    // ESC ESC ] 9 ; ... — the second ESC starts the real introducer.
    assert.deepEqual(scanOnce(seq(ESC, ESC, "]9;x", BEL)), [
      { kind: "osc9", payload: { message: "x", source: "osc9" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pure content parser (edge cases)
// ---------------------------------------------------------------------------

describe("notify-scanner: parseOscContent edge cases", () => {
  it("bare '9' with no body → osc9 with empty message", () => {
    assert.deepEqual(parseOscContent("9"), { kind: "osc9", payload: { message: "", source: "osc9" } });
  });

  it("unknown OSC number → null", () => {
    assert.equal(parseOscContent("52;c;stuff"), null);
  });

  it("empty content → null", () => {
    assert.equal(parseOscContent(""), null);
  });
});
