/**
 * PaneStreamConsumer tests — acceptance criteria for tc-ekd.
 *
 * Coverage:
 *   1. Per-pane delivery: bytes for pane A and pane B go to their respective
 *      handlers only, in order.
 *   2. Non-UTF-8 safety: feed 0xff,0x00,0xfe,0x80 → handler receives
 *      byte-exact Uint8Array.
 *   3. Ordering: multiple chunks for one pane → received in order, FIFO.
 *   4. Pre-subscription buffering: bytes arrive before handler registered →
 *      flushed synchronously on registration, then live bytes continue.
 *   5. Global handler (onOutput): receives all panes, live frames only.
 *   6. Multiple per-pane handlers: all receive each chunk.
 *   7. Unsubscribe: after unsub(), no more delivery.
 *   8. getBuffered(): returns concatenated pre-subscription bytes.
 *   9. End-to-end via SessionProxyConnection + createInMemoryTransportPair:
 *      sessionProxy.sendData → consumer delivers to pane handler.
 *  10. Pre-subscription buffer cap (overflow):
 *      drop-oldest policy evicts front chunks when byte budget is exceeded.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTransportPair, runSessionProxyHandshake, WIRE_PROTOCOL_VERSION, paneId } from "@tmuxcc/protocol";
import type { PaneId } from "@tmuxcc/protocol";

import { SessionProxyConnection } from "./connection.js";
import { PaneStreamConsumer, connectPaneStream } from "./pane-stream.js";
import type { PaneStreamConsumerOptions } from "./pane-stream.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PA: PaneId = paneId("p-a");
const PB: PaneId = paneId("p-b");

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Set up a handshook SessionProxyConnection pair for integration tests. */
async function makeConnectedPair() {
  const { sessionProxy: sessionProxyTransport, client: clientTransport } =
    createInMemoryTransportPair();
  const conn = new SessionProxyConnection(clientTransport);
  const caps = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: ["pane-lifecycle"] as string[],
  } as const;
  const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps);
  await conn.connect();
  await sessionProxyHandshake;
  return { conn, sessionProxyTransport };
}

// ---------------------------------------------------------------------------
// 1. Per-pane delivery
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — per-pane delivery", () => {
  it("bytes for pane A go only to pane A's handler, and vice versa", () => {
    const consumer = new PaneStreamConsumer();

    const aReceived: Uint8Array[] = [];
    const bReceived: Uint8Array[] = [];

    consumer.onPaneOutput(PA, (b) => aReceived.push(b));
    consumer.onPaneOutput(PB, (b) => bReceived.push(b));

    const chunkA = text("hello from A");
    const chunkB = text("hello from B");
    const chunkA2 = text("more A");

    consumer.push(PA, chunkA);
    consumer.push(PB, chunkB);
    consumer.push(PA, chunkA2);

    // Pane A handler receives only pane A chunks.
    assert.equal(aReceived.length, 2);
    assert.deepEqual(aReceived[0], chunkA);
    assert.deepEqual(aReceived[1], chunkA2);

    // Pane B handler receives only pane B chunk.
    assert.equal(bReceived.length, 1);
    assert.deepEqual(bReceived[0], chunkB);
  });
});

// ---------------------------------------------------------------------------
// 2. Non-UTF-8 safety
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — non-UTF-8 safety", () => {
  it("feed 0xff,0x00,0xfe,0x80 → handler receives byte-exact Uint8Array", () => {
    const consumer = new PaneStreamConsumer();

    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));

    const nonUtf8 = Uint8Array.from([0xff, 0x00, 0xfe, 0x80]);
    consumer.push(PA, nonUtf8);

    assert.equal(received.length, 1);
    // Byte-exact comparison.
    assert.deepEqual(received[0], nonUtf8);
    assert.equal(received[0]![0], 0xff);
    assert.equal(received[0]![1], 0x00);
    assert.equal(received[0]![2], 0xfe);
    assert.equal(received[0]![3], 0x80);
  });

  it("handler receives the same Uint8Array instance (no copy, no stringify)", () => {
    const consumer = new PaneStreamConsumer();

    let received: Uint8Array | undefined;
    consumer.onPaneOutput(PA, (b) => {
      received = b;
    });

    const chunk = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    consumer.push(PA, chunk);

    // Should be the same reference (no wrapping or copying by the consumer).
    assert.ok(received !== undefined);
    assert.equal(received, chunk);
  });
});

