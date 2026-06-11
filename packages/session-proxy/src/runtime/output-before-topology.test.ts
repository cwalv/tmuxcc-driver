/**
 * Output-before-topology buffering tests (tc-128.3, tc-128.4).
 *
 * Acceptance criteria (post tc-128.4, pane tracking is always-on):
 *   A1. Split storm: bytes that arrive for a pane before the model knows about
 *       it are buffered, then flushed to transports in order once the pane is
 *       bound — every byte lands in the right terminal.
 *   A2. Foreign-pane containment: bytes for a pane that is never bound stay in
 *       the overflow-bounded staging buffer and are not fanned out to transports;
 *       overflow is dropped with a log, not accumulated unboundedly.
 *   A3. Ordering guarantee: `pane.opened` (control plane) always precedes the
 *       flushed data bytes (data plane) at the client.
 *   A5. Bootstrap path: panes present in the initial model after bootstrap are
 *       bound correctly and receive subsequent output without staging.
 *
 * NOTE (tc-128.4): A4 (legacy pass-through behaviour without
 * `activatePaneTracking`) is RETIRED. The opt-in toggle is gone — pane
 * tracking is the only mode. Test harnesses must call notifyPaneBound for
 * every pane they expect bytes for.
 *
 * @module runtime/output-before-topology.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOutputDemux } from "./output-demux.js";
import { createInMemoryTransportPair } from "../wire/transport.js";
import { paneId } from "../wire/ids.js";
import type { PaneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

interface Frame {
  paneId: PaneId;
  bytes: Uint8Array;
}

function captureFrames(
  transport: ReturnType<typeof createInMemoryTransportPair>["client"],
): Frame[] {
  const frames: Frame[] = [];
  transport.onData((pid, b) => frames.push({ paneId: pid, bytes: new Uint8Array(b) }));
  return frames;
}

/** Wait for a microtask flush (one call to queueMicrotask completes). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

// ---------------------------------------------------------------------------
// A1: Split storm — bytes arrive before model knows about the pane
// ---------------------------------------------------------------------------

describe("OutputDemux: output-before-topology buffering", () => {
  it("A1: bytes for unknown pane are staged, then flushed in order on notifyPaneBound", async () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");

    // Pane not yet known — bytes should be staged, NOT fanned out.
    demux.store.append(P1, bytes(0x10, 0x11));
    demux.store.append(P1, bytes(0x12, 0x13));

    assert.equal(frames.length, 0, "bytes must be staged before pane is bound");
    assert.equal(demux.pendingBytes(P1), 4, "pendingBytes must reflect staged bytes");
    assert.equal(demux.isPaneKnown(P1), false, "pane must not be known yet");

    // Bind the pane: staged bytes should be flushed via queueMicrotask.
    demux.notifyPaneBound(P1);
    assert.equal(demux.isPaneKnown(P1), true, "pane must be known after notifyPaneBound");
    assert.equal(demux.pendingBytes(P1), 0, "staging buffer must be cleared after bind");

    // Flush is deferred by one microtask — wait for it.
    await flushMicrotasks();

    assert.equal(frames.length, 2, "both staged chunks must arrive after microtask flush");
    assert.deepEqual(frames[0]!.bytes, bytes(0x10, 0x11), "first chunk byte-exact");
    assert.deepEqual(frames[1]!.bytes, bytes(0x12, 0x13), "second chunk byte-exact, in order");
  });

  it("A1: bytes appended AFTER notifyPaneBound fan out immediately (no staging)", () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");
    demux.notifyPaneBound(P1);

    // After bind, bytes must fan out immediately (no deferral for new bytes).
    demux.store.append(P1, bytes(0xAA, 0xBB));
    assert.equal(frames.length, 1, "bytes after bind must fan out immediately");
    assert.deepEqual(frames[0]!.bytes, bytes(0xAA, 0xBB));
  });

  it("A1: multiple panes staged concurrently, flushed independently", async () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");
    const P2 = paneId("p2");

    // Stage bytes for two unknown panes interleaved.
    demux.store.append(P1, bytes(0x01));
    demux.store.append(P2, bytes(0x02));
    demux.store.append(P1, bytes(0x03));

    assert.equal(frames.length, 0, "all staged — no fan-out");
    assert.equal(demux.pendingBytes(P1), 2);
    assert.equal(demux.pendingBytes(P2), 1);

    // Bind P1 only.
    demux.notifyPaneBound(P1);
    await flushMicrotasks();

    // P1 bytes flushed; P2 still staged.
    const p1frames = frames.filter((f) => f.paneId === P1);
    const p2frames = frames.filter((f) => f.paneId === P2);
    assert.equal(p1frames.length, 2, "P1 gets both staged chunks");
    assert.deepEqual(p1frames[0]!.bytes, bytes(0x01));
    assert.deepEqual(p1frames[1]!.bytes, bytes(0x03));
    assert.equal(p2frames.length, 0, "P2 still staged — not yet bound");
    assert.equal(demux.pendingBytes(P2), 1, "P2 staging buffer intact");

    // Bind P2.
    demux.notifyPaneBound(P2);
    await flushMicrotasks();
    const p2framesAfter = frames.filter((f) => f.paneId === P2);
    assert.equal(p2framesAfter.length, 1, "P2 chunk flushed after bind");
    assert.deepEqual(p2framesAfter[0]!.bytes, bytes(0x02));
  });
});

// ---------------------------------------------------------------------------
// A2: Foreign-pane containment — bytes for never-bound panes don't accumulate
// ---------------------------------------------------------------------------

describe("OutputDemux: foreign-pane containment", () => {
  it("A2: bytes for a pane that is never bound are NOT sent to transports", () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const FOREIGN = paneId("p99");
    demux.store.append(FOREIGN, bytes(0xFF, 0xFE));

    assert.equal(frames.length, 0, "foreign-pane bytes must not reach transports");
    assert.equal(demux.pendingBytes(FOREIGN), 2, "bytes are staged, not dropped yet");
  });

  it("A2: notifyPaneClosed discards the staging buffer without fan-out", async () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");
    demux.store.append(P1, bytes(0x01, 0x02));
    assert.equal(demux.pendingBytes(P1), 2);

    // Close without binding — should discard staging buffer.
    demux.notifyPaneClosed(P1);
    assert.equal(demux.pendingBytes(P1), 0, "staging buffer must be cleared on close");
    assert.equal(demux.isPaneKnown(P1), false, "pane must not be known after close");

    await flushMicrotasks();
    assert.equal(frames.length, 0, "no bytes must be delivered after close");
  });

  it("A2: overflow drops excess bytes with a warning (does not accumulate unboundedly)", () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const FOREIGN = paneId("p99");

    // Capture console.warn to verify the overflow warning is emitted.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    try {
      // 128 KiB = 131072 bytes is the limit.  Push 128 KiB + 1 to trigger overflow.
      const cap = 128 * 1024;
      // First chunk: exactly at cap.
      const fillChunk = new Uint8Array(cap).fill(0xAA);
      demux.store.append(FOREIGN, fillChunk);
      assert.equal(demux.pendingBytes(FOREIGN), cap, "at cap: no overflow yet");
      assert.equal(warnings.length, 0, "no warning at exactly cap");

      // Second chunk: 1 byte over cap → overflow.
      demux.store.append(FOREIGN, bytes(0xBB));
      assert.equal(
        demux.pendingBytes(FOREIGN),
        cap,
        "overflow byte must not increase pendingBytes",
      );
      assert.ok(warnings.length >= 1, "overflow warning must be emitted");
      assert.ok(
        warnings[0]!.includes("overflow") || warnings[0]!.includes("pre-topology"),
        `warning must mention overflow: ${warnings[0]}`,
      );

      // Further appends beyond cap are silently dropped.
      demux.store.append(FOREIGN, bytes(0xCC));
      assert.equal(demux.pendingBytes(FOREIGN), cap, "further appends beyond cap silently dropped");

      // No bytes ever reach the transport.
      assert.equal(frames.length, 0, "no bytes must reach transport for foreign pane");
    } finally {
      console.warn = origWarn;
    }
  });

  it("A2: overflow does NOT affect other panes (isolation)", () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const FOREIGN = paneId("p99");
    const P2 = paneId("p2");

    // Mark P2 as known before any appends so its bytes flow through.
    demux.notifyPaneBound(P2);

    // Overflow FOREIGN.
    const cap = 128 * 1024;
    const orig = console.warn;
    console.warn = () => {};
    try {
      demux.store.append(FOREIGN, new Uint8Array(cap + 1).fill(0xAA));
    } finally {
      console.warn = orig;
    }

    // P2 bytes should still flow through unaffected.
    demux.store.append(P2, bytes(0x42, 0x43));
    assert.equal(frames.length, 1, "P2 bytes must still fan out despite FOREIGN overflow");
    assert.deepEqual(frames[0]!.bytes, bytes(0x42, 0x43));
  });
});

// ---------------------------------------------------------------------------
// A3: Ordering guarantee — pane.opened before flushed data bytes
// ---------------------------------------------------------------------------

describe("OutputDemux: pane.opened ordering guarantee", () => {
  it("A3: flushed bytes arrive AFTER synchronous control-plane handlers complete (microtask)", async () => {
    // Simulate the ordering contract: the demux subscription fires first
    // (registered at factory time), but flushes via queueMicrotask so that
    // control-plane handlers (registered per-client in addClient()) fire
    // synchronously first.
    //
    // We verify this by recording the order of events:
    //   1. A "control-plane sent pane.opened" marker (synchronous, in the
    //      same call that triggers notifyPaneBound).
    //   2. The actual bytes arriving at the transport (microtask-deferred).
    //
    // The bytes must arrive AFTER the marker.

    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");
    const events: string[] = [];

    // Stage some bytes before the pane is bound.
    demux.store.append(P1, bytes(0x01, 0x02));

    // Simulate the "control-plane pane.opened" by calling notifyPaneBound
    // (which is what the session-proxy does synchronously in onModelChange).
    // Record the call.
    events.push("notifyPaneBound called");
    demux.notifyPaneBound(P1);

    // At this point, bytes are NOT yet delivered (they're in the microtask queue).
    assert.equal(frames.length, 0, "bytes must not yet be delivered synchronously");
    events.push("synchronous work complete");

    // Now flush the microtask queue.
    await flushMicrotasks();

    // Record that bytes arrived.
    if (frames.length > 0) {
      events.push("bytes arrived");
    }

    // Verify ordering: pane.opened notification (synchronous) before bytes.
    assert.deepEqual(events, [
      "notifyPaneBound called",
      "synchronous work complete",
      "bytes arrived",
    ], "bytes must arrive after all synchronous work completes");

    assert.equal(frames.length, 1, "one frame delivered");
    assert.deepEqual(frames[0]!.bytes, bytes(0x01, 0x02));
  });

  it("A3: flush is skipped if pane is closed before the microtask fires", async () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");
    demux.store.append(P1, bytes(0x01));

    // Bind, then immediately close before the microtask fires.
    demux.notifyPaneBound(P1);
    demux.notifyPaneClosed(P1);

    await flushMicrotasks();

    assert.equal(frames.length, 0, "bytes must not be flushed if pane closed before microtask");
  });

  it("A3: flush is skipped if pane is paused when the microtask fires", async () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");
    demux.store.append(P1, bytes(0x01));

    // Bind, then pause before microtask fires.
    demux.notifyPaneBound(P1);
    demux.pausePane(P1);

    await flushMicrotasks();

    assert.equal(frames.length, 0, "bytes must not be flushed to paused pane");

    // After resume, new bytes flow (but the staged bytes from before bind are gone —
    // the content-plane recapture-on-bind handles historical content).
    demux.resumePane(P1);
    demux.store.append(P1, bytes(0x02));
    assert.equal(frames.length, 1, "new bytes after resume flow through");
    assert.deepEqual(frames[0]!.bytes, bytes(0x02));
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("OutputDemux: notifyPaneBound / notifyPaneClosed idempotency", () => {
  it("notifyPaneBound is idempotent (double-call does not double-flush)", async () => {
    const demux = createOutputDemux();
    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    const P1 = paneId("p1");
    demux.store.append(P1, bytes(0xAA));

    demux.notifyPaneBound(P1);
    demux.notifyPaneBound(P1); // second call — must be a no-op

    await flushMicrotasks();
    // Only one frame (first call flushed the buffer; second was a no-op).
    assert.equal(frames.length, 1, "double notifyPaneBound must not double-flush");
  });

  it("notifyPaneClosed is idempotent (double-call safe)", () => {
    const demux = createOutputDemux();
    const P1 = paneId("p1");
    demux.store.append(P1, bytes(0x01));
    demux.notifyPaneClosed(P1);
    demux.notifyPaneClosed(P1); // no-op — should not throw
    assert.equal(demux.pendingBytes(P1), 0);
    assert.equal(demux.isPaneKnown(P1), false);
  });
});

// ---------------------------------------------------------------------------
// A5: Bootstrap path via the live pipeline (synthetic host)
// ---------------------------------------------------------------------------

import { createRuntimePipeline } from "./pipeline.js";
import type { TmuxHost } from "./tmux-host.js";
import type { DataHandler as HostDataHandler } from "./tmux-host.js";

/**
 * Build a minimal synthetic tmux host that lets us inject arbitrary bytes.
 */
