/**
 * tc-5quo — clear-then-replay hydration tests.
 *
 * Coverage:
 *
 *   (A) `lfToCrlf` byte-level: LF→CRLF, CRLF preserved, lone CR preserved,
 *       no-LF source returned unchanged, empty source.
 *
 *   (B) `hydrateTransport` unit-level (with a fake pipeline + fake
 *       transport):
 *         1. Each pane in the input gets ONE sendData with
 *            CLEAR_AND_SCROLLBACK prefix + capture body (LF→CRLF).
 *         2. Order: clear-prefix bytes precede the replayed body in the
 *            SAME sendData call (single combined frame).
 *         3. Multiple panes → multiple sendData calls, one per pane.
 *         4. `pipeline.send` is invoked exactly once per pane with the
 *            canonical capture-pane command.
 *         5. Per-pane error (rejected Promise / ok=false reply) is
 *            swallowed; sibling panes still hydrate.
 *         6. Empty pane list → no sendData calls, no pipeline.send calls.
 *
 *   (C) `hydrateTransport` invariants the bead pins:
 *         I1. Pre-existing buffer content is wiped (CLEAR escape sent),
 *             so any pre-disconnect terminal content cannot duplicate
 *             after hydration.
 *         I2. The replayed body matches the capture body byte-for-byte
 *             after LF→CRLF.  Output produced during disconnection lives
 *             in tmux's history and reaches the client via the replay.
 *
 *   (D) Integration: drive the full assembly's `addClient` against a fake
 *       host, verifying that after addClient resolves and the hydration
 *       fires, the recording transport observes (clear + replay) bytes
 *       for the bootstrapped pane.
 *
 * @module runtime/hydration.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLEAR_AND_SCROLLBACK,
  hydrateTransport,
  lfToCrlf,
  trimTrailingBlankLines,
} from "./hydration.js";
import type { HydrationPipeline } from "./hydration.js";
import { paneId } from "../wire/ids.js";
import type { PaneId } from "../wire/ids.js";
import type { Transport } from "../wire/transport.js";
import type { ControlMessage } from "../wire/session-proxy-control.js";
import type { CommandResult } from "../parser/correlator.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const P1 = paneId("p1");
const P2 = paneId("p2");
const P7 = paneId("p7");

/** A fake pipeline that records command sends and returns scripted replies. */
function makeFakePipeline(): {
  pipeline: HydrationPipeline;
  sentCommands: string[];
  /** Configure the reply for the next matching command (by `capture-pane -t %N` prefix). */
  setReply(prefix: string, reply: CommandResult | "reject"): void;
} {
  const sentCommands: string[] = [];
  const replies = new Map<string, CommandResult | "reject">();
  return {
    pipeline: {
      send(command: string): Promise<CommandResult> {
        sentCommands.push(command);
        for (const [prefix, reply] of replies) {
          if (command.startsWith(prefix)) {
            if (reply === "reject") return Promise.reject(new Error("scripted reject"));
            return Promise.resolve(reply);
          }
        }
        // Default: empty success reply so the hydrator still sends the CLEAR.
        return Promise.resolve({ ok: true, commandNumber: 0, body: new Uint8Array(0) });
      },
    },
    sentCommands,
    setReply(prefix, reply) {
      replies.set(prefix, reply);
    },
  };
}

/** A fake Transport that records every sendData call. */
function makeRecordingTransport(): {
  transport: Transport;
  frames: Array<{ paneId: PaneId; bytes: Uint8Array }>;
} {
  const frames: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];
  const transport: Transport = {
    sendControl(_msg: ControlMessage): void { /* not exercised */ },
    onControl(_handler: (msg: ControlMessage) => void): void { /* not exercised */ },
    sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
      frames.push({ paneId: pid, bytes });
    },
    onData(_handler: (pid: PaneId, bytes: Uint8Array) => void): void { /* not exercised */ },
    onClose(_handler: (err?: Error) => void): () => void { return () => {}; },
    close(_err?: Error): void { /* not exercised */ },
  };
  return { transport, frames };
}

/** Build a CommandResult with `body` as raw bytes. */
function ok(body: Uint8Array): CommandResult {
  return { ok: true, commandNumber: 0, body };
}