// ---------------------------------------------------------------------------
// 3. Ordering — per-pane FIFO
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — per-pane FIFO ordering", () => {
  it("multiple chunks for one pane arrive in push order", () => {
    const consumer = new PaneStreamConsumer();

    const order: string[] = [];
    consumer.onPaneOutput(PA, (b) => order.push(new TextDecoder().decode(b)));

    consumer.push(PA, text("first"));
    consumer.push(PA, text("second"));
    consumer.push(PA, text("third"));

    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("interleaved panes do not affect per-pane ordering", () => {
    const consumer = new PaneStreamConsumer();

    const aOrder: number[] = [];
    const bOrder: number[] = [];

    consumer.onPaneOutput(PA, (b) => aOrder.push(b[0]!));
    consumer.onPaneOutput(PB, (b) => bOrder.push(b[0]!));

    consumer.push(PA, Uint8Array.from([1]));
    consumer.push(PB, Uint8Array.from([10]));
    consumer.push(PA, Uint8Array.from([2]));
    consumer.push(PB, Uint8Array.from([20]));
    consumer.push(PA, Uint8Array.from([3]));

    assert.deepEqual(aOrder, [1, 2, 3]);
    assert.deepEqual(bOrder, [10, 20]);
  });
});

// ---------------------------------------------------------------------------
// 4. Pre-subscription buffering
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — pre-subscription buffering", () => {
  it("bytes pushed before handler registration are flushed on registration", () => {
    const consumer = new PaneStreamConsumer();

    // Push bytes BEFORE any handler is registered for PA.
    const pre1 = text("pre-1");
    const pre2 = text("pre-2");
    consumer.push(PA, pre1);
    consumer.push(PA, pre2);

    // Now register the handler — pre-subscription bytes flush synchronously.
    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));

    // Buffered bytes should be delivered immediately.
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], pre1);
    assert.deepEqual(received[1], pre2);

    // Live bytes after registration also arrive.
    const live = text("live");
    consumer.push(PA, live);
    assert.equal(received.length, 3);
    assert.deepEqual(received[2], live);
  });

  it("pre-subscription buffer is cleared after flush — no double-delivery", () => {
    const consumer = new PaneStreamConsumer();

    consumer.push(PA, text("once"));

    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));

    // Register a second handler — should NOT get the already-flushed bytes.
    const secondReceived: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => secondReceived.push(b));

    // The second handler gets no backlog.
    assert.equal(secondReceived.length, 0);

    // Both handlers get subsequent live frames.
    consumer.push(PA, text("live"));
    assert.equal(received.length, 2); // pre + live
    assert.equal(secondReceived.length, 1); // live only
  });

  it("bytes for pane B are not buffered under pane A", () => {
    const consumer = new PaneStreamConsumer();

    consumer.push(PB, text("for B"));

    const aReceived: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => aReceived.push(b));

    // PA handler should receive nothing — "for B" is buffered under PB.
    assert.equal(aReceived.length, 0);

    // PB's buffer is still there.
    const bBuf = consumer.getBuffered(PB);
    assert.ok(bBuf !== undefined);
    assert.deepEqual(bBuf, text("for B"));
  });

  it("no bytes are lost: full sequence pre+live is concatenable", () => {
    const consumer = new PaneStreamConsumer();

    const allChunks: Uint8Array[] = [];

    consumer.push(PA, Uint8Array.from([0, 1, 2]));
    consumer.push(PA, Uint8Array.from([3, 4]));

    consumer.onPaneOutput(PA, (b) => allChunks.push(b));

    consumer.push(PA, Uint8Array.from([5, 6, 7]));

    // Concatenate all received chunks.
    const total = allChunks.reduce((sum, c) => sum + c.length, 0);
    const full = new Uint8Array(total);
    let off = 0;
    for (const c of allChunks) {
      full.set(c, off);
      off += c.length;
    }

    assert.deepEqual(full, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
  });
});

