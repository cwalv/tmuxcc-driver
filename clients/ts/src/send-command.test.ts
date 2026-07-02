/**
 * tc-9hk: sendCommand tests.
 *
 * Verifies that `controller.sendCommand(cmd)` wraps the WireCommand in a
 * valid `command.request` ClientMessage and sends it over the wire.
 *
 * Two layers are tested:
 *   1. InputApi.sendCommand — unit test via a mock InputSender (no transport).
 *   2. ClientHandle.controller.sendCommand via createInMemoryTransportPair —
 *      end-to-end: the session-proxy end of the in-memory transport must receive a
 *      well-formed CommandRequestMessage.
 *
 * NO DOM, NO vscode.  Plain Node `node --test`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { paneId, sessionId, createInMemoryTransportPair, runSessionProxyHandshake, WIRE_PROTOCOL_VERSION } from "@tmuxcc/protocol";
import type { CommandRequestMessage, WireCommand, ClientMessage, SnapshotMessage, SessionProxyCommandResponseMessage } from "@tmuxcc/protocol";
import { windowId } from "@tmuxcc/protocol";

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
// 1b. InputApi.sendVerb — returns effect ids (tc-ozk.1)
// ---------------------------------------------------------------------------

describe("InputApi.sendVerb — returns effect ids (tc-ozk.1)", () => {
  it("resolves with newPaneId/newWindowId when the matching command.response carries the payload", async () => {
    const messages: CommandRequestMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as CommandRequestMessage); },
    };

    const api = createInputApi(sender);
    const promise = api.sendVerb({ kind: "split-pane", paneId: paneId("p1"), direction: "horizontal" });

    assert.equal(messages.length, 1);
    const correlationId = messages[0]!.correlationId;

    // SessionProxy returns the created ids in the command.response payload.
    const response: SessionProxyCommandResponseMessage = {
      type: "command.response",
      seq: 5,
      correlationId,
      result: { ok: true, payload: { paneId: paneId("p7"), windowId: windowId("w2") } },
    };
    api.handleCommandResponse(response);

    const result = await promise;
    assert.deepEqual(result, { ok: true, newPaneId: paneId("p7"), newWindowId: windowId("w2") });
  });

  it("resolves ok=false on a failed command.response (%error mapping)", async () => {
    const sender: InputSender = { send() { /* drop */ } };
    const api = createInputApi(sender);

    const promise = api.sendVerb({ kind: "split-pane", paneId: paneId("p1"), direction: "vertical" });
    // We don't know the correlationId from outside; capture it from the message.
    const messages: CommandRequestMessage[] = [];
    const sender2: InputSender = { send(m) { messages.push(m as CommandRequestMessage); } };
    const api2 = createInputApi(sender2);
    const promise2 = api2.sendVerb({ kind: "split-pane", paneId: paneId("p1"), direction: "vertical" });
    const correlationId = messages[0]!.correlationId;
    api2.handleCommandResponse({
      type: "command.response",
      seq: 6,
      correlationId,
      result: { ok: false, code: "verb.failed", message: "tmux rejected split-pane" },
    });
    const result2 = await promise2;
    assert.equal(result2.ok, false);
    if (result2.ok === false) {
      assert.equal(result2.code, "verb.failed");
      assert.match(result2.message, /split-pane/);
    }
    // The first api's promise stays pending; reject it so the test doesn't leak.
    api.rejectAllPending("test cleanup");
    await assert.rejects(promise);
  });

  it("rejectAllPending rejects every in-flight verb", async () => {
    const sender: InputSender = { send() { /* drop */ } };
    const api = createInputApi(sender);
    const p1 = api.sendVerb({ kind: "open-window" });
    const p2 = api.sendVerb({ kind: "split-pane", paneId: paneId("p1"), direction: "horizontal" });
    api.rejectAllPending("disconnected");
    await assert.rejects(p1, /disconnected/);
    await assert.rejects(p2, /disconnected/);
  });

  it("handleCommandResponse for an unknown correlationId is a no-op", () => {
    const sender: InputSender = { send() { /* drop */ } };
    const api = createInputApi(sender);
    // Should not throw.
    api.handleCommandResponse({
      type: "command.response",
      seq: 7,
      correlationId: "no-such-id",
      result: { ok: true, payload: { paneId: paneId("p9"), windowId: windowId("w9") } },
    });
  });
});

