/**
 * SessionProxyConnection tests — acceptance criteria for tc-ahh.
 *
 * All tests use createInMemoryTransportPair() for deterministic, synchronous
 * delivery.  The session-proxy-side end of the pair simulates the real sessionProxy:
 *   - runSessionProxyHandshake drives the session-proxy side of the capabilities exchange.
 *   - After the handshake, sessionProxy.sendControl / sessionProxy.sendData push messages.
 *
 * Coverage:
 *   1. Happy path: connect() resolves to a NegotiatedSession with the correct
 *      protocolVersion and intersected features; state goes connecting→ready.
 *   2. Handshake failure (version mismatch): connect() rejects with
 *      HandshakeError (code "protocol.version-mismatch"), state → "failed".
 *   3. Close after ready: sessionProxy.close() → client state → "closed",
 *      onStateChange fires.
 *   4. Post-handshake control routing: a session-proxy→client control message sent
 *      after ready is surfaced via onControl.
 *   5. Post-handshake data routing: a data frame sent after ready is surfaced
 *      via onData.
 *   6. send() in ready state delivers the message to the session-proxy.
 *   7. send() in non-ready state throws.
 *   8. Buffering: messages arriving synchronously after handshake but before
 *      connect() resolves are delivered after connect() resolves.
 *   9. Double-connect guard: calling connect() twice throws.
 *  10. explicit close(): calling conn.close() → state "closed".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTransportPair, runSessionProxyHandshake, HandshakeError, WIRE_PROTOCOL_VERSION, paneId } from "@tmuxcc/protocol";
import type { SessionProxyMessage, NegotiatedSession, PaneId } from "@tmuxcc/protocol";

import { SessionProxyConnection } from "./connection.js";
import type { ConnectionState } from "./connection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_FEATURES = [
  "pane-lifecycle",
  "layout-updates",
  "focus-events",
  "input-forwarding",
] as const;

const P0: PaneId = paneId("p0");

/** Build a standard Capabilities object. */
function caps(features = ALL_FEATURES as unknown as string[]) {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features,
  } as const;
}

/**
 * Wire up a connected pair ready for a handshake test.
 * Returns { conn, sessionProxyTransport } where:
 *   - conn is the SessionProxyConnection under test.
 *   - sessionProxyTransport is the other end for driving the session-proxy side.
 */
function makePair(clientFeatures?: string[]) {
  const { sessionProxy: sessionProxyTransport, client: clientTransport } =
    createInMemoryTransportPair();
  const conn = new SessionProxyConnection(
    clientTransport,
    clientFeatures !== undefined ? { features: clientFeatures } : undefined,
  );
  return { conn, sessionProxyTransport };
}

// ---------------------------------------------------------------------------
// 1. Happy path — connect() resolves; state goes connecting → ready
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — happy path", () => {
  it("connect() resolves with a NegotiatedSession (matching version + intersected features)", async () => {
    const { conn, sessionProxyTransport } = makePair([
      "pane-lifecycle",
      "focus-events",
    ]);

    // Collect state transitions.
    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Run session-proxy side concurrently.  runSessionProxyHandshake sends session-proxy.capabilities
    // and waits for client.capabilities.
    const sessionProxyHandshake = runSessionProxyHandshake(
      sessionProxyTransport,
      caps(["pane-lifecycle", "layout-updates", "focus-events"]),
    );

    const session = await conn.connect();

    // SessionProxy side should also resolve.
    const sessionProxySession = await sessionProxyHandshake;

    // Both sides agree on the session.
    assert.equal(session.protocolVersion, WIRE_PROTOCOL_VERSION);
    assert.deepEqual(
      [...session.features].sort(),
      ["focus-events", "pane-lifecycle"], // intersection
    );
    assert.deepEqual(
      [...sessionProxySession.features].sort(),
      ["focus-events", "pane-lifecycle"],
    );

    // State: connecting was emitted first (from connect()), then ready.
    assert.deepEqual(states, ["connecting", "ready"]);
    assert.equal(conn.state, "ready");

    // session getter matches resolved value.
    assert.ok(conn.session !== undefined);
    assert.equal(conn.session.protocolVersion, WIRE_PROTOCOL_VERSION);
  });

  it("session getter is defined after connect()", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    const s: NegotiatedSession | undefined = conn.session;
    assert.ok(s !== undefined);
    assert.equal(s.protocolVersion, WIRE_PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 2. Handshake failure — version mismatch → state "failed", rejects HandshakeError
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — handshake failure", () => {
  it("connect() rejects with HandshakeError when session-proxy advertises a different version", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Advertise a mismatched version from the session-proxy side.
    const mismatchedCaps = {
      protocolVersion: (WIRE_PROTOCOL_VERSION + 1) as typeof WIRE_PROTOCOL_VERSION,
      features: [] as string[],
    };

    // The session-proxy handshake will reject too (version mismatch on its end),
    // so we swallow that error.
    const sessionProxyHandshake = runSessionProxyHandshake(
      sessionProxyTransport,
      mismatchedCaps,
    ).catch(() => {
      /* expected */
    });

    await assert.rejects(
      () => conn.connect(),
      (err: unknown) => {
        assert.ok(err instanceof HandshakeError, "should be HandshakeError");
        assert.equal(err.code, "protocol.version-mismatch");
        return true;
      },
    );

    await sessionProxyHandshake;

    // State should be "failed".
    assert.equal(conn.state, "failed");
    // States emitted: connecting, failed.
    assert.deepEqual(states, ["connecting", "failed"]);
    // session is undefined after failure.
    assert.equal(conn.session, undefined);
  });

  it("connect() rejects with HandshakeError when session-proxy closes transport before handshake", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Close the session-proxy transport immediately — client should see transport.closed.
    // We use a microtask deferral so connect() installs its handlers first.
    const connectPromise = conn.connect();
    sessionProxyTransport.close();

    await assert.rejects(
      () => connectPromise,
      (err: unknown) => {
        assert.ok(err instanceof HandshakeError, "should be HandshakeError");
        assert.equal(err.code, "transport.closed");
        return true;
      },
    );

    assert.equal(conn.state, "failed");
  });
});

