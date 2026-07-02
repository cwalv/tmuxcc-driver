/**
 * Layer A tests: attached-client count query (tc-1elae, §11.4).
 *
 * Verifies that:
 *   (1) SnapshotMessage.attachedClientCount propagates through applySnapshot
 *       into ClientModel.attachedClientCount.
 *   (2) The serve layer (ControlServer.addClient) includes the current client
 *       count in the snapshot it sends.
 *   (3) When two clients connect to the same ControlServer, each snapshot
 *       carries the correct count at the time it was sent:
 *         - first client snapshot: count = 1 (only this client)
 *         - second client snapshot: count = 2 (both clients)
 *   (4) Mirror.getModel().attachedClientCount reflects the snapshot value.
 *   (5) A snapshot without attachedClientCount (older sessionProxy) leaves the field
 *       undefined in ClientModel.
 *
 * These tests use createInMemoryTransportPair + createControlServer for a
 * hermetic in-process proof of the end-to-end path. No real tmux or vscode.
 *
 * §8.2 resize semantics are documented in docs/notes/multi-client-resize.md;
 * this file focuses on the client-count query correctness only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTransportPair, runClientHandshake, WIRE_PROTOCOL_VERSION, paneId, windowId, sessionId } from "@tmuxcc/protocol";
import { emptyModel, addSession, addWindow, addPane, setFocus, projectSnapshot, createControlServer } from "@tmuxcc/driver";
import type { SnapshotMessage, Capabilities, Transport, ControlMessage } from "@tmuxcc/protocol";
import type { ControlServer } from "@tmuxcc/driver";

import { applySnapshot } from "./mirror.js";
import type { ClientModel } from "./mirror.js";
import { Mirror } from "./mirror.js";
import { connectClient } from "./client.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const S0 = sessionId("s0");
const W0 = windowId("w0");
const P0 = paneId("p0");

function buildBaseModel() {
  let m = emptyModel();
  m = addSession(m, {
    sessionId: S0,
    name: "main",
    windowIds: [],
    activeWindowId: null,
  });
  m = addWindow(m, {
    windowId: W0,
    sessionId: S0,
    name: "editor",
    paneIds: [],
    activePaneId: null,
    layout: null,
    synchronizePanes: false, monitorActivity: true, monitorSilence: 0,
  });
  m = addPane(m, {
    paneId: P0,
    windowId: W0,
    sessionId: S0,
    cols: 80,
    rows: 24,
    mode: "normal",
    dead: false,
    exitCode: undefined,
    label: undefined,
    boundClients: new Set(),
    detach: undefined,
    icon: undefined,
    // scrollbackHandle is optional — omit rather than passing undefined (exactOptionalPropertyTypes)
  });
  m = setFocus(m, { paneId: P0, windowId: W0, sessionId: S0 });
  return m;
}

const SESSION_PROXY_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
};

const CLIENT_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["pane-lifecycle", "focus-events"],
};

// ---------------------------------------------------------------------------
// Helper: connect one client through the ControlServer and collect its snapshot
// ---------------------------------------------------------------------------

/**
 * Connect a single client to the given session-proxy-side transport pair, capture
 * all control messages received (excluding session-proxy.capabilities), and return
 * them along with the ClientModel built from the first snapshot.
 */
async function connectClientViaServer(
  server: ControlServer,
): Promise<{ received: ControlMessage[]; model: ClientModel; sessionProxyTransport: Transport }> {
  const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();

  const received: ControlMessage[] = [];

  // Spy on session-proxy-side sends (exclude handshake messages).
  const origSendControl = sessionProxyTransport.sendControl.bind(sessionProxyTransport);
  sessionProxyTransport.sendControl = function (msg: ControlMessage) {
    if (msg.type !== "session-proxy.capabilities") {
      received.push(msg);
    }
    return origSendControl(msg);
  };

  await Promise.all([
    server.addClient(sessionProxyTransport),
    runClientHandshake(clientTransport, CLIENT_CAPS),
  ]);

  // Build ClientModel from the first snapshot.
  const snapMsg = received[0] as SnapshotMessage;
  const { model } = applySnapshot(snapMsg);

  return { received, model, sessionProxyTransport };
}