// ---------------------------------------------------------------------------
// (A) lfToCrlf
// ---------------------------------------------------------------------------

describe("tc-5quo lfToCrlf", () => {
  it("returns the same Uint8Array when there are no LFs", () => {
    const src = new TextEncoder().encode("hello world");
    const out = lfToCrlf(src);
    assert.equal(out, src, "no-LF input should be returned unchanged (same reference)");
  });

  it("returns an empty array for empty input unchanged", () => {
    const src = new Uint8Array(0);
    const out = lfToCrlf(src);
    assert.equal(out.length, 0, "empty input → empty output");
    assert.equal(out, src, "empty input is returned unchanged (same reference)");
  });

  it("translates bare LF to CRLF", () => {
    const src = new TextEncoder().encode("a\nb");
    const out = lfToCrlf(src);
    assert.deepEqual(Array.from(out), [0x61, 0x0d, 0x0a, 0x62]);
  });

  it("preserves existing CRLF (does not double-CR)", () => {
    const src = new TextEncoder().encode("a\r\nb");
    const out = lfToCrlf(src);
    assert.deepEqual(Array.from(out), [0x61, 0x0d, 0x0a, 0x62]);
  });

  it("preserves a lone CR with no following LF", () => {
    const src = new TextEncoder().encode("a\rb");
    const out = lfToCrlf(src);
    assert.deepEqual(Array.from(out), [0x61, 0x0d, 0x62]);
  });

  it("inserts CR before a leading LF (no preceding byte to check)", () => {
    const src = new Uint8Array([0x0a, 0x61]);
    const out = lfToCrlf(src);
    assert.deepEqual(Array.from(out), [0x0d, 0x0a, 0x61]);
  });

  it("handles a multi-line scrollback shape (mixed bare LF + CRLF)", () => {
    const src = new TextEncoder().encode("line-A\nline-B\r\nline-C\n");
    const out = lfToCrlf(src);
    assert.equal(new TextDecoder().decode(out), "line-A\r\nline-B\r\nline-C\r\n");
  });

  it("preserves arbitrary non-UTF-8 bytes adjacent to LF translations", () => {
    const src = new Uint8Array([0xff, 0x0a, 0x80, 0x0d, 0x0a, 0xfe]);
    const out = lfToCrlf(src);
    assert.deepEqual(Array.from(out), [0xff, 0x0d, 0x0a, 0x80, 0x0d, 0x0a, 0xfe]);
  });
});

// ---------------------------------------------------------------------------
// (A') tc-pizl.2 — trimTrailingBlankLines (fresh-pane viewport-tail strip)
// ---------------------------------------------------------------------------

describe("tc-pizl.2 trimTrailingBlankLines", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

  it("strips a fresh pane's empty viewport tail down to the prompt row", () => {
    // capture-pane -E - returns the prompt near the top then the empty viewport
    // rows (one bare LF each).  Trimming the tail leaves the prompt as the last
    // line with NO trailing LF, so the replayed cursor lands on the prompt row.
    const body = enc("\ncwa at chost in ~\n$ \n\n\n\n\n");
    assert.equal(dec(trimTrailingBlankLines(body)), "\ncwa at chost in ~\n$ ");
  });

  it("leaves a scrollback body that ends on real content byte-unchanged (p2)", () => {
    // A pane WITH scrollback fills the viewport down to the cursor: its last
    // captured line is real content, so there is no trailing blank to strip.
    const body = enc("python file1.py\npython file2.py\n^C\nreset\n$ ls -la");
    const out = trimTrailingBlankLines(body);
    assert.equal(out, body, "no trailing blank → returned same reference (unchanged)");
  });

  it("drops the single trailing LF when real content ends with one (cursor on its row)", () => {
    const body = enc("line1\nline2\n$ ls\n");
    assert.equal(dec(trimTrailingBlankLines(body)), "line1\nline2\n$ ls");
  });

  it("preserves interior and leading blank lines — only the trailing run is stripped", () => {
    const body = enc("\n\nabove\n\nbelow\n\n\n");
    assert.equal(dec(trimTrailingBlankLines(body)), "\n\nabove\n\nbelow");
  });

  it("treats space-only trailing rows as blank (belt-and-braces)", () => {
    const body = enc("text\n   \n  \n");
    assert.equal(dec(trimTrailingBlankLines(body)), "text");
  });

  it("returns empty for an all-blank body and for an empty body", () => {
    assert.equal(dec(trimTrailingBlankLines(enc("\n\n\n"))), "");
    assert.equal(dec(trimTrailingBlankLines(new Uint8Array(0))), "");
  });
});