// ---------------------------------------------------------------------------
// 1c. InputApi.sendPaneCapture — tc-295a.17 / E3.2 pane.capture round-trip
// ---------------------------------------------------------------------------

describe("InputApi.sendPaneCapture — pane.capture wire round-trip (tc-295a.17)", () => {
  it("sends command.request { kind: pane.capture, paneId } and resolves with text on success", async () => {
    const messages: CommandRequestMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as CommandRequestMessage); },
    };
    const api = createInputApi(sender);

    const capturePromise = api.sendPaneCapture(paneId("p3"));

    assert.equal(messages.length, 1, "exactly one message should be sent");
    const msg = messages[0]!;
    assert.equal(msg.type, "command.request");
    assert.deepEqual(msg.command, { kind: "pane.capture", paneId: paneId("p3") });
    assert.ok(typeof msg.correlationId === "string" && msg.correlationId.length > 0);

    // Session-proxy replies with the captured text.
    const response: SessionProxyCommandResponseMessage = {
      type: "command.response",
      seq: 10,
      correlationId: msg.correlationId,
      result: { ok: true, payload: { text: "hello world\nfoo bar\n" } },
    };
    api.handleCommandResponse(response);

    const text = await capturePromise;
    assert.equal(text, "hello world\nfoo bar\n");
  });

  it("rejects (fail-loud) when result.ok=false (pane.not-found)", async () => {
    const messages: CommandRequestMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as CommandRequestMessage); },
    };
    const api = createInputApi(sender);

    const capturePromise = api.sendPaneCapture(paneId("p99"));
    const correlationId = messages[0]!.correlationId;

    api.handleCommandResponse({
      type: "command.response",
      seq: 11,
      correlationId,
      result: { ok: false, code: "pane.not-found", message: "Pane p99 not in model" },
    });

    await assert.rejects(capturePromise, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /pane\.not-found/);
      return true;
    });
  });

  it("rejects when ok=true but payload.text is absent (protocol violation)", async () => {
    const messages: CommandRequestMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as CommandRequestMessage); },
    };
    const api = createInputApi(sender);

    const capturePromise = api.sendPaneCapture(paneId("p1"));
    const correlationId = messages[0]!.correlationId;

    api.handleCommandResponse({
      type: "command.response",
      seq: 12,
      correlationId,
      result: { ok: true, payload: {} },
    });

    await assert.rejects(capturePromise, /payload\.text was absent/);
  });

  it("rejectAllPending rejects in-flight sendPaneCapture awaits", async () => {
    const sender: InputSender = { send() { /* drop */ } };
    const api = createInputApi(sender);

    const p1 = api.sendPaneCapture(paneId("p1"));
    const p2 = api.sendPaneCapture(paneId("p2"));
    api.rejectAllPending("connection closed");

    await assert.rejects(p1, /connection closed/);
    await assert.rejects(p2, /connection closed/);
  });

  it("sendPaneCapture and sendVerb each use distinct correlationIds", async () => {
    const messages: CommandRequestMessage[] = [];
    const sender: InputSender = {
      send(msg) { messages.push(msg as CommandRequestMessage); },
    };
    const api = createInputApi(sender);

    // Attach .catch() before rejectAllPending so the rejections are handled.
    const captureP = api.sendPaneCapture(paneId("p0")).catch(() => { /* swallow cleanup rejection */ });
    const verbP = api.sendVerb({ kind: "open-window" }).catch(() => { /* swallow cleanup rejection */ });

    assert.equal(messages.length, 2);
    assert.notEqual(messages[0]!.correlationId, messages[1]!.correlationId);
    // Cleanup: reject pending to avoid test leak.
    api.rejectAllPending("test cleanup");

    // Await so the test runner sees the rejections were handled before teardown.
    await captureP;
    await verbP;
  });
});

// ---------------------------------------------------------------------------
// 2. createClient + createInMemoryTransportPair — integration
// ---------------------------------------------------------------------------

