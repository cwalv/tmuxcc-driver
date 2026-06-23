/**
 * Tests for flow-control coordinator (tc-1ho).
 *
 * Acceptance: Under a high-output flood, the session-proxy throttles via pause mode
 * without dropping or corrupting bytes.
 *
 * Strategy:
 *   - Use a fake `send` callback that captures issued commands (tc-3si.1).
 *   - Use a real createOutputDemux() with createInMemoryTransportPair() to
 *     assert client-side byte delivery is byte-exact.
 *   - Drive the controller directly (onPaneBytes / noteDrained /
 *     onPauseNotification / onContinueNotification) — no real tmux needed.
 *
 * @module runtime/flow-control.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createFlowController,
  DEFAULT_HIGH_WATER_BYTES,
  DEFAULT_LOW_WATER_BYTES,
} from "./flow-control.js";
import { createOutputDemux } from "./output-demux.js";
import { createInMemoryTransportPair } from "../wire/transport.js";
import { paneId } from "../wire/ids.js";
import type { PaneId } from "../wire/ids.js";
import type { CommandResult } from "../parser/correlator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal fake `send` callback that records the issued commands (tc-3si.1).
 *
 * The fake captures each command WITH the trailing "\n" so existing assertions
 * that split-and-rejoin via `commands(writes)` keep working. The returned
 * Promise never resolves — the flow controller fires-and-forgets pause/continue
 * commands and ignores the result.
 */
function makeFakeSend(): {
  writes: string[];
  send: (command: string) => Promise<CommandResult>;
} {
  const writes: string[] = [];
  const send = (command: string): Promise<CommandResult> => {
    writes.push(command + "\n");
    return new Promise<CommandResult>(() => {});
  };
  return { writes, send };
}

/** Convenience: make a Uint8Array of a given length filled with a value. */
function makeBytes(len: number, fill = 0xAB): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

/** Decode all writes to a flat array of command strings (split on \n). */
function commands(writes: string[]): string[] {
  return writes.join("").split("\n").filter((s) => s.length > 0);
}

/** PaneId helpers. */
const P3 = paneId("p3");
const P5 = paneId("p5");

// ---------------------------------------------------------------------------
// Flood → pause
// ---------------------------------------------------------------------------

describe("createFlowController — flood → pause", () => {
  it("issues refresh-client -A pause command when bytes exceed high-water mark", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    // Send bytes up to (but not exceeding) the high-water mark — no pause.
    fc.onPaneBytes(P3, 1_000);
    assert.equal(demux.isPanePaused(P3), false, "not paused at exactly high-water");
    assert.equal(writes.length, 0, "no command written at exactly high-water");

    // One more byte — crosses the threshold.
    fc.onPaneBytes(P3, 1);
    assert.equal(demux.isPanePaused(P3), true, "demux paused after exceeding high-water");

    const cmds = commands(writes);
    assert.equal(cmds.length, 1, "exactly one write issued");
    assert.equal(cmds[0], "refresh-client -A '%3:pause'", "pause command for pane %3");
  });

  it("maps pane 'p5' → %5 in the refresh-client command", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    fc.onPaneBytes(P5, 101);
    const cmds = commands(writes);
    assert.ok(cmds[0]?.includes("%5:pause"), `expected %5:pause, got: ${cmds[0]}`);
  });

  it("does not re-issue pause command when already paused", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    fc.onPaneBytes(P3, 101); // triggers pause
    const countAfterFirst = writes.length;

    fc.onPaneBytes(P3, 1_000); // still paused — must NOT re-issue
    assert.equal(writes.length, countAfterFirst, "no duplicate pause command");
  });

  it("isPanePaused returns true after flood exceeds high-water", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 500,
      lowWaterBytes: 100,
    });

    fc.onPaneBytes(P3, 501);
    assert.equal(fc.isPanePaused(P3), true);
  });
});

// ---------------------------------------------------------------------------
// Drain → continue
// ---------------------------------------------------------------------------