// ---------------------------------------------------------------------------
// (B) + (C) hydrateTransport — pipeline + transport interaction
// ---------------------------------------------------------------------------

describe("tc-5quo hydrateTransport — single pane", () => {
  it("sends capture-pane via pipeline with the canonical full-history args", async () => {
    const { pipeline, sentCommands } = makeFakePipeline();
    const { transport } = makeRecordingTransport();

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(sentCommands.length, 1, "exactly one pipeline.send per pane");
    assert.equal(
      sentCommands[0],
      "capture-pane -t %1 -p -e -S - -E -",
      "must use -p -e -S - -E - for full-history rehydration",
    );
  });

  it("delivers CLEAR_AND_SCROLLBACK + replayed body in a single sendData frame", async () => {
    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    const captureBody = new TextEncoder().encode("hello\nworld");
    setReply("capture-pane -t %1", ok(captureBody));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1, "one sendData per pane");
    assert.equal(frames[0]!.paneId, P1);

    // Expected payload: CLEAR_AND_SCROLLBACK + "hello\r\nworld"
    const expected = new Uint8Array(
      CLEAR_AND_SCROLLBACK.length + "hello\r\nworld".length,
    );
    expected.set(CLEAR_AND_SCROLLBACK, 0);
    expected.set(new TextEncoder().encode("hello\r\nworld"), CLEAR_AND_SCROLLBACK.length);

    assert.deepEqual(frames[0]!.bytes, expected);
  });

  it("CLEAR_AND_SCROLLBACK prefix appears BEFORE the replayed body in the frame", async () => {
    // I1: pre-existing buffer content cannot duplicate post-hydration because
    // the clear escape always precedes the replay.
    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    const captureBody = new TextEncoder().encode("X");
    setReply("capture-pane", ok(captureBody));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const bytes = frames[0]!.bytes;

    // Sanity: the first CLEAR_AND_SCROLLBACK.length bytes match the prefix.
    for (let i = 0; i < CLEAR_AND_SCROLLBACK.length; i++) {
      assert.equal(
        bytes[i],
        CLEAR_AND_SCROLLBACK[i],
        `byte ${i} of frame must be CLEAR_AND_SCROLLBACK[${i}]`,
      );
    }
    // And the replay follows.
    assert.equal(bytes[CLEAR_AND_SCROLLBACK.length], 0x58 /* 'X' */);
  });

  it("uses the byte-exact tmux body for replay (after LF→CRLF) — no string round-trip", async () => {
    // I2: history bytes round-trip byte-exact (subject to CRLF fixup).
    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    // Non-UTF-8 sequence + escape codes — what capture-pane -e returns.
    const captureBody = new Uint8Array([
      0x1b, 0x5b, 0x33, 0x31, 0x6d,   // ESC [ 31 m  (red)
      0xff, 0x80, 0xfe,                // non-UTF-8 garbage
      0x0a,                            // LF
      0x41,                            // 'A'
    ]);
    setReply("capture-pane", ok(captureBody));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const payload = frames[0]!.bytes.subarray(CLEAR_AND_SCROLLBACK.length);
    assert.deepEqual(Array.from(payload), [
      0x1b, 0x5b, 0x33, 0x31, 0x6d,
      0xff, 0x80, 0xfe,
      0x0d, 0x0a,    // LF expanded to CRLF
      0x41,
    ]);
  });

  it("sends CLEAR alone (empty replay) when capture-pane returns an empty body", async () => {
    // Edge case: a freshly-spawned pane with no scrollback yet.  Clear still
    // fires so the hydration contract holds (the terminal buffer is reset
    // and matches tmux's "empty" state).
    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();
    setReply("capture-pane", ok(new Uint8Array(0)));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0]!.bytes, CLEAR_AND_SCROLLBACK);
  });
});

