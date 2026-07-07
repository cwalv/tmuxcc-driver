/**
 * Tests for the control-plane server — tc-dv3.
 *
 * Covers the acceptance criteria:
 *   1. Single client: receives snapshot (seq=1) then correct deltas (seq=2,3,…).
 *   2. Multi-client: two clients each get their own snapshot + independent seq.
 *   3. Seq monotonicity: 1, 2, 3, … with no gaps.
 *   4. Client disconnect: removeClient / transport close → no more sends, no crash.
 *   5. Snapshot timing (tc-3eh.2): snapshot arrives after async-transport delivery,
 *      not at the no-op handler that runClientHandshake leaves in place.
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
import { createVerbOriginRegistry } from "./verb-origin.js";
import {
  createInMemoryTransportPair,
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "@tmuxcc/protocol";
import type { Transport, ControlMessage, SessionProxyMessage, SnapshotMessage, PaneNotifyMessage, ControlHandler, CloseHandler } from "@tmuxcc/protocol";
import type { RuntimePipeline, ModelChangeHandler, NotificationHandler, PaneNotifyHandler, PaneNotifyEmission } from "./pipeline.js";
import {
  emptyModel,
  paneId,
  windowId,
  sessionId,
  scrollbackHandle,
} from "../state/model.js";
import type { SessionModel, Session, Window, Pane, FocusState } from "../state/model.js";
import type { PaneId, WindowId, SessionId } from "@tmuxcc/protocol";
import { WIRE_PROTOCOL_VERSION as WPV } from "@tmuxcc/protocol";

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
  /** Drive a pane.notify — fires all registered onPaneNotify handlers (tc-76m8.1). */
  firePaneNotify(notify: PaneNotifyEmission): void;
}

