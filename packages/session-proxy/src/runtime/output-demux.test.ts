/**
 * Tests for output-demux (tc-fbz, updated tc-128.4).
 *
 * Acceptance: %output for pane N becomes a data-plane frame tagged pane N;
 * bytes are byte-exact (including non-UTF-8 sequences).
 *
 * Strategy: drive the demux's tapped store directly to simulate pane bytes
 * arriving from the runtime pipeline, paired with createInMemoryTransportPair()
 * to verify the client-side onData handler receives the correct (paneId,
 * bytes). Pane tracking is always-on (tc-128.4), so every test calls
 * `notifyPaneBound` for the panes it expects bytes for — exactly what the
 * production wiring in session-proxy.ts does in its onModelChange handler.
 *
 * @module runtime/output-demux.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOutputDemux } from "./output-demux.js";
import { createInMemoryTransportPair } from "../wire/transport.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { paneId } from "../wire/ids.js";
import type { PaneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const P1 = paneId("p1");
const P2 = paneId("p2");

/** Build a Uint8Array from an array of byte values. */
function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

/** Capture all (paneId, bytes) tuples received by the client-side transport. */
interface Frame {
  paneId: PaneId;
  bytes: Uint8Array;
}

function captureFrames(transport: ReturnType<typeof createInMemoryTransportPair>["client"]): Frame[] {
  const frames: Frame[] = [];
  transport.onData((pid, b) => frames.push({ paneId: pid, bytes: b }));
  return frames;
}

/**
 * Helper: create a demux + transport pair, attach the transport, and bind the
 * given panes so subsequent appends fan out immediately. This is the standard
 * setup for the per-test path; production wiring lives in session-proxy.ts.
 */
