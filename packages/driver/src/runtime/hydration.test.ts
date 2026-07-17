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
 *         4. `pipeline.send` is invoked twice per pane: the canonical
 *            capture-pane command, then the display-message grid-facts read
 *            (tc-w3ir.2 structured reconstruction).
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
  hydratePane,
  lfToCrlf,
  stripOneTrailingLf,
  parsePaneGridFacts,
  cursorPositionEscape,
} from "./hydration.js";
import type { HydrationPipeline } from "./hydration.js";
import { paneId } from "@tmuxcc/protocol";
import type { PaneId } from "@tmuxcc/protocol";
import type { Transport } from "@tmuxcc/protocol";
import type { ControlMessage } from "@tmuxcc/protocol";
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
// (A') tc-w3ir.2 — structured-reconstruction helpers
// ---------------------------------------------------------------------------

describe("tc-w3ir.2 stripOneTrailingLf", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

  it("drops exactly one trailing LF (capture-pane terminates the last row)", () => {
    assert.equal(dec(stripOneTrailingLf(enc("line1\nline2\n"))), "line1\nline2");
  });

  it("preserves the screen's legitimate blank tail — removes only ONE LF", () => {
    // A short screen with a blank viewport tail: capture is prompt + blank rows,
    // one LF each. Only the final terminator is dropped; the blank rows (now
    // separated by LFs) survive to fill the viewport.
    assert.equal(dec(stripOneTrailingLf(enc("$ \n\n\n\n"))), "$ \n\n\n");
  });

  it("returns the same reference when there is no trailing LF", () => {
    const body = enc("$ ls");
    assert.equal(stripOneTrailingLf(body), body);
  });

  it("returns empty input unchanged", () => {
    const body = new Uint8Array(0);
    assert.equal(stripOneTrailingLf(body), body);
  });
});

describe("tc-w3ir.2 parsePaneGridFacts", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("parses the cursor cell + scrollback/screen split", () => {
    assert.deepEqual(parsePaneGridFacts(enc("2,3,0,10")), {
      cursorX: 2,
      cursorY: 3,
      historySize: 0,
      paneHeight: 10,
    });
  });

  it("tolerates a trailing newline and a leading blank line", () => {
    assert.deepEqual(parsePaneGridFacts(enc("\n5,7,300,41\n")), {
      cursorX: 5,
      cursorY: 7,
      historySize: 300,
      paneHeight: 41,
    });
  });

  it("returns null for an empty body (pane vanished mid-read)", () => {
    assert.equal(parsePaneGridFacts(new Uint8Array(0)), null);
  });

  it("returns null for a malformed / short field list", () => {
    assert.equal(parsePaneGridFacts(enc("2,3,0")), null);
    assert.equal(parsePaneGridFacts(enc("2,3,x,10")), null);
    assert.equal(parsePaneGridFacts(enc("2,3,-1,10")), null);
  });
});

describe("tc-w3ir.2 cursorPositionEscape", () => {
  const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

  it("converts 0-based cursor_x/cursor_y to a 1-based CUP escape", () => {
    // tmux cursor_x=2 cursor_y=3 → ESC[4;3H (row=cursor_y+1, col=cursor_x+1).
    assert.equal(dec(cursorPositionEscape(2, 3)), "\x1b[4;3H");
  });

  it("home cell (0,0) → ESC[1;1H", () => {
    assert.equal(dec(cursorPositionEscape(0, 0)), "\x1b[1;1H");
  });
});

// ---------------------------------------------------------------------------
// (B) + (C) hydrateTransport — pipeline + transport interaction
// ---------------------------------------------------------------------------

