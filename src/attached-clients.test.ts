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
 *   (5) A snapshot without attachedClientCount (older daemon) leaves the field
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

import {
  createInMemoryTransportPair,
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
  emptyModel,
  paneId,
  windowId,
  sessionId,
  addSession,
  addWindow,
  addPane,
  setFocus,
  projectSnapshot,
  createControlServer,
} from "@tmuxcc/daemon";
import type {
  SnapshotMessage,
  Capabilities,
  Transport,
  ControlMessage,
  ControlServer,
} from "@tmuxcc/daemon";

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
  });
  m = addPane(m, {
    paneId: P0,
    windowId: W0,
    sessionId: S0,
    cols: 80,
    rows: 24,
    mode: "normal",
    scrollbackHandle: undefined,
  });
  m = setFocus(m, { paneId: P0, windowId: W0, sessionId: S0 });
  return m;
}

const DAEMON_CAPS: Capabilities = {
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
 * Connect a single client to the given daemon-side transport pair, capture
 * all control messages received (excluding daemon.capabilities), and return
 * them along with the ClientModel built from the first snapshot.
 */
async function connectClientViaServer(
  server: ControlServer,
): Promise<{ received: ControlMessage[]; model: ClientModel; daemonTransport: Transport }> {
  const { daemon: daemonTransport, client: clientTransport } = createInMemoryTransportPair();

  const received: ControlMessage[] = [];

  // Spy on daemon-side sends (exclude handshake messages).
  const origSendControl = daemonTransport.sendControl.bind(daemonTransport);
  daemonTransport.sendControl = function (msg: ControlMessage) {
    if (msg.type !== "daemon.capabilities") {
      received.push(msg);
    }
    return origSendControl(msg);
  };

  await Promise.all([
    server.addClient(daemonTransport),
    runClientHandshake(clientTransport, CLIENT_CAPS),
  ]);

  // Build ClientModel from the first snapshot.
  const snapMsg = received[0] as SnapshotMessage;
  const { model } = applySnapshot(snapMsg);

  return { received, model, daemonTransport };
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

  it("missing attachedClientCount (older daemon) → undefined in ClientModel", () => {
    // Older daemons do not send attachedClientCount; the field is optional.
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
      get buffers(): never { throw new Error("no buffers"); },
    };

    const server = createControlServer(pipeline);

    const { model: clientModel1, daemonTransport: t1 } = await connectClientViaServer(server);

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
      get buffers(): never { throw new Error("no buffers"); },
    };

    const server = createControlServer(pipeline);

    // Connect client 1 (count becomes 1).
    const { model: model1, daemonTransport: t1 } = await connectClientViaServer(server);
    assert.equal(
      model1.attachedClientCount,
      1,
      "first client snapshot: attachedClientCount must be 1",
    );

    // Connect client 2 while client 1 is still connected (count becomes 2).
    const { model: model2, daemonTransport: t2 } = await connectClientViaServer(server);
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
      get buffers(): never { throw new Error("no buffers"); },
    };
    const server = createControlServer(pipeline);

    // This is the core §8.2 multi-client verification scenario:
    // three VS Code windows (or mix of tmuxcc + other clients) all connecting
    // to the same session. The third to connect sees count=3.
    const { daemonTransport: t1 } = await connectClientViaServer(server);
    const { daemonTransport: t2 } = await connectClientViaServer(server);
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
      get buffers(): never { throw new Error("no buffers"); },
    };
    const server = createControlServer(pipeline);

    // Client A connects first.
    const { daemon: dA, client: cA } = createInMemoryTransportPair();
    const clientA = await Promise.all([
      server.addClient(dA),
      connectClient(cA),
    ]).then(([, h]) => h);

    const countA = clientA.mirror.getModel().attachedClientCount;
    assert.equal(countA, 1, "client A (first) must see attachedClientCount=1");

    // Client B connects while A is still connected.
    const { daemon: dB, client: cB } = createInMemoryTransportPair();
    const clientB = await Promise.all([
      server.addClient(dB),
      connectClient(cB),
    ]).then(([, h]) => h);

    const countB = clientB.mirror.getModel().attachedClientCount;
    assert.equal(countB, 2, "client B (second) must see attachedClientCount=2 (A still connected)");

    // Send a snapshot to client A to catch up with the post-snapshot model.
    dA.sendControl(projectSnapshot(model, { seq: 2, attachedClientCount: 2 }));

    clientA.disconnect();
    clientB.disconnect();
    dA.close();
    dB.close();
  });
});