describe("createFlowController — drain → continue", () => {
  it("issues refresh-client -A continue command when drained below low-water", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    // Flood past high-water to trigger pause. The crossing chunk's overshoot
    // is gate-dropped (FC-4, tc-2ztp), so buffered clamps to HIGH_WATER (1000)
    // rather than the raw 1001 appended.
    fc.onPaneBytes(P3, 1_001);
    assert.equal(fc.bufferedBytes(P3), 1_000, "buffered clamps to high-water at the pause edge");
    writes.length = 0; // reset to track only the resume command

    // Drain to just above low-water — not enough to resume.
    fc.noteDrained(P3, 799); // buffered = 201 > 200 lowWater
    assert.equal(demux.isPanePaused(P3), true, "still paused above low-water");
    assert.equal(writes.length, 0, "no continue command yet");

    // Drain two more bytes — falls below low-water.
    fc.noteDrained(P3, 2); // buffered = 199 < 200
    assert.equal(demux.isPanePaused(P3), false, "demux resumed after draining below low-water");

    const cmds = commands(writes);
    assert.equal(cmds.length, 1, "exactly one continue command");
    assert.equal(cmds[0], "refresh-client -A '%3:continue'", "continue command for pane %3");
  });

  it("does not issue continue if not previously paused", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    fc.onPaneBytes(P3, 500); // below high-water — no pause
    fc.noteDrained(P3, 499); // below low-water — but not paused
    assert.equal(writes.length, 0, "no commands issued when not paused");
  });

  it("isPanePaused returns false after drain below low-water", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    fc.onPaneBytes(P3, 101);
    assert.equal(fc.isPanePaused(P3), true);

    fc.noteDrained(P3, 90); // buffered = 11 < 20
    assert.equal(fc.isPanePaused(P3), false);
  });

  it("bufferedBytes tracks onPaneBytes minus noteDrained", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 10_000,
      lowWaterBytes: 1_000,
    });

    fc.onPaneBytes(P3, 5_000);
    assert.equal(fc.bufferedBytes(P3), 5_000);
    fc.noteDrained(P3, 3_000);
    assert.equal(fc.bufferedBytes(P3), 2_000);
    fc.noteDrained(P3, 4_000); // cannot go below 0
    assert.equal(fc.bufferedBytes(P3), 0);
  });
});

// ---------------------------------------------------------------------------
// Honor %pause / %continue notifications
// ---------------------------------------------------------------------------

describe("createFlowController — honor %pause / %continue notifications", () => {
  it("onPauseNotification gates the demux", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux);

    assert.equal(demux.isPanePaused(P3), false, "initially not paused");
    fc.onPauseNotification(P3);
    assert.equal(demux.isPanePaused(P3), true, "demux paused after notification");
  });

  it("onContinueNotification opens the demux gate", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux);

    fc.onPauseNotification(P3);
    assert.equal(demux.isPanePaused(P3), true);
    fc.onContinueNotification(P3);
    assert.equal(demux.isPanePaused(P3), false, "demux resumed after continue notification");
  });

  it("onPauseNotification is idempotent when already paused by backpressure", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    fc.onPaneBytes(P3, 101); // triggers backpressure pause
    const cmdCountAfterBP = writes.length;

    // tmux sends its %pause notification — must not cause another write
    fc.onPauseNotification(P3);
    assert.equal(writes.length, cmdCountAfterBP, "no extra write from duplicate pause notification");
    assert.equal(demux.isPanePaused(P3), true);
  });

  it("onContinueNotification is idempotent when not paused", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux);

    fc.onContinueNotification(P3); // not paused — should be a no-op
    assert.equal(writes.length, 0, "no command written for continue when not paused");
    assert.equal(demux.isPanePaused(P3), false);
  });
});

// ---------------------------------------------------------------------------
// %extended-output handling
// ---------------------------------------------------------------------------

describe("createFlowController — %extended-output", () => {
  it("onExtendedOutput counts toward backpressure (triggers pause at high-water)", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    fc.onExtendedOutput(P3, 1_001);
    assert.equal(demux.isPanePaused(P3), true, "extended-output bytes trigger pause");
    const cmds = commands(writes);
    assert.ok(cmds.some((c) => c.includes("pause")), "pause command issued");
  });
});

