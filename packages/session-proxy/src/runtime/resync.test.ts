/**
 * Resync recovery integration test — tc-7ml.4 acceptance criteria.
 *
 * Verifies the full resync round-trip using real session-proxy code (createControlServer)
 * and the real client Mirror, connected via a filtered in-memory transport pair.
 *
 * Acceptance criteria covered:
 *   1. The mirror sends `resync.request` when a seq gap is detected.
 *   2. The session-proxy re-sends a fresh snapshot at the next per-connection seq (no
 *      seq reset).
 *   3. The mirror recovers — model is consistent — WITHOUT a full reconnect.
 *   4. Dedup policy: further gaps while resync is in flight are suppressed.
 *   5. Persistent gap escalation: a gap after the resync snapshot triggers
 *      transport.close().
 *   6. Seq continuity: the resync snapshot has seq > 1; subsequent deltas
 *      continue monotonically.
 *
 * # Gap detection mechanics
 *
 * A seq gap is detected when the mirror receives a message whose seq is NOT
 * (lastSeq + 1).  Dropping a message alone is not enough — a subsequent
 * message must arrive to expose the hole.  The pattern used throughout:
 *
 *   1. Connect → snapshot (seq=1) → mirror initialized, lastSeq=1.
 *      Then client-count.changed (seq=2, tc-44wu0) → lastSeq=2.
 *   2. Drop predicate drops model delta (seq=3, e.g. pane.opened).
 *   3. A SECOND model change fires delta (seq=4); mirror receives it and
 *      detects the gap (expected=3, received=4).
 *   4. Mirror sends resync.request → session-proxy re-sends snapshot (seq=5+).
 *   5. Mirror applies the resync snapshot → recovered.
 *
 * # Import strategy
 *
 * This file imports from @remux/client via relative src paths (outside the
 * session-proxy's rootDir). tsx resolves them at runtime without issues, but tsc
 * rejects the rootDir violation. Therefore this file is excluded from
 * session-proxy/tsconfig.json (see the "exclude" array there) — matching the pattern
 * used by e2e-smoke.test.ts.
 *
 * @module runtime/resync.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// SessionProxy internals (within rootDir — no tsconfig issue)
// ---------------------------------------------------------------------------

import { createControlServer } from "./serve.js";
import type { ModelChangeHandler } from "./pipeline.js";
import {
  emptyModel,
  paneId,
  windowId,
  sessionId,
} from "../state/model.js";
import type { SessionModel, Session, Window, Pane } from "../state/model.js";
import type { RuntimePipeline } from "./pipeline.js";
import type { Transport, ControlMessage, ControlHandler, CloseHandler, PaneId } from "../wire/index.js";

// ---------------------------------------------------------------------------
// Client modules — relative src paths; tsx resolves at runtime.
// Excluded from session-proxy tsconfig (see tsconfig.json "exclude").
// ---------------------------------------------------------------------------

// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { SessionProxyConnection } from "../../../tmuxcc-client/src/connection.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { Mirror } from "../../../tmuxcc-client/src/mirror.js";

// ---------------------------------------------------------------------------
// Fake pipeline (same pattern as serve.test.ts)
// ---------------------------------------------------------------------------

interface FakePipeline extends RuntimePipeline {
  fireChange(newModel: SessionModel, prevModel: SessionModel): void;
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
    fireChange(newModel: SessionModel, prevModel: SessionModel) {
      current = newModel;
      for (const h of handlers) {
        h(newModel, prevModel);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Model fixtures
// ---------------------------------------------------------------------------

const S1 = sessionId("s1");
const W1 = windowId("w1");
const P1 = paneId("p1");
const P2 = paneId("p2");

function makeModel1(): SessionModel {
  const sess: Session = { sessionId: S1, name: "main", windowIds: [W1], activeWindowId: W1 };
  const win: Window = { windowId: W1, sessionId: S1, name: "editor", paneIds: [P1], activePaneId: P1, layout: null };
  const p1: Pane = { paneId: P1, windowId: W1, sessionId: S1, cols: 80, rows: 24, mode: "normal", scrollbackHandle: undefined };
  return {
    sessions: new Map([[S1, sess]]),
    windows: new Map([[W1, win]]),
    panes: new Map([[P1, p1]]),
    focus: { paneId: P1, windowId: W1, sessionId: S1 },
  };
}

function makeModel2(): SessionModel {
  const sess: Session = { sessionId: S1, name: "main", windowIds: [W1], activeWindowId: W1 };
  const win: Window = { windowId: W1, sessionId: S1, name: "editor", paneIds: [P1, P2], activePaneId: P1, layout: null };
  const p1: Pane = { paneId: P1, windowId: W1, sessionId: S1, cols: 80, rows: 24, mode: "normal", scrollbackHandle: undefined };
  const p2: Pane = { paneId: P2, windowId: W1, sessionId: S1, cols: 40, rows: 24, mode: "normal", scrollbackHandle: undefined };
  return {
    sessions: new Map([[S1, sess]]),
    windows: new Map([[W1, win]]),
    panes: new Map([[P1, p1], [P2, p2]]),
    focus: { paneId: P1, windowId: W1, sessionId: S1 },
  };
}

// ---------------------------------------------------------------------------
// Filtering transport pair
//
// Wraps independent handler closures to simulate a two-leg transport with a
// drop filter on the session-proxy→client direction.  Client→session-proxy messages are
// recorded and forwarded unfiltered (so resync.request reaches the sessionProxy).
// ---------------------------------------------------------------------------

interface FilteredPair {
  /** SessionProxy-side transport (passed to createControlServer). */
  sessionProxyT: Transport;
  /** Client-side transport (passed to SessionProxyConnection). */
  clientT: Transport;
  /** Set a predicate to drop matching session-proxy→client control messages. */
  setDropPredicate(pred: ((msg: ControlMessage) => boolean) | null): void;
  /** All control messages sent by the client (client→session-proxy direction). */
  readonly clientToServer: ControlMessage[];
}