function createFakePipeline(initialModel?: SessionModel): FakePipeline {
  let current: SessionModel = initialModel ?? emptyModel();
  const handlers = new Set<ModelChangeHandler>();
  const paneNotifyHandlers = new Set<PaneNotifyHandler>();

  return {
    getModel() { return current; },
    isLive() { return true; },
    async start() { /* no-op */ },
    stop() { /* no-op */ },
    onModelChange(handler: ModelChangeHandler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    onNotification(_handler: NotificationHandler) {
      // FakePipeline does not emit notifications — no-op for serve.test.ts.
      return () => {};
    },
    onPaneNotify(handler: PaneNotifyHandler) {
      paneNotifyHandlers.add(handler);
      return () => { paneNotifyHandlers.delete(handler); };
    },
    injectNotification(_event: import("../parser/notifications.js").NotificationEvent) {
      // FakePipeline: no-op — serve.test.ts does not test the optimistic-update path.
    },
    patchModel(_updater: (m: SessionModel) => SessionModel) {
      // FakePipeline: no-op — serve.test.ts drives model changes via fireChange.
    },
    async applyClientBinding(_clientId: string | undefined) {
      // FakePipeline: no-op — serve.test.ts does not exercise the per-client
      // binding connect-read (tc-4b6k.2). The real pipeline reads @tmuxcc-bound-<key>.
    },
    send(_command: string): Promise<import("../parser/correlator.js").CommandResult> {
      // FakePipeline: returns a never-resolving promise.  serve.test.ts does
      // not exercise the atomic-send seam (tc-3si.1).
      return new Promise<import("../parser/correlator.js").CommandResult>(() => {});
    },
    sendBatch(_commands: readonly string[]): Promise<import("../parser/correlator.js").CommandResult>[] {
      // FakePipeline: returns one never-resolving promise per command.
      return _commands.map(() => new Promise<import("../parser/correlator.js").CommandResult>(() => {}));
    },
    refreshCorrelatorPendingGauge(): void {
      // FakePipeline: no correlator, no gauge to refresh (tc-3si.5).
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
    firePaneNotify(notify: PaneNotifyEmission) {
      for (const h of paneNotifyHandlers) {
        h(notify);
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
 * Returns {received, sessionProxyTransport} where received[] accumulates all session-proxy-push
 * control messages EXCEPT the handshake message (session-proxy.capabilities).
 *
 * # Interception strategy
 *
 * The serve layer calls `sessionProxyTransport.sendControl(msg)` to push messages to the
 * client. We intercept by wrapping `sessionProxyTransport.sendControl` with a spy that
 * records every message except `session-proxy.capabilities` (the handshake advertisement,
 * which the serve layer sends via `runSessionProxyHandshake` internally).
 *
 * This is done on the session-proxy-side transport, so it is independent of which
 * `onControl` handler the client-side transport currently has registered.
 * The handshake resets `clientTransport.onControl` to `() => {}` when it settles
 * (per runSessionProxyHandshake / runClientHandshake implementation), so we MUST NOT
 * rely on `clientTransport.onControl` for post-handshake collection.
 */
async function connectClient(
  server: ControlServer,
): Promise<{ received: ControlMessage[]; sessionProxyTransport: Transport }> {
  const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();

  const received: ControlMessage[] = [];

  // Wrap sendControl on the session-proxy transport to spy on outgoing messages.
  // We skip "session-proxy.capabilities" (the handshake advertisement) so tests only
  // see application-level messages: snapshot, deltas, errors.
  const originalSendControl = sessionProxyTransport.sendControl.bind(sessionProxyTransport);
  sessionProxyTransport.sendControl = function (msg: ControlMessage) {
    if (msg.type !== "session-proxy.capabilities") {
      received.push(msg);
    }
    return originalSendControl(msg);
  };

  // Run both handshakes concurrently. addClient resolves after the initial
  // snapshot has been sent (synchronously inside addClient, before its promise
  // resolves). runClientHandshake resolves once capabilities are exchanged.
  await Promise.all([
    server.addClient(sessionProxyTransport),
    runClientHandshake(clientTransport, CLIENT_CAPS),
  ]);

  return { received, sessionProxyTransport };
}

// ---------------------------------------------------------------------------
// Fixture models
// ---------------------------------------------------------------------------

const S1 = sessionId("s1");
const W1 = windowId("w1");
const P1 = paneId("p1");
const P2 = paneId("p2");

function makePane(id: PaneId, winId: WindowId, sessId: SessionId, cols = 80, rows = 24): Pane {
  // exitCode and label are required (X | undefined); scrollbackHandle and
  // paneTitle are optional — omit to avoid exactOptionalPropertyTypes TS2375.
  return { paneId: id, windowId: winId, sessionId: sessId, cols, rows, mode: "normal", dead: false, exitCode: undefined, label: undefined, boundClients: new Set(), detach: undefined, icon: undefined };
}

function makeModel1(): SessionModel {
  const sess: Session = { sessionId: S1, name: "main", windowIds: [W1], activeWindowId: W1 };
  const win: Window = { windowId: W1, sessionId: S1, name: "editor", paneIds: [P1], activePaneId: P1, layout: null, synchronizePanes: false, monitorActivity: true, monitorSilence: 0 }; // ── tc-7xv.15 ──
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
  const win: Window = { windowId: W1, sessionId: S1, name: "editor", paneIds: [P1, P2], activePaneId: P1, layout: null, synchronizePanes: false, monitorActivity: true, monitorSilence: 0 }; // ── tc-7xv.15 ──
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
      // handled inside runClientHandshake and runSessionProxyHandshake, not re-delivered
      // to the application-level onControl after they unregister their handlers).
      //
      // tc-44wu0: a client-count.changed message is broadcast immediately after
      // the snapshot, so the single-client case receives [snapshot, ccc].
      assert.ok(received.length >= 1, "should have received at least the snapshot");
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
      assert.equal(snap.session.sessionId, S1);
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
      const delta = received.find((m) => m.type === "pane.opened") as SessionProxyMessage | undefined;
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

      // client2 should have snapshot and a client-count.changed (but no model
      // deltas that occurred before its connect — tc-44wu0).
      assert.ok(recv2.length >= 1, "client2 should have received at least the snapshot");
      assert.equal((recv2[0]! as SnapshotMessage).type, "snapshot");
      // Any messages beyond the snapshot must all be client-count.changed (not model deltas).
      for (let i = 1; i < recv2.length; i++) {
        assert.equal(recv2[i]!.type, "client-count.changed",
          "client2 must not receive model deltas that occurred before it connected");
      }

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
      const { sessionProxyTransport: t1 } = await connectClient(server);
      assert.equal(server.clientCount(), 1);
      const { sessionProxyTransport: _t2 } = await connectClient(server);
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

      const { received, sessionProxyTransport } = await connectClient(server);
      const countAfterSnapshot = received.length;

      // Remove the client
      server.removeClient(sessionProxyTransport);
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

      const { received, sessionProxyTransport } = await connectClient(server);
      const countAfterSnapshot = received.length;

      // Close the transport (simulates remote disconnect)
      sessionProxyTransport.close();
      assert.equal(server.clientCount(), 0);

      // Fire a model change — should NOT crash or deliver
      pipeline.fireChange(model2, model1);

      assert.equal(received.length, countAfterSnapshot, "no new messages after transport close");
    });

    it("removeClient is idempotent", () => {
      const pipeline = createFakePipeline();
      const server = createControlServer(pipeline);

      const { sessionProxy: t } = createInMemoryTransportPair();
      // Never added — removeClient should be a no-op
      assert.doesNotThrow(() => server.removeClient(t));
      assert.doesNotThrow(() => server.removeClient(t));
    });

    it("model changes after one client disconnects do not affect remaining clients", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2();
      const pipeline = createFakePipeline(model1);
      const server = createControlServer(pipeline);

      const { received: recv1, sessionProxyTransport: t1 } = await connectClient(server);
      const { received: recv2 } = await connectClient(server);

      // Disconnect client1
      server.removeClient(t1);

      // Fire a change — only client2 should receive deltas
      pipeline.fireChange(model2, model1);

      // tc-44wu0: client1 may have received client-count.changed messages (from
      // client2 connecting, and from client1's own connect), but no model
      // deltas should have arrived after disconnect.
      const client1ModelDeltas = recv1.filter(
        (m) => m.type !== "snapshot" && m.type !== "client-count.changed",
      );
      assert.equal(
        client1ModelDeltas.length,
        0,
        "client1 should have only snapshot + count-changes (no model deltas post-disconnect)",
      );
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
      const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
      const received: ControlMessage[] = [];
      clientTransport.onControl((msg) => received.push(msg));

      let negotiated;
      [, negotiated] = await Promise.all([
        server.addClient(sessionProxyTransport),
        runClientHandshake(clientTransport, {
          protocolVersion: WPV,
          features: ["pane-lifecycle", "focus-events"],
        }),
      ]);

      // Intersection = ["pane-lifecycle"]
      assert.deepEqual(negotiated.features, ["pane-lifecycle"]);
    });

  });

  // --------------------------------------------------------------------------
  // tc-ozk.2 — causality-tagged creation deltas (origin attribution)
  //
  // The ACCEPTANCE scenario: two connections share one session-proxy. Conn A
  // issues a creating verb (open-window / split-pane); the daemon records the
  // verb's returned effect ids against A's connectionId in the
  // VerbOriginRegistry. When the new pane materialises in the model, BOTH
  // connections' per-client diffModel passes the SAME origin lookup, so:
  //   - conn A's pane.opened carries origin.connectionId === A  (its own)
  //   - conn B's pane.opened carries the SAME origin.connectionId === A,
  //     which is ≠ B's own connectionId — so B treats it as not-its-own.
  // A FOREIGN creation (no verb recorded) carries no origin on either side.
  // --------------------------------------------------------------------------
  describe("origin attribution (tc-ozk.2)", () => {

    /** Read the connectionId the server assigned a connection from its snapshot. */
    function connIdOf(received: ControlMessage[]): string {
      const snap = received[0]! as SnapshotMessage;
      assert.equal(snap.type, "snapshot");
      assert.ok((snap as SnapshotMessage).connectionId !== undefined, "snapshot must carry connectionId");
      return String((snap as SnapshotMessage).connectionId);
    }

    function firstPaneOpened(received: ControlMessage[]): SessionProxyMessage & { type: "pane.opened" } {
      const d = received.find((m) => m.type === "pane.opened");
      assert.ok(d !== undefined, "expected a pane.opened delta");
      return d as SessionProxyMessage & { type: "pane.opened" };
    }

    it("two-connection: A's verb-caused pane carries origin.connectionId=A; B sees it as not-its-own", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2(); // adds P2
      const pipeline = createFakePipeline(model1);
      const verbOrigins = createVerbOriginRegistry();
      const server = createControlServer(pipeline, {
        originLookup: (id) => verbOrigins.lookup(id),
      });

      // Two connections share the server.
      const { received: recvA, sessionProxyTransport: tA } = await connectClient(server);
      const { received: recvB } = await connectClient(server);

      const connA = connIdOf(recvA);
      const connB = connIdOf(recvB);
      assert.notEqual(connA, connB, "the two connections must get distinct connectionIds");

      // Conn A issued an open-window verb (correlationId "req-A"); the daemon
      // correlated its returned effect ids (P2 + W1) to A. We record that here
      // exactly as session-proxy.ts's verb responder does, using A's id.
      const aId = server.connectionIdFor(tA);
      assert.ok(aId !== undefined);
      verbOrigins.record(P2, W1, aId!, "req-A");

      // The new pane materialises in the model → both connections diff it.
      pipeline.fireChange(model2, model1);

      const openedA = firstPaneOpened(recvA);
      const openedB = firstPaneOpened(recvB);
      assert.equal(openedA.paneId, P2);
      assert.equal(openedB.paneId, P2);

      // A's view: origin names A (its own creation).
      assert.ok(openedA.origin !== undefined, "A's pane.opened must carry origin");
      assert.equal(String(openedA.origin!.connectionId), connA);
      assert.equal(openedA.origin!.requestId, "req-A");

      // B's view: origin names A (NOT B) — B treats it as not-its-own.
      assert.ok(openedB.origin !== undefined, "B's pane.opened must also carry the origin");
      assert.equal(String(openedB.origin!.connectionId), connA);
      assert.notEqual(String(openedB.origin!.connectionId), connB,
        "B must see origin.connectionId != its own → foreign-to-B");
    });

    it("foreign creation (no verb recorded) carries NO origin on either connection", async () => {
      const model1 = makeModel1();
      const model2 = makeModel2(); // adds P2
      const pipeline = createFakePipeline(model1);
      const verbOrigins = createVerbOriginRegistry();
      const server = createControlServer(pipeline, {
        originLookup: (id) => verbOrigins.lookup(id),
      });

      const { received: recvA } = await connectClient(server);
      const { received: recvB } = await connectClient(server);

      // No verb recorded — P2 is a native-client / script creation.
      pipeline.fireChange(model2, model1);

      const openedA = firstPaneOpened(recvA);
      const openedB = firstPaneOpened(recvB);
      assert.equal(openedA.paneId, P2);
      assert.equal(openedB.paneId, P2);
      assert.equal(openedA.origin, undefined, "foreign pane.opened must be untagged for A");
      assert.equal(openedB.origin, undefined, "foreign pane.opened must be untagged for B");
    });

  });

});