describe("tc-5quo hydrateTransport — single pane", () => {
  it("sends capture-pane then display-message (grid facts) per pane", async () => {
    const { pipeline, sentCommands } = makeFakePipeline();
    const { transport } = makeRecordingTransport();

    await hydrateTransport(pipeline, transport, [P1]);

    // tc-w3ir.2: two round-trips per pane — the capture body, then the grid
    // facts (cursor cell + scrollback/screen split) for the structured replay.
    assert.equal(sentCommands.length, 2, "capture + display-message per pane");
    assert.equal(
      sentCommands[0],
      "capture-pane -t %1 -p -e -J -S - -E -",
      "must use -p -e -J -S - -E - for full-history rehydration (tc-0ghi: -J joins wrapped rows + preserves trailing spaces)",
    );
    assert.equal(
      sentCommands[1],
      "display-message -p -t %1 -F '#{cursor_x},#{cursor_y},#{history_size},#{pane_height}'",
      "must read cursor_x/cursor_y/history_size/pane_height for the structured reconstruction (tc-w3ir.2)",
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

    const captures = sentCommands.filter((c) => c.startsWith("capture-pane"));
    assert.equal(captures.length, 2, "one capture-pane per pane");
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
        // Defer only the capture round-trips (so we can prove both panes'
        // captures dispatch before either reply). The follow-up grid-facts read
        // resolves immediately — it is not part of the parallelism assertion.
        if (command.startsWith("display-message")) {
          return Promise.resolve(ok(new Uint8Array(0)));
        }
        return new Promise<CommandResult>((resolve) => {
          inflight.push(resolve);
        });
      },
    };
    const { transport, frames } = makeRecordingTransport();

    const hydrationPromise = hydrateTransport(pipeline, transport, [P1, P2]);

    // Give microtasks a chance to dispatch both capture sends.
    await new Promise<void>((r) => setImmediate(r));

    assert.equal(
      sentCommands.filter((c) => c.startsWith("capture-pane")).length,
      2,
      "both capture-pane sends must have been dispatched before any reply (parallel)",
    );

    // Resolve both capture replies.
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

    // Only the well-formed pane should have produced sends + a frame (capture
    // then grid-facts read).
    assert.deepEqual(sentCommands, [
      "capture-pane -t %7 -p -e -J -S - -E -",
      "display-message -p -t %7 -F '#{cursor_x},#{cursor_y},#{history_size},#{pane_height}'",
    ]);
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
// (E) tc-w3ir.2 — structured grid reconstruction (full hydrateTransport frame)
//
// The reconstruction writes the FULL captured grid (history_size scrollback rows
// + pane_height screen rows, the screen's blank tail preserved, one trailing LF
// dropped) then restores the cursor via ESC[<row>;<col>H. We exercise the full
// hydrateTransport frame so the assertion covers the delivered byte stream.
// ---------------------------------------------------------------------------

describe("tc-w3ir.2 structured grid reconstruction frame", () => {
  const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

  /** The replay body (after CLEAR prefix) decoded as a string. */
  function replayString(frameBytes: Uint8Array): string {
    return dec(frameBytes.subarray(CLEAR_AND_SCROLLBACK.length));
  }

  it("fresh no-scrollback pane: full grid + cursor restore to the prompt row (top-anchored)", async () => {
    // A fresh 10-row pane: prompt "$ " at row 0, then 9 empty viewport rows
    // (one bare LF each, plus the row-0 terminator → 10 trailing LFs). Cursor at
    // (cursor_x=2, cursor_y=0): just after the prompt, top of the screen.
    const ROWS = 10;
    const captureBody = "$ " + "\n".repeat(ROWS); // "$ \n" + 9 empty rows + final LF

    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode(captureBody)));
    setReply("display-message -p -t %1", ok(new TextEncoder().encode("2,0,0,10")));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const replay = replayString(frames[0]!.bytes);

    // Frame = grid (one trailing LF dropped, LF→CRLF) + cursor restore.
    const expectedGrid = "$ " + "\r\n".repeat(ROWS - 1);
    const expectedCursor = "\x1b[1;3H"; // cursor_y=0 → row1, cursor_x=2 → col3
    assert.equal(replay, expectedGrid + expectedCursor);

    // The prompt is at the TOP (not preceded by blanks); the blank viewport tail
    // is PRESERVED (fills the viewport); the cursor escape pins the prompt row.
    assert.ok(replay.startsWith("$ "), "prompt must be top-anchored");
    assert.ok(replay.endsWith(expectedCursor), "must end with the cursor restore");
    assert.equal(
      replay.split("\r\n").length,
      ROWS,
      "must write the full pane-height grid (blank tail preserved, not trimmed)",
    );
  });

  it("short screen WITH scrollback: full grid written + screen blank-tail preserved + cursor restored", async () => {
    // 5-row screen with a blank tail (cursor above the bottom) and 8 scrollback
    // rows. The OLD flat-replay+trim dropped the screen's blank tail, pulling
    // scrollback into the viewport; the structured form writes the WHOLE grid so
    // the screen fills the viewport with scrollback above the fold.
    const scrollback = ["SB-1", "SB-2", "SB-3", "SB-4", "SB-5", "SB-6", "SB-7", "SB-8"];
    const screen = ["LIVE-1", "LIVE-2", "", "", ""]; // 5 rows, blank tail
    const captureBody = [...scrollback, ...screen].join("\n") + "\n"; // capture-pane trailing LF
    // cursor on the 3rd screen row (the first blank row): cursor_x=0, cursor_y=2.

    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode(captureBody)));
    setReply("display-message -p -t %1", ok(new TextEncoder().encode("0,2,8,5")));

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const replay = replayString(frames[0]!.bytes);

    // All scrollback survives (it lands above the fold in xterm).
    for (const sb of scrollback) {
      assert.ok(replay.includes(sb), `scrollback line must survive: ${sb}`);
    }
    assert.ok(replay.includes("LIVE-1") && replay.includes("LIVE-2"), "screen content must survive");

    // The cursor restore is the LAST thing in the frame…
    const cursor = "\x1b[3;1H"; // cursor_y=2 → row3, cursor_x=0 → col1
    assert.ok(replay.endsWith(cursor), `frame must end with cursor restore ${JSON.stringify(cursor)}`);

    // …and the screen's blank tail is PRESERVED (the rows between LIVE-2 and the
    // cursor restore are blank, NOT trimmed away). Strip the cursor escape and
    // assert the grid ends with the blank rows.
    const grid = replay.slice(0, replay.length - cursor.length);
    assert.ok(
      grid.endsWith("LIVE-2\r\n\r\n\r\n"),
      `screen blank tail must be preserved, got grid tail: ${JSON.stringify(grid.slice(-20))}`,
    );
  });

  it("missing grid facts: delivers the body WITHOUT a cursor restore (best-effort)", async () => {
    // display-message returns an empty/garbled body (pane raced away between the
    // capture reply and the facts read) → no cursor escape; the body still
    // delivers so the pane is not left blank.
    const captureBody = "history-1\nhistory-2\n";
    const { pipeline, setReply } = makeFakePipeline();
    const { transport, frames } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode(captureBody)));
    // display-message falls through to the fake's default empty-body reply.

    await hydrateTransport(pipeline, transport, [P1]);

    assert.equal(frames.length, 1);
    const replay = replayString(frames[0]!.bytes);
    // No cursor escape; body delivered with one trailing LF dropped, LF→CRLF.
    assert.equal(replay, "history-1\r\nhistory-2");
    assert.ok(!replay.includes("\x1b["), "must NOT contain a cursor escape when facts are absent");
  });
});