// ---------------------------------------------------------------------------
// 5. Global handler (onOutput)
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — global handler", () => {
  it("onOutput handler receives frames for all panes", () => {
    const consumer = new PaneStreamConsumer();

    consumer.onPaneOutput(PA, () => {
      /* no-op, so push goes live */
    });
    consumer.onPaneOutput(PB, () => {
      /* no-op */
    });

    const globalReceived: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];
    consumer.onOutput((pid, bytes) => globalReceived.push({ paneId: pid, bytes }));

    consumer.push(PA, text("from A"));
    consumer.push(PB, text("from B"));

    assert.equal(globalReceived.length, 2);
    assert.equal(globalReceived[0]?.paneId, PA);
    assert.equal(globalReceived[1]?.paneId, PB);
  });

  it("global handler fires AFTER per-pane handlers for same frame", () => {
    const consumer = new PaneStreamConsumer();

    const order: string[] = [];
    consumer.onPaneOutput(PA, () => order.push("pane"));
    consumer.onOutput(() => order.push("global"));

    consumer.push(PA, text("x"));

    assert.deepEqual(order, ["pane", "global"]);
  });

  it("global handler does NOT receive pre-subscription buffered bytes", () => {
    const consumer = new PaneStreamConsumer();

    // Push before any handler (pre-subscription buffer).
    consumer.push(PA, text("buffered"));

    const globalReceived: Uint8Array[] = [];
    consumer.onOutput((_pid, bytes) => globalReceived.push(bytes));

    // Register pane handler (flushes buffer to pane handler, NOT global).
    const paneReceived: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => paneReceived.push(b));

    // Pane handler gets the buffered bytes via flush.
    assert.equal(paneReceived.length, 1);

    // Global handler did NOT receive the flush.
    assert.equal(globalReceived.length, 0);

    // Subsequent live frames go to both.
    consumer.push(PA, text("live"));
    assert.equal(paneReceived.length, 2);
    assert.equal(globalReceived.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple per-pane handlers
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — multiple per-pane handlers", () => {
  it("all registered handlers for a pane receive each chunk", () => {
    const consumer = new PaneStreamConsumer();

    const h1: Uint8Array[] = [];
    const h2: Uint8Array[] = [];

    consumer.onPaneOutput(PA, (b) => h1.push(b));
    consumer.onPaneOutput(PA, (b) => h2.push(b));

    consumer.push(PA, text("shared"));

    assert.equal(h1.length, 1);
    assert.equal(h2.length, 1);
    assert.deepEqual(h1[0], text("shared"));
    assert.deepEqual(h2[0], text("shared"));
  });
});

// ---------------------------------------------------------------------------
// 7. Unsubscribe
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — unsubscribe", () => {
  it("after unsub(), handler no longer receives frames", () => {
    const consumer = new PaneStreamConsumer();

    const received: Uint8Array[] = [];
    const unsub = consumer.onPaneOutput(PA, (b) => received.push(b));

    consumer.push(PA, text("before"));
    unsub();
    consumer.push(PA, text("after"));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], text("before"));
  });

  it("unsub() for global handler stops delivery", () => {
    const consumer = new PaneStreamConsumer();
    consumer.onPaneOutput(PA, () => {}); // keep live path

    const received: Uint8Array[] = [];
    const unsub = consumer.onOutput((_pid, bytes) => received.push(bytes));

    consumer.push(PA, text("live1"));
    unsub();
    consumer.push(PA, text("live2"));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], text("live1"));
  });
});

// ---------------------------------------------------------------------------
// 8. getBuffered()
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — getBuffered", () => {
  it("returns undefined when no bytes have been pushed for the pane", () => {
    const consumer = new PaneStreamConsumer();
    assert.equal(consumer.getBuffered(PA), undefined);
  });

  it("returns undefined after a handler has been registered (buffer flushed)", () => {
    const consumer = new PaneStreamConsumer();
    consumer.push(PA, text("x"));
    consumer.onPaneOutput(PA, () => {});
    assert.equal(consumer.getBuffered(PA), undefined);
  });

  it("returns concatenated pre-subscription bytes as a single Uint8Array", () => {
    const consumer = new PaneStreamConsumer();
    consumer.push(PA, Uint8Array.from([1, 2]));
    consumer.push(PA, Uint8Array.from([3, 4, 5]));

    const buf = consumer.getBuffered(PA);
    assert.ok(buf !== undefined);
    assert.deepEqual(buf, Uint8Array.from([1, 2, 3, 4, 5]));
  });

  it("getBuffered returns a copy — mutating it does not affect internal buffer", () => {
    const consumer = new PaneStreamConsumer();
    consumer.push(PA, Uint8Array.from([10, 20]));

    const copy1 = consumer.getBuffered(PA)!;
    copy1[0] = 99; // mutate the copy

    const copy2 = consumer.getBuffered(PA)!;
    assert.equal(copy2[0], 10); // internal buffer is unchanged
  });
});