// ---------------------------------------------------------------------------
// 3. Close after ready — transport.close() → state "closed", onStateChange fires
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — close after ready", () => {
  it("session-proxy closing the transport after ready transitions state to 'closed'", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Complete handshake.
    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    assert.equal(conn.state, "ready");

    // SessionProxy closes — client should transition to "closed".
    sessionProxyTransport.close();

    assert.equal(conn.state, "closed");
    // The last emitted state is "closed".
    assert.equal(states[states.length - 1], "closed");
  });

  it("explicit conn.close() in ready state transitions to 'closed'", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    conn.close();

    assert.equal(conn.state, "closed");
    assert.equal(states[states.length - 1], "closed");
  });

  it("conn.close() is idempotent (safe to call twice)", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    conn.close();
    assert.doesNotThrow(() => conn.close());
    assert.equal(conn.state, "closed");
  });
});

// ---------------------------------------------------------------------------
// 4. Post-handshake control routing — onControl receives session-proxy→client messages
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — post-handshake control routing", () => {
  it("session-proxy control message after ready is surfaced via onControl", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const received: SessionProxyMessage[] = [];
    conn.onControl((msg) => received.push(msg));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    // SessionProxy sends a pane.opened message after handshake.
    const msg: SessionProxyMessage = {
      type: "pane.opened",
      seq: 2,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/protocol").WindowId,
      cols: 80,
      rows: 24,
      active: true,
    };
    sessionProxyTransport.sendControl(msg);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], msg);
  });

  it("multiple session-proxy control messages are all routed to onControl", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const received: SessionProxyMessage[] = [];
    conn.onControl((msg) => received.push(msg));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    const msgs: SessionProxyMessage[] = [
      {
        type: "pane.opened",
        seq: 2,
        paneId: P0,
        windowId: "w0" as import("@tmuxcc/protocol").WindowId,
        cols: 80,
        rows: 24,
        active: true,
      },
      {
        type: "pane.closed",
        seq: 3,
        paneId: P0,
        windowId: "w0" as import("@tmuxcc/protocol").WindowId,
      },
    ];

    for (const m of msgs) {
      sessionProxyTransport.sendControl(m);
    }

    assert.equal(received.length, 2);
    assert.deepEqual(received[0], msgs[0]);
    assert.deepEqual(received[1], msgs[1]);
  });
});

// ---------------------------------------------------------------------------
// 5. Post-handshake data routing — onData receives raw pane bytes
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — post-handshake data routing", () => {
  it("session-proxy data frame after ready is surfaced via onData", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const receivedData: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];
    conn.onData((pid, bytes) => receivedData.push({ paneId: pid, bytes }));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    const bytes = new TextEncoder().encode("hello pane");
    sessionProxyTransport.sendData(P0, bytes);

    assert.equal(receivedData.length, 1);
    assert.equal(receivedData[0]?.paneId, P0);
    assert.deepEqual(receivedData[0]?.bytes, bytes);
  });

  it("binary (non-UTF-8) data frames are delivered intact", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const receivedData: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];
    conn.onData((pid, bytes) => receivedData.push({ paneId: pid, bytes }));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    const bytes = Uint8Array.from([0xff, 0x00, 0xfe, 0x80]);
    sessionProxyTransport.sendData(P0, bytes);

    assert.equal(receivedData.length, 1);
    assert.deepEqual(receivedData[0]?.bytes, bytes);
  });
});