function makeSyntheticHost(): {
  host: TmuxHost;
  inject: (bytes: Uint8Array) => void;
} {
  const handlers = new Set<HostDataHandler>();
  const host: TmuxHost = {
    get pid() { return undefined; },
    get exited() { return false; },
    async start() { /* no-op */ },
    write() { /* no-op */ },
    onData(h: HostDataHandler) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    onExit() { return () => {}; },
    onError() { return () => {}; },
    onStderr() { return () => {}; },
    async stop() { /* no-op */ },
    kill() { /* no-op */ },
  };
  return {
    host,
    inject(b: Uint8Array) {
      for (const h of handlers) h(b);
    },
  };
}

/**
 * Minimal bootstrap stream for one session/window/pane.
 * Matches BOOTSTRAP_WINDOWS_FORMAT + BOOTSTRAP_PANES_FORMAT.
 */
function makeBootstrapStream(paneNum: number): Uint8Array {
  const ts = 1_000_000;
  const sid = "$0";
  const wid = "@1";
  const pid_ = `%${paneNum}`;
  const layoutStr = `aaaa,80x24,0,0,${paneNum}`;
  const winBody = `${sid}\ttestsession\t${wid}\ttestwin\t80\t24\t${layoutStr}\t*\t1\n`;
  const paneBody = `${pid_}\t${wid}\t${sid}\t0\t80\t24\t0\t0\t1\t1234\tbash\n`;
  const winBlock = `%begin ${ts} 100 1\r\n${winBody}%end ${ts} 100 1\r\n`;
  const paneBlock = `%begin ${ts} 101 1\r\n${paneBody}%end ${ts} 101 1\r\n`;
  return new TextEncoder().encode(winBlock + paneBlock);
}