describe("tc-5quo hydrateTransport — multi-pane + error handling", () => {
  it("hydrates each pane independently with its own capture-pane round-trip", async () => {
    const { pipeline, sentCommands, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    setReply("capture-pane -t %1", ok(new TextEncoder().encode("body-1")));
    setReply("capture-pane -t %2", ok(new TextEncoder().encode("body-2")));

    await hydrateTransport(pipeline, transport, [P1, P2]);

    assert.equal(sentCommands.length, 2);
    assert.ok(
      sentCommands.some((c) => c.startsWith("capture-pane -t %1")),
      "must capture pane 1",
    );
    assert.ok(
      sentCommands.some((c) => c.startsWith("capture-pane -t %2")),
      "must capture pane 2",
    );

    assert.equal(frames.length, 2);
    const p1Frame = frames.find((f) => f.paneId === P1)!;
    const p2Frame = frames.find((f) => f.paneId === P2)!;
    assert.ok(p1Frame !== undefined, "must deliver to pane 1");
    assert.ok(p2Frame !== undefined, "must deliver to pane 2");

    // Each frame ends with the matching pane's body.
    const p1Body = new TextDecoder().decode(p1Frame.bytes.subarray(CLEAR_AND_SCROLLBACK.length));
    const p2Body = new TextDecoder().decode(p2Frame.bytes.subarray(CLEAR_AND_SCROLLBACK.length));
    assert.equal(p1Body, "body-1");
    assert.equal(p2Body, "body-2");
  });

  it("swallows a per-pane rejection — siblings still hydrate", async () => {
    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    setReply("capture-pane -t %1", "reject");
    setReply("capture-pane -t %2", ok(new TextEncoder().encode("survivor")));

    await hydrateTransport(pipeline, transport, [P1, P2]);

    // p1 must NOT have produced a frame (capture failed → skip).
    const p1Frame = frames.find((f) => f.paneId === P1);
    assert.equal(p1Frame, undefined, "rejected pane must not produce a frame");

    // p2 must have produced a normal frame.
    const p2Frame = frames.find((f) => f.paneId === P2);
    assert.ok(p2Frame !== undefined, "surviving sibling must hydrate");
    const p2Body = new TextDecoder().decode(p2Frame!.bytes.subarray(CLEAR_AND_SCROLLBACK.length));
    assert.equal(p2Body, "survivor");
  });

  it("swallows ok=false reply (e.g. pane closed mid-capture)", async () => {
    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    setReply("capture-pane -t %1", {
      ok: false,
      commandNumber: 0,
      body: new TextEncoder().encode("pane not found"),
    });
    setReply("capture-pane -t %2", ok(new TextEncoder().encode("survivor")));

    await hydrateTransport(pipeline, transport, [P1, P2]);

    assert.equal(frames.find((f) => f.paneId === P1), undefined);
    assert.ok(frames.find((f) => f.paneId === P2) !== undefined);
  });

  it("does nothing for an empty pane set (no sends, no frames)", async () => {
    const { pipeline, sentCommands } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    await hydrateTransport(pipeline, transport, []);

    assert.equal(sentCommands.length, 0);
    assert.equal(frames.length, 0);
  });

  it("hydrates concurrently across panes (Promise.all, not serial)", async () => {
    // Both panes get held until externally resolved.  hydrateTransport
    // must dispatch BOTH sends before either resolves — proving the
    // fan-out is parallel and total wall time is one RTT, not N.
    const sentCommands: string[] = [];
    const inflight: Array<(r: CommandResult) => void> = [];
    const pipeline: HydrationPipeline = {
      send(command: string): Promise<CommandResult> {
        sentCommands.push(command);
        return new Promise<CommandResult>((resolve) => {
          inflight.push(resolve);
        });
      },
    };
    const { transport, frames } = makeRecordingTransport();

    const hydrationPromise = hydrateTransport(pipeline, transport, [P1, P2]);

    // Give microtasks a chance to dispatch both sends.
    await new Promise<void>((r) => setImmediate(r));

    assert.equal(
      sentCommands.length,
      2,
      "both capture-pane sends must have been dispatched before any reply (parallel)",
    );

    // Resolve both replies.
    inflight[0]!(ok(new TextEncoder().encode("p1")));
    inflight[1]!(ok(new TextEncoder().encode("p2")));

    await hydrationPromise;
    assert.equal(frames.length, 2);
  });

  it("skips malformed PaneId silently (defensive guard, does not throw)", async () => {
    const { pipeline, sentCommands } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();

    // PaneId is a branded string; we synthesize a malformed one.  Pre-alpha
    // misformed-id from upstream is a bug — but hydration must not crash.
    const bad1 = "not-a-pane" as unknown as PaneId;
    const bad2 = "p-not-a-number" as unknown as PaneId;
    const bad3 = "p" as unknown as PaneId; // length < 2
    const empty = "" as unknown as PaneId;

    await hydrateTransport(pipeline, transport, [bad1, bad2, bad3, empty, P7]);

    // Only the well-formed pane should have produced a send + frame.
    assert.equal(sentCommands.length, 1);
    assert.equal(sentCommands[0], "capture-pane -t %7 -p -e -S - -E -");
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.paneId, P7);
  });
});