// ---------------------------------------------------------------------------
// Pane id mapping: "p3" → %3 in refresh-client command
// ---------------------------------------------------------------------------

describe("createFlowController — pane id mapping", () => {
  it('pane "p3" maps to %3 in refresh-client -A command', () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 10,
      lowWaterBytes: 2,
    });

    fc.onPaneBytes(paneId("p3"), 11);
    const cmds = commands(writes);
    assert.ok(cmds[0]?.includes("%3:pause"), `got: ${cmds[0]}`);
  });

  it('pane "p5" maps to %5 in refresh-client -A continue command', () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 10,
      lowWaterBytes: 2,
    });

    fc.onPaneBytes(paneId("p5"), 11); // pause
    writes.length = 0;
    fc.noteDrained(paneId("p5"), 10); // drain below low-water → continue
    const cmds = commands(writes);
    assert.ok(cmds[0]?.includes("%5:continue"), `got: ${cmds[0]}`);
  });

  it("throws TypeError for bad pane id rather than silently dropping", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 10,
      lowWaterBytes: 2,
    });

    // "x99" doesn't start with "p" — defaultPaneIdToTmux now throws TypeError
    // rather than returning NaN and silently dropping the command.
    assert.throws(
      () => fc.onPaneBytes(paneId("x99"), 9999),
      (err: unknown) => err instanceof TypeError && /p<N>/.test((err as TypeError).message),
    );
  });
});

// ---------------------------------------------------------------------------
// Byte integrity — bytes are delivered byte-exact across a pause/resume cycle
// ---------------------------------------------------------------------------