// ---------------------------------------------------------------------------
// Multi-client snapshot fan-out (tc-j9c.7)
//
// Verifies the fan-out contract (multiple clients on one session-proxy):
//   - Each connection receives its own independent snapshot (seq=1).
//   - A single tmux event fans out as N session-proxy-wire deltas, one per client,
//     each stamped with that client's per-connection seq counter (seq=2, 3, …).
//   - Seq counters are INDEPENDENT across clients: client A and client B both
//     get their own seq=1 snapshot and seq=2 first-delta, regardless of when
//     they connected relative to each other.
// ---------------------------------------------------------------------------

describe("pane.notify broadcast (tc-76m8.1, S9)", () => {
  it("broadcasts a scanner-emitted pane.notify to a connected client", async () => {
    const pipeline = createFakePipeline(makeModel1());
    const server = createControlServer(pipeline);
    const { received } = await connectClient(server);

    pipeline.firePaneNotify({ paneId: P1, kind: "osc9", payload: { message: "done", source: "osc9" } });
    await new Promise((r) => setImmediate(r));

    const notify = received.find((m): m is PaneNotifyMessage => m.type === "pane.notify");
    assert.ok(notify, "client should receive a pane.notify");
    assert.equal(notify!.paneId, P1);
    assert.equal(notify!.kind, "osc9");
    assert.deepEqual(notify!.payload, { message: "done", source: "osc9" });
    assert.ok(notify!.seq >= 1, "pane.notify carries a per-connection seq");
  });

  it("omits payload for a bell notify", async () => {
    const pipeline = createFakePipeline(makeModel1());
    const server = createControlServer(pipeline);
    const { received } = await connectClient(server);

    pipeline.firePaneNotify({ paneId: P1, kind: "bell" });
    await new Promise((r) => setImmediate(r));

    const notify = received.find((m): m is PaneNotifyMessage => m.type === "pane.notify");
    assert.ok(notify, "client should receive a pane.notify");
    assert.equal(notify!.kind, "bell");
    assert.equal(notify!.payload, undefined);
  });

  it("fans one pane.notify out to every connected client", async () => {
    const pipeline = createFakePipeline(makeModel1());
    const server = createControlServer(pipeline);
    const { received: recvA } = await connectClient(server);
    const { received: recvB } = await connectClient(server);

    pipeline.firePaneNotify({ paneId: P1, kind: "bell" });
    await new Promise((r) => setImmediate(r));

    assert.ok(recvA.some((m) => m.type === "pane.notify"), "client A got the notify");
    assert.ok(recvB.some((m) => m.type === "pane.notify"), "client B got the notify");
  });
});