function setup(panes: PaneId[] = []): {
  demux: ReturnType<typeof createOutputDemux>;
  sessionProxy: ReturnType<typeof createInMemoryTransportPair>["sessionProxy"];
  client: ReturnType<typeof createInMemoryTransportPair>["client"];
  frames: Frame[];
} {
  const demux = createOutputDemux();
  const { sessionProxy, client } = createInMemoryTransportPair();
  const frames = captureFrames(client);
  demux.attachTransport(sessionProxy);
  for (const pid of panes) demux.notifyPaneBound(pid);
  return { demux, sessionProxy, client, frames };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOutputDemux", () => {
  describe("single client, single pane", () => {
    it("delivers plain ASCII bytes byte-exact to the attached transport", () => {
      const { demux, frames } = setup([P1]);

      const payload = new TextEncoder().encode("hello world");
      demux.store.append(P1, payload);

      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.paneId, P1);
      assert.deepEqual(frames[0]!.bytes, payload);
    });

    it("delivers non-UTF-8 bytes byte-exact (canonical non-UTF-8 payload)", () => {
      const { demux, frames } = setup([P1]);

      // Canonical non-UTF-8 test payload: contains 0xFF, 0x00, 0xFE.
      const payload = bytes(0xff, 0x00, 0xfe, 0x80, 0xbf);
      demux.store.append(P1, payload);

      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.paneId, P1);
      // Byte-for-byte equal — no UTF-8 decode/encode corruption.
      assert.deepEqual(frames[0]!.bytes, payload);
      assert.equal(frames[0]!.bytes[0], 0xff);
      assert.equal(frames[0]!.bytes[1], 0x00);
      assert.equal(frames[0]!.bytes[2], 0xfe);
      assert.equal(frames[0]!.bytes[3], 0x80);
      assert.equal(frames[0]!.bytes[4], 0xbf);
    });
  });

  describe("two panes", () => {
    it("delivers each pane's output to the correct tagged frame", () => {
      const { demux, frames } = setup([P1, P2]);

      const payloadP1 = new TextEncoder().encode("pane-1-data");
      const payloadP2 = bytes(0x01, 0x02, 0x03);

      demux.store.append(P1, payloadP1);
      demux.store.append(P2, payloadP2);

      assert.equal(frames.length, 2);

      const frameP1 = frames.find((f) => f.paneId === P1);
      const frameP2 = frames.find((f) => f.paneId === P2);

      assert.ok(frameP1, "frame for P1 must exist");
      assert.ok(frameP2, "frame for P2 must exist");

      assert.deepEqual(frameP1.bytes, payloadP1);
      assert.deepEqual(frameP2.bytes, payloadP2);
    });

    it("does not mix bytes across panes", () => {
      const { demux, frames } = setup([P1, P2]);

      const p1Chunk1 = bytes(0x10, 0x11);
      const p2Chunk1 = bytes(0x20, 0x21);
      const p1Chunk2 = bytes(0x12, 0x13);

      demux.store.append(P1, p1Chunk1);
      demux.store.append(P2, p2Chunk1);
      demux.store.append(P1, p1Chunk2);

      // Three frames: P1, P2, P1 in order.
      assert.equal(frames.length, 3);
      assert.equal(frames[0]!.paneId, P1);
      assert.deepEqual(frames[0]!.bytes, p1Chunk1);
      assert.equal(frames[1]!.paneId, P2);
      assert.deepEqual(frames[1]!.bytes, p2Chunk1);
      assert.equal(frames[2]!.paneId, P1);
      assert.deepEqual(frames[2]!.bytes, p1Chunk2);
    });
  });

  describe("non-UTF-8 round-trip through InMemoryTransportPair", () => {
    it("byte-exact round-trip: sessionProxy.sendData → client.onData", () => {
      // Drive the demux, verify the client receives unmodified bytes.
      const demux = createOutputDemux();
      const { sessionProxy, client } = createInMemoryTransportPair();

      const received: { paneId: PaneId; bytes: Uint8Array }[] = [];
      client.onData((pid, b) => received.push({ paneId: pid, bytes: b }));

      demux.attachTransport(sessionProxy);
      demux.notifyPaneBound(P1);

      // Non-UTF-8 payload: surrogate range bytes, null, high byte.
      const original = bytes(0xed, 0xa0, 0x80, 0x00, 0xff, 0xfe);
      demux.store.append(P1, original);

      assert.equal(received.length, 1);
      assert.equal(received[0]!.paneId, P1);
      // Every byte position must match exactly.
      assert.equal(received[0]!.bytes.length, original.length);
      for (let i = 0; i < original.length; i++) {
        assert.equal(
          received[0]!.bytes[i],
          original[i],
          `byte at index ${i} must be ${original[i]}, got ${received[0]!.bytes[i]}`,
        );
      }
    });
  });

  describe("multi-client fan-out", () => {
    it("two attached transports both receive the output", () => {
      const demux = createOutputDemux();
      const pair1 = createInMemoryTransportPair();
      const pair2 = createInMemoryTransportPair();

      const frames1 = captureFrames(pair1.client);
      const frames2 = captureFrames(pair2.client);

      demux.attachTransport(pair1.sessionProxy);
      demux.attachTransport(pair2.sessionProxy);
      demux.notifyPaneBound(P1);

      const payload = bytes(0xaa, 0xbb, 0xcc);
      demux.store.append(P1, payload);

      // Both clients get the frame.
      assert.equal(frames1.length, 1, "client 1 must receive the frame");
      assert.equal(frames2.length, 1, "client 2 must receive the frame");

      assert.equal(frames1[0]!.paneId, P1);
      assert.equal(frames2[0]!.paneId, P1);
      assert.deepEqual(frames1[0]!.bytes, payload);
      assert.deepEqual(frames2[0]!.bytes, payload);
    });

    it("detached transport no longer receives output", () => {
      const demux = createOutputDemux();
      const pair1 = createInMemoryTransportPair();
      const pair2 = createInMemoryTransportPair();

      const frames1 = captureFrames(pair1.client);
      const frames2 = captureFrames(pair2.client);

      const unsub1 = demux.attachTransport(pair1.sessionProxy);
      demux.attachTransport(pair2.sessionProxy);
      demux.notifyPaneBound(P1);

      // Both receive first chunk.
      demux.store.append(P1, bytes(0x01));
      assert.equal(frames1.length, 1);
      assert.equal(frames2.length, 1);

      // Detach client 1.
      unsub1();

      // Only client 2 receives second chunk.
      demux.store.append(P1, bytes(0x02));
      assert.equal(frames1.length, 1, "detached client 1 must not receive further frames");
      assert.equal(frames2.length, 2, "client 2 must still receive frames");
    });

    it("detachTransport method is equivalent to unsub()", () => {
      const { demux, sessionProxy, frames } = setup([P1]);

      demux.store.append(P1, bytes(0x01));
      assert.equal(frames.length, 1);

      demux.detachTransport(sessionProxy);
      demux.store.append(P1, bytes(0x02));
      assert.equal(frames.length, 1, "detached transport must not receive further frames");
    });
  });

  describe("scrollback store integrity", () => {
    it("append still writes to the inner store even when no transports are attached", () => {
      const demux = createOutputDemux();
      const payload = bytes(0x42, 0x43);
      demux.store.append(P1, payload);

      // Inner store received the bytes even though no transport was attached.
      const contents = demux.store.getContents(P1);
      assert.deepEqual(contents, payload);
    });

    it("inner store supplied via opts is used and also written to", () => {
      const inner = createPaneBufferStore();
      const demux = createOutputDemux({ innerStore: inner });
      const { sessionProxy, client } = createInMemoryTransportPair();
      const frames = captureFrames(client);

      demux.attachTransport(sessionProxy);
      demux.notifyPaneBound(P1);
      const payload = bytes(0x10, 0x20, 0x30);
      demux.store.append(P1, payload);

      // Transport received the bytes.
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0]!.bytes, payload);

      // Inner store also has the bytes.
      assert.deepEqual(inner.getContents(P1), payload);
    });
  });

  describe("flow-control (pausePane / resumePane)", () => {
    it("paused pane output is NOT sent to transports", () => {
      const { demux, frames } = setup([P1]);
      demux.pausePane(P1);

      demux.store.append(P1, bytes(0xff, 0x00));
      assert.equal(frames.length, 0, "paused pane output must not reach transport");
    });

    it("paused pane output IS still written to the scrollback store", () => {
      const demux = createOutputDemux();
      demux.notifyPaneBound(P1);
      demux.pausePane(P1);

      const payload = bytes(0xaa, 0xbb);
      demux.store.append(P1, payload);

      // Even though paused, scrollback is intact.
      assert.deepEqual(demux.store.getContents(P1), payload);
    });

    it("resumed pane output is sent again after resumePane", () => {
      const { demux, frames } = setup([P1]);
      demux.pausePane(P1);
      demux.store.append(P1, bytes(0x01)); // dropped from transport
      assert.equal(frames.length, 0);

      demux.resumePane(P1);
      demux.store.append(P1, bytes(0x02)); // delivered
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0]!.bytes, bytes(0x02));
    });

    it("isPanePaused reflects current pause state", () => {
      const demux = createOutputDemux();
      assert.equal(demux.isPanePaused(P1), false);
      demux.pausePane(P1);
      assert.equal(demux.isPanePaused(P1), true);
      demux.resumePane(P1);
      assert.equal(demux.isPanePaused(P1), false);
    });

    it("pausing P1 does not affect P2 output", () => {
      const { demux, frames } = setup([P1, P2]);
      demux.pausePane(P1);

      demux.store.append(P1, bytes(0x01)); // paused — dropped
      demux.store.append(P2, bytes(0x02)); // not paused — delivered

      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.paneId, P2);
      assert.deepEqual(frames[0]!.bytes, bytes(0x02));
    });
  });

  describe("edge cases", () => {
    it("empty bytes array is not sent to transports", () => {
      const { demux, frames } = setup([P1]);
      demux.store.append(P1, new Uint8Array(0));

      assert.equal(frames.length, 0, "empty payload must not produce a frame");
    });

    it("attachTransport is idempotent (same transport, same Set)", () => {
      const demux = createOutputDemux();
      const { sessionProxy, client } = createInMemoryTransportPair();
      const frames = captureFrames(client);

      // Attach the same transport twice — Set ensures single delivery.
      demux.attachTransport(sessionProxy);
      demux.attachTransport(sessionProxy);
      demux.notifyPaneBound(P1);

      demux.store.append(P1, bytes(0x01));
      // Set deduplication: only one delivery, not two.
      assert.equal(frames.length, 1, "same transport must only receive one copy");
    });

    it("detachTransport on non-attached transport is a no-op", () => {
      const demux = createOutputDemux();
      const { sessionProxy, client } = createInMemoryTransportPair();
      const frames = captureFrames(client);

      // Never attached — should not throw.
      demux.detachTransport(sessionProxy);
      demux.notifyPaneBound(P1);
      demux.store.append(P1, bytes(0x01));
      assert.equal(frames.length, 0);
    });

    it("multiple sequential appends for the same pane produce ordered frames", () => {
      const { demux, frames } = setup([P1]);

      const chunks = [bytes(0x01), bytes(0x02, 0x03), bytes(0x04)];
      for (const chunk of chunks) {
        demux.store.append(P1, chunk);
      }

      assert.equal(frames.length, 3);
      for (let i = 0; i < chunks.length; i++) {
        assert.equal(frames[i]!.paneId, P1);
        assert.deepEqual(frames[i]!.bytes, chunks[i]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // tc-295a.9 — per-(transport, pane) hydration queue (no-interleave gate)
  // -------------------------------------------------------------------------

  describe("per-pane hydration queue (tc-295a.9)", () => {
    it("queues live bytes for a pane during its hydration window, then flushes in order on end", () => {
      const { demux, sessionProxy, frames } = setup([P1]);

      // Open the window — live bytes for P1 are now queued, not fanned out.
      demux.beginPaneHydration(sessionProxy, P1);

      demux.store.append(P1, bytes(0x01));
      demux.store.append(P1, bytes(0x02, 0x03));
      assert.equal(frames.length, 0, "live bytes must NOT fan out during hydration");

      // The hydrator would deliver clear+replay directly here (transport.sendData).
      // End the window — queued live bytes flush in arrival order, after the replay.
      demux.endPaneHydration(sessionProxy, P1);

      assert.equal(frames.length, 2, "both queued chunks flush on end");
      assert.deepEqual(frames[0]!.bytes, bytes(0x01));
      assert.deepEqual(frames[1]!.bytes, bytes(0x02, 0x03));
    });

    it("does not interleave: a directly-delivered replay frame precedes the queued live bytes", () => {
      const { demux, sessionProxy, frames } = setup([P1]);

      demux.beginPaneHydration(sessionProxy, P1);
      demux.store.append(P1, bytes(0xaa)); // live byte during hydration → queued

      // Simulate the hydrator delivering the clear+replay frame DIRECTLY.
      sessionProxy.sendData(P1, bytes(0xde, 0xad));

      // At this instant the replay is the only delivered frame.
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0]!.bytes, bytes(0xde, 0xad));

      demux.endPaneHydration(sessionProxy, P1);

      // Now the queued live byte follows the replay.
      assert.equal(frames.length, 2);
      assert.deepEqual(frames[1]!.bytes, bytes(0xaa));
    });

    it("only the hydrating transport queues; sibling transports keep streaming live", () => {
      const demux = createOutputDemux();
      const a = createInMemoryTransportPair();
      const b = createInMemoryTransportPair();
      const framesA = captureFrames(a.client);
      const framesB = captureFrames(b.client);
      demux.attachTransport(a.sessionProxy);
      demux.attachTransport(b.sessionProxy);
      demux.notifyPaneBound(P1);

      demux.beginPaneHydration(a.sessionProxy, P1);
      demux.store.append(P1, bytes(0x55));

      assert.equal(framesA.length, 0, "hydrating transport A queues");
      assert.equal(framesB.length, 1, "warm sibling B keeps receiving live bytes");
      assert.deepEqual(framesB[0]!.bytes, bytes(0x55));

      demux.endPaneHydration(a.sessionProxy, P1);
      assert.equal(framesA.length, 1, "A receives the queued byte on end");
      assert.deepEqual(framesA[0]!.bytes, bytes(0x55));
    });

    it("queue is per-pane: bytes for a non-hydrating pane fan out normally", () => {
      const { demux, sessionProxy, frames } = setup([P1, P2]);

      demux.beginPaneHydration(sessionProxy, P1);
      demux.store.append(P1, bytes(0x01)); // queued
      demux.store.append(P2, bytes(0x02)); // not hydrating → live

      assert.equal(frames.length, 1, "P2 fans out while P1 is gated");
      assert.deepEqual(frames[0]!.bytes, bytes(0x02));
      assert.equal(frames[0]!.paneId, P2);

      demux.endPaneHydration(sessionProxy, P1);
      assert.equal(frames.length, 2);
      assert.deepEqual(frames[1]!.bytes, bytes(0x01));
      assert.equal(frames[1]!.paneId, P1);
    });

    it("endPaneHydration on a pane that was not hydrating is a no-op", () => {
      const { demux, sessionProxy, frames } = setup([P1]);
      demux.endPaneHydration(sessionProxy, P1); // never began
      demux.store.append(P1, bytes(0x09));
      assert.equal(frames.length, 1, "no spurious frames; live path intact");
    });

    it("detachTransport drops in-flight hydration queues (no leak, no late flush)", () => {
      const { demux, sessionProxy, frames } = setup([P1]);
      demux.beginPaneHydration(sessionProxy, P1);
      demux.store.append(P1, bytes(0x01)); // queued
      demux.detachTransport(sessionProxy);
      // A late end must not throw and must not deliver to the detached transport.
      demux.endPaneHydration(sessionProxy, P1);
      assert.equal(frames.length, 0, "detached transport receives nothing");
    });

    it("notifyPaneClosed discards a hydrating pane's queue", () => {
      const { demux, sessionProxy, frames } = setup([P1]);
      demux.beginPaneHydration(sessionProxy, P1);
      demux.store.append(P1, bytes(0x01)); // queued
      demux.notifyPaneClosed(P1);
      demux.endPaneHydration(sessionProxy, P1); // queue already gone
      assert.equal(frames.length, 0, "closed pane's queued bytes are dropped");
    });
  });
});
