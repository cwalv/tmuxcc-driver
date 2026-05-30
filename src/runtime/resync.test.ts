/**
 * Resync recovery integration test — tc-7ml.4 acceptance criteria.
 *
 * Verifies the full resync round-trip using real daemon code (createControlServer)
 * and the real client Mirror, connected via a filtered in-memory transport pair.
 *
 * Acceptance criteria covered:
 *   1. The mirror sends `resync.request` when a seq gap is detected.
 *   2. The daemon re-sends a fresh snapshot at the next per-connection seq (no
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
 *   2. Drop predicate drops delta (seq=2).
 *   3. A SECOND model change fires delta (seq=3); mirror receives it and
 *      detects the gap (expected=2, received=3).
 *   4. Mirror sends resync.request → daemon re-sends snapshot (seq=4+).
 *   5. Mirror applies the resync snapshot → recovered.
 *
 * # Import strategy
 *
 * This file imports from @tmuxcc/client via relative src paths (outside the
 * daemon's rootDir). tsx resolves them at runtime without issues, but tsc
 * rejects the rootDir violation. Therefore this file is excluded from
 * daemon/tsconfig.json (see the "exclude" array there) — matching the pattern
 * used by e2e-smoke.test.ts.
 *
 * @module runtime/resync.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Daemon internals (within rootDir — no tsconfig issue)
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
// Excluded from daemon tsconfig (see tsconfig.json "exclude").
// ---------------------------------------------------------------------------

// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { DaemonConnection } from "../../../tmuxcc-client/src/connection.js";
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
// drop filter on the daemon→client direction.  Client→daemon messages are
// recorded and forwarded unfiltered (so resync.request reaches the daemon).
// ---------------------------------------------------------------------------

interface FilteredPair {
  /** Daemon-side transport (passed to createControlServer). */
  daemonT: Transport;
  /** Client-side transport (passed to DaemonConnection). */
  clientT: Transport;
  /** Set a predicate to drop matching daemon→client control messages. */
  setDropPredicate(pred: ((msg: ControlMessage) => boolean) | null): void;
  /** All control messages sent by the client (client→daemon direction). */
  readonly clientToServer: ControlMessage[];
}