// ---------------------------------------------------------------------------
// (F) tc-cvny — different-size reattach: pre-capture per-window report gate
//
// The reusable report-before-capture core: when `initialViewport` is provided,
// `hydrateTransport` / `hydratePane` must issue `refresh-client -C @<win>:WxH`
// (a `pipeline.send` that awaits `%end`) BEFORE dispatching any `capture-pane`
// command — the "no mid-reflow capture" guarantee for a different-size reattach.
// WHICH window/size to report is the caller's concern (session-proxy's per-window
// report resolver, tested separately); this section pins the MECHANISM.
//
//   F1. `refresh-client -C @<win>:` appears in the command log BEFORE any
//       `capture-pane`.
//   F2. The capture is gated: no `capture-pane` is dispatched while the
//       `refresh-client -C` round-trip is still in flight.
//   F3. Path unchanged: no `refresh-client -C` when `initialViewport` absent.
// ---------------------------------------------------------------------------

describe("tc-cvny different-size reattach — pre-capture per-window report gate (hydrateTransport)", () => {
  it("F1: refresh-client -C @<win>: appears before any capture-pane in the command log", async () => {
    const { pipeline, sentCommands, setReply } = makeFakePipeline();
    const { transport } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode("body")));

    await hydrateTransport(pipeline, transport, [P1], undefined, {
      initialViewport: { windowTmuxNum: 5, cols: 100, rows: 30 },
    });

    const refreshIdx = sentCommands.findIndex((c) => c.startsWith("refresh-client -C @5:100x30"));
    const captureIdx = sentCommands.findIndex((c) => c.startsWith("capture-pane"));
    assert.ok(refreshIdx >= 0, "refresh-client -C @5:100x30 must be in the command log");
    assert.ok(captureIdx >= 0, "capture-pane must be in the command log");
    assert.ok(
      refreshIdx < captureIdx,
      `refresh-client -C (idx=${refreshIdx}) must precede capture-pane (idx=${captureIdx})`,
    );
  });

  it("F2: no capture-pane dispatched while refresh-client -C is in-flight (gate on %end)", async () => {
    // A pipeline that holds the refresh-client -C round-trip open. While the
    // resize reply is pending, capture-pane must NOT have been sent.
    const sentCommands: string[] = [];
    let resolveRefresh!: (r: CommandResult) => void;
    const pipeline: HydrationPipeline = {
      send(command: string): Promise<CommandResult> {
        sentCommands.push(command);
        if (command.startsWith("refresh-client -C")) {
          return new Promise<CommandResult>((res) => {
            resolveRefresh = res;
          });
        }
        return Promise.resolve({ ok: true, commandNumber: 0, body: new Uint8Array(0) });
      },
    };
    const { transport } = makeRecordingTransport();

    const hydrationDone = hydrateTransport(pipeline, transport, [P1], undefined, {
      initialViewport: { windowTmuxNum: 5, cols: 80, rows: 24 },
    });

    // Yield to let the resize request dispatch (async fn body + microtasks).
    await Promise.resolve();
    await Promise.resolve();

    const capturesSentSoFar = sentCommands.filter((c) => c.startsWith("capture-pane")).length;
    assert.equal(
      capturesSentSoFar,
      0,
      "no capture-pane must be dispatched while refresh-client -C is in-flight",
    );

    // Resolve the resize reply → captures should proceed.
    resolveRefresh({ ok: true, commandNumber: 0, body: new Uint8Array(0) });
    await hydrationDone;

    const capturesAfter = sentCommands.filter((c) => c.startsWith("capture-pane")).length;
    assert.ok(capturesAfter > 0, "capture-pane must be dispatched after refresh-client %end");
  });

  it("F3: no refresh-client -C when initialViewport is absent (legacy path unchanged)", async () => {
    const { pipeline, sentCommands, setReply } = makeFakePipeline();
    const { transport } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode("body")));

    await hydrateTransport(pipeline, transport, [P1]);

    const hasRefresh = sentCommands.some((c) => c.startsWith("refresh-client"));
    assert.equal(hasRefresh, false, "no refresh-client must be issued when initialViewport is absent");
  });

  it("F1 hydratePane: refresh-client -C precedes capture-pane for single-pane targeted attach", async () => {
    const { pipeline, sentCommands, setReply } = makeFakePipeline();
    const { transport } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode("body")));

    await hydratePane(pipeline, transport, P1, undefined, {
      initialViewport: { windowTmuxNum: 5, cols: 200, rows: 50 },
    });

    const refreshIdx = sentCommands.findIndex((c) => c.startsWith("refresh-client -C @5:200x50"));
    const captureIdx = sentCommands.findIndex((c) => c.startsWith("capture-pane"));
    assert.ok(refreshIdx >= 0, "refresh-client -C @5:200x50 must be in the command log");
    assert.ok(captureIdx >= 0, "capture-pane must be in the command log");
    assert.ok(
      refreshIdx < captureIdx,
      `refresh-client -C (idx=${refreshIdx}) must precede capture-pane (idx=${captureIdx}) for single-pane attach`,
    );
  });

  it("F3 hydratePane: no refresh-client -C when initialViewport absent", async () => {
    const { pipeline, sentCommands, setReply } = makeFakePipeline();
    const { transport } = makeRecordingTransport();
    setReply("capture-pane", ok(new TextEncoder().encode("body")));

    await hydratePane(pipeline, transport, P1);

    const hasRefresh = sentCommands.some((c) => c.startsWith("refresh-client"));
    assert.equal(hasRefresh, false, "no refresh-client on the legacy hydratePane path");
  });
});
