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
import type { ControlMessage } from "./session-proxy-control.js";
import { paneId } from "./ids.js";

// ---------------------------------------------------------------------------
// Control-plane tests
// ---------------------------------------------------------------------------

describe("InMemoryTransportPair — control plane", () => {
  it("delivers a control message from session-proxy to client", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    const received: ControlMessage[] = [];
    client.onControl((msg) => received.push(msg));

    const msg: ControlMessage = {
      type: "pane.opened",
      seq: 1,
      paneId: paneId("p0"),
      windowId: "w0" as ControlMessage extends { windowId: infer W } ? W : never,
      cols: 80,
      rows: 24,
      active: true,
    };

    sessionProxy.sendControl(msg);

    assert.equal(received.length, 1, "expected exactly one message");
    assert.deepStrictEqual(received[0], msg);
  });

  it("delivers a control message from client to session-proxy", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    const received: ControlMessage[] = [];
    sessionProxy.onControl((msg) => received.push(msg));

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
    const { sessionProxy, client } = createInMemoryTransportPair();

    const first: ControlMessage[] = [];
    const second: ControlMessage[] = [];

    client.onControl((msg) => first.push(msg));
    client.onControl((msg) => second.push(msg)); // replaces first

    const msg: ControlMessage = {
      type: "focus.changed",
      seq: 2,
      paneId: paneId("p0"),
      windowId: null,
    };

    sessionProxy.sendControl(msg);

    assert.equal(first.length, 0, "first handler should have been replaced");
    assert.equal(second.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Data-plane tests
// ---------------------------------------------------------------------------

describe("InMemoryTransportPair — data plane", () => {
  it("delivers raw bytes from session-proxy to client, byte-identical", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    const pid = paneId("p0");
    const sentBytes = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

    let receivedPaneId: ReturnType<typeof paneId> | null = null;
    let receivedBytes: Uint8Array | null = null;

    client.onData((id, bytes) => {
      receivedPaneId = id;
      receivedBytes = bytes;
    });

    sessionProxy.sendData(pid, sentBytes);

    assert.equal(receivedPaneId, pid);
    assert.ok(receivedBytes !== null);
    assert.deepStrictEqual(Array.from(receivedBytes as Uint8Array), Array.from(sentBytes));
  });

  it("delivers non-UTF-8 bytes byte-identical (binary transparency)", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    // Non-UTF-8 sequence: 0xff 0x00 0xfe — would corrupt if run through JSON/base64.
    const nonUtf8 = Uint8Array.from([0xff, 0x00, 0xfe]);
    const pid = paneId("p2");

    let receivedBytes: Uint8Array | null = null;
    client.onData((_id, bytes) => {
      receivedBytes = bytes;
    });

    sessionProxy.sendData(pid, nonUtf8);

    assert.ok(receivedBytes !== null, "expected bytes to be received");
    assert.deepStrictEqual(
      Array.from(receivedBytes as Uint8Array),
      [0xff, 0x00, 0xfe],
      "non-UTF-8 bytes must survive the transport unchanged",
    );
  });

  it("delivers raw bytes from client to session-proxy", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    const pid = paneId("p3");
    const bytes = Uint8Array.from([0x1b, 0x5b, 0x41]); // ESC [ A (cursor up)

    let receivedBytes: Uint8Array | null = null;
    sessionProxy.onData((_id, b) => {
      receivedBytes = b;
    });

    client.sendData(pid, bytes);

    assert.ok(receivedBytes !== null);
    assert.deepStrictEqual(Array.from(receivedBytes as Uint8Array), Array.from(bytes));
  });

  it("tags data frames with the correct paneId", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    const received: Array<{ paneId: string; bytes: number[] }> = [];
    client.onData((id, bytes) => received.push({ paneId: id, bytes: Array.from(bytes) }));

    sessionProxy.sendData(paneId("p10"), Uint8Array.from([0x61]));
    sessionProxy.sendData(paneId("p11"), Uint8Array.from([0x62]));

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
    const { sessionProxy, client } = createInMemoryTransportPair();

    let clientCloseCalled = false;
    client.onClose(() => {
      clientCloseCalled = true;
    });

    sessionProxy.close();

    assert.ok(clientCloseCalled, "client onClose handler should fire when session-proxy closes");
  });

  it("also fires the closing endpoint's own onClose handler", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    let sessionProxyCloseCalled = false;
    let clientCloseCalled = false;

    sessionProxy.onClose(() => {
      sessionProxyCloseCalled = true;
    });
    client.onClose(() => {
      clientCloseCalled = true;
    });

    sessionProxy.close();

    assert.ok(sessionProxyCloseCalled, "session-proxy onClose handler should fire");
    assert.ok(clientCloseCalled, "client onClose handler should fire");
  });

  it("propagates an error to both close handlers", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    const testErr = new Error("transport failure");
    let sessionProxyErr: Error | undefined;
    let clientErr: Error | undefined;

    sessionProxy.onClose((err) => {
      sessionProxyErr = err;
    });
    client.onClose((err) => {
      clientErr = err;
    });

    sessionProxy.close(testErr);

    assert.equal(clientErr, testErr, "error should propagate to client");
    assert.equal(sessionProxyErr, testErr, "error should propagate to session-proxy's own handler");
  });

  it("close is idempotent — calling close twice does not double-fire handlers", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    let callCount = 0;
    client.onClose(() => {
      callCount++;
    });

    sessionProxy.close();
    sessionProxy.close(); // second close — should be a no-op

    assert.equal(callCount, 1);
  });

  it("drops messages sent after close", () => {
    const { sessionProxy, client } = createInMemoryTransportPair();

    const received: ControlMessage[] = [];
    client.onControl((msg) => received.push(msg));

    sessionProxy.close();

    const msg: ControlMessage = { type: "focus.changed", seq: 3, paneId: null, windowId: null };
    sessionProxy.sendControl(msg); // should silently drop

    assert.equal(received.length, 0, "messages after close should be dropped");
  });
});
