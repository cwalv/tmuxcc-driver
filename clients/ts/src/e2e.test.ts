/**
 * End-to-end client tests — scripted mock session-proxy over createInMemoryTransportPair.
 *
 * These tests drive a scripted mock sessionProxy (session-proxy-side of the in-memory
 * transport) against the full headless client stack (createClient) and assert
 * that the EchoRenderHook records the right callbacks and that the Mirror
 * reflects the correct model state.
 *
 * Scenarios covered:
 *   1. Handshake + snapshot — client connects, mirror reflects snapshot,
 *      render hook fires onWindowAdded / onPaneOpened / onFocusChanged /
 *      onConnected.
 *   2. Deltas — session-proxy sends pane.resized, window.renamed, focus.changed,
 *      pane.closed; mirror updates and hook fires in order.
 *   3. %output byte streams — session-proxy sends data-plane frames for two panes
 *      including a NON-UTF-8 payload; hook.onPaneOutput receives byte-exact
 *      Uint8Array per pane in order.
 *   4. Resync / seq gap — session-proxy sends a delta with a skipped seq; mirror
 *      detects the gap and fires onResyncNeeded; then the session-proxy re-sends a
 *      fresh snapshot and the mirror recovers.
 *   5. Input/resize round-trip — controller.sendInput / resizePane; session-proxy end
 *      receives the correct wire InputMessage / ResizeRequestMessage.
 *
 * # Timing note
 *
 * The in-memory transport delivers synchronously, but the handshake defers
 * the session-proxy's first message by one microtask (Promise.resolve().then(...))
 * so both sides have a chance to register handlers. As a result, the snapshot
 * is sent AFTER await client.connect() returns: both handshake promises resolve
 * inside the same microtask, and only after both awaits settle do we send the
 * snapshot.
 *
 * Because of this ordering, createClient's driver.start() fires onConnected
 * against an EMPTY model first (the snapshot hasn't arrived yet). The snapshot
 * then arrives via sessionProxyTransport.sendControl() and triggers the mirror's
 * onModelChange, which drives the driver's diff loop (onWindowAdded,
 * onPaneOpened, onFocusChanged). Tests assert on the combined call log.
 *
 * # onLayoutChanged — tc-7ml.3
 *
 * WindowInfo now carries a `layout` field (tc-7ml.3 fix).  The render-hook
 * driver fires onLayoutChanged:
 *   - During initial snapshot replay: once per window after onWindowAdded.
 *   - During model diffs: when a window's layout reference changes (i.e. after
 *     a layout.updated delta propagates through the mirror).
 * Scenario 6 exercises this end-to-end: snapshot with a known split layout,
 * then a layout.updated delta; asserts onLayoutChanged fires with geometry.
 *
 * Reuses E1's round-trip harness: createInMemoryTransportPair +
 * runSessionProxyHandshake from @tmuxcc/session-proxy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createInMemoryTransportPair,
  runSessionProxyHandshake,
  paneId,
  windowId,
  sessionId,
  WIRE_PROTOCOL_VERSION,
  // State model helpers for building realistic wire traffic
  emptyModel,
  addSession,
  addWindow,
  addPane,
  setFocus,
  // Projection helpers
  projectSnapshot,
  diffModel,
} from "@tmuxcc/session-proxy";

import type {
  PaneId,
  WindowId,
  SessionId,
  SnapshotMessage,
  SessionProxyMessage,
  WindowLayout,
  Capabilities,
} from "@tmuxcc/session-proxy";

import { EchoRenderHook } from "./render-hook.js";
import { Mirror } from "./mirror.js";
import type { SeqGapInfo } from "./mirror.js";
import { connectClient } from "./client.js";
import type { ClientHandle } from "./client.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const P0: PaneId = paneId("p0");
const P1: PaneId = paneId("p1");
const W0: WindowId = windowId("w0");
const S0: SessionId = sessionId("s0");

const SESSION_PROXY_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
};

const SAMPLE_LAYOUT: WindowLayout = {
  cols: 200,
  rows: 50,
  root: {
    kind: "hsplit",
    rect: { x: 0, y: 0, cols: 200, rows: 50 },
    children: [
      { kind: "pane", paneId: P0, rect: { x: 0, y: 0, cols: 100, rows: 50 } },
      { kind: "pane", paneId: P1, rect: { x: 100, y: 0, cols: 100, rows: 50 } },
    ],
  },
};

/**
 * Build a minimal SessionModel with one session, one window (layout set),
 * two panes, and focus on P0.
 */
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
    layout: SAMPLE_LAYOUT,
    synchronizePanes: false, monitorActivity: true, monitorSilence: 0,
  });
  m = addPane(m, {
    paneId: P0,
    windowId: W0,
    sessionId: S0,
    cols: 100,
    rows: 50,
    mode: "normal",
    dead: false,
    exitCode: undefined,
    scrollbackHandle: undefined,
  });
  m = addPane(m, {
    paneId: P1,
    windowId: W0,
    sessionId: S0,
    cols: 100,
    rows: 50,
    mode: "normal",
    dead: false,
    exitCode: undefined,
    scrollbackHandle: undefined,
  });
  m = setFocus(m, { paneId: P0, windowId: W0, sessionId: S0 });
  return m;
}

