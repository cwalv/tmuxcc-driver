/**
 * DaemonConnection tests — acceptance criteria for tc-ahh.
 *
 * All tests use createInMemoryTransportPair() for deterministic, synchronous
 * delivery.  The daemon-side end of the pair simulates the real daemon:
 *   - runDaemonHandshake drives the daemon side of the capabilities exchange.
 *   - After the handshake, daemon.sendControl / daemon.sendData push messages.
 *
 * Coverage:
 *   1. Happy path: connect() resolves to a NegotiatedSession with the correct
 *      protocolVersion and intersected features; state goes connecting→ready.
 *   2. Handshake failure (version mismatch): connect() rejects with
 *      HandshakeError (code "protocol.version-mismatch"), state → "failed".
 *   3. Close after ready: daemon.close() → client state → "closed",
 *      onStateChange fires.
 *   4. Post-handshake control routing: a daemon→client control message sent
 *      after ready is surfaced via onControl.
 *   5. Post-handshake data routing: a data frame sent after ready is surfaced
 *      via onData.
 *   6. send() in ready state delivers the message to the daemon.
 *   7. send() in non-ready state throws.
 *   8. Buffering: messages arriving synchronously after handshake but before
 *      connect() resolves are delivered after connect() resolves.
 *   9. Double-connect guard: calling connect() twice throws.
 *  10. explicit close(): calling conn.close() → state "closed".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createInMemoryTransportPair,
  runDaemonHandshake,
  HandshakeError,
  WIRE_PROTOCOL_VERSION,
  paneId,
} from "@tmuxcc/daemon";
import type {
  DaemonMessage,
  NegotiatedSession,
  PaneId,
} from "@tmuxcc/daemon";

import { DaemonConnection } from "./connection.js";
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
 * Returns { conn, daemonTransport } where:
 *   - conn is the DaemonConnection under test.
 *   - daemonTransport is the other end for driving the daemon side.
 */
function makePair(clientFeatures?: string[]) {
  const { daemon: daemonTransport, client: clientTransport } =
    createInMemoryTransportPair();
  const conn = new DaemonConnection(
    clientTransport,
    clientFeatures !== undefined ? { features: clientFeatures } : undefined,
  );
  return { conn, daemonTransport };
}

// ---------------------------------------------------------------------------
// 1. Happy path — connect() resolves; state goes connecting → ready
// ---------------------------------------------------------------------------