describe("ClientHandle.controller.sendCommand — via in-memory transport", () => {
  /**
   * Run the session-proxy side of the handshake and collect control messages.
   * Returns a promise that resolves with all client→session-proxy messages received
   * after the handshake, up until the first setTimeout(0) tick.
   */
  async function setupWithSessionProxySide(): Promise<{
    receivedBySessionProxy: ClientMessage[];
    sendSnapshotAndStart: () => void;
  }> {
    const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();

    const receivedBySessionProxy: ClientMessage[] = [];

    // SessionProxy handshake: send SessionProxyCapabilities, wait for ClientCapabilities.
    const sessionProxyHandshakePromise = runSessionProxyHandshake(sessionProxyTransport, {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle"],
    });

    // Connect client (runs handshake).
    const handle = await connectClient(clientTransport);

    await sessionProxyHandshakePromise;

    // Attach no-op hook (required to complete the setup).
    handle.mirror.attach(NoOpRenderHook);

    // After handshake, install a control handler on the session-proxy side.
    sessionProxyTransport.onControl((msg) => {
      receivedBySessionProxy.push(msg as ClientMessage);
    });

    // SessionProxy sends an empty snapshot so the mirror catches up.
    function sendSnapshotAndStart(): void {
      const snapshot: SnapshotMessage = {
        type: "snapshot",
        seq: 1,
        session: { sessionId: sessionId("s0"), name: "main" },
        windows: [],
        panes: [],
        focus: { paneId: null, windowId: null },
      };
      sessionProxyTransport.sendControl(snapshot);
    }

    return { receivedBySessionProxy, sendSnapshotAndStart };
  }

  it("controller.sendCommand(open-window) → session-proxy receives CommandRequestMessage", async () => {
    const { client: clientTransport, sessionProxy: sessionProxyTransport } = createInMemoryTransportPair();
    const receivedBySessionProxy: ClientMessage[] = [];

    // Run session-proxy handshake.
    const sessionProxyHandshakeP = runSessionProxyHandshake(sessionProxyTransport, {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle"],
    });

    const handle = await connectClient(clientTransport);
    handle.mirror.attach(NoOpRenderHook);

    await sessionProxyHandshakeP;

    // Install control handler on session-proxy side AFTER handshake.
    sessionProxyTransport.onControl((msg) => {
      receivedBySessionProxy.push(msg as ClientMessage);
    });

    // Issue the command via the controller.
    const cmd: WireCommand = { kind: "open-window" };
    handle.controller.sendCommand(cmd);

    // The in-memory transport delivers synchronously.
    assert.equal(receivedBySessionProxy.length, 1, "session-proxy should receive exactly one message");
    const received = receivedBySessionProxy[0]! as CommandRequestMessage;
    assert.equal(received.type, "command.request", "type should be command.request");
    assert.deepEqual(received.command, cmd, "command payload should match");
    assert.ok(typeof received.correlationId === "string", "correlationId should be a string");
    assert.ok(received.correlationId.length > 0, "correlationId should be non-empty");

    handle.disconnect();
  });

  it("controller.sendCommand(split-pane) → session-proxy receives correct CommandRequestMessage", async () => {
    const { client: clientTransport, sessionProxy: sessionProxyTransport } = createInMemoryTransportPair();
    const receivedBySessionProxy: ClientMessage[] = [];

    const sessionProxyHandshakeP = runSessionProxyHandshake(sessionProxyTransport, {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle"],
    });
    const handle = await connectClient(clientTransport);
    handle.mirror.attach(NoOpRenderHook);
    await sessionProxyHandshakeP;

    sessionProxyTransport.onControl((msg) => {
      receivedBySessionProxy.push(msg as ClientMessage);
    });

    const cmd: WireCommand = {
      kind: "split-pane",
      paneId: paneId("p0"),
      direction: "vertical",
    };
    handle.controller.sendCommand(cmd);

    assert.equal(receivedBySessionProxy.length, 1);
    const received = receivedBySessionProxy[0]! as CommandRequestMessage;
    assert.equal(received.type, "command.request");
    assert.deepEqual(received.command, cmd);

    handle.disconnect();
  });
});