function createFilteredPair(): FilteredPair {
  let dropPredicate: ((msg: ControlMessage) => boolean) | null = null;
  const clientToServer: ControlMessage[] = [];

  let sessionProxyControlHandler: ControlHandler = () => {};
  let sessionProxyCloseHandler: CloseHandler = () => {};
  let clientControlHandler: ControlHandler = () => {};
  let clientCloseHandler: CloseHandler = () => {};
  let closed = false;

  const sessionProxyT: Transport = {
    sendControl(msg: ControlMessage) {
      if (closed) return;
      // Apply drop filter (session-proxy→client direction).
      if (dropPredicate !== null && dropPredicate(msg)) return;
      clientControlHandler(msg);
    },
    onControl(handler: ControlHandler) { sessionProxyControlHandler = handler; },
    sendData(_pid: PaneId, _b: Uint8Array) { /* no data plane in this test */ },
    onData() { /* unused */ },
    onClose(handler: CloseHandler) { sessionProxyCloseHandler = handler; },
    close(err?: Error) {
      if (closed) return;
      closed = true;
      clientCloseHandler(err);
      sessionProxyCloseHandler(err);
    },
  };

  const clientT: Transport = {
    sendControl(msg: ControlMessage) {
      if (closed) return;
      clientToServer.push(msg); // record client→session-proxy messages
      sessionProxyControlHandler(msg);
    },
    onControl(handler: ControlHandler) { clientControlHandler = handler; },
    sendData(_pid: PaneId, _b: Uint8Array) { /* no data plane in this test */ },
    onData() { /* unused */ },
    onClose(handler: CloseHandler) { clientCloseHandler = handler; },
    close(err?: Error) {
      if (closed) return;
      closed = true;
      sessionProxyCloseHandler(err);
      clientCloseHandler(err);
    },
  };

  return {
    sessionProxyT,
    clientT,
    setDropPredicate(pred) { dropPredicate = pred; },
    clientToServer,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resync.request — tc-7ml.4 acceptance criteria", { timeout: 5000 }, () => {

  // --------------------------------------------------------------------------
  // 1. Core resync round-trip
  //
  // Timeline (seq numbers, tc-44wu0: client-count.changed is seq=2 on connect):
  //   seq=1: initial snapshot (model1, 1 pane)
  //   seq=2: client-count.changed (broadcast on connect) — passes through; lastSeq=2
  //   seq=3: pane.opened P2 (model1→model2) — DROPPED; lastSeq stays 2
  //   seq=4: pane.closed P2 (model2→model1) — arrives → gap(3!=4) detected
  //          → resync.request sent synchronously
  //          → session-proxy sends snapshot(seq=5, model1) → mirror recovers (1 pane)
  //   result: mirror has 1 pane; connection still "ready"
  // --------------------------------------------------------------------------

  it("mirror sends resync.request after dropped delta; session-proxy re-snapshots; model recovers without reconnect", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { sessionProxyT, clientT, setDropPredicate, clientToServer } = createFilteredPair();

    // Connect both sides concurrently (same pattern as serve.test.ts).
    const conn = new SessionProxyConnection(clientT);
    await Promise.all([
      server.addClient(sessionProxyT),
      conn.connect(),
    ]);

    const mirror = new Mirror();
    mirror.connectTo(conn);

    // Verify baseline: snapshot (seq=1) was buffered during the microtask gap
    // in addClient and delivered synchronously by connectTo() via drain-on-register.
    assert.equal(mirror.initialized, true, "mirror should be initialized after connectTo");
    assert.equal(mirror.getModel().panes.size, 1, "model should have 1 pane after initial snapshot");

    // Track gap signals.
    let gapCount = 0;
    mirror.onResyncNeeded(() => { gapCount++; });

    // Drop the pane.opened delta for P2 (type-based; seq-independent of tc-44wu0 client-count.changed).
    setDropPredicate((msg: ControlMessage) => msg.type === "pane.opened");

    // pane.opened P2: model1→model2 — dropped; mirror invisible.
    pipeline.fireChange(model2, model1);
    assert.equal(gapCount, 0, "no gap yet — dropped delta is invisible to the mirror");

    // pane.closed P2: model2→model1 — arrives at mirror.
    // Mirror detects a seq gap (expected N+1, got N+2 due to dropped pane.opened).
    // Synchronously: resync.request sent → session-proxy sends resync snapshot → mirror recovers.
    pipeline.fireChange(model1, model2);

    // Gap was detected.
    assert.equal(gapCount, 1, "exactly 1 gap should be detected");

    // resync.request was sent.
    const resyncMsgs = clientToServer.filter((m: ControlMessage) => m.type === "resync.request");
    assert.equal(resyncMsgs.length, 1, "mirror should send exactly 1 resync.request");

    // Resync snapshot was received and applied.
    // Pipeline model at resync time is model1 (set by second fireChange).
    const modelAfter = mirror.getModel();
    assert.equal(modelAfter.panes.size, 1, "mirror should have 1 pane after resync snapshot (model1)");
    assert.ok(modelAfter.panes.has(P1), "mirror model should include P1 after recovery");

    // Connection should still be open — no full reconnect.
    assert.equal(conn.state, "ready", "connection must still be 'ready' (no full reconnect)");

    sessionProxyT.close();
  });

  // --------------------------------------------------------------------------
  // 2. Dedup: only one resync.request in flight at a time
  //
  // Timeline (tc-44wu0: client-count.changed is seq=2 on connect):
  //   seq=1: initial snapshot (model1)
  //   seq=2: client-count.changed — passes through; lastSeq=2
  //   seq=3: pane.opened P2 — DROPPED (first model delta); lastSeq stays 2
  //   seq=4: pane.closed P2 — arrives → gap(3!=4) → resync.request sent
  //          → session-proxy sends snapshot(seq=5) — also DROPPED (resync in flight)
  //   seq=6: pane.opened P2 — arrives → another gap → #resyncRequested is still true
  //          → DEDUP → no second resync.request
  //   result: only 1 resync.request sent despite 2+ gaps
  // --------------------------------------------------------------------------

  it("dedup: only one resync.request sent even when multiple gaps arrive while one is in flight", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { sessionProxyT, clientT, setDropPredicate, clientToServer } = createFilteredPair();

    const conn = new SessionProxyConnection(clientT);
    await Promise.all([
      server.addClient(sessionProxyT),
      conn.connect(),
    ]);

    const mirror = new Mirror();
    mirror.connectTo(conn);
    assert.equal(mirror.getModel().panes.size, 1, "baseline: 1 pane");

    let gapCount = 0;
    mirror.onResyncNeeded(() => { gapCount++; });

    // Stateful drop predicate: drop the FIRST pane.opened delta AND the first
    // resync snapshot (snapshot with seq > 1). After that, let everything through.
    // This is seq-independent of the tc-44wu0 client-count.changed message.
    let droppedPaneOpened = false;
    let droppedResyncSnapshot = false;
    setDropPredicate((msg: ControlMessage) => {
      if (msg.type === "pane.opened" && !droppedPaneOpened) {
        droppedPaneOpened = true;
        return true;
      }
      if (msg.type === "snapshot" && msg.seq > 1 && !droppedResyncSnapshot) {
        droppedResyncSnapshot = true;
        return true;
      }
      return false;
    });

    // pane.opened P2 — DROPPED (first model delta).
    pipeline.fireChange(model2, model1);
    assert.equal(gapCount, 0, "no gap yet after first dropped delta");

    // pane.closed P2 — arrives → gap detected → resync.request sent.
    // session-proxy sends resync snapshot → DROPPED → #resyncRequested still true.
    pipeline.fireChange(model1, model2);
    assert.equal(gapCount, 1, "first gap detected");

    // pane.opened P2 — arrives (predicate no longer drops pane.opened) →
    // gap detected (lastSeq stale because resync snapshot was dropped).
    // #resyncRequested is still true → dedup → no second resync.request.
    pipeline.fireChange(model2, model1);
    assert.ok(gapCount >= 2, `expected ≥2 gap signals, got ${gapCount}`);

    // Only ONE resync.request should have been sent.
    const resyncMsgs = clientToServer.filter((m: ControlMessage) => m.type === "resync.request");
    assert.equal(resyncMsgs.length, 1, "dedup: only 1 resync.request should be sent");

    sessionProxyT.close();
  });

  // --------------------------------------------------------------------------
  // 3. Persistent gap escalation
  //
  // Timeline (tc-44wu0: client-count.changed is seq=2 on connect) — two cycles:
  //   seq=1: initial snapshot  seq=2: client-count.changed (passes through)
  //   Cycle 1 (succeeds):
  //     seq=3: pane.opened P2 — DROPPED  seq=4: pane.closed — arrives → gap
  //     → resync.request → snapshot(seq=5) OK → #resyncDelivered = true
  //   Cycle 2 (persistent gap):
  //     seq=6: pane.opened P2 — DROPPED  seq=7: pane.closed — arrives
  //     → #resyncDelivered=true + new gap → mirror calls closeFn() → state = "closed"
  // --------------------------------------------------------------------------

  it("persistent gap: transport.close() is called after gap persists post-resync", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { sessionProxyT, clientT, setDropPredicate } = createFilteredPair();

    const conn = new SessionProxyConnection(clientT);
    await Promise.all([
      server.addClient(sessionProxyT),
      conn.connect(),
    ]);

    const mirror = new Mirror();
    mirror.connectTo(conn);
    assert.equal(mirror.getModel().panes.size, 1, "baseline: 1 pane");

    // --- Cycle 1: first gap → resync succeeds ---
    // Drop only pane.opened; allow pane.closed (trigger) and resync snapshot.
    // Type-based drop is seq-independent of tc-44wu0 client-count.changed.
    let droppedCycle1 = false;
    setDropPredicate((msg: ControlMessage) => {
      if (msg.type === "pane.opened" && !droppedCycle1) {
        droppedCycle1 = true;
        return true;
      }
      return false;
    });

    // pane.opened P2 — dropped.
    pipeline.fireChange(model2, model1);

    // pane.closed P2 — arrives → gap → resync.request → resync snapshot OK.
    // After snapshot: #resyncRequested=false, #resyncDelivered=true.
    pipeline.fireChange(model1, model2);

    assert.equal(mirror.getModel().panes.size, 1, "model should have 1 pane after first resync (model1)");
    assert.equal(conn.state, "ready", "connection should still be ready after first resync");

    // --- Cycle 2: second gap → persistent → escalate ---
    // Drop the second pane.opened; allow pane.closed (trigger).
    let droppedCycle2 = false;
    setDropPredicate((msg: ControlMessage) => {
      if (msg.type === "pane.opened" && !droppedCycle2) {
        droppedCycle2 = true;
        return true;
      }
      return false;
    });

    // pane.opened P2 — dropped.
    pipeline.fireChange(model2, model1);

    // pane.closed P2 — arrives → #resyncDelivered=true → persistent gap.
    // Mirror calls closeFn() → conn.close() → state = "closed".
    pipeline.fireChange(model1, model2);

    assert.equal(conn.state, "closed", "connection should be closed after persistent gap escalation");
  });

  // --------------------------------------------------------------------------
  // 4. Seq continuity: session-proxy does NOT reset seq on resync
  //
  // Timeline (tc-44wu0: client-count.changed is seq=2 on connect):
  //   seq=1: initial snapshot  seq=2: client-count.changed (passes through)
  //   seq=3: pane.opened P2 — DROPPED  seq=4: pane.closed — arrives
  //   → gap → resync.request → snapshot(seq=5)
  //   seq=6: post-resync delta (pane.opened P2)
  //   assert: resync snapshot seq > 1; seq=6 = resyncSeq + 1
  // --------------------------------------------------------------------------

  it("seq continuity: resync snapshot has seq > 1; subsequent deltas continue monotonically", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { sessionProxyT, clientT, setDropPredicate } = createFilteredPair();

    // Spy on ALL control messages delivered to the client transport handler.
    const allReceived: ControlMessage[] = [];
    const origOnControl = clientT.onControl.bind(clientT);
    (clientT as any).onControl = (handler: ControlHandler) => {
      origOnControl((msg: ControlMessage) => {
        allReceived.push(msg);
        handler(msg);
      });
    };

    const conn = new SessionProxyConnection(clientT);
    await Promise.all([
      server.addClient(sessionProxyT),
      conn.connect(),
    ]);

    const mirror = new Mirror();
    mirror.connectTo(conn);

    assert.equal(mirror.initialized, true, "mirror should be initialized");

    // Drop the first pane.opened delta (type-based; seq-independent of tc-44wu0
    // client-count.changed which now occupies seq=2 after connect).
    // pane.closed (next delta) will expose the gap, triggering the resync.
    let droppedPaneOpened = false;
    setDropPredicate((msg: ControlMessage) => {
      if (msg.type === "pane.opened" && !droppedPaneOpened) {
        droppedPaneOpened = true;
        return true;
      }
      return false;
    });

    // pane.opened P2 — dropped.
    pipeline.fireChange(model2, model1);

    // pane.closed P2 → gap → resync.request → resync snapshot.
    pipeline.fireChange(model1, model2);

    // Disable drop filter so post-resync deltas flow freely.
    setDropPredicate(null);

    // Find snapshots in allReceived.
    const snapshots = allReceived.filter((m: ControlMessage) => m.type === "snapshot");
    assert.ok(snapshots.length >= 2, `expected ≥2 snapshots (initial + resync), got ${snapshots.length}`);

    const initialSeq = snapshots[0]!.seq;
    const resyncSeq = snapshots[1]!.seq;

    assert.equal(initialSeq, 1, "initial snapshot should have seq=1");
    assert.ok(resyncSeq > initialSeq, `resync snapshot seq (${resyncSeq}) should be > initial (${initialSeq})`);

    // Fire another model change after resync; the delta should be seq = resyncSeq + 1.
    pipeline.fireChange(model2, model1);

    const postResyncDeltas = allReceived.filter(
      (m: ControlMessage) => m.seq > resyncSeq && m.type !== "session-proxy.capabilities",
    );
    assert.ok(postResyncDeltas.length >= 1, "should have at least one delta after resync snapshot");
    assert.equal(
      postResyncDeltas[0]!.seq,
      resyncSeq + 1,
      `first post-resync delta should have seq = resync snapshot seq + 1 (${resyncSeq + 1})`,
    );

    sessionProxyT.close();
  });

});