// ---------------------------------------------------------------------------
// 10. Pre-subscription buffer cap — overflow and drop-oldest policy
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — pre-subscription buffer cap (overflow)", () => {
  /** Build a consumer with a small cap for overflow testing. */
  function cappedConsumer(capBytes: number): PaneStreamConsumer {
    const opts: PaneStreamConsumerOptions = { preSubBufferCapBytes: capBytes };
    return new PaneStreamConsumer(opts);
  }

  it("buffers up to the cap without dropping anything", () => {
    // Cap = 10 bytes; push exactly 10 bytes in two chunks.
    const consumer = cappedConsumer(10);

    consumer.push(PA, Uint8Array.from([1, 2, 3, 4, 5]));    // 5 bytes
    consumer.push(PA, Uint8Array.from([6, 7, 8, 9, 10]));   // 5 bytes → total 10

    const buf = consumer.getBuffered(PA);
    assert.ok(buf !== undefined);
    assert.equal(buf.length, 10);
    assert.deepEqual(buf, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });

  it("drop-oldest: when cap is exceeded, oldest chunks are evicted", () => {
    // Cap = 10 bytes; push three 5-byte chunks (total 15 bytes).
    // After overflow: chunk 1 (oldest) should be dropped; chunks 2 + 3 survive.
    const consumer = cappedConsumer(10);

    const chunk1 = Uint8Array.from([1, 1, 1, 1, 1]);
    const chunk2 = Uint8Array.from([2, 2, 2, 2, 2]);
    const chunk3 = Uint8Array.from([3, 3, 3, 3, 3]);

    consumer.push(PA, chunk1); // 5 bytes in buffer
    consumer.push(PA, chunk2); // 10 bytes in buffer (at cap)
    consumer.push(PA, chunk3); // 15 bytes would exceed cap → chunk1 evicted

    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));

    // Should have received only chunk2 and chunk3 (chunk1 was dropped).
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], chunk2);
    assert.deepEqual(received[1], chunk3);
  });

  it("drop-oldest: multiple oldest chunks evicted when needed to make room", () => {
    // Cap = 6 bytes; fill with 2-byte chunks, then push a 6-byte chunk.
    // All previously buffered chunks should be evicted to make room.
    const consumer = cappedConsumer(6);

    consumer.push(PA, Uint8Array.from([1, 2])); // 2 bytes
    consumer.push(PA, Uint8Array.from([3, 4])); // 4 bytes
    consumer.push(PA, Uint8Array.from([5, 6])); // 6 bytes (at cap)
    // Now push 6 bytes: must evict all three prior 2-byte chunks.
    const big = Uint8Array.from([7, 8, 9, 10, 11, 12]);
    consumer.push(PA, big);

    const buf = consumer.getBuffered(PA);
    assert.ok(buf !== undefined);
    assert.deepEqual(buf, big);
  });

  it("drop-oldest: a single chunk larger than the cap stores only its tail", () => {
    // Cap = 4 bytes; push a single 10-byte chunk.
    // The last 4 bytes of the chunk should be retained.
    const consumer = cappedConsumer(4);

    const oversized = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    consumer.push(PA, oversized);

    const buf = consumer.getBuffered(PA);
    assert.ok(buf !== undefined);
    assert.equal(buf.length, 4);
    // Should be the trailing 4 bytes of the chunk.
    assert.deepEqual(buf, Uint8Array.from([7, 8, 9, 10]));
  });

  it("cap is per-pane: overflowing pane A does not affect pane B's buffer", () => {
    const consumer = cappedConsumer(5);

    consumer.push(PA, Uint8Array.from([1, 2, 3]));  // 3 bytes in A
    consumer.push(PB, Uint8Array.from([10, 20]));   // 2 bytes in B
    // Push to A to exceed cap: eviction happens only in A.
    consumer.push(PA, Uint8Array.from([4, 5, 6]));  // 6 bytes total for A → evict [1,2,3]

    const aBuf = consumer.getBuffered(PA);
    assert.ok(aBuf !== undefined);
    assert.deepEqual(aBuf, Uint8Array.from([4, 5, 6]));

    const bBuf = consumer.getBuffered(PB);
    assert.ok(bBuf !== undefined);
    assert.deepEqual(bBuf, Uint8Array.from([10, 20]));
  });

  it("live frames after handler registration are not affected by the cap", () => {
    // After handler registers and buffer flushes, live frames bypass the cap.
    const consumer = cappedConsumer(3);

    // Fill buffer to cap.
    consumer.push(PA, Uint8Array.from([1, 2, 3]));

    // Register handler — flushes.
    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));

    // Push more than cap as a live frame — should be delivered in full.
    const large = Uint8Array.from([10, 20, 30, 40, 50]);
    consumer.push(PA, large);

    assert.equal(received.length, 2);
    assert.deepEqual(received[0], Uint8Array.from([1, 2, 3])); // flushed pre-sub
    assert.deepEqual(received[1], large);                        // live, no cap
  });
});