function createFilteredPair(): FilteredPair {
  let dropPredicate: ((msg: ControlMessage) => boolean) | null = null;
  const clientToServer: ControlMessage[] = [];

  let daemonControlHandler: ControlHandler = () => {};
  let daemonCloseHandler: CloseHandler = () => {};
  let clientControlHandler: ControlHandler = () => {};
  let clientCloseHandler: CloseHandler = () => {};
  let closed = false;

  const daemonT: Transport = {
    sendControl(msg: ControlMessage) {
      if (closed) return;
      // Apply drop filter (daemon→client direction).
      if (dropPredicate !== null && dropPredicate(msg)) return;
      clientControlHandler(msg);
    },
    onControl(handler: ControlHandler) { daemonControlHandler = handler; },
    sendData(_pid: PaneId, _b: Uint8Array) { /* no data plane in this test */ },
    onData() { /* unused */ },
    onClose(handler: CloseHandler) { daemonCloseHandler = handler; },
    close(err?: Error) {
      if (closed) return;
      closed = true;
      clientCloseHandler(err);
      daemonCloseHandler(err);
    },
  };

  const clientT: Transport = {
    sendControl(msg: ControlMessage) {
      if (closed) return;
      clientToServer.push(msg); // record client→daemon messages
      daemonControlHandler(msg);
    },
    onControl(handler: ControlHandler) { clientControlHandler = handler; },
    sendData(_pid: PaneId, _b: Uint8Array) { /* no data plane in this test */ },
    onData() { /* unused */ },
    onClose(handler: CloseHandler) { clientCloseHandler = handler; },
    close(err?: Error) {
      if (closed) return;
      closed = true;
      daemonCloseHandler(err);
      clientCloseHandler(err);
    },
  };

  return {
    daemonT,
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
  // Timeline (seq numbers):
  //   seq=1: initial snapshot (model1, 1 pane)
  //   seq=2: pane.opened P2 (model1→model2) — DROPPED
  //   seq=3: pane.closed P2 (model2→model1) — arrives → gap(2!=3) detected
  //          → resync.request sent synchronously
  //          → daemon sends snapshot(seq=4, model1) → mirror recovers (1 pane)
  //   result: mirror has 1 pane; connection still "ready"
  // --------------------------------------------------------------------------

  it("mirror sends resync.request after dropped delta; daemon re-snapshots; model recovers without reconnect", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { daemonT, clientT, setDropPredicate, clientToServer } = createFilteredPair();

    // Connect both sides concurrently (same pattern as serve.test.ts).
    const conn = new DaemonConnection(clientT);
    await Promise.all([
      server.addClient(daemonT),
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

    // Drop seq=2 (the pane.opened delta for P2).
    setDropPredicate((msg: ControlMessage) => msg.seq === 2);

    // seq=2: model1→model2 (pane.opened P2) — dropped; mirror invisible.
    pipeline.fireChange(model2, model1);
    assert.equal(gapCount, 0, "no gap yet — dropped delta is invisible to the mirror");

    // seq=3: model2→model1 (pane.closed P2) — arrives at mirror.
    // Mirror sees seq=3, expected=2 → gap detected.
    // Synchronously: resync.request sent → daemon sends snapshot(seq=4, model1).
    pipeline.fireChange(model1, model2);

    // Gap was detected.
    assert.equal(gapCount, 1, "exactly 1 gap should be detected");

    // resync.request was sent.
    const resyncMsgs = clientToServer.filter((m: ControlMessage) => m.type === "resync.request");
    assert.equal(resyncMsgs.length, 1, "mirror should send exactly 1 resync.request");

    // Resync snapshot (seq=4, model1) was received and applied.
    // Pipeline model at resync time is model1 (set by second fireChange).
    const modelAfter = mirror.getModel();
    assert.equal(modelAfter.panes.size, 1, "mirror should have 1 pane after resync snapshot (model1)");
    assert.ok(modelAfter.panes.has(P1), "mirror model should include P1 after recovery");

    // Connection should still be open — no full reconnect.
    assert.equal(conn.state, "ready", "connection must still be 'ready' (no full reconnect)");

    daemonT.close();
  });

  // --------------------------------------------------------------------------
  // 2. Dedup: only one resync.request in flight at a time
  //
  // Timeline:
  //   seq=1: initial snapshot (model1)
  //   seq=2: pane.opened P2 — DROPPED
  //   seq=3: pane.closed P2 — arrives → gap(2!=3) → resync.request sent
  //          → daemon sends snapshot(seq=4) — also DROPPED (resync in flight)
  //   seq=5: pane.opened P2 — arrives → another gap (expected=2, got=5)
  //          → #resyncRequested is still true → DEDUP → no second resync.request
  //   result: only 1 resync.request sent despite 2+ gaps
  // --------------------------------------------------------------------------

  it("dedup: only one resync.request sent even when multiple gaps arrive while one is in flight", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { daemonT, clientT, setDropPredicate, clientToServer } = createFilteredPair();

    const conn = new DaemonConnection(clientT);
    await Promise.all([
      server.addClient(daemonT),
      conn.connect(),
    ]);

    const mirror = new Mirror();
    mirror.connectTo(conn);
    assert.equal(mirror.getModel().panes.size, 1, "baseline: 1 pane");

    let gapCount = 0;
    mirror.onResyncNeeded(() => { gapCount++; });

    // Drop seq=2 (first delta) AND seq=4 (resync snapshot response).
    // seq=3 and seq=5 are allowed through.
    setDropPredicate((msg: ControlMessage) => msg.seq === 2 || msg.seq === 4);

    // seq=2 (pane.opened P2) — dropped.
    pipeline.fireChange(model2, model1);
    assert.equal(gapCount, 0, "no gap yet after first dropped delta");

    // seq=3 (pane.closed P2) — arrives → gap(2!=3) detected → resync.request sent.
    // daemon sends snapshot(seq=4) → dropped → #resyncRequested still true.
    pipeline.fireChange(model1, model2);
    assert.equal(gapCount, 1, "first gap detected");

    // seq=5 (pane.opened P2) — arrives → gap(2!=5, lastSeq still 1) detected.
    // #resyncRequested is still true → dedup → no second resync.request.
    pipeline.fireChange(model2, model1);
    assert.ok(gapCount >= 2, `expected ≥2 gap signals, got ${gapCount}`);

    // Only ONE resync.request should have been sent.
    const resyncMsgs = clientToServer.filter((m: ControlMessage) => m.type === "resync.request");
    assert.equal(resyncMsgs.length, 1, "dedup: only 1 resync.request should be sent");

    daemonT.close();
  });

  // --------------------------------------------------------------------------
  // 3. Persistent gap escalation
  //
  // Timeline — two resync cycles:
  //   Cycle 1 (succeeds):
  //     seq=2: DROPPED  seq=3: arrives → gap → resync.request → snapshot(seq=4) OK
  //     → #resyncDelivered = true
  //   Cycle 2 (persistent gap):
  //     seq=5: DROPPED  seq=6: arrives → #resyncDelivered=true + new gap
  //     → mirror calls closeFn() → conn.close() → state = "closed"
  // --------------------------------------------------------------------------

  it("persistent gap: transport.close() is called after gap persists post-resync", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { daemonT, clientT, setDropPredicate } = createFilteredPair();

    const conn = new DaemonConnection(clientT);
    await Promise.all([
      server.addClient(daemonT),
      conn.connect(),
    ]);

    const mirror = new Mirror();
    mirror.connectTo(conn);
    assert.equal(mirror.getModel().panes.size, 1, "baseline: 1 pane");

    // --- Cycle 1: first gap → resync succeeds ---
    // Drop seq=2; allow seq=3 (trigger) and seq=4 (resync snapshot).
    setDropPredicate((msg: ControlMessage) => msg.seq === 2);

    // seq=2 (pane.opened P2) — dropped.
    pipeline.fireChange(model2, model1);

    // seq=3 (pane.closed P2) — arrives → gap → resync.request → snapshot(seq=4) OK.
    // After snapshot: #resyncRequested=false, #resyncDelivered=true.
    pipeline.fireChange(model1, model2);

    assert.equal(mirror.getModel().panes.size, 1, "model should have 1 pane after first resync (model1)");
    assert.equal(conn.state, "ready", "connection should still be ready after first resync");

    // --- Cycle 2: second gap → persistent → escalate ---
    // Drop seq=5; allow seq=6 (trigger).
    setDropPredicate((msg: ControlMessage) => msg.seq === 5);

    // seq=5 (pane.opened P2) — dropped.
    pipeline.fireChange(model2, model1);

    // seq=6 (pane.closed P2) — arrives → #resyncDelivered=true → persistent gap.
    // Mirror calls closeFn() → conn.close() → state = "closed".
    pipeline.fireChange(model1, model2);

    assert.equal(conn.state, "closed", "connection should be closed after persistent gap escalation");
  });

  // --------------------------------------------------------------------------
  // 4. Seq continuity: daemon does NOT reset seq on resync
  //
  // Timeline:
  //   seq=1: initial snapshot
  //   seq=2: DROPPED  seq=3: trigger → gap → resync.request → snapshot(seq=4)
  //   seq=5: post-resync delta (pane.opened P2)
  //   assert: resync snapshot seq > 1; seq=5 = resyncSeq + 1
  // --------------------------------------------------------------------------

  it("seq continuity: resync snapshot has seq > 1; subsequent deltas continue monotonically", async () => {
    const model1 = makeModel1();
    const model2 = makeModel2();
    const pipeline = createFakePipeline(model1);
    const server = createControlServer(pipeline);
    const { daemonT, clientT, setDropPredicate } = createFilteredPair();

    // Spy on ALL control messages delivered to the client transport handler.
    const allReceived: ControlMessage[] = [];
    const origOnControl = clientT.onControl.bind(clientT);
    (clientT as any).onControl = (handler: ControlHandler) => {
      origOnControl((msg: ControlMessage) => {
        allReceived.push(msg);
        handler(msg);
      });
    };

    const conn = new DaemonConnection(clientT);
    await Promise.all([
      server.addClient(daemonT),
      conn.connect(),
    ]);

    const mirror = new Mirror();
    mirror.connectTo(conn);

    assert.equal(mirror.initialized, true, "mirror should be initialized");

    // Drop seq=2; allow seq=3 (trigger) and seq=4 (resync snapshot).
    setDropPredicate((msg: ControlMessage) => msg.seq === 2);

    // seq=2 dropped.
    pipeline.fireChange(model2, model1);

    // seq=3 → gap → resync.request → snapshot(seq=4).
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
      (m: ControlMessage) => m.seq > resyncSeq && m.type !== "daemon.capabilities",
    );
    assert.ok(postResyncDeltas.length >= 1, "should have at least one delta after resync snapshot");
    assert.equal(
      postResyncDeltas[0]!.seq,
      resyncSeq + 1,
      `first post-resync delta should have seq = resync snapshot seq + 1 (${resyncSeq + 1})`,
    );

    daemonT.close();
  });

});