describe("OutputDemux: integration with pipeline and pane tracking", () => {
  it("A5: bootstrap panes are bound and receive subsequent output without staging", async () => {
    const { host, inject } = makeSyntheticHost();
    const demux = createOutputDemux();
    const pipeline = createRuntimePipeline(host, { buffers: demux.store });

    // Wire the model-change subscription that keeps demux's known-pane set
    // in sync (always-on pane tracking — tc-128.4 removed the opt-in).
    pipeline.onModelChange((next, prev) => {
      for (const pid of next.panes.keys()) {
        if (!demux.isPaneKnown(pid)) demux.notifyPaneBound(pid);
      }
      for (const pid of prev.panes.keys()) {
        if (!next.panes.has(pid)) demux.notifyPaneClosed(pid);
      }
    });

    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    // Start and inject bootstrap bytes for pane %1.
    const startPromise = pipeline.start();
    inject(makeBootstrapStream(1));
    await startPromise;

    // After bootstrap, p1 should be known.
    const P1 = paneId("p1");
    assert.equal(demux.isPaneKnown(P1), true, "p1 must be known after bootstrap");
    assert.equal(demux.pendingBytes(P1), 0, "no pending bytes at bootstrap");

    // Output for p1 must flow through immediately (no staging).
    // Simulate %output %1 <octal for "hi"> → 0x68 0x69
    const outputLine = `%output %1 \\150\\151\r\n`; // h=150 i=151 in octal
    inject(new TextEncoder().encode(outputLine));

    // Allow a tick for the notification to be processed.
    await new Promise<void>((r) => setTimeout(r, 30));

    const p1frames = frames.filter((f) => f.paneId === P1);
    assert.ok(p1frames.length >= 1, "output bytes must reach transport for known bootstrap pane");
    const all = Buffer.concat(p1frames.map((f) => Buffer.from(f.bytes)));
    assert.ok(all.includes(Buffer.from([0x68, 0x69])), `expected 0x68 0x69 (hi), got: ${all.toString("hex")}`);

    // Stop the pipeline so the coalescer's heartbeat timer doesn't hold the
    // process open (tc-128.4: coalescer is always armed once start() resolves).
    pipeline.stop();
  });

  it("A1 (integration): bytes for a new pane arriving before the model knows it are staged then flushed", async () => {
    const { host, inject } = makeSyntheticHost();
    const demux = createOutputDemux();
    const pipeline = createRuntimePipeline(host, { buffers: demux.store });

    pipeline.onModelChange((next, prev) => {
      for (const pid of next.panes.keys()) {
        if (!demux.isPaneKnown(pid)) demux.notifyPaneBound(pid);
      }
      for (const pid of prev.panes.keys()) {
        if (!next.panes.has(pid)) demux.notifyPaneClosed(pid);
      }
    });

    const { sessionProxy, client } = createInMemoryTransportPair();
    const frames = captureFrames(client);
    demux.attachTransport(sessionProxy);

    // Bootstrap with pane %1.
    const startPromise = pipeline.start();
    inject(makeBootstrapStream(1));
    await startPromise;

    const P2 = paneId("p2");
    assert.equal(demux.isPaneKnown(P2), false, "p2 not yet known");

    // Inject output for p2 BEFORE the model knows about p2 (simulating the
    // output-before-topology race: %output arrives before the topology requery
    // adds p2 to the model).
    // 0x41 0x42 = "AB"
    const outputBeforeTopology = `%output %2 \\101\\102\r\n`;
    inject(new TextEncoder().encode(outputBeforeTopology));

    // Allow a tick for notification processing.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Bytes must be staged — p2 is not yet known.
    const p2framesBefore = frames.filter((f) => f.paneId === P2);
    assert.equal(p2framesBefore.length, 0, "bytes must be staged before p2 is known");
    assert.ok(demux.pendingBytes(P2) > 0, "pendingBytes for p2 must be > 0");

    // Now simulate the model learning about p2 (as would happen after a
    // topology requery or layout-change event). We call notifyPaneBound
    // directly to simulate the model-change handler binding p2.
    demux.notifyPaneBound(P2);

    // Wait for the microtask flush.
    await flushMicrotasks();

    const p2framesAfter = frames.filter((f) => f.paneId === P2);
    assert.ok(p2framesAfter.length >= 1, "staged bytes must be delivered after bind");
    const all = Buffer.concat(p2framesAfter.map((f) => Buffer.from(f.bytes)));
    assert.ok(
      all.includes(Buffer.from([0x41, 0x42])),
      `expected bytes 0x41 0x42 ("AB") after bind, got: ${all.toString("hex")}`,
    );

    // tc-128.4: stop the pipeline so the coalescer's heartbeat timer is
    // cleared and the test process can exit.
    pipeline.stop();
  });
});