describe("multi-client snapshot fan-out (tc-j9c.7)", () => {

  it("two clients each receive their own snapshot with seq=1", async () => {
    const model = makeModel1();
    const pipeline = createFakePipeline(model);
    const server = createControlServer(pipeline);

    const { received: recv1 } = await connectClient(server);
    const { received: recv2 } = await connectClient(server);

    // Each client's first message must be a snapshot at seq=1.
    const snap1 = recv1[0]! as SnapshotMessage;
    const snap2 = recv2[0]! as SnapshotMessage;
    assert.equal(snap1.type, "snapshot", "client1 first message is snapshot");
    assert.equal(snap2.type, "snapshot", "client2 first message is snapshot");
    assert.equal(snap1.seq, 1, "client1 snapshot has seq=1");
    assert.equal(snap2.seq, 1, "client2 snapshot has seq=1 (independent counter)");
  });

  it("model change fans out to both clients with independent seq counters", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);

    const { received: recv1 } = await connectClient(server);
    const { received: recv2 } = await connectClient(server);

    // Confirm both start with snapshot at seq=1.
    assert.equal(recv1[0]!.seq, 1, "client1 snapshot seq=1");
    assert.equal(recv2[0]!.seq, 1, "client2 snapshot seq=1");

    // Fire a model change — P2 added.
    pipeline.fireChange(model2, model1);

    // Both clients should receive at least one delta (pane.opened for P2).
    assert.ok(recv1.length > 1, "client1 should receive delta(s)");
    assert.ok(recv2.length > 1, "client2 should receive delta(s)");

    // The first delta for each client must be seq=2 (directly after snapshot seq=1).
    assert.equal(recv1[1]!.seq, 2, "client1 first delta has seq=2");
    assert.equal(recv2[1]!.seq, 2, "client2 first delta has seq=2 (independent counter)");

    // Both clients receive the pane.opened delta for P2.
    const delta1 = recv1.find((m) => m.type === "pane.opened");
    const delta2 = recv2.find((m) => m.type === "pane.opened");
    assert.ok(delta1 !== undefined, "client1 receives pane.opened delta for P2");
    assert.ok(delta2 !== undefined, "client2 receives pane.opened delta for P2");
    if (delta1?.type === "pane.opened") assert.equal(delta1.paneId, P2);
    if (delta2?.type === "pane.opened") assert.equal(delta2.paneId, P2);
  });

  it("sequential model changes produce monotonic seq on both clients", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);

    const { received: recv1 } = await connectClient(server);
    const { received: recv2 } = await connectClient(server);

    // Two successive changes.
    pipeline.fireChange(model2, model1); // P2 added
    pipeline.fireChange(model1, model2); // P2 removed

    // Each client's seq values must be 1, 2, 3, … with no gaps.
    for (const [label, received] of [["client1", recv1], ["client2", recv2]] as const) {
      const seqs = received.map((m) => m.seq);
      for (let i = 0; i < seqs.length; i++) {
        assert.equal(seqs[i], i + 1, `${label}: seq at index ${i} must be ${i + 1}`);
      }
    }
  });

});