// ---------------------------------------------------------------------------
// 6. send() in ready state — client→session-proxy message delivery
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — send() in ready state", () => {
  it("send() delivers a ClientMessage to the session-proxy transport", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const sessionProxyReceived: import("@tmuxcc/protocol").ControlMessage[] = [];
    sessionProxyTransport.onControl((msg) => sessionProxyReceived.push(msg));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    // The sessionProxy.onControl was replaced by runSessionProxyHandshake and then
    // cleared when it settled.  Re-install it for this test.
    sessionProxyTransport.onControl((msg) => sessionProxyReceived.push(msg));

    const inputMsg: import("@tmuxcc/protocol").InputMessage = {
      type: "input",
      seq: 1,
      paneId: P0,
      data: "ls -la\r",
    };

    conn.send(inputMsg);

    assert.equal(sessionProxyReceived.length, 1);
    assert.deepEqual(sessionProxyReceived[0], inputMsg);
  });
});

// ---------------------------------------------------------------------------
// 7. send() in non-ready state — throws
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — send() guards", () => {
  it("send() throws if called before connect()", () => {
    const { conn } = makePair();
    assert.throws(
      () =>
        conn.send({
          type: "input",
          seq: 1,
          paneId: P0,
          data: "hello\r",
        }),
      /ready/,
    );
  });

  it("send() throws after close()", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    conn.close();

    assert.throws(
      () =>
        conn.send({
          type: "input",
          seq: 1,
          paneId: P0,
          data: "hello\r",
        }),
      /ready/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Buffering — messages arriving before onControl is installed
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — message buffering", () => {
  it("control messages arriving before onControl is registered are buffered and delivered when handler is installed after connect()", async () => {
    const { conn, sessionProxyTransport } = makePair();

    // Do NOT install onControl before connect().
    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());

    // connect() installs post-handshake routing internally.
    // After connect() resolves, send a message — but install onControl AFTER.
    await conn.connect();
    await sessionProxyHandshake;

    // Send a message while no control handler is installed on the connection.
    const msg: SessionProxyMessage = {
      type: "focus.changed",
      seq: 2,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/protocol").WindowId,
    };
    sessionProxyTransport.sendControl(msg);

    // Now install the handler — the buffered message is drained immediately on
    // handler install (tc-7ml.4: drain-on-register so Mirror.connectTo() after
    // await connect() receives buffered snapshots reliably).
    const received: SessionProxyMessage[] = [];
    conn.onControl((m) => received.push(m));

    // msg was buffered while no handler was registered; it is delivered
    // synchronously when the handler is installed via onControl().
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], msg);

    // Messages sent AFTER the handler is registered arrive directly.
    const msg2: SessionProxyMessage = {
      type: "pane.opened",
      seq: 3,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/protocol").WindowId,
      cols: 80,
      rows: 24,
      active: false,
    };
    sessionProxyTransport.sendControl(msg2);

    assert.equal(received.length, 2);
    assert.deepEqual(received[1], msg2);
  });

  it("handler registered BEFORE connect() receives all messages without buffering", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const received: SessionProxyMessage[] = [];
    // Register BEFORE connect().
    conn.onControl((msg) => received.push(msg));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    const msg: SessionProxyMessage = {
      type: "pane.opened",
      seq: 2,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/protocol").WindowId,
      cols: 80,
      rows: 24,
      active: true,
    };
    sessionProxyTransport.sendControl(msg);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], msg);
  });
});

// ---------------------------------------------------------------------------
// 9. Double-connect guard
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — double-connect guard", () => {
  it("calling connect() twice throws synchronously on the second call", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    await assert.rejects(
      () => conn.connect(),
      /once/,
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Multiple onStateChange handlers — all fire
// ---------------------------------------------------------------------------

describe("SessionProxyConnection — multiple onStateChange handlers", () => {
  it("all registered state-change handlers fire on each transition", async () => {
    const { conn, sessionProxyTransport } = makePair();

    const eventsA: ConnectionState[] = [];
    const eventsB: ConnectionState[] = [];

    conn.onStateChange((s) => eventsA.push(s));
    conn.onStateChange((s) => eventsB.push(s));

    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, caps());
    await conn.connect();
    await sessionProxyHandshake;

    conn.close();

    // Both handlers should have seen connecting, ready, closed.
    assert.deepEqual(eventsA, ["connecting", "ready", "closed"]);
    assert.deepEqual(eventsB, ["connecting", "ready", "closed"]);
  });
});