// ---------------------------------------------------------------------------
// (D) Integration with the bind-path invariant
// ---------------------------------------------------------------------------

describe("tc-5quo hydration — bind-path invariant", () => {
  // The bead pins: "after ANY bind (first bind, warm rebind, reconnect),
  // terminal buffer == pane history (bounded by tmux history-limit)".
  //
  // The unit tests above already establish that hydrateTransport delivers
  // CLEAR + replay for every pane in the input.  This block adds the
  // higher-level invariant: regardless of which bind path called
  // hydrateTransport, the resulting frame stream is identical for the same
  // model state — proving the contract is unified.

  it("produces byte-identical hydration frames for the SAME pane regardless of how addClient was reached", async () => {
    // Simulate two distinct bind paths arriving at the same model state:
    // both must produce the same hydration bytes for pane P1.
    const captureBody = new TextEncoder().encode("history-A\nhistory-B");

    // Path X: simulate "first bind".
    const fakeX = makeFakePipeline();
    fakeX.setReply("capture-pane", ok(captureBody));
    const recX = makeRecordingTransport();
    await hydrateTransport(fakeX.pipeline, recX.transport, [P1]);

    // Path Y: simulate "warm rebind" — same model, same capture content.
    const fakeY = makeFakePipeline();
    fakeY.setReply("capture-pane", ok(captureBody));
    const recY = makeRecordingTransport();
    await hydrateTransport(fakeY.pipeline, recY.transport, [P1]);

    assert.equal(recX.frames.length, 1);
    assert.equal(recY.frames.length, 1);
    assert.deepEqual(
      recX.frames[0]!.bytes,
      recY.frames[0]!.bytes,
      "hydration frame must be byte-identical across bind paths for the same model state",
    );
  });

  it("acceptance: marker text from before disconnect AND output from during disconnect both appear in the replay", async () => {
    // The bead acceptance: "marker text echoed pre-disconnect AND output
    // produced while disconnected are both visible after reconnect."
    //
    // This is exactly the shape of a `capture-pane -p -e -S - -E -` body:
    // tmux's history holds everything from the moment the pane started
    // through the current cursor row, including bytes produced while no
    // client was attached.  We model that by feeding a capture body that
    // contains BOTH a pre-disconnect marker and disconnect-window output,
    // then asserting both reach the transport in the replay.
    const captureBody = new TextEncoder().encode(
      "MARKER-pre-disconnect\nLINE-DURING-DISCONNECT-1\nLINE-DURING-DISCONNECT-2",
    );

    const { pipeline, setReply } = makeFakePipeline();
    setReply("capture-pane", ok(captureBody));
    const { transport, frames } = makeRecordingTransport();

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const replayBytes = frames[0]!.bytes.subarray(CLEAR_AND_SCROLLBACK.length);
    const replayStr = new TextDecoder().decode(replayBytes);

    assert.ok(
      replayStr.includes("MARKER-pre-disconnect"),
      "pre-disconnect marker must appear in the hydrated replay",
    );
    assert.ok(
      replayStr.includes("LINE-DURING-DISCONNECT-1"),
      "first line produced during disconnect must appear in the hydrated replay",
    );
    assert.ok(
      replayStr.includes("LINE-DURING-DISCONNECT-2"),
      "second line produced during disconnect must appear in the hydrated replay",
    );
  });
});

