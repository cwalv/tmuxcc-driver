/**
 * Tests for flow-control coordinator (tc-1ho).
 *
 * Acceptance: Under a high-output flood, the session-proxy throttles via pause mode
 * without dropping or corrupting bytes.
 *
 * Strategy:
 *   - Use a fake TmuxHost that captures write() calls without spawning a process.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal fake TmuxHost that records write() calls. */
function makeFakeHost(): { writes: string[]; host: import("./tmux-host.js").TmuxHost } {
  const writes: string[] = [];
  const host: import("./tmux-host.js").TmuxHost = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    kill: () => {},
    write: (data) => { writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8")); },
    onData: () => () => {},
    onExit: () => () => {},
    onError: () => () => {},
    onStderr: () => () => {},
    pid: undefined,
    exited: false,
  };
  return { writes, host };
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
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
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
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    fc.onPaneBytes(P5, 101);
    const cmds = commands(writes);
    assert.ok(cmds[0]?.includes("%5:pause"), `expected %5:pause, got: ${cmds[0]}`);
  });

  it("does not re-issue pause command when already paused", () => {
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    fc.onPaneBytes(P3, 101); // triggers pause
    const countAfterFirst = writes.length;

    fc.onPaneBytes(P3, 1_000); // still paused — must NOT re-issue
    assert.equal(writes.length, countAfterFirst, "no duplicate pause command");
  });

  it("isPanePaused returns true after flood exceeds high-water", () => {
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
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
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    // Flood past high-water to trigger pause.
    fc.onPaneBytes(P3, 1_001);
    writes.length = 0; // reset to track only the resume command

    // Drain to just above low-water — not enough to resume.
    fc.noteDrained(P3, 800); // buffered = 201 > 200 lowWater
    assert.equal(demux.isPanePaused(P3), true, "still paused above low-water");
    assert.equal(writes.length, 0, "no continue command yet");

    // Drain one more byte — falls below low-water.
    fc.noteDrained(P3, 2); // buffered = 199 < 200
    assert.equal(demux.isPanePaused(P3), false, "demux resumed after draining below low-water");

    const cmds = commands(writes);
    assert.equal(cmds.length, 1, "exactly one continue command");
    assert.equal(cmds[0], "refresh-client -A '%3:continue'", "continue command for pane %3");
  });

  it("does not issue continue if not previously paused", () => {
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
      highWaterBytes: 1_000,
      lowWaterBytes: 200,
    });

    fc.onPaneBytes(P3, 500); // below high-water — no pause
    fc.noteDrained(P3, 499); // below low-water — but not paused
    assert.equal(writes.length, 0, "no commands issued when not paused");
  });

  it("isPanePaused returns false after drain below low-water", () => {
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
      highWaterBytes: 100,
      lowWaterBytes: 20,
    });

    fc.onPaneBytes(P3, 101);
    assert.equal(fc.isPanePaused(P3), true);

    fc.noteDrained(P3, 90); // buffered = 11 < 20
    assert.equal(fc.isPanePaused(P3), false);
  });

  it("bufferedBytes tracks onPaneBytes minus noteDrained", () => {
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
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
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux);

    assert.equal(demux.isPanePaused(P3), false, "initially not paused");
    fc.onPauseNotification(P3);
    assert.equal(demux.isPanePaused(P3), true, "demux paused after notification");
  });

  it("onContinueNotification opens the demux gate", () => {
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux);

    fc.onPauseNotification(P3);
    assert.equal(demux.isPanePaused(P3), true);
    fc.onContinueNotification(P3);
    assert.equal(demux.isPanePaused(P3), false, "demux resumed after continue notification");
  });

  it("onPauseNotification is idempotent when already paused by backpressure", () => {
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
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
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux);

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
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
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
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
      highWaterBytes: 10,
      lowWaterBytes: 2,
    });

    fc.onPaneBytes(paneId("p3"), 11);
    const cmds = commands(writes);
    assert.ok(cmds[0]?.includes("%3:pause"), `got: ${cmds[0]}`);
  });

  it('pane "p5" maps to %5 in refresh-client -A continue command', () => {
    const { writes, host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
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
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux, {
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
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    const fc = createFlowController(host, demux, {
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
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    const fc = createFlowController(host, demux, {
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
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    const fc = createFlowController(host, demux, {
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
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    demux.attachTransport(sessionProxy);
    demux.notifyPaneBound(P3);
    demux.notifyPaneBound(P5);
    const fc = createFlowController(host, demux, {
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
// Defaults
// ---------------------------------------------------------------------------

describe("createFlowController — defaults", () => {
  it("exports DEFAULT_HIGH_WATER_BYTES = 262144 and DEFAULT_LOW_WATER_BYTES = 65536", () => {
    assert.equal(DEFAULT_HIGH_WATER_BYTES, 262_144);
    assert.equal(DEFAULT_LOW_WATER_BYTES, 65_536);
  });

  it("uses defaults when no opts provided", () => {
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    const fc = createFlowController(host, demux);

    // Below default high-water: no pause.
    fc.onPaneBytes(P3, 262_144);
    assert.equal(fc.isPanePaused(P3), false, "not paused at exactly 262144");
    fc.onPaneBytes(P3, 1);
    assert.equal(fc.isPanePaused(P3), true, "paused at 262145 (> 262144)");
  });

  it("throws if lowWaterBytes >= highWaterBytes", () => {
    const { host } = makeFakeHost();
    const demux = createOutputDemux();
    assert.throws(
      () => createFlowController(host, demux, { highWaterBytes: 100, lowWaterBytes: 100 }),
      /lowWaterBytes.*must be less than/,
    );
  });
});