/**
 * Stamp real seq values onto diffModel deltas (diffModel returns seq=0
 * placeholders; the session-proxy runtime normally does this).
 */
function stampSeqs(deltas: SessionProxyMessage[], startSeq: number): SessionProxyMessage[] {
  let seq = startSeq;
  return deltas.map((d) => ({ ...d, seq: seq++ }));
}

/**
 * Run the handshake on both sides, connect the client, attach the hook,
 * then send the snapshot.
 *
 * We send the snapshot AFTER both sides have completed their handshake and
 * connectClient() has returned, then attach the hook.  This means attach()
 * fires onConnected with the empty model first, and the snapshot arrives as
 * a model-change event (same ordering as the old driver.start() flow).
 */
async function connectAndSnapshot(
  sessionProxyTransport: import("@tmuxcc/session-proxy").Transport,
  clientTransport: import("@tmuxcc/session-proxy").Transport,
  hook: EchoRenderHook,
  snapshot: SnapshotMessage,
): Promise<{ handle: ClientHandle; session: import("@tmuxcc/session-proxy").NegotiatedSession }> {
  // Start handshake on both sides concurrently (session-proxy doesn't need to await).
  const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, SESSION_PROXY_CAPS);

  // Await the client — this completes both sides of the handshake.
  const handle = await connectClient(clientTransport);

  // Ensure session-proxy promise has resolved (it must have by now; just drain).
  await sessionProxyHandshake;

  // Attach the hook before sending the snapshot, so the ordering matches
  // the old driver.start() behavior: onConnected fires with empty model,
  // then snapshot arrives as a model-change event.
  handle.mirror.attach(hook);

  // Send the snapshot NOW — client post-handshake routing is installed.
  sessionProxyTransport.sendControl(snapshot);

  return { handle, session: handle.session };
}

// ---------------------------------------------------------------------------
// Scenario 1 — Handshake + Snapshot
// ---------------------------------------------------------------------------