// ---------------------------------------------------------------------------
// Async-transport pair — regression test helper (tc-3eh.2)
//
// createAsyncTransportPair() wraps the in-memory transport so that all
// sendControl deliveries are deferred via queueMicrotask.  This simulates
// the semantics of a real socket transport: bytes are written synchronously
// into a kernel buffer, but the remote's read handler fires asynchronously
// (on the next event-loop iteration).
//
// Timing contract being verified (tc-3eh.2):
//
//   SessionProxy side:
//     1. await runSessionProxyHandshake() — resolves; settle() set sessionProxyTransport.onControl
//        to a no-op.
//     2. Install delta subscription + onClose (synchronous).
//     3. await Promise.resolve() — yield one microtask so the client's
//        runClientHandshake continuation can install its post-handshake onControl.
//     4. sendControl(snapshot).
//
//   Client side:
//     1. await runClientHandshake() — resolves; settle() set clientTransport.onControl
//        to a no-op.
//     2. SYNCHRONOUSLY install post-handshake onControl (no await between steps 1
//        and 2 — SessionProxyConnection.#installPostHandshakeRouting() is called directly
//        after runClientHandshake returns, before any awaits).
//
//   With async delivery: by the time the snapshot arrives on the client transport,
//   step 2 has already run.  Snapshot reaches the real handler, not the no-op.
// ---------------------------------------------------------------------------

