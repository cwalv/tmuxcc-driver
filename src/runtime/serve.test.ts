/**
 * Tests for the control-plane server — tc-dv3.
 *
 * Covers the acceptance criteria:
 *   1. Single client: receives snapshot (seq=1) then correct deltas (seq=2,3,…).
 *   2. Multi-client: two clients each get their own snapshot + independent seq.
 *   3. Seq monotonicity: 1, 2, 3, … with no gaps.
 *   4. Client disconnect: removeClient / transport close → no more sends, no crash.
 *
 * # Test strategy
 *
 * We use a FAKE pipeline (`createFakePipeline`) that exposes `getModel()` and
 * `onModelChange()` but is driven manually by the test (calling `fireChange` to
 * simulate a model update). This avoids real tmux and keeps tests deterministic.
 *
 * For the handshake, we run `runClientHandshake` on the client side of the
 * in-memory transport pair so we get a real negotiated session without needing
 * a real process.
 *
 * @module runtime/serve.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createControlServer } from "./serve.js";
import type { ControlServer } from "./serve.js";
import {
  createInMemoryTransportPair,
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "../wire/index.js";
import type { Transport, ControlMessage, DaemonMessage, SnapshotMessage } from "../wire/index.js";
import type { RuntimePipeline, ModelChangeHandler } from "./pipeline.js";
import {
  emptyModel,
  paneId,
  windowId,
  sessionId,
  scrollbackHandle,
} from "../state/model.js";
import type { SessionModel, Session, Window, Pane, FocusState } from "../state/model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";
import { WIRE_PROTOCOL_VERSION as WPV } from "../wire/control.js";

// ---------------------------------------------------------------------------
// Fake pipeline
// ---------------------------------------------------------------------------

/**
 * A minimal fake RuntimePipeline for testing. Exposes `getModel()` and
 * `onModelChange()` driven by the test; ignores start/stop/isLive/buffers.
 */
interface FakePipeline extends RuntimePipeline {
  /** Drive a model change — fires all registered onModelChange handlers. */
  fireChange(newModel: SessionModel, prevModel: SessionModel): void;
  /** Replace the current model returned by getModel(). */
  setModel(model: SessionModel): void;
}

