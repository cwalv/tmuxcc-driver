/**
 * Tests for the in-memory transport pair (src/wire/transport.ts).
 *
 * These tests exercise the Transport seam without any real socket or pipe:
 *   1. Control-plane round-trip: a ControlMessage sent on one endpoint
 *      arrives byte-identical on the other.
 *   2. Data-plane round-trip: raw bytes (including non-UTF-8 sequences)
 *      sent on one endpoint arrive byte-identical on the other.
 *   3. Close propagation: closing one endpoint notifies the other's onClose
 *      handler.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTransportPair } from "./transport.js";
import type { ControlMessage } from "./daemon-control.js";
import { paneId } from "./ids.js";

// ---------------------------------------------------------------------------
// Control-plane tests
// ---------------------------------------------------------------------------

describe("InMemoryTransportPair — control plane", () => {
  it("delivers a control message from daemon to client", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const received: ControlMessage[] = [];
    client.onControl((msg) => received.push(msg));

    const msg: ControlMessage = {
      type: "pane.opened",
      seq: 1,
      paneId: paneId("p0"),
      windowId: "w0" as ControlMessage extends { windowId: infer W } ? W : never,
      sessionId: "s0" as ControlMessage extends { sessionId: infer S } ? S : never,
      cols: 80,
      rows: 24,
      active: true,
    };

    daemon.sendControl(msg);

    assert.equal(received.length, 1, "expected exactly one message");
    assert.deepStrictEqual(received[0], msg);
  });

  it("delivers a control message from client to daemon", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const received: ControlMessage[] = [];
    daemon.onControl((msg) => received.push(msg));

    const msg: ControlMessage = {
      type: "input",
      seq: 1,
      paneId: paneId("p1"),
      data: "hello",
    };

    client.sendControl(msg);

    assert.equal(received.length, 1);
    assert.deepStrictEqual(received[0], msg);
  });

  it("replaces the control handler when onControl is called again", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const first: ControlMessage[] = [];
    const second: ControlMessage[] = [];

    client.onControl((msg) => first.push(msg));
    client.onControl((msg) => second.push(msg)); // replaces first

    const msg: ControlMessage = {
      type: "focus.changed",
      seq: 2,
      paneId: paneId("p0"),
      windowId: null,
      sessionId: null,
    };

    daemon.sendControl(msg);

    assert.equal(first.length, 0, "first handler should have been replaced");
    assert.equal(second.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Data-plane tests
// ---------------------------------------------------------------------------

describe("InMemoryTransportPair — data plane", () => {
  it("delivers raw bytes from daemon to client, byte-identical", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const pid = paneId("p0");
    const sentBytes = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

    let receivedPaneId: ReturnType<typeof paneId> | null = null;
    let receivedBytes: Uint8Array | null = null;

    client.onData((id, bytes) => {
      receivedPaneId = id;
      receivedBytes = bytes;
    });

    daemon.sendData(pid, sentBytes);

    assert.equal(receivedPaneId, pid);
    assert.ok(receivedBytes !== null);
    assert.deepStrictEqual(Array.from(receivedBytes as Uint8Array), Array.from(sentBytes));
  });

  it("delivers non-UTF-8 bytes byte-identical (binary transparency)", () => {
    const { daemon, client } = createInMemoryTransportPair();

    // Non-UTF-8 sequence: 0xff 0x00 0xfe — would corrupt if run through JSON/base64.
    const nonUtf8 = Uint8Array.from([0xff, 0x00, 0xfe]);
    const pid = paneId("p2");

    let receivedBytes: Uint8Array | null = null;
    client.onData((_id, bytes) => {
      receivedBytes = bytes;
    });

    daemon.sendData(pid, nonUtf8);

    assert.ok(receivedBytes !== null, "expected bytes to be received");
    assert.deepStrictEqual(
      Array.from(receivedBytes as Uint8Array),
      [0xff, 0x00, 0xfe],
      "non-UTF-8 bytes must survive the transport unchanged",
    );
  });

  it("delivers raw bytes from client to daemon", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const pid = paneId("p3");
    const bytes = Uint8Array.from([0x1b, 0x5b, 0x41]); // ESC [ A (cursor up)

    let receivedBytes: Uint8Array | null = null;
    daemon.onData((_id, b) => {
      receivedBytes = b;
    });

    client.sendData(pid, bytes);

    assert.ok(receivedBytes !== null);
    assert.deepStrictEqual(Array.from(receivedBytes as Uint8Array), Array.from(bytes));
  });

  it("tags data frames with the correct paneId", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const received: Array<{ paneId: string; bytes: number[] }> = [];
    client.onData((id, bytes) => received.push({ paneId: id, bytes: Array.from(bytes) }));

    daemon.sendData(paneId("p10"), Uint8Array.from([0x61]));
    daemon.sendData(paneId("p11"), Uint8Array.from([0x62]));

    assert.equal(received.length, 2);
    assert.equal(received[0]?.paneId, "p10");
    assert.equal(received[1]?.paneId, "p11");
    assert.deepStrictEqual(received[0]?.bytes, [0x61]);
    assert.deepStrictEqual(received[1]?.bytes, [0x62]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe("InMemoryTransportPair — lifecycle", () => {
  it("propagates close to the remote endpoint's onClose handler", () => {
    const { daemon, client } = createInMemoryTransportPair();

    let clientCloseCalled = false;
    client.onClose(() => {
      clientCloseCalled = true;
    });

    daemon.close();

    assert.ok(clientCloseCalled, "client onClose handler should fire when daemon closes");
  });

  it("also fires the closing endpoint's own onClose handler", () => {
    const { daemon, client } = createInMemoryTransportPair();

    let daemonCloseCalled = false;
    let clientCloseCalled = false;

    daemon.onClose(() => {
      daemonCloseCalled = true;
    });
    client.onClose(() => {
      clientCloseCalled = true;
    });

    daemon.close();

    assert.ok(daemonCloseCalled, "daemon onClose handler should fire");
    assert.ok(clientCloseCalled, "client onClose handler should fire");
  });

  it("propagates an error to both close handlers", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const testErr = new Error("transport failure");
    let daemonErr: Error | undefined;
    let clientErr: Error | undefined;

    daemon.onClose((err) => {
      daemonErr = err;
    });
    client.onClose((err) => {
      clientErr = err;
    });

    daemon.close(testErr);

    assert.equal(clientErr, testErr, "error should propagate to client");
    assert.equal(daemonErr, testErr, "error should propagate to daemon's own handler");
  });

  it("close is idempotent — calling close twice does not double-fire handlers", () => {
    const { daemon, client } = createInMemoryTransportPair();

    let callCount = 0;
    client.onClose(() => {
      callCount++;
    });

    daemon.close();
    daemon.close(); // second close — should be a no-op

    assert.equal(callCount, 1);
  });

  it("drops messages sent after close", () => {
    const { daemon, client } = createInMemoryTransportPair();

    const received: ControlMessage[] = [];
    client.onControl((msg) => received.push(msg));

    daemon.close();

    const msg: ControlMessage = { type: "focus.changed", seq: 3, paneId: null, windowId: null, sessionId: null };
    daemon.sendControl(msg); // should silently drop

    assert.equal(received.length, 0, "messages after close should be dropped");
  });
});