/**
 * A wrapped Transport pair whose sendControl calls defer delivery to the
 * remote endpoint via queueMicrotask, simulating a real async socket transport.
 * sendData and close remain synchronous for simplicity.
 */
function createAsyncTransportPair(): { sessionProxy: Transport; client: Transport } {
  const { sessionProxy: rawSessionProxy, client: rawClient } = createInMemoryTransportPair();

  // clientControlHandler and sessionProxyControlHandler are accessed via the raw
  // transport's delivery mechanism.  We override sendControl on each side to
  // queue the delivery, but the raw onControl replacement still works because
  // the raw transport's closure captures the handler by reference.
  //
  // To defer delivery without touching raw internals, we layer over sendControl:
  // instead of calling rawSessionProxy.sendControl (which delivers synchronously to
  // clientControlHandler), we capture the current clientControlHandler at
  // send time via a closure over the raw transport pair's state.
  //
  // Simpler: build our own minimal async transport pair from scratch.

  let sessionProxyControlHandler: ControlHandler = () => {};
  const sessionProxyCloseHandlers = new Set<CloseHandler>();

  let clientControlHandler: ControlHandler = () => {};
  const clientCloseHandlers = new Set<CloseHandler>();

  let closed = false;

  const sessionProxy: Transport = {
    sendControl(msg) {
      if (closed) return;
      // Defer delivery to the client's onControl handler via a microtask.
      // This simulates a real socket where the write() completes synchronously
      // but the remote read() fires on the next event-loop turn.
      const handler = clientControlHandler;
      queueMicrotask(() => { if (!closed) handler(msg); });
    },
    onControl(handler) { sessionProxyControlHandler = handler; },
    sendData(paneId, bytes) {
      if (closed) return;
      // Data plane: synchronous for test simplicity.
    },
    onData(_handler) { /* not used in this test */ },
    onClose(handler) {
      sessionProxyCloseHandlers.add(handler);
      return () => { sessionProxyCloseHandlers.delete(handler); };
    },
    close(err) {
      if (closed) return;
      closed = true;
      for (const h of clientCloseHandlers) h(err);
      for (const h of sessionProxyCloseHandlers) h(err);
    },
  };

  const client: Transport = {
    sendControl(msg) {
      if (closed) return;
      // Client → sessionProxy: also async for symmetry.
      const handler = sessionProxyControlHandler;
      queueMicrotask(() => { if (!closed) handler(msg); });
    },
    onControl(handler) { clientControlHandler = handler; },
    sendData(paneId, bytes) {
      if (closed) return;
    },
    onData(_handler) { /* not used in this test */ },
    onClose(handler) {
      clientCloseHandlers.add(handler);
      return () => { clientCloseHandlers.delete(handler); };
    },
    close(err) {
      if (closed) return;
      closed = true;
      for (const h of sessionProxyCloseHandlers) h(err);
      for (const h of clientCloseHandlers) h(err);
    },
  };

  return { sessionProxy, client };
}