describe("createFlowController — byte integrity", () => {
  it("delivers all bytes byte-exact before pause and does not deliver while paused", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    const received: { paneId: PaneId; bytes: Uint8Array }[] = [];
    client.onData((pid, b) => received.push({ paneId: pid, bytes: new Uint8Array(b) }));

    // Before high-water: bytes flow through.
    const chunk1 = makeBytes(500, 0xAA);
    demux.store.append(P3, chunk1);
    fc.onPaneBytes(P3, chunk1.length);
    assert.equal(received.length, 1, "first chunk delivered");
    assert.deepEqual(received[0]!.bytes, chunk1, "first chunk byte-exact");

    // Flood past high-water: pause is triggered, but bytes already in store
    // (the append already happened). Subsequent appends are gated.
    const chunk2 = makeBytes(600, 0xBB); // total = 1100 > 1000
    demux.store.append(P3, chunk2);
    fc.onPaneBytes(P3, chunk2.length);
    // The pause triggers at onPaneBytes (after the append), so chunk2 may or
    // may not have been fanned out depending on gate ordering. In our impl,
    // demux.pausePane is called BEFORE the append in _pause — but here we call
    // append first, then onPaneBytes. The gate is set by onPaneBytes after
    // the append — so chunk2 WAS delivered (gate was open during append).
    assert.equal(received.length, 2, "second chunk delivered (gate was open during append)");
    assert.deepEqual(received[1]!.bytes, chunk2, "second chunk byte-exact");
    assert.equal(demux.isPanePaused(P3), true, "pane is now paused");

    // While paused: further appends are NOT delivered.
    const chunk3 = makeBytes(100, 0xCC);
    demux.store.append(P3, chunk3); // gate is closed — not delivered
    fc.onPaneBytes(P3, chunk3.length); // still paused (1200 > 200 low-water)
    assert.equal(received.length, 2, "chunk3 NOT delivered while paused");

    // Drain below low-water → resume.
    fc.noteDrained(P3, 1_001); // 1200 - 1001 = 199 < 200 → resume
    assert.equal(demux.isPanePaused(P3), false, "pane resumed");

    // After resume: new appends flow through.
    const chunk4 = makeBytes(50, 0xDD);
    demux.store.append(P3, chunk4);
    fc.onPaneBytes(P3, chunk4.length);
    assert.equal(received.length, 3, "chunk4 delivered after resume");
    assert.deepEqual(received[2]!.bytes, chunk4, "chunk4 byte-exact");
  });

  it("handles non-UTF-8 bytes without corruption", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    const fc = createFlowController(send, demux, {
      highWaterBytes: 10_000,
      lowWaterBytes: 1_000,
    });

    const received: Uint8Array[] = [];
    client.onData((_pid, b) => received.push(new Uint8Array(b)));

    // Non-UTF-8 byte sequence (surrogate bytes, null, 0xFF, 0xFE).
    const nonUtf8 = new Uint8Array([0xFF, 0x00, 0xFE, 0x80, 0xBF, 0xC0, 0xC1]);
    demux.store.append(P3, nonUtf8);
    fc.onPaneBytes(P3, nonUtf8.length);

    assert.equal(received.length, 1, "non-UTF-8 chunk delivered");
    assert.deepEqual(received[0], nonUtf8, "non-UTF-8 bytes delivered byte-exact without corruption");
  });

  it("delivers bytes in order across multiple appends", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    const fc = createFlowController(send, demux, {
      highWaterBytes: 10_000,
      lowWaterBytes: 1_000,
    });

    const order: number[] = [];
    client.onData((_pid, b) => order.push(...Array.from(b)));

    for (let i = 0; i < 5; i++) {
      const chunk = new Uint8Array([i]);
      demux.store.append(P3, chunk);
      fc.onPaneBytes(P3, 1);
    }

    assert.deepEqual(order, [0, 1, 2, 3, 4], "bytes delivered in order");
  });

  it("independent pane state: pausing P3 does not affect P5", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    demux.notifyPaneBound(P5);
    const fc = createFlowController(send, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    const received: { paneId: PaneId; bytes: Uint8Array }[] = [];
    client.onData((pid, b) => received.push({ paneId: pid, bytes: new Uint8Array(b) }));

    // Flood P3 to trigger pause.
    fc.onPaneBytes(P3, 101);
    demux.store.append(P3, makeBytes(10, 0x01)); // gated — not delivered

    // P5 should still flow freely.
    const p5chunk = makeBytes(10, 0x05);
    demux.store.append(P5, p5chunk);
    fc.onPaneBytes(P5, 10);

    const p5frames = received.filter((f) => f.paneId === P5);
    assert.equal(p5frames.length, 1, "P5 bytes delivered despite P3 being paused");
    assert.deepEqual(p5frames[0]!.bytes, p5chunk, "P5 bytes byte-exact");

    const p3frames = received.filter((f) => f.paneId === P3);
    assert.equal(p3frames.length, 0, "P3 bytes not delivered while paused");
  });
});

// ---------------------------------------------------------------------------
// Multi-client per-client ledgers (tc-0wtb)
//
// The bug: one shared FC-1 ledger but each attached client wraps its own
// draining transport that credits noteDrained independently. The demux fans
// one %output append out to ALL N transports, so a single onPaneBytes(+n) was
// matched by N×noteDrained(−n). With N≥2 the shared ledger nets +n−N·n, clamps
// at 0, never reaches high-water → backpressure silently disabled.
//
// Fix (option b): per-(pane × client) sub-ledgers. onPaneBytes fans +n into
// every registered client; noteDrained(client,…,−n) debits ONLY that client.
// Pause on the MAX over clients; resume only when ALL ≤ low-water; removeClient
// re-evaluates the max (detaching the slowest may itself resume).
// ---------------------------------------------------------------------------