// ---------------------------------------------------------------------------
// 9. End-to-end via SessionProxyConnection + createInMemoryTransportPair
// ---------------------------------------------------------------------------

describe("PaneStreamConsumer — end-to-end via SessionProxyConnection", () => {
  it("sessionProxy.sendData → consumer delivers to per-pane handler", async () => {
    const { conn, sessionProxyTransport } = await makeConnectedPair();
    const consumer = new PaneStreamConsumer();

    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));

    // Wire consumer AFTER connect() — safe per the connector contract.
    connectPaneStream(conn, consumer);

    const chunk = text("hello from session-proxy");
    sessionProxyTransport.sendData(PA, chunk);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], chunk);

    conn.close();
  });

  it("non-UTF-8 bytes survive the full SessionProxyConnection path", async () => {
    const { conn, sessionProxyTransport } = await makeConnectedPair();
    const consumer = new PaneStreamConsumer();

    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));
    connectPaneStream(conn, consumer);

    const nonUtf8 = Uint8Array.from([0xff, 0x00, 0xfe, 0x80]);
    sessionProxyTransport.sendData(PA, nonUtf8);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], nonUtf8);

    conn.close();
  });

  it("multiple panes via one connection are demuxed correctly", async () => {
    const { conn, sessionProxyTransport } = await makeConnectedPair();
    const consumer = new PaneStreamConsumer();

    const aReceived: Uint8Array[] = [];
    const bReceived: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => aReceived.push(b));
    consumer.onPaneOutput(PB, (b) => bReceived.push(b));
    connectPaneStream(conn, consumer);

    sessionProxyTransport.sendData(PA, text("A1"));
    sessionProxyTransport.sendData(PB, text("B1"));
    sessionProxyTransport.sendData(PA, text("A2"));

    assert.equal(aReceived.length, 2);
    assert.deepEqual(aReceived[0], text("A1"));
    assert.deepEqual(aReceived[1], text("A2"));
    assert.equal(bReceived.length, 1);
    assert.deepEqual(bReceived[0], text("B1"));

    conn.close();
  });

  it("pre-subscription bytes buffered before connectPaneStream are flushed to handler", async () => {
    // This test exercises the SessionProxyConnection's own pending-data buffer:
    // bytes sent by the session-proxy arrive in conn's #pendingData during the handshake
    // settlement window, then are drained into the consumer when the consumer's
    // push is installed via connectPaneStream.
    //
    // In the in-memory transport, sendData is synchronous, so messages sent after
    // conn.connect() resolves go directly to the installed handler.  We test
    // that messages sent right after connect() — before connectPaneStream is
    // called — are buffered in the consumer and flushed on handler registration.
    const { conn, sessionProxyTransport } = await makeConnectedPair();
    const consumer = new PaneStreamConsumer();

    // Wire BEFORE registering the pane handler — so consumer buffers them.
    connectPaneStream(conn, consumer);

    // SessionProxy sends data before we've registered a per-pane handler.
    sessionProxyTransport.sendData(PA, text("before-handler"));

    // Verify consumer has buffered it.
    const preReg = consumer.getBuffered(PA);
    assert.ok(preReg !== undefined);
    assert.deepEqual(preReg, text("before-handler"));

    // Register pane handler — should flush buffer.
    const received: Uint8Array[] = [];
    consumer.onPaneOutput(PA, (b) => received.push(b));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], text("before-handler"));

    // Buffer is gone.
    assert.equal(consumer.getBuffered(PA), undefined);

    // Live bytes still arrive.
    sessionProxyTransport.sendData(PA, text("after-handler"));
    assert.equal(received.length, 2);
    assert.deepEqual(received[1], text("after-handler"));

    conn.close();
  });
});