describe("e2e — scenario 1: handshake + snapshot", () => {
  it("client connects, mirror reflects snapshot, render hook fires windowAdded/paneOpened/focusChanged/connected", async () => {
    const { sessionProxy: sessionProxyTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const echo = new EchoRenderHook();

    // Build a model and project a snapshot.
    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, { seq: 2 });

    const { handle, session: clientSession } = await connectAndSnapshot(sessionProxyTransport, clientTransport, echo, snapshot);

    // Verify negotiated session.
    assert.equal(clientSession.protocolVersion, WIRE_PROTOCOL_VERSION);
    assert.ok(clientSession.features.includes("pane-lifecycle"));

    // ── Render hook call sequence ─────────────────────────────────────────────
    // The driver fires onConnected early (with the initial empty model), then
    // the snapshot triggers model-change events: onWindowAdded, onPaneOpened,
    // onFocusChanged.
    // The initial empty model also fires onFocusChanged(null) + onConnected.
    // So the full sequence is at least:
    //   focusChanged({null,null,null})  — from empty initial model
    //   connected                       — from driver.start()
    //   windowAdded(W0)                 — from snapshot model diff
    //   paneOpened(P0)                  — from snapshot model diff
    //   paneOpened(P1)                  — from snapshot model diff
    //   focusChanged({P0,W0,S0})        — from snapshot model diff

    const types = echo.calls.map((c) => c.type);
    assert.ok(types.includes("windowAdded"), "expected windowAdded");
    assert.ok(types.includes("paneOpened"), "expected paneOpened");
    assert.ok(types.includes("focusChanged"), "expected focusChanged");
    assert.ok(types.includes("connected"), "expected connected");

    // Verify windowAdded call has correct data.
    const windowAddedCall = echo.calls.find((c) => c.type === "windowAdded");
    assert.ok(windowAddedCall?.type === "windowAdded");
    assert.equal(windowAddedCall.window.windowId, W0);
    assert.equal(windowAddedCall.window.name, "editor");

    // Verify both panes were opened.
    const paneOpenedCalls = echo.calls.filter((c) => c.type === "paneOpened");
    assert.equal(paneOpenedCalls.length, 2, "expected 2 paneOpened calls");
    const openedPaneIds = paneOpenedCalls.map((c) => {
      assert.ok(c.type === "paneOpened");
      return c.pane.paneId;
    });
    assert.ok(openedPaneIds.includes(P0), "P0 should be opened");
    assert.ok(openedPaneIds.includes(P1), "P1 should be opened");

    // Verify pane dims from snapshot.
    const p0Opened = paneOpenedCalls.find((c) => {
      assert.ok(c.type === "paneOpened");
      return c.pane.paneId === P0;
    });
    assert.ok(p0Opened?.type === "paneOpened");
    assert.equal(p0Opened.pane.cols, 100);
    assert.equal(p0Opened.pane.rows, 50);

    // Verify focusChanged with the correct focus triple (from snapshot).
    const focusCalls = echo.calls.filter((c) => c.type === "focusChanged");
    const snapshotFocusCall = focusCalls.find((c) => {
      assert.ok(c.type === "focusChanged");
      return c.focus.paneId === P0;
    });
    assert.ok(snapshotFocusCall?.type === "focusChanged", "focusChanged for P0 must fire");
    assert.equal(snapshotFocusCall.focus.paneId, P0);
    assert.equal(snapshotFocusCall.focus.windowId, W0);

    // windowAdded must appear before paneOpened (within the diff batch).
    const windowAddedIdx = types.indexOf("windowAdded");
    const firstPaneOpenedIdx = types.indexOf("paneOpened");
    assert.ok(windowAddedIdx < firstPaneOpenedIdx, "windowAdded must come before paneOpened");

    handle.disconnect();
    sessionProxyTransport.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Deltas
// ---------------------------------------------------------------------------

describe("e2e — scenario 2: deltas", () => {
  it("session-proxy sends a sequence of deltas; hook fires in order with correct args", async () => {
    const { sessionProxy: sessionProxyTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const echo = new EchoRenderHook();

    // Base model + snapshot.
    const baseModel = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(baseModel, { seq: 2 });

    const { handle } = await connectAndSnapshot(sessionProxyTransport, clientTransport, echo, snapshot);
    echo.clear(); // clear initial snapshot calls; focus only on delta calls

    // Build updated model:
    //   - P1 resized to 120×40
    //   - W0 renamed to "terminal"
    //   - Focus changed to P1
    //   - P0 closed
    let updatedModel = baseModel;
    // Resize P1.
    const panes1 = new Map(updatedModel.panes);
    panes1.set(P1, { ...updatedModel.panes.get(P1)!, cols: 120, rows: 40 });
    updatedModel = { ...updatedModel, panes: panes1 };
    // Rename W0.
    const windows1 = new Map(updatedModel.windows);
    windows1.set(W0, { ...updatedModel.windows.get(W0)!, name: "terminal" });
    updatedModel = { ...updatedModel, windows: windows1 };
    // Change focus to P1.
    updatedModel = setFocus(updatedModel, { paneId: P1, windowId: W0, sessionId: S0 });
    // Remove P0.
    const panes2 = new Map(updatedModel.panes);
    panes2.delete(P0);
    const w = updatedModel.windows.get(W0)!;
    const windows2 = new Map(updatedModel.windows);
    windows2.set(W0, {
      ...w,
      paneIds: w.paneIds.filter((id) => id !== P0),
      activePaneId: P1,
    });
    updatedModel = { ...updatedModel, panes: panes2, windows: windows2 };

    // Compute deltas from base → updated, stamp seqs starting at 3.
    const rawDeltas = diffModel(baseModel, updatedModel);
    const deltas = stampSeqs(rawDeltas, 3);

    // Send all deltas synchronously.
    for (const delta of deltas) {
      sessionProxyTransport.sendControl(delta);
    }

    // pane.resized → onPaneResized for P1
    const resizeCall = echo.calls.find(
      (c): c is Extract<typeof c, { type: "paneResized" }> =>
        c.type === "paneResized" && c.paneId === P1,
    );
    assert.ok(resizeCall !== undefined, "expected paneResized for P1");
    assert.equal(resizeCall.cols, 120);
    assert.equal(resizeCall.rows, 40);

    // window.renamed → onWindowRenamed for W0
    const renameCall = echo.calls.find(
      (c): c is Extract<typeof c, { type: "windowRenamed" }> => c.type === "windowRenamed",
    );
    assert.ok(renameCall !== undefined, "expected windowRenamed");
    assert.equal(renameCall.windowId, W0);
    assert.equal(renameCall.newName, "terminal");

    // focus.changed → onFocusChanged to P1
    const focusCalls = echo.calls.filter(
      (c): c is Extract<typeof c, { type: "focusChanged" }> => c.type === "focusChanged",
    );
    const p1FocusCall = focusCalls.find((c) => c.focus.paneId === P1);
    assert.ok(p1FocusCall !== undefined, "expected focusChanged to P1");

    // pane.closed → onPaneClosed for P0
    const closedCall = echo.calls.find(
      (c): c is Extract<typeof c, { type: "paneClosed" }> =>
        c.type === "paneClosed" && c.paneId === P0,
    );
    assert.ok(closedCall !== undefined, "expected paneClosed for P0");

    // Order: paneResized must come before paneClosed (diff ordering rule).
    const resizeIdx = echo.calls.indexOf(resizeCall);
    const closeIdx = echo.calls.indexOf(closedCall);
    assert.ok(resizeIdx < closeIdx, "paneResized must come before paneClosed");

    handle.disconnect();
    sessionProxyTransport.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — %output byte streams (data plane)
// ---------------------------------------------------------------------------

describe("e2e — scenario 3: %output byte streams", () => {
  it("session-proxy sends data-plane frames (incl. non-UTF-8); hook receives byte-exact Uint8Array per pane in order", async () => {
    const { sessionProxy: sessionProxyTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const echo = new EchoRenderHook();

    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, { seq: 2 });

    const { handle } = await connectAndSnapshot(sessionProxyTransport, clientTransport, echo, snapshot);

    // Payloads — including non-UTF-8 bytes.
    const p0Chunk1 = new TextEncoder().encode("hello ");
    const p0Chunk2 = new TextEncoder().encode("world\r\n");
    const p1ChunkNonUtf8 = Uint8Array.from([0xff, 0x00, 0xfe, 0x80, 0x42]);

    // Send data frames after snapshot (panes are now open).
    sessionProxyTransport.sendData(P0, p0Chunk1);
    sessionProxyTransport.sendData(P0, p0Chunk2);
    sessionProxyTransport.sendData(P1, p1ChunkNonUtf8);

    // Collect all paneOutput calls (type-safe via explicit narrowing).
    const allOutputCalls = echo.calls.filter(
      (c): c is Extract<typeof c, { type: "paneOutput" }> => c.type === "paneOutput",
    );

    // P0 should have received both chunks in order.
    const p0Outputs = allOutputCalls.filter((c) => c.paneId === P0);
    assert.equal(p0Outputs.length, 2, "P0 should have 2 output chunks");
    const p0a = p0Outputs[0];
    const p0b = p0Outputs[1];
    assert.ok(p0a !== undefined, "P0 chunk 1 exists");
    assert.ok(p0b !== undefined, "P0 chunk 2 exists");
    assert.deepEqual(p0a.bytes, p0Chunk1, "P0 chunk 1 must be byte-exact");
    assert.deepEqual(p0b.bytes, p0Chunk2, "P0 chunk 2 must be byte-exact");

    // P1 should have received the non-UTF-8 chunk.
    const p1Outputs = allOutputCalls.filter((c) => c.paneId === P1);
    assert.equal(p1Outputs.length, 1, "P1 should have 1 output chunk");
    const p1a = p1Outputs[0];
    assert.ok(p1a !== undefined, "P1 chunk exists");
    assert.deepEqual(p1a.bytes, p1ChunkNonUtf8, "P1 non-UTF-8 bytes must be byte-exact");

    // Verify non-UTF-8 byte values are preserved.
    assert.equal(p1a.bytes[0], 0xff);
    assert.equal(p1a.bytes[1], 0x00);
    assert.equal(p1a.bytes[2], 0xfe);
    assert.equal(p1a.bytes[3], 0x80);
    assert.equal(p1a.bytes[4], 0x42);

    // P0 outputs must appear before P1 output (ordering by arrival).
    const p0LastIdx = allOutputCalls.lastIndexOf(p0b);
    const p1FirstIdx = allOutputCalls.indexOf(p1a);
    assert.ok(p0LastIdx < p1FirstIdx, "P0 outputs must arrive before P1");

    handle.disconnect();
    sessionProxyTransport.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Resync / seq gap
// ---------------------------------------------------------------------------

describe("e2e — scenario 4: resync — seq gap detection and recovery", () => {
  it("mirror detects seq gap and fires resync; model is not updated; after re-snapshot mirror recovers", async () => {
    const { sessionProxy: sessionProxyTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const echo = new EchoRenderHook();

    // Drive a standalone Mirror to observe resync signals directly.
    const directMirror = new Mirror();
    const resyncGaps: SeqGapInfo[] = [];
    directMirror.onResyncNeeded((gap) => {
      resyncGaps.push(gap);
    });

    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, { seq: 2 });

    const { handle } = await connectAndSnapshot(sessionProxyTransport, clientTransport, echo, snapshot);

    // Build a delta with a GAP: snapshot seq=2, next expected=3, but we send seq=5.
    const gapDelta: SessionProxyMessage = {
      type: "pane.resized",
      seq: 5, // GAP: expected 3
      paneId: P0,
      cols: 200,
      rows: 60,
    };

    // After the gap, session-proxy re-sends a fresh snapshot (resync recovery).
    const model2 = (() => {
      const panes = new Map(model.panes);
      panes.set(P0, { ...model.panes.get(P0)!, cols: 200, rows: 60 });
      return { ...model, panes };
    })();
    const snapshot2: SnapshotMessage = projectSnapshot(model2, { seq: 6 });

    // ── Verify gap detection via directMirror ────────────────────────────────

    directMirror.receiveSnapshot(snapshot);
    directMirror.receiveDelta(gapDelta); // triggers resync
    assert.equal(resyncGaps.length, 1, "mirror must detect the seq gap");
    const resyncGap = resyncGaps[0]!;
    assert.equal(resyncGap.expected, 3, "expected seq 3");
    assert.equal(resyncGap.received, 5, "received seq 5 (gap)");

    // Gap delta must NOT have been applied.
    const modelAfterGap = directMirror.getModel();
    const p0AfterGap = modelAfterGap.panes.get(P0);
    assert.ok(p0AfterGap !== undefined);
    assert.equal(p0AfterGap.cols, 100, "P0 cols must not change after gap delta");
    assert.equal(p0AfterGap.rows, 50, "P0 rows must not change after gap delta");

    // Recovery: re-snapshot resets seq tracking.
    directMirror.receiveSnapshot(snapshot2);
    const modelAfterResync = directMirror.getModel();
    const p0AfterResync = modelAfterResync.panes.get(P0);
    assert.ok(p0AfterResync !== undefined);
    assert.equal(p0AfterResync.cols, 200, "P0 cols should be 200 after resync");
    assert.equal(p0AfterResync.rows, 60, "P0 rows should be 60 after resync");

    // ── Client-side: send gap delta + re-snapshot, verify client recovers ────

    sessionProxyTransport.sendControl(gapDelta);   // gap detected by client's mirror
    sessionProxyTransport.sendControl(snapshot2);  // re-snapshot → client recovers

    // Client's render hook should have received at least the initial events.
    const types = echo.calls.map((c) => c.type);
    assert.ok(types.includes("connected"), "connected must have fired");
    assert.ok(types.includes("windowAdded"), "windowAdded must have fired");

    // After the re-snapshot, P0 should appear as resized in the hook
    // (the driver diffs the model and fires paneResized for P0).
    const resizedCalls = echo.calls.filter(
      (c): c is Extract<typeof c, { type: "paneResized" }> =>
        c.type === "paneResized" && c.paneId === P0,
    );
    assert.ok(resizedCalls.length > 0, "paneResized for P0 should fire after resync");
    const lastResize = resizedCalls[resizedCalls.length - 1]!;
    assert.equal(lastResize.cols, 200);
    assert.equal(lastResize.rows, 60);

    handle.disconnect();
    sessionProxyTransport.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Input / resize round-trip
// ---------------------------------------------------------------------------

describe("e2e — scenario 5: input/resize round-trip", () => {
  it("controller.sendInput sends InputMessage to sessionProxy; controller.resizePane sends ResizeRequestMessage", async () => {
    const { sessionProxy: sessionProxyTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const echo = new EchoRenderHook();

    const model = buildBaseModel();
    const snapshot: SnapshotMessage = projectSnapshot(model, { seq: 2 });

    // Capture messages received by the session-proxy side after the handshake.
    const sessionProxyReceived: unknown[] = [];

    // Start handshake concurrently.
    const sessionProxyHandshake = runSessionProxyHandshake(sessionProxyTransport, SESSION_PROXY_CAPS);

    // Connect the client (coalesceResizes: false so resize is sent immediately).
    const handle = await connectClient(clientTransport, { input: { coalesceResizes: false } });

    // After connectClient(), session-proxy side must also have resolved.
    await sessionProxyHandshake;

    // Attach hook before sending snapshot.
    handle.mirror.attach(echo);

    // Install session-proxy-side handler NOW (handshake no-op has settled).
    sessionProxyTransport.onControl((msg) => {
      sessionProxyReceived.push(msg);
    });

    // Send the snapshot.
    sessionProxyTransport.sendControl(snapshot);

    // Send input via controller.
    handle.controller.sendInput(P0, "ls -la\r");

    // Send resize via controller (coalescing disabled → immediate send).
    handle.controller.resizePane(P0, 220, 50);

    // The in-memory transport delivers synchronously.

    // Find the InputMessage.
    const inputMsg = sessionProxyReceived.find(
      (m): m is { type: "input"; paneId: PaneId; data: string; seq: number } =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "input",
    );
    assert.ok(inputMsg !== undefined, "session-proxy must have received an input message");
    assert.equal(inputMsg.type, "input");
    assert.equal(inputMsg.paneId, P0);
    assert.equal(inputMsg.data, "ls -la\r");

    // Find the ResizeRequestMessage.
    const resizeMsg = sessionProxyReceived.find(
      (
        m,
      ): m is { type: "resize.request"; paneId: PaneId; cols: number; rows: number; seq: number } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "resize.request",
    );
    assert.ok(resizeMsg !== undefined, "session-proxy must have received a resize.request message");
    assert.equal(resizeMsg.type, "resize.request");
    assert.equal(resizeMsg.paneId, P0);
    assert.equal(resizeMsg.cols, 220);
    assert.equal(resizeMsg.rows, 50);

    // Seq numbers must be positive and input must come before resize.
    assert.ok(inputMsg.seq > 0, "input seq must be positive");
    assert.ok(resizeMsg.seq > 0, "resize seq must be positive");
    assert.ok(inputMsg.seq < resizeMsg.seq, "input must be sent before resize");

    handle.disconnect();
    sessionProxyTransport.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — onLayoutChanged delivers geometry (tc-7ml.3)
// ---------------------------------------------------------------------------

describe("e2e — scenario 6: onLayoutChanged delivers split-tree geometry", () => {
  it("snapshot with a split layout fires onLayoutChanged with non-empty geometry; layout.updated delta fires it again", async () => {
    const { sessionProxy: sessionProxyTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const echo = new EchoRenderHook();

    // Build a model with a known split layout on W0.
    const model = buildBaseModel(); // W0 carries SAMPLE_LAYOUT (hsplit, 2 panes)
    const snapshot: SnapshotMessage = projectSnapshot(model, { seq: 2 });

    const { handle } = await connectAndSnapshot(sessionProxyTransport, clientTransport, echo, snapshot);

    // ── Part 1: snapshot replay fires onLayoutChanged with the split layout ──
    const layoutCalls = echo.calls.filter(
      (c): c is Extract<typeof c, { type: "layoutChanged" }> => c.type === "layoutChanged",
    );
    assert.ok(layoutCalls.length > 0, "onLayoutChanged must fire at least once from snapshot");

    // Find the call for W0.
    const w0LayoutCall = layoutCalls.find((c) => c.windowId === W0);
    assert.ok(w0LayoutCall !== undefined, "onLayoutChanged must fire for W0");

    // Layout must carry the split geometry from SAMPLE_LAYOUT.
    const deliveredLayout = w0LayoutCall.layout;
    assert.equal(deliveredLayout.cols, SAMPLE_LAYOUT.cols, "layout.cols must match SAMPLE_LAYOUT");
    assert.equal(deliveredLayout.rows, SAMPLE_LAYOUT.rows, "layout.rows must match SAMPLE_LAYOUT");
    assert.equal(deliveredLayout.root.kind, "hsplit", "root must be hsplit (non-trivial split)");
    if (deliveredLayout.root.kind === "hsplit") {
      assert.equal(deliveredLayout.root.children.length, 2, "hsplit must have 2 children");
      const left = deliveredLayout.root.children[0];
      const right = deliveredLayout.root.children[1];
      assert.ok(left !== undefined && left.kind === "pane", "left child is a pane");
      assert.ok(right !== undefined && right.kind === "pane", "right child is a pane");
      if (left.kind === "pane") assert.equal(left.paneId, P0, "left pane is P0");
      if (right.kind === "pane") assert.equal(right.paneId, P1, "right pane is P1");
    }

    // ── Part 2: layout.updated delta fires onLayoutChanged again ────────────
    const updatedLayout: WindowLayout = {
      cols: 200,
      rows: 50,
      root: {
        kind: "vsplit",
        rect: { x: 0, y: 0, cols: 200, rows: 50 },
        children: [
          { kind: "pane", paneId: P0, rect: { x: 0, y: 0, cols: 200, rows: 25 } },
          { kind: "pane", paneId: P1, rect: { x: 0, y: 25, cols: 200, rows: 25 } },
        ],
      },
    };

    const layoutUpdatedDelta: SessionProxyMessage = {
      type: "layout.updated",
      seq: 3,
      windowId: W0,
      layout: updatedLayout,
    };

    echo.clear(); // reset — focus only on the delta-driven call
    sessionProxyTransport.sendControl(layoutUpdatedDelta);

    const deltaLayoutCalls = echo.calls.filter(
      (c): c is Extract<typeof c, { type: "layoutChanged" }> => c.type === "layoutChanged",
    );
    assert.equal(deltaLayoutCalls.length, 1, "exactly one onLayoutChanged after layout.updated");
    const deltaCall = deltaLayoutCalls[0];
    assert.ok(deltaCall !== undefined);
    assert.equal(deltaCall.windowId, W0);
    assert.equal(deltaCall.layout.root.kind, "vsplit", "updated root must be vsplit");
    if (deltaCall.layout.root.kind === "vsplit") {
      assert.equal(deltaCall.layout.root.children.length, 2);
    }

    handle.disconnect();
    sessionProxyTransport.close();
  });
});

// ---------------------------------------------------------------------------
// Bonus: mirror direct API assertions — seq tracking
// ---------------------------------------------------------------------------

describe("mirror seq tracking — complementary unit assertions", () => {
  it("mirror.getModel() reflects snapshot contents", () => {
    const mirror = new Mirror();

    const snapshot: SnapshotMessage = projectSnapshot(buildBaseModel(), { seq: 2 });
    mirror.receiveSnapshot(snapshot);

    const model = mirror.getModel();
    assert.ok(model.panes.has(P0), "P0 should be in the mirror");
    assert.ok(model.panes.has(P1), "P1 should be in the mirror");
    assert.ok(model.windows.has(W0), "W0 should be in the mirror");
    assert.equal(model.focus.paneId, P0);
    assert.equal(model.focus.windowId, W0);
  });

  it("mirror applies in-order deltas correctly", () => {
    const mirror = new Mirror();

    const snapshot: SnapshotMessage = projectSnapshot(buildBaseModel(), { seq: 2 });
    mirror.receiveSnapshot(snapshot);

    // Apply a pane.resized delta (seq=3).
    const resizeDelta: SessionProxyMessage = {
      type: "pane.resized",
      seq: 3,
      paneId: P0,
      cols: 200,
      rows: 60,
    };
    mirror.receiveDelta(resizeDelta);

    const pane = mirror.getModel().panes.get(P0)!;
    assert.equal(pane.cols, 200);
    assert.equal(pane.rows, 60);
  });

  it("mirror drops out-of-order delta and fires resync", () => {
    const mirror = new Mirror();

    const snapshot: SnapshotMessage = projectSnapshot(buildBaseModel(), { seq: 2 });
    mirror.receiveSnapshot(snapshot);

    const gaps: SeqGapInfo[] = [];
    mirror.onResyncNeeded((g) => {
      gaps.push(g);
    });

    // Gap: expected seq=3 but send seq=10.
    const outOfOrderDelta: SessionProxyMessage = {
      type: "pane.resized",
      seq: 10,
      paneId: P0,
      cols: 999,
      rows: 999,
    };
    mirror.receiveDelta(outOfOrderDelta);

    // Delta must not have been applied.
    const pane = mirror.getModel().panes.get(P0)!;
    assert.equal(pane.cols, 100, "cols should not change after gap");
    assert.equal(pane.rows, 50, "rows should not change after gap");
    assert.equal(gaps.length, 1, "resync must have fired");
    const gap = gaps[0]!;
    assert.equal(gap.expected, 3);
    assert.equal(gap.received, 10);
  });
});