describe("createFlowController — multi-client per-client ledgers (tc-0wtb)", () => {
  // RED baseline: the exact probe that confirmed the bug. Two clients, one
  // 6-byte append. Under the OLD shared ledger: onPaneBytes(+6) then TWO
  // noteDrained(−6) (one per draining transport) → 6 − 12 clamps at 0 with an
  // excess-6 DRAIN CLAMPED tripwire. Under per-client ledgers each client owes
  // its own 6 bytes, so the SECOND drain debits a DIFFERENT sub-ledger and
  // never over-credits: zero clamps, and neither sub-ledger pins below 0.
  it("RED→GREEN: 2 clients + one 6-byte append does NOT over-credit (no clamp, no pin)", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const clamps: Array<{ pane: PaneId; excess: number }> = [];
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
      metrics: { onDrainClamped: (pane, excess) => clamps.push({ pane, excess }) },
    });

    const clientA = { id: "A" };
    const clientB = { id: "B" };
    fc.addClient(clientA);
    fc.addClient(clientB);

    // One %output append of 6 bytes — fanned to BOTH draining transports.
    fc.onPaneBytes(P3, 6);

    // The demux fan-out matches the single append with one drain PER transport.
    fc.noteDrained(P3, 6, clientA);
    fc.noteDrained(P3, 6, clientB);

    // The bug: the second drain over-credits the shared ledger by 6 and trips
    // the clamp. Per-client ledgers debit separate sub-ledgers → no clamp.
    assert.equal(
      clamps.length,
      0,
      `expected NO drain-clamp (per-client ledgers), got ${clamps.length}: ${JSON.stringify(clamps)}`,
    );
    assert.equal(fc.bufferedBytes(P3), 0, "both clients drained their own 6 bytes → max backlog 0");
  });

  it("does NOT pin at ~0 under a flood with 2 clients — pause still engages", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    const clientA = { id: "A" };
    const clientB = { id: "B" };
    fc.addClient(clientA);
    fc.addClient(clientB);

    // Flood: 11 appends of 100 bytes each. Client A keeps up (drains each
    // chunk); client B is the slow consumer and drains nothing. Under the OLD
    // shared ledger A's drains would cancel the appends and the counter would
    // pin at ~0, never pausing. Under per-client ledgers B's sub-ledger climbs
    // past high-water and pauses on B. The crossing append clamps B to
    // HIGH_WATER (FC-4, tc-2ztp: the overshoot is gate-dropped), so B's max
    // backlog settles at 1000, not the raw 1100 appended.
    for (let i = 0; i < 11; i++) {
      fc.onPaneBytes(P3, 100);
      fc.noteDrained(P3, 100, clientA); // A is the fast client
    }

    assert.equal(fc.isPanePaused(P3), true, "pause must engage on the slow client (B), not pin at 0");
    assert.equal(fc.bufferedBytes(P3), 1_000, "max backlog is the slow client B's backlog, clamped at high-water");
    const cmds = commands(writes);
    assert.ok(cmds.some((c) => c.includes("%3:pause")), `expected a %3:pause command, got: ${cmds}`);
  });

  it("resumes only when ALL clients fall to/below low-water (slowest gates resume)", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    const clientA = { id: "A" };
    const clientB = { id: "B" };
    fc.addClient(clientA);
    fc.addClient(clientB);

    // Flood both clients past high-water → pause (max = 1100 > 1000).
    for (let i = 0; i < 11; i++) fc.onPaneBytes(P3, 100);
    assert.equal(fc.isPanePaused(P3), true, "paused after flood");
    writes.length = 0;

    // Drain client A all the way below low-water (A: 1100 → 100 ≤ 200).
    fc.noteDrained(P3, 1_000, clientA);
    assert.equal(
      fc.isPanePaused(P3),
      true,
      "must STILL be paused: client B is still at 1100 > low-water",
    );
    assert.equal(commands(writes).length, 0, "no continue while the slow client is above low-water");

    // Now drain client B below low-water too (B: 1100 → 100 ≤ 200).
    fc.noteDrained(P3, 1_000, clientB);
    assert.equal(fc.isPanePaused(P3), false, "resumes once ALL clients ≤ low-water");
    const cmds = commands(writes);
    assert.equal(cmds.length, 1, "exactly one continue command");
    assert.ok(cmds[0]?.includes("%3:continue"), `expected %3:continue, got: ${cmds[0]}`);
  });

  it("removeClient re-evaluates the max: detaching the slowest client resumes", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    const fast = { id: "fast" };
    const slow = { id: "slow" };
    fc.addClient(fast);
    fc.addClient(slow);

    // Flood past high-water → pause (both at 1100).
    for (let i = 0; i < 11; i++) fc.onPaneBytes(P3, 100);
    assert.equal(fc.isPanePaused(P3), true, "paused after flood");

    // The fast client drains below low-water; the slow client does not.
    fc.noteDrained(P3, 1_000, fast); // fast: 100 ≤ 200
    assert.equal(fc.isPanePaused(P3), true, "still paused: slow client pins the max at 1100");
    writes.length = 0;

    // The slow client detaches. Its sub-ledger is dropped and the max is
    // re-evaluated → now only `fast` at 100 ≤ low-water → resume must fire.
    fc.removeClient(slow);
    assert.equal(
      fc.isPanePaused(P3),
      false,
      "detaching the slowest client must re-evaluate the max and resume",
    );
    const cmds = commands(writes);
    assert.equal(cmds.length, 1, "exactly one continue command from the removeClient re-eval");
    assert.ok(cmds[0]?.includes("%3:continue"), `expected %3:continue, got: ${cmds[0]}`);
  });

  it("a client attaching mid-flood starts at 0 (only live deltas count)", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    const early = { id: "early" };
    fc.addClient(early);

    // Pre-attach flood for the early client only.
    fc.onPaneBytes(P3, 500);
    assert.equal(fc.bufferedBytes(P3), 500, "early client owes 500");

    // A late client attaches mid-flood. Its replay is on the raw transport and
    // is never counted; it starts at 0 and only accrues subsequent live deltas.
    const late = { id: "late" };
    fc.addClient(late);
    assert.equal(fc.bufferedBytes(P3), 500, "late client starts at 0 → max unchanged (early still 500)");

    // One more live append: both clients accrue it.
    fc.onPaneBytes(P3, 100);
    assert.equal(fc.bufferedBytes(P3), 600, "early=600, late=100 → max=600");

    // Drain the early client to 0; the late client (only the post-attach 100)
    // is now the max.
    fc.noteDrained(P3, 600, early);
    assert.equal(fc.bufferedBytes(P3), 100, "late client's post-attach 100 bytes are the residual max");
  });

  it("reduces to single-client behavior at N=1 (per-client == shared ledger)", () => {
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    const only = { id: "only" };
    fc.addClient(only);

    fc.onPaneBytes(P3, 1_001); // crosses high-water
    assert.equal(fc.isPanePaused(P3), true, "single client pauses exactly like the old shared ledger");
    fc.noteDrained(P3, 1_001, only); // drains below low-water
    assert.equal(fc.isPanePaused(P3), false, "single client resumes exactly like the old shared ledger");
    assert.ok(commands(writes).some((c) => c.includes("%3:continue")), "continue issued");
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("createFlowController — defaults", () => {
  it("exports DEFAULT_HIGH_WATER_BYTES = 262144 and DEFAULT_LOW_WATER_BYTES = 65536", () => {
    assert.equal(DEFAULT_HIGH_WATER_BYTES, 262_144);
    assert.equal(DEFAULT_LOW_WATER_BYTES, 65_536);
  });

  it("uses defaults when no opts provided", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux);

    // Below default high-water: no pause.
    fc.onPaneBytes(P3, 262_144);
    assert.equal(fc.isPanePaused(P3), false, "not paused at exactly 262144");
    fc.onPaneBytes(P3, 1);
    assert.equal(fc.isPanePaused(P3), true, "paused at 262145 (> 262144)");
  });

  it("throws if lowWaterBytes >= highWaterBytes", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    assert.throws(
      () => createFlowController(send, demux, { highWaterBytes: 100, lowWaterBytes: 100 }),
      /lowWaterBytes.*must be less than/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant-tripwire metrics hooks (tc-d7i)
// ---------------------------------------------------------------------------

describe("createFlowController — metrics hooks (tc-d7i)", () => {
  it("onDrainClamped fires with the excess when a drain credit exceeds buffered (FC-1)", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const clamps: Array<{ pane: PaneId; excess: number }> = [];
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
      metrics: {
        onDrainClamped: (pane, excess) => clamps.push({ pane, excess }),
      },
    });

    fc.onPaneBytes(P3, 100);
    fc.noteDrained(P3, 100); // exact drain — no clamp
    assert.equal(clamps.length, 0, "exact drain must not clip");

    fc.onPaneBytes(P3, 50);
    fc.noteDrained(P3, 80); // over-drain by 30
    assert.equal(clamps.length, 1, "over-drain must fire the clamp hook once");
    assert.equal(clamps[0]!.pane, P3);
    assert.equal(clamps[0]!.excess, 30);
    assert.equal(fc.bufferedBytes(P3), 0, "counter clamped at 0");

    fc.noteDrained(P5, 10); // drain for a pane with no bytes at all
    assert.equal(clamps.length, 2, "drain-for-unknown-pane must clip");
    assert.equal(clamps[1]!.excess, 10);
  });

  it("onBytesWhilePaused fires only for bytes arriving while paused (FC-4/FC-5)", () => {
    const { send } = makeFakeSend();
    const demux = createOutputDemux();
    const seen: number[] = [];
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
      metrics: {
        onBytesWhilePaused: (_pane, n) => seen.push(n),
      },
    });

    fc.onPaneBytes(P3, 900); // below high-water — not paused
    assert.deepEqual(seen, [], "pre-pause bytes are not counted");

    fc.onPaneBytes(P3, 200); // crosses high-water: THIS call pauses; the
    // crossing bytes themselves are not "while paused"
    assert.equal(fc.isPanePaused(P3), true);
    assert.deepEqual(seen, [], "the crossing call itself is not while-paused");

    // The crossing call clamped buffered to HIGH_WATER (FC-4, tc-2ztp): 1100
    // appended, overshoot gate-dropped → buffered == 1000.
    assert.equal(fc.bufferedBytes(P3), 1_000, "crossing overshoot is gate-dropped, buffered clamps to high-water");

    fc.onPaneBytes(P3, 300); // in-flight window
    fc.onPaneBytes(P3, 50);
    assert.deepEqual(seen, [300, 50], "post-pause arrivals are witnessed, per arrival");
    // FC-4 (tc-2ztp): while-paused bytes are gate-dropped, NOT retained — the
    // demux never fans them out, so noteDrained never credits them. Retaining
    // them is exactly the wedge: the resume MAX would never clear once the
    // producer stops. bufferedBytes must stay clamped at HIGH_WATER, not
    // climb to 1000+300+50.
    assert.equal(fc.bufferedBytes(P3), 1_000, "while-paused bytes are not retained in the resume-gating ledger");

    // Drain to resume; subsequent bytes are no longer counted.
    fc.noteDrained(P3, fc.bufferedBytes(P3));
    assert.equal(fc.isPanePaused(P3), false);
    fc.onPaneBytes(P3, 40);
    assert.deepEqual(seen, [300, 50], "post-resume bytes are not counted");
  });

  it("onCommandFailed fires on %error replies, not on success or rejection", async () => {
    const demux = createOutputDemux();
    const failures: string[] = [];
    // Scripted send: pause reply fails (%error), continue reply succeeds,
    // then a rejecting send simulates correlator teardown.
    const results: Array<Promise<CommandResult>> = [
      Promise.resolve({ ok: false, commandNumber: 1, body: new Uint8Array() }),
      Promise.resolve({ ok: true, commandNumber: 2, body: new Uint8Array() }),
      Promise.reject(new Error("correlator destroyed")),
    ];
    let i = 0;
    const send = (): Promise<CommandResult> => results[i++]!;
    const fc = createFlowController(send, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
      metrics: {
        onCommandFailed: (kind) => failures.push(kind),
      },
    });

    fc.onPaneBytes(P3, 1_100); // pause → %error reply
    fc.noteDrained(P3, 1_100); // resume → ok reply
    fc.onPaneBytes(P3, 1_100); // pause again → rejected (teardown)

    // Let the scripted promises settle.
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(
      failures,
      ["pause"],
      "only the %error reply counts: ok replies and teardown rejections are ignored",
    );
  });
});