// ---------------------------------------------------------------------------
// 1. applySnapshot propagates attachedClientCount → ClientModel
// ---------------------------------------------------------------------------

describe("tc-1elae: attached-client count via applySnapshot", () => {
  it("attachedClientCount from snapshot is reflected in ClientModel", () => {
    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, {
      seq: 1,
      attachedClientCount: 3,
    });
    const { model: clientModel } = applySnapshot(snapshot);
    assert.equal(
      clientModel.attachedClientCount,
      3,
      "ClientModel.attachedClientCount must match snapshot value",
    );
  });

  it("attachedClientCount=1 is preserved (single client)", () => {
    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, {
      seq: 1,
      attachedClientCount: 1,
    });
    const { model: clientModel } = applySnapshot(snapshot);
    assert.equal(clientModel.attachedClientCount, 1);
  });

  it("missing attachedClientCount (older sessionProxy) → undefined in ClientModel", () => {
    // Older session-proxies do not send attachedClientCount; the field is optional.
    const model = buildBaseModel();
    // projectSnapshot without attachedClientCount = no field in snapshot.
    const snapshot: SnapshotMessage = projectSnapshot(model, { seq: 1 });
    assert.equal(
      (snapshot as { attachedClientCount?: number }).attachedClientCount,
      undefined,
      "snapshot must not carry attachedClientCount when not supplied",
    );
    const { model: clientModel } = applySnapshot(snapshot);
    assert.equal(
      clientModel.attachedClientCount,
      undefined,
      "ClientModel.attachedClientCount must be undefined when snapshot omits it",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. projectSnapshot includes attachedClientCount in the wire snapshot
// ---------------------------------------------------------------------------

describe("tc-1elae: projectSnapshot attachedClientCount wire format", () => {
  it("attachedClientCount appears in the serialized snapshot when provided", () => {
    const model = buildBaseModel();
    const snapshot = projectSnapshot(model, { seq: 1, attachedClientCount: 2 });
    assert.equal(snapshot.attachedClientCount, 2);
    assert.equal(snapshot.type, "snapshot");
  });

  it("attachedClientCount is absent when not provided (non-breaking)", () => {
    const model = buildBaseModel();
    const snapshot = projectSnapshot(model, { seq: 1 });
    // The field should be absent (not just undefined) for backwards compat.
    assert.ok(
      !("attachedClientCount" in snapshot) || snapshot.attachedClientCount === undefined,
      "attachedClientCount must be absent or undefined when not supplied",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. ControlServer sends correct count to each connecting client
// ---------------------------------------------------------------------------

describe("tc-1elae: ControlServer stamps attachedClientCount in snapshots", () => {
  it("first client receives attachedClientCount=1 (only itself)", async () => {
    // Construct a minimal fake pipeline.
    const model = buildBaseModel();
    let current = model;
    const handlers = new Set<(n: typeof model, p: typeof model) => void>();
    const pipeline = {
      getModel: () => current,
      isLive: () => true,
      async start() {},
      stop() {},
      onModelChange(h: (n: typeof model, p: typeof model) => void) {
        handlers.add(h);
        return () => { handlers.delete(h); };
      },
      onNotification() { return () => {}; },
      injectNotification() {},
      patchModel(updater: (m: typeof model) => typeof model) {
        const prev = current;
        const next = updater(prev);
        if (next === prev) return;
        current = next;
        for (const h of handlers) h(next, prev);
      },
      send() { return new Promise<never>(() => {}); },
      sendBatch(cmds: readonly string[]) { return cmds.map(() => new Promise<never>(() => {})); },
      async applyClientBinding() {},
      refreshCorrelatorPendingGauge() {},
      get buffers(): never { throw new Error("no buffers"); },
    };

    const server = createControlServer(pipeline);

    const { model: clientModel1, sessionProxyTransport: t1 } = await connectClientViaServer(server);

    assert.equal(
      clientModel1.attachedClientCount,
      1,
      "first client snapshot must have attachedClientCount=1",
    );

    t1.close();
  });

  it("second client receives attachedClientCount=2 while first remains connected", async () => {
    const model = buildBaseModel();
    let current = model;
    const handlers = new Set<(n: typeof model, p: typeof model) => void>();
    const pipeline = {
      getModel: () => current,
      isLive: () => true,
      async start() {},
      stop() {},
      onModelChange(h: (n: typeof model, p: typeof model) => void) {
        handlers.add(h);
        return () => { handlers.delete(h); };
      },
      onNotification() { return () => {}; },
      injectNotification() {},
      patchModel(updater: (m: typeof model) => typeof model) {
        const prev = current;
        const next = updater(prev);
        if (next === prev) return;
        current = next;
        for (const h of handlers) h(next, prev);
      },
      send() { return new Promise<never>(() => {}); },
      sendBatch(cmds: readonly string[]) { return cmds.map(() => new Promise<never>(() => {})); },
      async applyClientBinding() {},
      refreshCorrelatorPendingGauge() {},
      get buffers(): never { throw new Error("no buffers"); },
    };

    const server = createControlServer(pipeline);

    // Connect client 1 (count becomes 1).
    const { model: model1, sessionProxyTransport: t1 } = await connectClientViaServer(server);
    assert.equal(
      model1.attachedClientCount,
      1,
      "first client snapshot: attachedClientCount must be 1",
    );

    // Connect client 2 while client 1 is still connected (count becomes 2).
    const { model: model2, sessionProxyTransport: t2 } = await connectClientViaServer(server);
    assert.equal(
      model2.attachedClientCount,
      2,
      "second client snapshot: attachedClientCount must be 2",
    );

    t1.close();
    t2.close();
  });

  it("third client sees count=3 with two prior clients still connected", async () => {
    const model = buildBaseModel();
    let current = model;
    const handlers = new Set<(n: typeof model, p: typeof model) => void>();
    const pipeline = {
      getModel: () => current,
      isLive: () => true,
      async start() {},
      stop() {},
      onModelChange(h: (n: typeof model, p: typeof model) => void) {
        handlers.add(h);
        return () => { handlers.delete(h); };
      },
      onNotification() { return () => {}; },
      injectNotification() {},
      patchModel(updater: (m: typeof model) => typeof model) {
        const prev = current;
        const next = updater(prev);
        if (next === prev) return;
        current = next;
        for (const h of handlers) h(next, prev);
      },
      send() { return new Promise<never>(() => {}); },
      sendBatch(cmds: readonly string[]) { return cmds.map(() => new Promise<never>(() => {})); },
      async applyClientBinding() {},
      refreshCorrelatorPendingGauge() {},
      get buffers(): never { throw new Error("no buffers"); },
    };
    const server = createControlServer(pipeline);

    // This is the core §8.2 multi-client verification scenario:
    // three VS Code windows (or mix of tmuxcc + other clients) all connecting
    // to the same session. The third to connect sees count=3.
    const { sessionProxyTransport: t1 } = await connectClientViaServer(server);
    const { sessionProxyTransport: t2 } = await connectClientViaServer(server);
    const { model: model3 } = await connectClientViaServer(server);

    assert.equal(
      model3.attachedClientCount,
      3,
      "§8.2: third concurrent client snapshot must show attachedClientCount=3",
    );

    t1.close();
    t2.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Mirror.getModel() reflects attachedClientCount from snapshot
// ---------------------------------------------------------------------------

describe("tc-1elae: Mirror reflects attachedClientCount", () => {
  it("mirror.getModel().attachedClientCount is set from snapshot", () => {
    const mirror = new Mirror();
    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, {
      seq: 1,
      attachedClientCount: 2,
    });
    mirror.receiveSnapshot(snapshot);
    assert.equal(
      mirror.getModel().attachedClientCount,
      2,
      "mirror.getModel().attachedClientCount must reflect snapshot value",
    );
  });

  it("mirror.getModel().attachedClientCount is undefined when snapshot omits it", () => {
    const mirror = new Mirror();
    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, { seq: 1 });
    mirror.receiveSnapshot(snapshot);
    assert.equal(
      mirror.getModel().attachedClientCount,
      undefined,
      "mirror.getModel().attachedClientCount must be undefined when snapshot omits it",
    );
  });

  it("mirror resets attachedClientCount on resync snapshot", () => {
    const mirror = new Mirror();
    const model = buildBaseModel();

    // First snapshot: count=3 (three clients).
    const snap1: SnapshotMessage = projectSnapshot(model, { seq: 1, attachedClientCount: 3 });
    mirror.receiveSnapshot(snap1);
    assert.equal(mirror.getModel().attachedClientCount, 3);

    // Resync: second snapshot carries updated count=1 (clients disconnected).
    const snap2: SnapshotMessage = projectSnapshot(model, { seq: 5, attachedClientCount: 1 });
    mirror.receiveSnapshot(snap2);
    assert.equal(
      mirror.getModel().attachedClientCount,
      1,
      "attachedClientCount must be updated on resync snapshot",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. connectClient end-to-end: count flows from ControlServer through to mirror
// ---------------------------------------------------------------------------

describe("tc-1elae: end-to-end via connectClient", () => {
  it("two concurrent connectClient calls: each sees the correct count", async () => {
    const model = buildBaseModel();
    let current = model;
    const handlers = new Set<(n: typeof model, p: typeof model) => void>();
    const pipeline = {
      getModel: () => current,
      isLive: () => true,
      async start() {},
      stop() {},
      onModelChange(h: (n: typeof model, p: typeof model) => void) {
        handlers.add(h);
        return () => { handlers.delete(h); };
      },
      onNotification() { return () => {}; },
      injectNotification() {},
      patchModel(updater: (m: typeof model) => typeof model) {
        const prev = current;
        const next = updater(prev);
        if (next === prev) return;
        current = next;
        for (const h of handlers) h(next, prev);
      },
      send() { return new Promise<never>(() => {}); },
      sendBatch(cmds: readonly string[]) { return cmds.map(() => new Promise<never>(() => {})); },
      async applyClientBinding() {},
      refreshCorrelatorPendingGauge() {},
      get buffers(): never { throw new Error("no buffers"); },
    };
    const server = createControlServer(pipeline);

    // Client A connects first.
    const { sessionProxy: dA, client: cA } = createInMemoryTransportPair();
    const clientA = await Promise.all([
      server.addClient(dA),
      connectClient(cA),
    ]).then(([, h]) => h);

    const countA = clientA.mirror.getModel().attachedClientCount;
    assert.equal(countA, 1, "client A (first) must see attachedClientCount=1");

    // Client B connects while A is still connected.
    const { sessionProxy: dB, client: cB } = createInMemoryTransportPair();
    const clientB = await Promise.all([
      server.addClient(dB),
      connectClient(cB),
    ]).then(([, h]) => h);

    const countB = clientB.mirror.getModel().attachedClientCount;
    assert.equal(countB, 2, "client B (second) must see attachedClientCount=2 (A still connected)");

    clientA.disconnect();
    clientB.disconnect();
    dA.close();
    dB.close();
  });
});

// ---------------------------------------------------------------------------
// tc-44wu0 — Live attach/detach updates via client-count.changed
// ---------------------------------------------------------------------------

/**
 * Layer A tests: live attached-client count updates (tc-44wu0, §11.4 Phase 4).
 *
 * Verifies that:
 *   (1) When a second client connects, the first client receives a
 *       `client-count.changed` delta and its `attachedClientCount` updates to 2.
 *   (2) When the second client disconnects, the first client receives a
 *       `client-count.changed` delta and its `attachedClientCount` drops to 1.
 *   (3) The newly-connected client itself receives a `client-count.changed`
 *       message after its initial snapshot, reflecting the new total.
 *   (4) applyDelta: `client-count.changed` correctly updates ClientModel.attachedClientCount.
 *
 * Test harness: createControlServer + createInMemoryTransportPair (in-process,
 * no real tmux, no vscode).
 */

import { applyDelta } from "./mirror.js";

// Helper: build a minimal pipeline for ControlServer.
function buildLivePipeline() {
  const model = buildBaseModel();
  let current = model;
  const handlers = new Set<(n: typeof model, p: typeof model) => void>();
  return {
    pipeline: {
      getModel: () => current,
      isLive: () => true,
      async start() {},
      stop() {},
      onModelChange(h: (n: typeof model, p: typeof model) => void) {
        handlers.add(h);
        return () => { handlers.delete(h); };
      },
      onNotification() { return () => {}; },
      injectNotification() {},
      patchModel(updater: (m: typeof model) => typeof model) {
        const prev = current;
        const next = updater(prev);
        if (next === prev) return;
        current = next;
        for (const h of handlers) h(next, prev);
      },
      send() { return new Promise<never>(() => {}); },
      sendBatch(cmds: readonly string[]) { return cmds.map(() => new Promise<never>(() => {})); },
      async applyClientBinding() {},
      refreshCorrelatorPendingGauge() {},
      get buffers(): never { throw new Error("no buffers"); },
    },
    setModel: (m: typeof model) => { current = m; },
  };
}

describe("tc-44wu0: applyDelta handles client-count.changed", () => {
  it("updates attachedClientCount in ClientModel", () => {
    const model = buildBaseModel();
    const snap: import("@tmuxcc/protocol").SnapshotMessage = projectSnapshot(model, {
      seq: 1,
      attachedClientCount: 1,
    });
    const { model: clientModel } = applySnapshot(snap);

    // Simulate a client-count.changed delta arriving (a second client connected).
    const delta: import("@tmuxcc/protocol").SessionProxyMessage = {
      type: "client-count.changed",
      seq: 2,
      count: 2,
    };
    const updated = applyDelta(clientModel, delta);

    assert.equal(
      updated.attachedClientCount,
      2,
      "applyDelta(client-count.changed) must update attachedClientCount",
    );
  });

  it("decrements attachedClientCount when a client detaches", () => {
    const model = buildBaseModel();
    const snap: import("@tmuxcc/protocol").SnapshotMessage = projectSnapshot(model, {
      seq: 1,
      attachedClientCount: 3,
    });
    const { model: clientModel } = applySnapshot(snap);

    const delta: import("@tmuxcc/protocol").SessionProxyMessage = {
      type: "client-count.changed",
      seq: 2,
      count: 2,
    };
    const updated = applyDelta(clientModel, delta);
    assert.equal(updated.attachedClientCount, 2);
  });

  it("does not affect other model fields", () => {
    const model = buildBaseModel();
    const snap: import("@tmuxcc/protocol").SnapshotMessage = projectSnapshot(model, {
      seq: 1,
      attachedClientCount: 1,
    });
    const { model: clientModel } = applySnapshot(snap);

    const delta: import("@tmuxcc/protocol").SessionProxyMessage = {
      type: "client-count.changed",
      seq: 2,
      count: 5,
    };
    const updated = applyDelta(clientModel, delta);

    // Other fields unchanged.
    assert.equal(updated.windows.size, clientModel.windows.size);
    assert.equal(updated.panes.size, clientModel.panes.size);
    assert.deepEqual(updated.focus, clientModel.focus);
    assert.strictEqual(updated.session, clientModel.session);
  });
});

describe("tc-44wu0: ControlServer broadcasts client-count.changed on attach", () => {
  it("existing client receives client-count.changed when a new client connects", async () => {
    const { pipeline } = buildLivePipeline();
    const server = createControlServer(pipeline);

    // Track all control messages received by client A (after snapshot).
    const receivedByA: import("@tmuxcc/protocol").ControlMessage[] = [];

    // Connect client A.
    const { sessionProxy: dA, client: cA } = createInMemoryTransportPair();
    await Promise.all([
      server.addClient(dA),
      runClientHandshake(cA, CLIENT_CAPS),
    ]);

    // Snapshot for A is already received (seq=1). Now spy on subsequent messages.
    const origSend = dA.sendControl.bind(dA);
    dA.sendControl = function (msg: import("@tmuxcc/protocol").ControlMessage) {
      receivedByA.push(msg);
      return origSend(msg);
    };

    // Connect client B — this should trigger a client-count.changed broadcast.
    const { sessionProxy: dB, client: cB } = createInMemoryTransportPair();
    await Promise.all([
      server.addClient(dB),
      runClientHandshake(cB, CLIENT_CAPS),
    ]);

    // Client A must have received at least one client-count.changed message.
    const countMsgs = receivedByA.filter(
      (m) => m.type === "client-count.changed",
    );
    assert.ok(
      countMsgs.length >= 1,
      "client A must receive at least one client-count.changed after client B connects",
    );

    // The last one (or only one) should have count=2.
    const last = countMsgs[countMsgs.length - 1] as import("@tmuxcc/protocol").ClientCountChangedMessage;
    assert.equal(
      last.count,
      2,
      "client-count.changed must carry count=2 after second client connects",
    );

    dA.close();
    dB.close();
  });

  it("remaining client sees count decrease after a client disconnects", async () => {
    const { pipeline } = buildLivePipeline();
    const server = createControlServer(pipeline);

    // Connect client A.
    const { sessionProxy: dA, client: cA } = createInMemoryTransportPair();
    await Promise.all([
      server.addClient(dA),
      runClientHandshake(cA, CLIENT_CAPS),
    ]);

    // Connect client B.
    const { sessionProxy: dB, client: cB } = createInMemoryTransportPair();
    await Promise.all([
      server.addClient(dB),
      runClientHandshake(cB, CLIENT_CAPS),
    ]);

    // Now spy on messages to client A.
    const receivedByA: import("@tmuxcc/protocol").ControlMessage[] = [];
    const origSend = dA.sendControl.bind(dA);
    dA.sendControl = function (msg: import("@tmuxcc/protocol").ControlMessage) {
      receivedByA.push(msg);
      return origSend(msg);
    };

    // Disconnect client B.
    dB.close();

    // Client A must receive a client-count.changed with count=1.
    // The close is synchronous in the in-memory transport, so receivedByA
    // should already be populated.
    const countMsgs = receivedByA.filter(
      (m) => m.type === "client-count.changed",
    );
    assert.ok(
      countMsgs.length >= 1,
      "client A must receive a client-count.changed after client B disconnects",
    );

    const last = countMsgs[countMsgs.length - 1] as import("@tmuxcc/protocol").ClientCountChangedMessage;
    assert.equal(
      last.count,
      1,
      "client-count.changed must carry count=1 after client B disconnects",
    );

    dA.close();
  });
});

describe("tc-44wu0: end-to-end live count updates via connectClient + Mirror", () => {
  it("client A's mirror.getModel().attachedClientCount updates live when B connects then disconnects", async () => {
    const { pipeline } = buildLivePipeline();
    const server = createControlServer(pipeline);

    // Connect client A via full connectClient path.
    const { sessionProxy: dA, client: cA } = createInMemoryTransportPair();
    const [, clientA] = await Promise.all([
      server.addClient(dA),
      connectClient(cA),
    ]);

    // Initial state: only A connected.
    assert.equal(
      clientA.mirror.getModel().attachedClientCount,
      1,
      "client A must start with attachedClientCount=1",
    );

    // Connect client B — session-proxy broadcasts client-count.changed to A.
    const { sessionProxy: dB, client: cB } = createInMemoryTransportPair();
    await Promise.all([
      server.addClient(dB),
      connectClient(cB),
    ]);

    // After B connects, A should see count=2.
    assert.equal(
      clientA.mirror.getModel().attachedClientCount,
      2,
      "client A must see attachedClientCount=2 after B connects",
    );

    // Disconnect B — session-proxy broadcasts client-count.changed to A.
    dB.close();

    // After B disconnects, A should see count=1.
    assert.equal(
      clientA.mirror.getModel().attachedClientCount,
      1,
      "client A must see attachedClientCount=1 after B disconnects",
    );

    clientA.disconnect();
    dA.close();
  });

  it("newly-connected client B receives updated count from client-count.changed", async () => {
    const { pipeline } = buildLivePipeline();
    const server = createControlServer(pipeline);

    // Connect client A.
    const { sessionProxy: dA, client: cA } = createInMemoryTransportPair();
    await Promise.all([
      server.addClient(dA),
      connectClient(cA),
    ]);

    // Connect client B.
    const { sessionProxy: dB, client: cB } = createInMemoryTransportPair();
    const [, clientB] = await Promise.all([
      server.addClient(dB),
      connectClient(cB),
    ]);

    // Client B's snapshot carries count=2 and may receive an extra
    // client-count.changed(2) after the snapshot. Either way the model
    // should show count=2.
    assert.equal(
      clientB.mirror.getModel().attachedClientCount,
      2,
      "newly-connected client B must see attachedClientCount=2",
    );

    clientB.disconnect();
    dA.close();
    dB.close();
  });
});