describe("DaemonConnection — happy path", () => {
  it("connect() resolves with a NegotiatedSession (matching version + intersected features)", async () => {
    const { conn, daemonTransport } = makePair([
      "pane-lifecycle",
      "focus-events",
    ]);

    // Collect state transitions.
    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Run daemon side concurrently.  runDaemonHandshake sends daemon.capabilities
    // and waits for client.capabilities.
    const daemonHandshake = runDaemonHandshake(
      daemonTransport,
      caps(["pane-lifecycle", "layout-updates", "focus-events"]),
    );

    const session = await conn.connect();

    // Daemon side should also resolve.
    const daemonSession = await daemonHandshake;

    // Both sides agree on the session.
    assert.equal(session.protocolVersion, WIRE_PROTOCOL_VERSION);
    assert.deepEqual(
      [...session.features].sort(),
      ["focus-events", "pane-lifecycle"], // intersection
    );
    assert.deepEqual(
      [...daemonSession.features].sort(),
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
    const { conn, daemonTransport } = makePair();

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    const s: NegotiatedSession | undefined = conn.session;
    assert.ok(s !== undefined);
    assert.equal(s.protocolVersion, WIRE_PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 2. Handshake failure — version mismatch → state "failed", rejects HandshakeError
// ---------------------------------------------------------------------------

describe("DaemonConnection — handshake failure", () => {
  it("connect() rejects with HandshakeError when daemon advertises a different version", async () => {
    const { conn, daemonTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Advertise a mismatched version from the daemon side.
    const mismatchedCaps = {
      protocolVersion: (WIRE_PROTOCOL_VERSION + 1) as typeof WIRE_PROTOCOL_VERSION,
      features: [] as string[],
    };

    // The daemon handshake will reject too (version mismatch on its end),
    // so we swallow that error.
    const daemonHandshake = runDaemonHandshake(
      daemonTransport,
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

    await daemonHandshake;

    // State should be "failed".
    assert.equal(conn.state, "failed");
    // States emitted: connecting, failed.
    assert.deepEqual(states, ["connecting", "failed"]);
    // session is undefined after failure.
    assert.equal(conn.session, undefined);
  });

  it("connect() rejects with HandshakeError when daemon closes transport before handshake", async () => {
    const { conn, daemonTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Close the daemon transport immediately — client should see transport.closed.
    // We use a microtask deferral so connect() installs its handlers first.
    const connectPromise = conn.connect();
    daemonTransport.close();

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

describe("DaemonConnection — close after ready", () => {
  it("daemon closing the transport after ready transitions state to 'closed'", async () => {
    const { conn, daemonTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    // Complete handshake.
    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    assert.equal(conn.state, "ready");

    // Daemon closes — client should transition to "closed".
    daemonTransport.close();

    assert.equal(conn.state, "closed");
    // The last emitted state is "closed".
    assert.equal(states[states.length - 1], "closed");
  });

  it("explicit conn.close() in ready state transitions to 'closed'", async () => {
    const { conn, daemonTransport } = makePair();

    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    conn.close();

    assert.equal(conn.state, "closed");
    assert.equal(states[states.length - 1], "closed");
  });

  it("conn.close() is idempotent (safe to call twice)", async () => {
    const { conn, daemonTransport } = makePair();

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    conn.close();
    assert.doesNotThrow(() => conn.close());
    assert.equal(conn.state, "closed");
  });
});

// ---------------------------------------------------------------------------
// 4. Post-handshake control routing — onControl receives daemon→client messages
// ---------------------------------------------------------------------------

describe("DaemonConnection — post-handshake control routing", () => {
  it("daemon control message after ready is surfaced via onControl", async () => {
    const { conn, daemonTransport } = makePair();

    const received: DaemonMessage[] = [];
    conn.onControl((msg) => received.push(msg));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    // Daemon sends a pane.opened message after handshake.
    const msg: DaemonMessage = {
      type: "pane.opened",
      seq: 2,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/daemon").WindowId,
      sessionId: "s0" as import("@tmuxcc/daemon").SessionId,
      cols: 80,
      rows: 24,
      active: true,
    };
    daemonTransport.sendControl(msg);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], msg);
  });

  it("multiple daemon control messages are all routed to onControl", async () => {
    const { conn, daemonTransport } = makePair();

    const received: DaemonMessage[] = [];
    conn.onControl((msg) => received.push(msg));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    const msgs: DaemonMessage[] = [
      {
        type: "pane.opened",
        seq: 2,
        paneId: P0,
        windowId: "w0" as import("@tmuxcc/daemon").WindowId,
        sessionId: "s0" as import("@tmuxcc/daemon").SessionId,
        cols: 80,
        rows: 24,
        active: true,
      },
      {
        type: "pane.closed",
        seq: 3,
        paneId: P0,
        windowId: "w0" as import("@tmuxcc/daemon").WindowId,
        sessionId: "s0" as import("@tmuxcc/daemon").SessionId,
      },
    ];

    for (const m of msgs) {
      daemonTransport.sendControl(m);
    }

    assert.equal(received.length, 2);
    assert.deepEqual(received[0], msgs[0]);
    assert.deepEqual(received[1], msgs[1]);
  });
});

// ---------------------------------------------------------------------------
// 5. Post-handshake data routing — onData receives raw pane bytes
// ---------------------------------------------------------------------------

describe("DaemonConnection — post-handshake data routing", () => {
  it("daemon data frame after ready is surfaced via onData", async () => {
    const { conn, daemonTransport } = makePair();

    const receivedData: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];
    conn.onData((pid, bytes) => receivedData.push({ paneId: pid, bytes }));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    const bytes = new TextEncoder().encode("hello pane");
    daemonTransport.sendData(P0, bytes);

    assert.equal(receivedData.length, 1);
    assert.equal(receivedData[0]?.paneId, P0);
    assert.deepEqual(receivedData[0]?.bytes, bytes);
  });

  it("binary (non-UTF-8) data frames are delivered intact", async () => {
    const { conn, daemonTransport } = makePair();

    const receivedData: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];
    conn.onData((pid, bytes) => receivedData.push({ paneId: pid, bytes }));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    const bytes = Uint8Array.from([0xff, 0x00, 0xfe, 0x80]);
    daemonTransport.sendData(P0, bytes);

    assert.equal(receivedData.length, 1);
    assert.deepEqual(receivedData[0]?.bytes, bytes);
  });
});

// ---------------------------------------------------------------------------
// 6. send() in ready state — client→daemon message delivery
// ---------------------------------------------------------------------------

describe("DaemonConnection — send() in ready state", () => {
  it("send() delivers a ClientMessage to the daemon transport", async () => {
    const { conn, daemonTransport } = makePair();

    const daemonReceived: import("@tmuxcc/daemon").ControlMessage[] = [];
    daemonTransport.onControl((msg) => daemonReceived.push(msg));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    // The daemon.onControl was replaced by runDaemonHandshake and then
    // cleared when it settled.  Re-install it for this test.
    daemonTransport.onControl((msg) => daemonReceived.push(msg));

    const inputMsg: import("@tmuxcc/daemon").InputMessage = {
      type: "input",
      seq: 1,
      paneId: P0,
      data: "ls -la\r",
    };

    conn.send(inputMsg);

    assert.equal(daemonReceived.length, 1);
    assert.deepEqual(daemonReceived[0], inputMsg);
  });
});

// ---------------------------------------------------------------------------
// 7. send() in non-ready state — throws
// ---------------------------------------------------------------------------

describe("DaemonConnection — send() guards", () => {
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
    const { conn, daemonTransport } = makePair();

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

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

describe("DaemonConnection — message buffering", () => {
  it("control messages arriving before onControl is registered are buffered and delivered when handler is installed after connect()", async () => {
    const { conn, daemonTransport } = makePair();

    // Do NOT install onControl before connect().
    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());

    // connect() installs post-handshake routing internally.
    // After connect() resolves, send a message — but install onControl AFTER.
    await conn.connect();
    await daemonHandshake;

    // Send a message while no control handler is installed on the connection.
    const msg: DaemonMessage = {
      type: "focus.changed",
      seq: 2,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/daemon").WindowId,
      sessionId: "s0" as import("@tmuxcc/daemon").SessionId,
    };
    daemonTransport.sendControl(msg);

    // Now install the handler — the buffered message is drained immediately on
    // handler install (tc-7ml.4: drain-on-register so Mirror.connectTo() after
    // await connect() receives buffered snapshots reliably).
    const received: DaemonMessage[] = [];
    conn.onControl((m) => received.push(m));

    // msg was buffered while no handler was registered; it is delivered
    // synchronously when the handler is installed via onControl().
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], msg);

    // Messages sent AFTER the handler is registered arrive directly.
    const msg2: DaemonMessage = {
      type: "pane.opened",
      seq: 3,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/daemon").WindowId,
      sessionId: "s0" as import("@tmuxcc/daemon").SessionId,
      cols: 80,
      rows: 24,
      active: false,
    };
    daemonTransport.sendControl(msg2);

    assert.equal(received.length, 2);
    assert.deepEqual(received[1], msg2);
  });

  it("handler registered BEFORE connect() receives all messages without buffering", async () => {
    const { conn, daemonTransport } = makePair();

    const received: DaemonMessage[] = [];
    // Register BEFORE connect().
    conn.onControl((msg) => received.push(msg));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    const msg: DaemonMessage = {
      type: "pane.opened",
      seq: 2,
      paneId: P0,
      windowId: "w0" as import("@tmuxcc/daemon").WindowId,
      sessionId: "s0" as import("@tmuxcc/daemon").SessionId,
      cols: 80,
      rows: 24,
      active: true,
    };
    daemonTransport.sendControl(msg);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], msg);
  });
});

// ---------------------------------------------------------------------------
// 9. Double-connect guard
// ---------------------------------------------------------------------------

describe("DaemonConnection — double-connect guard", () => {
  it("calling connect() twice throws synchronously on the second call", async () => {
    const { conn, daemonTransport } = makePair();

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    await assert.rejects(
      () => conn.connect(),
      /once/,
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Multiple onStateChange handlers — all fire
// ---------------------------------------------------------------------------

describe("DaemonConnection — multiple onStateChange handlers", () => {
  it("all registered state-change handlers fire on each transition", async () => {
    const { conn, daemonTransport } = makePair();

    const eventsA: ConnectionState[] = [];
    const eventsB: ConnectionState[] = [];

    conn.onStateChange((s) => eventsA.push(s));
    conn.onStateChange((s) => eventsB.push(s));

    const daemonHandshake = runDaemonHandshake(daemonTransport, caps());
    await conn.connect();
    await daemonHandshake;

    conn.close();

    // Both handlers should have seen connecting, ready, closed.
    assert.deepEqual(eventsA, ["connecting", "ready", "closed"]);
    assert.deepEqual(eventsB, ["connecting", "ready", "closed"]);
  });
});