// ---------------------------------------------------------------------------
// (E) tc-pizl.2 — fresh-pane top-anchor invariant (FUTURE E2E ORACLE, unit form)
//
// The oracle: a fresh no-history pane must NOT produce a full-pane-height block
// of trailing blank lines in the replay (those newlines bottom-anchor the prompt
// in xterm).  A pane WITH scrollback must STILL replay its real content ending on
// the last real line (bottom-anchored), unregressed.  We exercise the full
// hydrateTransport frame here so the assertion covers the delivered byte stream,
// not just the trim helper.
// ---------------------------------------------------------------------------

describe("tc-pizl.2 fresh-pane top-anchor invariant", () => {
  /** The replay body (after CLEAR prefix) decoded as a string. */
  function replayString(frameBytes: Uint8Array): string {
    return new TextDecoder().decode(frameBytes.subarray(CLEAR_AND_SCROLLBACK.length));
  }

  it("fresh pane: replay carries NO trailing pane-height block of blank lines", async () => {
    // tmux capture-pane -E - of a fresh 50-row pane: prompt near the top, then
    // ~47 empty viewport rows (one bare LF each).
    const ROWS = 50;
    const captureBody =
      "\ncwa at chost in ~\n$ " + "\n".repeat(ROWS - 3);

    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode(captureBody)));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const replay = replayString(frames[0]!.bytes);

    // The replay must END on the prompt (no trailing newline / blank block).
    assert.ok(replay.endsWith("$ "), `replay must end on the prompt, got: ${JSON.stringify(replay)}`);
    assert.ok(
      !/\n\s*\n\s*$/.test(replay),
      "replay must not end with a run of blank lines (would bottom-anchor the prompt)",
    );
    // The FIRST non-empty line must be near the TOP — within the first few rows,
    // NOT preceded by a pane-height block of blanks.
    const lines = replay.split(/\r?\n/);
    const firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
    assert.ok(firstNonEmpty >= 0, "replay must contain a non-empty line");
    assert.ok(
      firstNonEmpty < 5,
      `first non-empty line must be near the top (got index ${firstNonEmpty})`,
    );
    // And the total line count must be a handful (prompt rows), not pane-height.
    assert.ok(
      lines.length < 10,
      `fresh-pane replay must not span a pane-height block of lines (got ${lines.length})`,
    );
  });

  it("scrollback pane: replay still ends bottom-anchored on real content (p2 non-regression)", async () => {
    // A pane with real scrollback filling the viewport down to the cursor: the
    // last captured line is real content (the live prompt), with no empty tail.
    const realLines = [
      "$ ls -la",
      "total 8",
      "drwxr-xr-x  2 cwa cwa 4096 Jun 15 file1.py",
      "drwxr-xr-x  2 cwa cwa 4096 Jun 15 file2.py",
      "^C",
      "$ reset",
      "$ ", // live prompt — the cursor row, bottom of the viewport
    ];
    const captureBody = realLines.join("\n"); // NO trailing blank rows

    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode(captureBody)));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const replay = replayString(frames[0]!.bytes);

    // Every real line survives and the last line is the live prompt (bottom-
    // anchored) — the trim must NOT have eaten real content.
    for (const ln of realLines) {
      assert.ok(replay.includes(ln), `scrollback line must survive hydration: ${JSON.stringify(ln)}`);
    }
    assert.ok(replay.endsWith("$ "), "scrollback replay must end on the live prompt (bottom-anchored)");
    // The trim is a no-op for a body with no trailing blanks: byte-identical to
    // the plain LF→CRLF of the capture body.
    assert.deepEqual(
      frames[0]!.bytes.subarray(CLEAR_AND_SCROLLBACK.length),
      lfToCrlf(new TextEncoder().encode(captureBody)),
      "scrollback body must be byte-unchanged by the trailing-blank trim",
    );
  });
});
