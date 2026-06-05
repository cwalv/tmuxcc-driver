/**
 * tc-9hk: sendCommand tests.
 *
 * Verifies that `controller.sendCommand(cmd)` wraps the WireCommand in a
 * valid `command.request` ClientMessage and sends it over the wire.
 *
 * Two layers are tested:
 *   1. InputApi.sendCommand — unit test via a mock InputSender (no transport).
 *   2. ClientHandle.controller.sendCommand via createInMemoryTransportPair —
 *      end-to-end: the daemon end of the in-memory transport must receive a
 *      well-formed CommandRequestMessage.
 *
 * NO DOM, NO vscode.  Plain Node `node --test`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  paneId,
  sessionId,
  createInMemoryTransportPair,
  runDaemonHandshake,
  WIRE_PROTOCOL_VERSION,
} from "@tmuxcc/daemon";
import type {
  CommandRequestMessage,
  WireCommand,
  ClientMessage,
  SnapshotMessage,
} from "@tmuxcc/daemon";

import { createInputApi } from "./input.js";
import type { InputSender } from "./input.js";
import { connectClient } from "./client.js";
import { NoOpRenderHook } from "./render-hook.js";

// ---------------------------------------------------------------------------
// 1. InputApi.sendCommand — unit test via mock sender
// ---------------------------------------------------------------------------

describe("InputApi.sendCommand — unit", () => {
  it("sends a command.request with correct type, command, and correlationId", () => {
    const messages: ClientMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as ClientMessage); },
    };

    const api = createInputApi(sender);
    const cmd: WireCommand = {
      kind: "open-window",
    };
    api.sendCommand(cmd);

    assert.equal(messages.length, 1, "exactly one message should be sent");
    const msg = messages[0]!;
    assert.equal(msg.type, "command.request", "message type should be command.request");

    const req = msg as CommandRequestMessage;
    assert.deepEqual(req.command, cmd, "command payload should match");
    assert.ok(typeof req.correlationId === "string", "correlationId should be a string");
    assert.ok(req.correlationId.length > 0, "correlationId should be non-empty");
    assert.ok(typeof req.seq === "number", "seq should be a number");
    assert.ok(req.seq >= 1, "seq should be >= 1");
  });

  it("sendCommand seq increments relative to sendInput/resizePane calls", () => {
    const messages: ClientMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as ClientMessage); },
    };

    const api = createInputApi(sender);
    api.sendInput(paneId("p0"), "hello");  // seq=1
    api.sendCommand({ kind: "open-window" });  // seq=2

    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.seq, 1, "sendInput should use seq=1");
    assert.equal(messages[1]!.seq, 2, "sendCommand should use seq=2");
  });

  it("split-pane command has the correct shape", () => {
    const messages: ClientMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as ClientMessage); },
    };

    const api = createInputApi(sender);
    const cmd: WireCommand = {
      kind: "split-pane",
      paneId: paneId("p1"),
      direction: "horizontal",
    };
    api.sendCommand(cmd);

    const req = messages[0]! as CommandRequestMessage;
    assert.equal(req.type, "command.request");
    assert.deepEqual(req.command, cmd);
  });
});

// ---------------------------------------------------------------------------
// 2. createClient + createInMemoryTransportPair — integration
// ---------------------------------------------------------------------------

describe("ClientHandle.controller.sendCommand — via in-memory transport", () => {
  /**
   * Run the daemon side of the handshake and collect control messages.
   * Returns a promise that resolves with all client→daemon messages received
   * after the handshake, up until the first setTimeout(0) tick.
   */
  async function setupWithDaemonSide(): Promise<{
    receivedByDaemon: ClientMessage[];
    sendSnapshotAndStart: () => void;
  }> {
    const { daemon: daemonTransport, client: clientTransport } = createInMemoryTransportPair();

    const receivedByDaemon: ClientMessage[] = [];

    // Daemon handshake: send DaemonCapabilities, wait for ClientCapabilities.
    const daemonHandshakePromise = runDaemonHandshake(daemonTransport, {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle"],
    });

    // Connect client (runs handshake).
    const handle = await connectClient(clientTransport);

    await daemonHandshakePromise;

    // Attach no-op hook (required to complete the setup).
    handle.mirror.attach(NoOpRenderHook);

    // After handshake, install a control handler on the daemon side.
    daemonTransport.onControl((msg) => {
      receivedByDaemon.push(msg as ClientMessage);
    });

    // Daemon sends an empty snapshot so the mirror catches up.
    function sendSnapshotAndStart(): void {
      const snapshot: SnapshotMessage = {
        type: "snapshot",
        seq: 1,
        session: { sessionId: sessionId("s0"), name: "main" },
        windows: [],
        panes: [],
        focus: { paneId: null, windowId: null },
      };
      daemonTransport.sendControl(snapshot);
    }

    return { receivedByDaemon, sendSnapshotAndStart };
  }

  it("controller.sendCommand(open-window) → daemon receives CommandRequestMessage", async () => {
    const { client: clientTransport, daemon: daemonTransport } = createInMemoryTransportPair();
    const receivedByDaemon: ClientMessage[] = [];

    // Run daemon handshake.
    const daemonHandshakeP = runDaemonHandshake(daemonTransport, {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle"],
    });

    const handle = await connectClient(clientTransport);
    handle.mirror.attach(NoOpRenderHook);

    await daemonHandshakeP;

    // Install control handler on daemon side AFTER handshake.
    daemonTransport.onControl((msg) => {
      receivedByDaemon.push(msg as ClientMessage);
    });

    // Issue the command via the controller.
    const cmd: WireCommand = { kind: "open-window" };
    handle.controller.sendCommand(cmd);

    // The in-memory transport delivers synchronously.
    assert.equal(receivedByDaemon.length, 1, "daemon should receive exactly one message");
    const received = receivedByDaemon[0]! as CommandRequestMessage;
    assert.equal(received.type, "command.request", "type should be command.request");
    assert.deepEqual(received.command, cmd, "command payload should match");
    assert.ok(typeof received.correlationId === "string", "correlationId should be a string");
    assert.ok(received.correlationId.length > 0, "correlationId should be non-empty");

    handle.disconnect();
  });

  it("controller.sendCommand(split-pane) → daemon receives correct CommandRequestMessage", async () => {
    const { client: clientTransport, daemon: daemonTransport } = createInMemoryTransportPair();
    const receivedByDaemon: ClientMessage[] = [];

    const daemonHandshakeP = runDaemonHandshake(daemonTransport, {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle"],
    });
    const handle = await connectClient(clientTransport);
    handle.mirror.attach(NoOpRenderHook);
    await daemonHandshakeP;

    daemonTransport.onControl((msg) => {
      receivedByDaemon.push(msg as ClientMessage);
    });

    const cmd: WireCommand = {
      kind: "split-pane",
      paneId: paneId("p0"),
      direction: "vertical",
    };
    handle.controller.sendCommand(cmd);

    assert.equal(receivedByDaemon.length, 1);
    const received = receivedByDaemon[0]! as CommandRequestMessage;
    assert.equal(received.type, "command.request");
    assert.deepEqual(received.command, cmd);

    handle.disconnect();
  });
});