// ---------------------------------------------------------------------------
// tc-3eh.2 regression tests — snapshot not dropped on async transport
// ---------------------------------------------------------------------------

describe("tc-3eh.2: addClient snapshot timing — async transport regression", () => {

  /**
   * Core timing scenario:
   *   - Async transport pair (sendControl defers via queueMicrotask).
   *   - Both addClient and runClientHandshake run concurrently.
   *   - After runClientHandshake resolves, the client installs its onControl
   *     handler SYNCHRONOUSLY (before any await).
   *   - SessionProxy defers snapshot by one microtask after handshake.
   *   - Snapshot must arrive at the client's real handler, not the no-op.
   *
   * WITHOUT the fix (no `await Promise.resolve()` in addClient before send):
   *   The snapshot would be queued for delivery at queueMicrotask time with
   *   the no-op handler that settle() installed.  The handler replacement
   *   (clientControlHandler = realHandler) happens in the microtask that runs
   *   runClientHandshake's continuation — but there is a race: the snapshot's
   *   queueMicrotask callback captures clientControlHandler at queue time, so
   *   whether it sees the old or new handler depends on microtask ordering.
   *   In practice with the async transport, the snapshot queueMicrotask fires
   *   before the client's continuation runs (since addClient enqueues it first),
   *   so it hits the no-op → snapshot dropped.
   *
   * WITH the fix (`await Promise.resolve()` before send):
   *   The session-proxy yields one microtask, allowing the client's runClientHandshake
   *   continuation to run (installing the real onControl).  Then the session-proxy
   *   sends the snapshot.  Its queueMicrotask fires after the handler is set.
   */
  it("client receives snapshot on async transport after microtask-deferred send", async () => {
    const model = makeModel1();
    const pipeline = createFakePipeline(model);
    const server = createControlServer(pipeline);

    const { sessionProxy: sessionProxyTransport, client: clientTransport } = createAsyncTransportPair();

    // Received messages on the client side (installed AFTER handshake, mimicking
    // SessionProxyConnection.#installPostHandshakeRouting's synchronous installation).
    const received: ControlMessage[] = [];

    // Run both handshake halves concurrently, just as production code does.
    const [, ] = await Promise.all([
      server.addClient(sessionProxyTransport),
      (async () => {
        await runClientHandshake(clientTransport, CLIENT_CAPS);
        // Install the post-handshake handler SYNCHRONOUSLY after runClientHandshake
        // resolves — no await in between.  This matches SessionProxyConnection behavior.
        clientTransport.onControl((msg) => {
          received.push(msg);
        });
      })(),
    ]);

    // addClient resolves only after the snapshot has been sent (awaited one microtask
    // internally).  The snapshot's queueMicrotask delivery may still be pending.
    // Wait one more event-loop turn for it to deliver.
    await new Promise<void>((r) => setImmediate(r));

    // The snapshot must have arrived.
    const snapshot = received.find((m) => m.type === "snapshot") as SnapshotMessage | undefined;
    assert.ok(
      snapshot !== undefined,
      `snapshot must arrive on async transport; received ${received.length} message(s): ${received.map((m) => m.type).join(", ")}`,
    );
    assert.equal(snapshot!.seq, 1, "snapshot seq must be 1");
    assert.ok(snapshot!.session !== undefined, "snapshot must have a session");

    sessionProxyTransport.close();
  });

  it("snapshot arrives before any deltas on async transport", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);

    const { sessionProxy: sessionProxyTransport, client: clientTransport } = createAsyncTransportPair();
    const received: ControlMessage[] = [];

    await Promise.all([
      server.addClient(sessionProxyTransport),
      (async () => {
        await runClientHandshake(clientTransport, CLIENT_CAPS);
        clientTransport.onControl((msg) => { received.push(msg); });
      })(),
    ]);

    // Fire a model change after addClient resolves (snapshot already sent).
    pipeline.fireChange(model2, model1);

    // Let all queued microtasks + setImmediate deliver.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Filter to application messages (skip session-proxy.capabilities if any leaked through).
    const appMsgs = received.filter((m) => m.type !== "session-proxy.capabilities");

    assert.ok(appMsgs.length >= 2, `expected snapshot + at least one delta, got ${appMsgs.length} messages`);

    // First message must be the snapshot.
    assert.equal(appMsgs[0]!.type, "snapshot", "first message must be snapshot");
    assert.equal(appMsgs[0]!.seq, 1, "snapshot seq must be 1");

    // All subsequent messages must have seq > 1.
    for (let i = 1; i < appMsgs.length; i++) {
      assert.ok(
        (appMsgs[i]!.seq ?? 0) > 1,
        `delta at index ${i} must have seq > 1; got seq=${appMsgs[i]!.seq}`,
      );
    }

    sessionProxyTransport.close();
  });

  it("snapshot is not dropped when client installs onControl synchronously after handshake", async () => {
    // Demonstrate the exact timing that production SessionProxyConnection uses:
    // install onControl synchronously (no await gap) after runClientHandshake.
    // The microtask defer in addClient makes this safe.
    const model = makeModel1();
    const pipeline = createFakePipeline(model);
    const server = createControlServer(pipeline);

    const { sessionProxy: sessionProxyTransport, client: clientTransport } = createAsyncTransportPair();

    let snapshotReceived = false;
    let snapshotSeq = -1;

    const [, ] = await Promise.all([
      server.addClient(sessionProxyTransport),
      (async () => {
        // This await runClientHandshake simulates the client's async handshake.
        await runClientHandshake(clientTransport, CLIENT_CAPS);
        // No await between here and onControl install — synchronous install.
        clientTransport.onControl((msg) => {
          if (msg.type === "snapshot") {
            snapshotReceived = true;
            snapshotSeq = msg.seq;
          }
        });
      })(),
    ]);

    // Allow async delivery to complete.
    await new Promise<void>((r) => setImmediate(r));

    assert.ok(snapshotReceived, "snapshot must be received when onControl is installed synchronously after handshake");
    assert.equal(snapshotSeq, 1, "received snapshot must have seq=1");

    sessionProxyTransport.close();
  });

});