function createFakePipeline(initialModel?: SessionModel): FakePipeline {
  let current: SessionModel = initialModel ?? emptyModel();
  const handlers = new Set<ModelChangeHandler>();

  return {
    getModel() { return current; },
    isLive() { return true; },
    async start() { /* no-op */ },
    stop() { /* no-op */ },
    onModelChange(handler: ModelChangeHandler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    get buffers(): never {
      throw new Error("FakePipeline has no buffers");
    },
    setModel(model: SessionModel) {
      current = model;
    },
    fireChange(newModel: SessionModel, prevModel: SessionModel) {
      current = newModel;
      for (const h of handlers) {
        h(newModel, prevModel);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Client capabilities for the handshake
// ---------------------------------------------------------------------------

const CLIENT_CAPS = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["pane-lifecycle" as const, "focus-events" as const],
};

// ---------------------------------------------------------------------------
// Helper: connect a client-side transport through the handshake
// ---------------------------------------------------------------------------

/**
 * Run the client side of the handshake concurrently with server.addClient.
 * Returns {received, daemonTransport} where received[] accumulates all daemon-push
 * control messages EXCEPT the handshake message (daemon.capabilities).
 *
 * # Interception strategy
 *
 * The serve layer calls `daemonTransport.sendControl(msg)` to push messages to the
 * client. We intercept by wrapping `daemonTransport.sendControl` with a spy that
 * records every message except `daemon.capabilities` (the handshake advertisement,
 * which the serve layer sends via `runDaemonHandshake` internally).
 *
 * This is done on the daemon-side transport, so it is independent of which
 * `onControl` handler the client-side transport currently has registered.
 * The handshake resets `clientTransport.onControl` to `() => {}` when it settles
 * (per runDaemonHandshake / runClientHandshake implementation), so we MUST NOT
 * rely on `clientTransport.onControl` for post-handshake collection.
 */
async function connectClient(
  server: ControlServer,
): Promise<{ received: ControlMessage[]; daemonTransport: Transport }> {
  const { daemon: daemonTransport, client: clientTransport } = createInMemoryTransportPair();

  const received: ControlMessage[] = [];

  // Wrap sendControl on the daemon transport to spy on outgoing messages.
  // We skip "daemon.capabilities" (the handshake advertisement) so tests only
  // see application-level messages: snapshot, deltas, errors.
  const originalSendControl = daemonTransport.sendControl.bind(daemonTransport);
  daemonTransport.sendControl = function (msg: ControlMessage) {
    if (msg.type !== "daemon.capabilities") {
      received.push(msg);
    }
    return originalSendControl(msg);
  };

  // Run both handshakes concurrently. addClient resolves after the initial
  // snapshot has been sent (synchronously inside addClient, before its promise
  // resolves). runClientHandshake resolves once capabilities are exchanged.
  await Promise.all([
    server.addClient(daemonTransport),
    runClientHandshake(clientTransport, CLIENT_CAPS),
  ]);

  return { received, daemonTransport };
}

// ---------------------------------------------------------------------------
// Fixture models
// ---------------------------------------------------------------------------

const S1 = sessionId("s1");
const W1 = windowId("w1");
const P1 = paneId("p1");
const P2 = paneId("p2");

function makePane(id: PaneId, winId: WindowId, sessId: SessionId, cols = 80, rows = 24): Pane {
  return { paneId: id, windowId: winId, sessionId: sessId, cols, rows, mode: "normal", scrollbackHandle: undefined };
}

function makeModel1(): SessionModel {
  const sess: Session = { sessionId: S1, name: "main", windowIds: [W1], activeWindowId: W1 };
  const win: Window = { windowId: W1, sessionId: S1, name: "editor", paneIds: [P1], activePaneId: P1, layout: null };
  const p1 = makePane(P1, W1, S1);

  return {
    sessions: new Map([[S1, sess]]),
    windows: new Map([[W1, win]]),
    panes: new Map([[P1, p1]]),
    focus: { paneId: P1, windowId: W1, sessionId: S1 },
  };
}

function makeModel2(): SessionModel {
  // model1 + an additional pane P2
  const sess: Session = { sessionId: S1, name: "main", windowIds: [W1], activeWindowId: W1 };
  const win: Window = { windowId: W1, sessionId: S1, name: "editor", paneIds: [P1, P2], activePaneId: P1, layout: null };
  const p1 = makePane(P1, W1, S1);
  const p2 = makePane(P2, W1, S1, 40, 24);

  return {
    sessions: new Map([[S1, sess]]),
    windows: new Map([[W1, win]]),
    panes: new Map([[P1, p1], [P2, p2]]),
    focus: { paneId: P1, windowId: W1, sessionId: S1 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createControlServer", () => {

  // --------------------------------------------------------------------------
  // 1. Single client — snapshot then deltas
  // --------------------------------------------------------------------------
  describe("single client", () => {

    it("client receives snapshot as first message with seq=1", async () => {
      const model = makeModel1();
      const pipeline = createFakePipeline(model);
      const server = createControlServer(pipeline);

      const { received } = await connectClient(server);

      // The snapshot is the first message (after handshake traffic which is
      // handled inside runClientHandshake and runDaemonHandshake, not re-delivered
      // to the application-level onControl after they unregister their handlers).
      assert.equal(received.length, 1, "should have received exactly the snapshot");
      const snap = received[0]! as SnapshotMessage;
      assert.equal(snap.type, "snapshot");
      assert.equal(snap.seq, 1);
    });

    it("snapshot reflects the current model (sessions, windows, panes)", async () => {
      const model = makeModel1();
      const pipeline = createFakePipeline(model);
      const server = createControlServer(pipeline);

      const { received } = await connectClient(server);

      const snap = received[0]! as SnapshotMessage;
      assert.equal(snap.sessions.length, 1);
      assert.equal(snap.sessions[0]!.sessionId, S1);
      assert.equal(snap.windows.length, 1);
      assert.equal(snap.windows[0]!.windowId, W1);
      assert.equal(snap.panes.length, 1);
      assert.equal(snap.panes[0]!.paneId, P1);
    });

    it("client receives deltas with contiguous seq after snapshot", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      const { received } = await connectClient(server);
      // snapshot is received[0] with seq=1

      // Fire a model change that adds P2
      pipeline.fireChange(model2, model1);

      // Should now have: snapshot + at least one delta (pane.opened for P2)
      assert.ok(received.length > 1, "should have received at least one delta");

      // Check seq monotonicity: 1, 2, 3, ...
      const seqs = received.map((m) => m.seq);
      for (let i = 0; i < seqs.length; i++) {
        assert.equal(seqs[i], i + 1, `seq at index ${i} should be ${i + 1}`);
      }

      // Verify a pane.opened delta for P2 is present
      const delta = received.find((m) => m.type === "pane.opened") as DaemonMessage | undefined;
      assert.ok(delta !== undefined, "should have a pane.opened delta for P2");
      if (delta && delta.type === "pane.opened") {
        assert.equal(delta.paneId, P2);
      }
    });

    it("seq is monotonically increasing across multiple model changes", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      const { received } = await connectClient(server);

      // Fire two successive model changes
      pipeline.fireChange(model2, model1);
      // Revert: P2 closes
      pipeline.fireChange(model1, model2);

      // All seqs must be strictly increasing from 1
      const seqs = received.map((m) => m.seq);
      for (let i = 1; i < seqs.length; i++) {
        assert.equal(seqs[i]!, (seqs[i - 1]!) + 1, `gap detected: seq[${i - 1}]=${seqs[i - 1]}, seq[${i}]=${seqs[i]}`);
      }
    });

  });

  // --------------------------------------------------------------------------
  // 2. Multi-client — independent snapshots and seq counters
  // --------------------------------------------------------------------------
  describe("multi-client", () => {

    it("two clients each get their own snapshot", async () => {
      const model = makeModel1();
      const pipeline = createFakePipeline(model);
      const server = createControlServer(pipeline);

      const { received: recv1 } = await connectClient(server);
      const { received: recv2 } = await connectClient(server);

      assert.equal(server.clientCount(), 2);

      const snap1 = recv1[0]! as SnapshotMessage;
      const snap2 = recv2[0]! as SnapshotMessage;
      assert.equal(snap1.type, "snapshot");
      assert.equal(snap2.type, "snapshot");
      assert.equal(snap1.seq, 1, "client1 snapshot seq must be 1");
      assert.equal(snap2.seq, 1, "client2 snapshot seq must be 1");
    });

    it("client connecting after a model change gets snapshot with updated model", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      // Connect client1 before the change
      const { received: recv1 } = await connectClient(server);
      assert.equal((recv1[0]! as SnapshotMessage).panes.length, 1);

      // Fire a model change (P2 added)
      pipeline.fireChange(model2, model1);

      // Connect client2 AFTER the change
      const { received: recv2 } = await connectClient(server);

      // client2's snapshot should reflect the updated model (P2 present)
      const snap2 = recv2[0]! as SnapshotMessage;
      assert.equal(snap2.panes.length, 2, "client2 snapshot should include P2");
      assert.equal(snap2.seq, 1, "client2 snapshot seq should start at 1");
    });

    it("two clients have independent seq counters", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      const { received: recv1 } = await connectClient(server);
      const { received: recv2 } = await connectClient(server);

      // Fire a model change — both clients receive deltas
      pipeline.fireChange(model2, model1);

      // Both clients should have received snapshot (seq=1) + delta(s) starting seq=2
      assert.ok(recv1.length > 1, "client1 should have deltas");
      assert.ok(recv2.length > 1, "client2 should have deltas");

      // Verify each client's seq is 1, 2, 3, … independently
      for (const [label, received] of [["client1", recv1], ["client2", recv2]] as const) {
        const seqs = received.map((m) => m.seq);
        for (let i = 0; i < seqs.length; i++) {
          assert.equal(seqs[i], i + 1, `${label}: seq at index ${i} should be ${i + 1}`);
        }
      }
    });

    it("a later client does not see deltas that occurred before it connected", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      // Connect client1
      const { received: recv1 } = await connectClient(server);

      // Fire model change BEFORE client2 connects
      pipeline.fireChange(model2, model1);

      // Connect client2 AFTER the change
      const { received: recv2 } = await connectClient(server);

      // client2 should only have snapshot (no deltas before its connect)
      assert.equal(recv2.length, 1, "client2 should only have the snapshot, no pre-connect deltas");
      assert.equal((recv2[0]! as SnapshotMessage).type, "snapshot");

      // client1 should have snapshot + the delta
      assert.ok(recv1.length > 1, "client1 should have received the delta");
    });

  });

  // --------------------------------------------------------------------------
  // 3. Client count
  // --------------------------------------------------------------------------
  describe("clientCount", () => {

    it("tracks the number of connected clients", async () => {
      const pipeline = createFakePipeline(makeModel1());
      const server = createControlServer(pipeline);

      assert.equal(server.clientCount(), 0);
      const { daemonTransport: t1 } = await connectClient(server);
      assert.equal(server.clientCount(), 1);
      const { daemonTransport: _t2 } = await connectClient(server);
      assert.equal(server.clientCount(), 2);

      server.removeClient(t1);
      assert.equal(server.clientCount(), 1);
    });

  });

  // --------------------------------------------------------------------------
  // 4. Disconnect — no more sends, no crash
  // --------------------------------------------------------------------------
  describe("client disconnect", () => {

    it("removeClient stops delta delivery to that client", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      const { received, daemonTransport } = await connectClient(server);
      const countAfterSnapshot = received.length;

      // Remove the client
      server.removeClient(daemonTransport);
      assert.equal(server.clientCount(), 0);

      // Fire a model change — should NOT deliver to the removed client
      pipeline.fireChange(model2, model1);

      assert.equal(received.length, countAfterSnapshot, "no new messages should arrive after removeClient");
    });

    it("transport close auto-removes the client", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      const { received, daemonTransport } = await connectClient(server);
      const countAfterSnapshot = received.length;

      // Close the transport (simulates remote disconnect)
      daemonTransport.close();
      assert.equal(server.clientCount(), 0);

      // Fire a model change — should NOT crash or deliver
      pipeline.fireChange(model2, model1);

      assert.equal(received.length, countAfterSnapshot, "no new messages after transport close");
    });

    it("removeClient is idempotent", () => {
      const pipeline = createFakePipeline();
      const server = createControlServer(pipeline);

      const { daemon: t } = createInMemoryTransportPair();
      // Never added — removeClient should be a no-op
      assert.doesNotThrow(() => server.removeClient(t));
      assert.doesNotThrow(() => server.removeClient(t));
    });

    it("model changes after one client disconnects do not affect remaining clients", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      const { received: recv1, daemonTransport: t1 } = await connectClient(server);
      const { received: recv2 } = await connectClient(server);

      // Disconnect client1
      server.removeClient(t1);

      // Fire a change — only client2 should receive deltas
      pipeline.fireChange(model2, model1);

      assert.equal(recv1.length, 1, "client1 should have only the snapshot (no deltas post-disconnect)");
      assert.ok(recv2.length > 1, "client2 should still receive deltas");
    });

  });

  // --------------------------------------------------------------------------
  // 5. Default capabilities
  // --------------------------------------------------------------------------
  describe("capabilities", () => {

    it("server uses WIRE_PROTOCOL_VERSION in default capabilities", async () => {
      const pipeline = createFakePipeline(makeModel1());
      const server = createControlServer(pipeline);

      // connectClient uses standard client caps; if version mismatch, handshake rejects
      const { received } = await connectClient(server);
      // If we get here, handshake succeeded
      assert.ok(received.length >= 1, "should have received at least the snapshot");
    });

    it("custom capabilities are passed through the handshake", async () => {
      const pipeline = createFakePipeline(makeModel1());
      const server = createControlServer(pipeline, {
        capabilities: {
          protocolVersion: WPV,
          features: ["pane-lifecycle"],
        },
      });

      // Client caps include "focus-events" but server only has "pane-lifecycle"
      // The negotiated features intersection = ["pane-lifecycle"]
      const { daemon: daemonTransport, client: clientTransport } = createInMemoryTransportPair();
      const received: ControlMessage[] = [];
      clientTransport.onControl((msg) => received.push(msg));

      let negotiated;
      [, negotiated] = await Promise.all([
        server.addClient(daemonTransport),
        runClientHandshake(clientTransport, {
          protocolVersion: WPV,
          features: ["pane-lifecycle", "focus-events"],
        }),
      ]);

      // Intersection = ["pane-lifecycle"]
      assert.deepEqual(negotiated.features, ["pane-lifecycle"]);
    });

  });

});
