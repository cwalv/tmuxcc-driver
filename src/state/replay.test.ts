/**
 * End-to-end E3 replay test (tc-9ht / tc-xdw).
 *
 * Wires the full south→model→north pipeline on REAL captured data:
 *   tmux34-session.raw  →  ControlTokenizer  →  parseNotification
 *   →  reduce(model, event, ctx)  →  projectSnapshot / diffModel
 *   →  applyDeltas round-trip
 *
 * # What the capture contains (from golden.test.ts + direct inspection)
 *
 * File: src/parser/golden/tmux34-session.raw
 * Captured from: tmux 3.4 -C (single-C, no DCS wrapper) on 2026-05-29.
 *
 * Notifications present:
 *   %session-changed $0 s0
 *   %window-add @1
 *   %window-pane-changed @1 %2   (pane 2 is active in window 1)
 *   %session-window-changed $0 @1
 *   %layout-change @1 <layoutString>   (keyword "layout-change" → UnknownNotification)
 *   many %output %0 …, %output %1 …, %output %2 …
 *   one %output containing literal bytes 0xc0, 0xfe, 0xff
 *   %exit
 *
 * No DCS wrapper (single -C). Command blocks present but do not carry
 * notification events that the reducer needs to handle — the reducer works
 * purely on NotificationTokens.
 *
 * # Final model facts (golden — derived from notifications above)
 *   - 1 session: id="s0" (tmux $0), name="s0"
 *   - 1 window:  id="w1" (tmux @1), sessionId="s0"
 *   - ≥1 pane from layout-change reconciliation (pane leaf ids vary by capture)
 *   - focus.paneId is the active pane of window 1 (pane 2 per window-pane-changed)
 *   - checkInvariants() → no violations
 *
 * @module state/replay.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ControlTokenizer, tokenizeBuffer } from "../parser/tokenizer.js";
import { parseNotification } from "../parser/notifications.js";
import type { NotificationToken } from "../parser/tokenizer.js";

import { reduce, type ReducerContext } from "./reducer.js";
import { emptyModel, checkInvariants, paneId, windowId, sessionId } from "./model.js";
import type { SessionModel } from "./model.js";
import { createPaneBufferStore } from "./scrollback.js";
import { projectSnapshot, diffModel } from "./projection.js";
import type { SnapshotMessage, DaemonMessage } from "../wire/daemon-control.js";
import type { PaneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Fixture path
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, "../parser/golden/tmux34-session.raw");

function loadGolden(): Uint8Array {
  return new Uint8Array(readFileSync(GOLDEN_PATH));
}

// ---------------------------------------------------------------------------
// applyDeltas reference applier (copied from projection.test.ts pattern)
//
// Applies a sequence of wire delta messages to a SnapshotMessage.
// Used for the round-trip property: applyDeltas(snap(prev), diff(prev,next))
// must deep-equal snap(next).
// ---------------------------------------------------------------------------

function applyDeltas(snap: SnapshotMessage, deltas: DaemonMessage[]): SnapshotMessage {
  // v3 single-session wire: no sessions array, no sessionId on deltas.
  let session = snap.session;
  let windows = [...snap.windows];
  let panes = [...snap.panes];
  let focus = { ...snap.focus };

  for (const delta of deltas) {
    switch (delta.type) {
      // --- session lifecycle (only rename on daemon wire in v3) ---
      case "session.renamed":
        session = { sessionId: session.sessionId, name: delta.newName };
        break;

      case "window.added":
        windows = [
          ...windows.map((w) => (delta.active ? { ...w, active: false } : w)),
          {
            windowId: delta.windowId,
            name: delta.name,
            active: delta.active,
            layout: {
              cols: 0,
              rows: 0,
              root: {
                kind: "pane" as const,
                paneId: "" as PaneId,
                rect: { x: 0, y: 0, cols: 0, rows: 0 },
              },
            },
          },
        ];
        break;

      case "window.closed":
        windows = windows.filter((w) => w.windowId !== delta.windowId);
        break;

      case "window.renamed":
        windows = windows.map((w) =>
          w.windowId === delta.windowId ? { ...w, name: delta.newName } : w,
        );
        break;

      case "layout.updated":
        windows = windows.map((w) =>
          w.windowId === delta.windowId ? { ...w, layout: delta.layout } : w,
        );
        break;

      case "pane.opened":
        panes = [
          ...panes,
          {
            paneId: delta.paneId,
            windowId: delta.windowId,
            cols: delta.cols,
            rows: delta.rows,
          },
        ];
        break;

      case "pane.closed":
        panes = panes.filter((p) => p.paneId !== delta.paneId);
        break;

      case "pane.resized":
        panes = panes.map((p) =>
          p.paneId === delta.paneId ? { ...p, cols: delta.cols, rows: delta.rows } : p,
        );
        break;

      case "pane.mode-changed":
        // SnapshotPane has no mode field — ignore.
        break;

      case "focus.changed":
        focus = {
          paneId: delta.paneId,
          windowId: delta.windowId,
        };
        windows = windows.map((w) => ({
          ...w,
          active: w.windowId === delta.windowId,
        }));
        break;

      default:
        break;
    }
  }

  return { type: "snapshot", seq: snap.seq, session, windows, panes, focus };
}

/**
 * Normalize a SnapshotMessage for deep comparison: sort arrays by id.
 * Strips seq (seq is a connection-level counter, not part of observable state).
 */
function normalizeSnapshot(snap: SnapshotMessage) {
  // v3 single-session: session is a scalar, no sessionId on windows/panes.
  return {
    session: snap.session,
    windows: [...snap.windows]
      .sort((a, b) => String(a.windowId).localeCompare(String(b.windowId)))
      .map(({ windowId, name, active, layout }) => ({
        windowId,
        name,
        active,
        layout,
      })),
    panes: [...snap.panes]
      .sort((a, b) => String(a.paneId).localeCompare(String(b.paneId)))
      .map(({ paneId, windowId, cols, rows }) => ({
        paneId,
        windowId,
        cols,
        rows,
      })),
    focus: snap.focus,
  };
}

// ---------------------------------------------------------------------------
// Pipeline helper: tokenize + parse + reduce all notifications in one shot,
// collecting snapshots after every event for the delta-stream test.
// Returns { finalModel, snapshots, allDeltas, bufferStore }.
// ---------------------------------------------------------------------------

interface ReplayResult {
  finalModel: SessionModel;
  /** snapshots[i] = model state after event i, projected to a SnapshotMessage. */
  snapshots: SnapshotMessage[];
  /** All deltas emitted step-by-step across the full replay. */
  allDeltas: DaemonMessage[];
  bufferStore: ReturnType<typeof createPaneBufferStore>;
  /** Number of notification events processed. */
  eventCount: number;
}

function replayCapture(rawBuf: Uint8Array): ReplayResult {
  const tokens = tokenizeBuffer(rawBuf);
  const bufferStore = createPaneBufferStore();
  const ctx: ReducerContext = { buffers: bufferStore };

  let model = emptyModel();
  const snapshots: SnapshotMessage[] = [];
  const allDeltas: DaemonMessage[] = [];
  let eventCount = 0;

  for (const tok of tokens) {
    if (tok.kind !== "notification") continue;

    const event = parseNotification(tok as NotificationToken);
    const prev = model;
    model = reduce(model, event, ctx);
    eventCount++;

    // Collect deltas for this step.
    const deltas = diffModel(prev, model);
    allDeltas.push(...deltas);

    // Take a snapshot after each step.
    snapshots.push(projectSnapshot(model, { seq: eventCount }));
  }

  return { finalModel: model, snapshots, allDeltas, bufferStore, eventCount };
}

// ===========================================================================
// TEST SUITE 1 — Real captured tmux 3.4 stream
// ===========================================================================

describe("E3 e2e replay: tmux34-session.raw → reduce → model", () => {
  it("loads and tokenizes the golden capture without throwing", () => {
    const rawBuf = loadGolden();
    assert.ok(rawBuf.length > 0, "golden file must be non-empty");
    const tokens = tokenizeBuffer(rawBuf);
    const notifCount = tokens.filter((t) => t.kind === "notification").length;
    assert.ok(notifCount > 0, `expected notification tokens, got ${notifCount}`);
  });

  it("replays full capture: processes > 0 notification events", () => {
    const rawBuf = loadGolden();
    const result = replayCapture(rawBuf);
    assert.ok(
      result.eventCount > 0,
      `expected at least one notification event, got ${result.eventCount}`,
    );
  });

  it("MODEL: exactly 1 session in final model (session $0 → 's0')", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    assert.equal(finalModel.sessions.size, 1, "expected exactly 1 session");
    const sid = sessionId("s0");
    const sess = finalModel.sessions.get(sid);
    assert.ok(sess !== undefined, `session 's0' not found; sessions: ${[...finalModel.sessions.keys()].join(",")}`);
    assert.equal(sess!.name, "s0", "session name should be 's0'");
  });

  it("MODEL: exactly 1 window in final model (window @1 → 'w1')", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    assert.equal(finalModel.windows.size, 1, "expected exactly 1 window");
    const wid = windowId("w1");
    const win = finalModel.windows.get(wid);
    assert.ok(win !== undefined, `window 'w1' not found; windows: ${[...finalModel.windows.keys()].join(",")}`);
    // Window belongs to session s0
    assert.equal(win!.sessionId, sessionId("s0"));
  });

  it("MODEL: exactly 2 panes in final model (added by layout-change reconciliation: panes %1 and %2)", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    // The layout-change @1 line has 2 leaf panes: %1 (left) and %2 (right).
    // The reducer's conservative-add policy adds both as p1 and p2.
    assert.equal(finalModel.panes.size, 2, `expected exactly 2 panes, got ${finalModel.panes.size}`);

    // Both panes belong to window w1
    const wid = windowId("w1");
    assert.ok(finalModel.panes.has(paneId("p1")), "pane p1 should exist");
    assert.ok(finalModel.panes.has(paneId("p2")), "pane p2 should exist");
    for (const pane of finalModel.panes.values()) {
      assert.equal(pane.windowId, wid, `pane ${pane.paneId} should belong to w1`);
      assert.equal(pane.sessionId, sessionId("s0"), `pane ${pane.paneId} should belong to s0`);
    }
  });

  it("MODEL: pane dimensions match the layout (80x24 window split into 40x24 and 39x24)", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    // Layout: 5914,80x24,0,0{40x24,0,0,1,39x24,41,0,2}
    // Pane 1 (left): 40 cols × 24 rows; Pane 2 (right): 39 cols × 24 rows
    const p1 = finalModel.panes.get(paneId("p1"));
    const p2 = finalModel.panes.get(paneId("p2"));
    assert.ok(p1 !== undefined, "pane p1 must exist");
    assert.ok(p2 !== undefined, "pane p2 must exist");
    assert.equal(p1!.cols, 40, "pane p1 should be 40 cols wide");
    assert.equal(p1!.rows, 24, "pane p1 should be 24 rows tall");
    assert.equal(p2!.cols, 39, "pane p2 should be 39 cols wide");
    assert.equal(p2!.rows, 24, "pane p2 should be 24 rows tall");
  });

  it("MODEL: window 'w1' activePaneId is 'p1' (first pane added by layout-change; window-pane-changed @1 %2 arrived before panes existed)", () => {
    // NOTE: %window-pane-changed @1 %2 arrives at step 4, BEFORE %layout-change adds
    // panes at step 5. The reducer correctly skips the pane-change (pane not in window
    // yet). After layout-change adds panes, activePaneId = p1 (auto-set by addPane for
    // the first leaf). This is the expected behavior for out-of-order bootstrap events.
    // E4 bootstrap (tc-835) reconciles this via list-panes post-bootstrap.
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    const wid = windowId("w1");
    const win = finalModel.windows.get(wid);
    assert.ok(win !== undefined, "window w1 must exist");
    assert.equal(
      win!.activePaneId,
      paneId("p1"),
      `expected activePaneId='p1' (first pane added by layout-change), got '${win!.activePaneId}'`,
    );
  });

  it("MODEL: focus is null after pure notification replay (bootstrap gap: session-window-changed arrived before window existed)", () => {
    // The capture notification ordering is:
    //   1. session-changed $0 s0       → session added, no windows yet → focus null
    //   2. session-window-changed $0 @1 → window @1 doesn't exist yet → ignored
    //   3. window-add @1               → window added (no panes yet)
    //   4. window-pane-changed @1 %2   → pane %2 not in window yet → ignored
    //   5. layout-change @1            → panes p1, p2 added
    //
    // No event after step 5 triggers setFocus. Therefore focus stays null.
    // This is correct for pure notification replay without command bootstrap.
    // E4 (tc-835) will resolve this via list-sessions/list-windows post-boot.
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    const { focus } = finalModel;
    assert.equal(focus.paneId, null, "focus.paneId should be null (bootstrap gap)");
    assert.equal(focus.windowId, null, "focus.windowId should be null (bootstrap gap)");
    assert.equal(focus.sessionId, null, "focus.sessionId should be null (bootstrap gap)");
  });

  it("MODEL: session s0 has activeWindowId='w1' (set by window-add)", () => {
    // Even though session-window-changed was ignored (window didn't exist),
    // window-add set session.activeWindowId = w1 (addWindow auto-assigns first window).
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    const sess = finalModel.sessions.get(sessionId("s0"));
    assert.ok(sess !== undefined);
    assert.equal(sess!.activeWindowId, windowId("w1"));
  });

  it("MODEL: window 'w1' has a non-null layout (set by %layout-change reconciliation)", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    const win = finalModel.windows.get(windowId("w1"));
    assert.ok(win !== undefined);
    assert.ok(win!.layout !== null, "window w1 should have a layout set by %layout-change");
    // Layout must have positive dimensions
    assert.ok(win!.layout!.cols > 0, "layout cols should be > 0");
    assert.ok(win!.layout!.rows > 0, "layout rows should be > 0");
  });

  it("MODEL: checkInvariants() returns no violations after full replay", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    const violations = checkInvariants(finalModel);
    assert.deepEqual(
      violations,
      [],
      `invariant violations: ${JSON.stringify(violations, null, 2)}`,
    );
  });

  it("MODEL: checkInvariants() with layout consistency returns no violations", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    const violations = checkInvariants(finalModel, { checkLayoutConsistency: true });
    assert.deepEqual(
      violations,
      [],
      `layout invariant violations: ${JSON.stringify(violations, null, 2)}`,
    );
  });

  it("MODEL: checkInvariants() passes at every step of the replay (invariants never broken mid-stream)", () => {
    const rawBuf = loadGolden();
    const tokens = tokenizeBuffer(rawBuf);
    const bufferStore = createPaneBufferStore();
    const ctx: ReducerContext = { buffers: bufferStore };

    let model = emptyModel();
    let step = 0;

    for (const tok of tokens) {
      if (tok.kind !== "notification") continue;
      const event = parseNotification(tok as NotificationToken);
      model = reduce(model, event, ctx);
      step++;
      const violations = checkInvariants(model);
      assert.deepEqual(
        violations,
        [],
        `invariant violation at step ${step} (event '${event.kind}'): ${JSON.stringify(violations)}`,
      );
    }
    assert.ok(step > 0, "expected at least one event");
  });
});

// ===========================================================================
// TEST SUITE 2 — Wire stream: snapshot correctness
// ===========================================================================

describe("E3 e2e replay: projectSnapshot on final model", () => {
  it("SNAPSHOT: produces a valid SnapshotMessage with correct structure", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);

    const snap = projectSnapshot(finalModel, { seq: 42 });
    assert.equal(snap.type, "snapshot");
    assert.equal(snap.seq, 42);
    assert.ok(snap.session !== undefined, "snapshot must have a session");
    assert.ok(Array.isArray(snap.windows));
    assert.ok(Array.isArray(snap.panes));
    assert.ok(snap.focus !== undefined);
  });

  it("SNAPSHOT: snapshot has 1 session, 1 window, 2 panes", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);
    const snap = projectSnapshot(finalModel, { seq: 1 });

    // v3: session is a scalar field, not an array
    assert.ok(snap.session !== undefined, "snapshot should have a session");
    assert.equal(snap.windows.length, 1, "snapshot should have 1 window");
    assert.equal(snap.panes.length, 2, `snapshot should have 2 panes, got ${snap.panes.length}`);
  });

  it("SNAPSHOT: session is present and named 's0'", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);
    const snap = projectSnapshot(finalModel, { seq: 1 });

    // v3: SnapshotSession has no 'active' field
    assert.equal(snap.session.name, "s0");
    assert.equal(snap.session.sessionId, sessionId("s0"));
  });

  it("SNAPSHOT: window is active (session.activeWindowId = w1) and has a non-null layout", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);
    const snap = projectSnapshot(finalModel, { seq: 1 });

    const win = snap.windows[0]!;
    // v3: SnapshotWindow has no sessionId field
    // Window is active in session (session.activeWindowId = w1)
    assert.equal(win.active, true);
    assert.ok(win.layout !== null);
    assert.ok(win.layout!.cols > 0 && win.layout!.rows > 0);
  });

  it("SNAPSHOT: focus pair in snapshot matches model focus (all null)", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);
    const snap = projectSnapshot(finalModel, { seq: 1 });

    // Focus is null after pure notification replay (bootstrap gap)
    // v3: focus has paneId and windowId only (no sessionId)
    assert.equal(snap.focus.windowId, null);
    assert.equal(snap.focus.paneId, null);
    // Must match the model
    assert.equal(snap.focus.windowId, finalModel.focus.windowId);
    assert.equal(snap.focus.paneId, finalModel.focus.paneId);
  });

  it("SNAPSHOT: all pane entries belong to window w1 with positive dimensions", () => {
    const rawBuf = loadGolden();
    const { finalModel } = replayCapture(rawBuf);
    const snap = projectSnapshot(finalModel, { seq: 1 });

    for (const p of snap.panes) {
      // v3: SnapshotPane has no sessionId field
      assert.equal(p.windowId, windowId("w1"), `pane ${p.paneId} should be in w1`);
      assert.ok(p.cols > 0, `pane ${p.paneId} cols should be > 0`);
      assert.ok(p.rows > 0, `pane ${p.paneId} rows should be > 0`);
    }
  });
});

// ===========================================================================
// TEST SUITE 3 — Delta stream: round-trip property
// ===========================================================================

describe("E3 e2e replay: delta round-trip", () => {
  it("DELTA ROUND-TRIP: applyDeltas(snap(post-session-bootstrap), all_deltas) deep-equals snap(final)", () => {
    // v3: session identity is established at connection time (in the snapshot), not via deltas.
    // There is no session.added delta on the daemon wire. The round-trip property therefore
    // requires the initial snapshot to already carry the session identity.
    // We use snapshots[0] (after the first notification event, which establishes the session)
    // as the baseline, since step 1 (session-changed) emits no wire deltas.
    const rawBuf = loadGolden();
    const { finalModel, allDeltas, snapshots } = replayCapture(rawBuf);

    // Initial snapshot (after first event = session established, no windows/panes yet)
    const initialSnap = snapshots[0]!;
    assert.ok(
      initialSnap !== undefined,
      "expected at least one snapshot step (session bootstrap)",
    );
    // Apply all accumulated deltas to the post-session-bootstrap snapshot
    const reconstructed = applyDeltas(initialSnap, allDeltas);
    // Final snapshot
    const finalSnap = projectSnapshot(finalModel, { seq: 1 });

    assert.deepEqual(
      normalizeSnapshot(reconstructed),
      normalizeSnapshot(finalSnap),
      "delta round-trip failed: reconstructed snapshot does not equal final snapshot",
    );
  });

  it("DELTA STREAM: at least one delta emitted during replay (model is non-trivial)", () => {
    const rawBuf = loadGolden();
    const { allDeltas } = replayCapture(rawBuf);

    assert.ok(
      allDeltas.length > 0,
      "expected at least one delta message from the replay",
    );
  });

  it("DELTA STREAM: first delta is window.added (v3 daemon wire has no session.added)", () => {
    // v3: session.added is not on the daemon wire — the bound session is established
    // at connection time. The first observable delta is window.added.
    const rawBuf = loadGolden();
    const { allDeltas } = replayCapture(rawBuf);

    const firstDelta = allDeltas[0];
    assert.ok(firstDelta !== undefined, "expected at least one delta");
    assert.equal(
      firstDelta!.type,
      "window.added",
      `expected first delta to be window.added (v3 has no session.added), got ${firstDelta!.type}`,
    );
  });

  it("DELTA STREAM: window.added delta is present for window w1", () => {
    const rawBuf = loadGolden();
    const { allDeltas } = replayCapture(rawBuf);

    const windowAdded = allDeltas.find(
      (d) => d.type === "window.added" && d.windowId === windowId("w1"),
    );
    assert.ok(windowAdded !== undefined, "expected a window.added delta for w1");
  });

  it("DELTA STREAM: pane.opened delta(s) are present", () => {
    const rawBuf = loadGolden();
    const { allDeltas } = replayCapture(rawBuf);

    const paneOpened = allDeltas.filter((d) => d.type === "pane.opened");
    assert.ok(paneOpened.length > 0, `expected at least one pane.opened delta, got ${paneOpened.length}`);
    // All opened panes must be in w1 (v3: no sessionId on pane.opened)
    for (const d of paneOpened) {
      if (d.type !== "pane.opened") continue;
      assert.equal(d.windowId, windowId("w1"), `pane ${d.paneId} should be in w1`);
    }
  });

  it("DELTA STREAM: layout.updated delta is emitted for window w1 after %layout-change", () => {
    const rawBuf = loadGolden();
    const { allDeltas } = replayCapture(rawBuf);

    const layoutUpdated = allDeltas.find(
      (d) => d.type === "layout.updated" && d.windowId === windowId("w1"),
    );
    assert.ok(
      layoutUpdated !== undefined,
      "expected a layout.updated delta for w1 (from %layout-change reconciliation)",
    );
  });

  it("DELTA STREAM: no focus.changed delta with non-null focus (focus stays null throughout bootstrap)", () => {
    // The bootstrap notification ordering prevents focus from being set:
    //   - session-changed fires before any windows exist → setFocus(null)
    //   - session-window-changed fires before the window exists → ignored
    //   - window-pane-changed fires before panes exist → ignored
    //   - layout-change adds panes but no event triggers setFocus afterwards
    // So focus stays null throughout, and the only focus.changed deltas (if any)
    // carry all-null focus values.
    const rawBuf = loadGolden();
    const { allDeltas } = replayCapture(rawBuf);

    const focusChangedWithRealFocus = allDeltas.filter(
      (d) => d.type === "focus.changed" && d.paneId !== null,
    );
    assert.equal(
      focusChangedWithRealFocus.length,
      0,
      "no focus.changed with non-null paneId expected (focus stays null during bootstrap replay)",
    );
  });

  it("DELTA STREAM: ordering — window.added precedes pane.opened", () => {
    // v3: no session.added on the daemon wire; first structural delta is window.added
    const rawBuf = loadGolden();
    const { allDeltas } = replayCapture(rawBuf);

    const windowAddedIdx = allDeltas.findIndex((d) => d.type === "window.added");
    const paneOpenedIdx = allDeltas.findIndex((d) => d.type === "pane.opened");

    assert.ok(windowAddedIdx !== -1, "window.added missing from delta stream");
    assert.ok(paneOpenedIdx !== -1, "pane.opened missing from delta stream");
    assert.ok(
      windowAddedIdx < paneOpenedIdx,
      `window.added (${windowAddedIdx}) must precede pane.opened (${paneOpenedIdx})`,
    );
  });

  it("DELTA ROUND-TRIP: step-by-step reconstruction holds for every intermediate state", () => {
    // Verify: for each step i, applyDeltas(snap(i-1), deltas_i) == snap(i).
    //
    // v3 note: session identity is established at connection time (snapshot), not via
    // deltas. The first event (session-changed) transitions the model from no-session to
    // session-present, but emits no wire delta. We handle this by seeding prevSnap from
    // the snapshot whenever the session identity transitions (empty → present), so the
    // delta property is verified for all steps where deltas actually carry state.
    const rawBuf = loadGolden();
    const tokens = tokenizeBuffer(rawBuf);
    const bufferStore = createPaneBufferStore();
    const ctx: ReducerContext = { buffers: bufferStore };

    let model = emptyModel();
    let prevSnap = projectSnapshot(emptyModel(), { seq: 0 });
    let step = 0;

    for (const tok of tokens) {
      if (tok.kind !== "notification") continue;
      const event = parseNotification(tok as NotificationToken);
      const prev = model;
      model = reduce(model, event, ctx);
      step++;

      const nextSnap = projectSnapshot(model, { seq: step });

      // v3: session identity cannot be derived from deltas alone.
      // When the session transitions from absent to present, reseed prevSnap
      // from the current snapshot so subsequent steps check the delta property.
      const prevSessId = prevSnap.session.sessionId;
      const nextSessId = nextSnap.session.sessionId;
      if (prevSessId === "" && nextSessId !== "") {
        // Session bootstrap step — delta property not testable; reseed baseline.
        prevSnap = nextSnap;
        continue;
      }

      const deltas = diffModel(prev, model);
      const reconstructed = applyDeltas(prevSnap, deltas);

      assert.deepEqual(
        normalizeSnapshot(reconstructed),
        normalizeSnapshot(nextSnap),
        `step ${step} round-trip failed for event '${event.kind}'`,
      );

      prevSnap = nextSnap;
    }

    assert.ok(step > 0, "expected at least one event");
  });
});

// ===========================================================================
// TEST SUITE 4 — Byte-exact buffer preservation
// ===========================================================================

describe("E3 e2e replay: byte-exact buffer preservation", () => {
  it("BUFFERS: %output bytes are accumulated in the pane buffer store", () => {
    // The capture has %output notifications for panes %0, %1, %2.
    // These are mapped to paneId("p0"), paneId("p1"), paneId("p2") by the reducer.
    // Note: pane p0 (tmux %0) is NOT in the model (not a leaf in the layout), but
    // the reducer still appends its output bytes to the buffer store.
    const rawBuf = loadGolden();
    const { bufferStore } = replayCapture(rawBuf);

    const p0size = bufferStore.size(paneId("p0"));
    const p1size = bufferStore.size(paneId("p1"));
    const p2size = bufferStore.size(paneId("p2"));

    // p0 receives all initial output (before split), p1 and p2 receive output after split
    assert.ok(p0size > 0, `expected p0 buffer to have bytes, got ${p0size}`);
    assert.ok(p1size > 0, `expected p1 buffer to have bytes, got ${p1size}`);
    assert.ok(p2size > 0, `expected p2 buffer to have bytes, got ${p2size}`);
  });

  it("BUFFERS: non-UTF-8 bytes (0xc0, 0xfe, 0xff) are preserved byte-exact in the buffer", () => {
    // The capture contains: %output %0 \xc0\xfe\xff test bytes\015\012
    // After replay, the buffer for pane p0 (tmux %0) must contain those bytes.
    const rawBuf = loadGolden();
    const { bufferStore } = replayCapture(rawBuf);

    // The non-UTF-8 output was emitted for pane %0 → paneId("p0")
    const p0buf = bufferStore.getContents(paneId("p0"));
    assert.ok(p0buf instanceof Uint8Array, "buffer content must be a Uint8Array");

    // Find the 0xc0 0xfe 0xff sequence somewhere in the buffer
    let found = false;
    for (let i = 0; i < p0buf.length - 2; i++) {
      if (p0buf[i] === 0xc0 && p0buf[i + 1] === 0xfe && p0buf[i + 2] === 0xff) {
        found = true;
        break;
      }
    }
    assert.ok(
      found,
      "expected bytes 0xc0, 0xfe, 0xff to appear byte-exact in pane p0's buffer",
    );
  });

  it("BUFFERS: buffer is a Uint8Array (no lossy string conversion)", () => {
    const rawBuf = loadGolden();
    const { bufferStore } = replayCapture(rawBuf);

    // Check all panes that might have output
    for (const pid of [paneId("p0"), paneId("p1"), paneId("p2")]) {
      const buf = bufferStore.getContents(pid);
      assert.ok(buf instanceof Uint8Array, `buffer for ${pid} must be Uint8Array`);
    }
  });

  it("BUFFERS: streaming (byte-by-byte) feed produces same buffer contents as one-shot", () => {
    const rawBuf = loadGolden();

    // One-shot replay
    const { bufferStore: oneShotStore } = replayCapture(rawBuf);

    // Byte-by-byte streaming replay
    const streamStore = createPaneBufferStore();
    const streamCtx: ReducerContext = { buffers: streamStore };
    const tok = new ControlTokenizer();
    let streamModel = emptyModel();

    for (let i = 0; i < rawBuf.length; i++) {
      const newTokens = tok.push(rawBuf.subarray(i, i + 1));
      for (const t of newTokens) {
        if (t.kind !== "notification") continue;
        const event = parseNotification(t as NotificationToken);
        streamModel = reduce(streamModel, event, streamCtx);
      }
    }

    // Compare buffers for known pane ids
    for (const pid of [paneId("p0"), paneId("p1"), paneId("p2")]) {
      const oneShotBuf = oneShotStore.getContents(pid);
      const streamBuf = streamStore.getContents(pid);
      assert.deepEqual(
        Array.from(streamBuf),
        Array.from(oneShotBuf),
        `buffer for pane ${pid} differs between one-shot and streaming replay`,
      );
    }
  });
});

// ===========================================================================
// TEST SUITE 5 — Synthetic event sequences (gap filler)
//
// Exercises paths the real capture doesn't cover:
//   - multi-window session
//   - window-close
//   - session rename
//   - session-window-changed (explicit window switch)
//   - reduce after exit (model unchanged)
// ===========================================================================

describe("E3 e2e synthetic: reduce+project paths not covered by real capture", () => {
  const enc = new TextEncoder();

  function bytes(s: string): Uint8Array {
    return enc.encode(s);
  }

  /** Build a notification token from a raw line string. */
  function notifToken(line: string): NotificationToken {
    return {
      kind: "notification" as const,
      keyword: line.split(" ")[0]!.slice(1), // e.g. "%session-changed" → "session-changed"
      rawLine: enc.encode(line),
    };
  }

  function makeCtx(): { ctx: ReducerContext; store: ReturnType<typeof createPaneBufferStore> } {
    const store = createPaneBufferStore();
    return { ctx: { buffers: store }, store };
  }

  it("SYNTHETIC: window-close removes window and its panes from the model", () => {
    // Build a model with 2 windows, then close one.
    const { ctx } = makeCtx();
    let model = emptyModel();

    // Establish session $0 with 2 windows via notifications
    const events: NotificationToken[] = [
      notifToken("%session-changed $0 main"),
      notifToken("%window-add @10"),
      notifToken("%layout-change @10 5914,220x50,0,0,0"), // pane %0 in window @10
      notifToken("%window-add @11"),
      notifToken("%layout-change @11 5914,220x50,0,0,1"), // pane %1 in window @11
      notifToken("%session-window-changed $0 @10"),
      notifToken("%window-pane-changed @10 %0"),
    ];

    for (const tok of events) {
      model = reduce(model, parseNotification(tok), ctx);
    }

    // Verify 2 windows before close
    assert.equal(model.windows.size, 2, "expected 2 windows before close");

    // Close window @11
    const closeToken = notifToken("%window-close @11");
    const prev = model;
    model = reduce(model, parseNotification(closeToken), ctx);

    assert.equal(model.windows.size, 1, "expected 1 window after window-close");
    assert.ok(!model.windows.has(windowId("w11")), "w11 should be removed");

    // Invariants hold
    const violations = checkInvariants(model);
    assert.deepEqual(violations, [], `invariants violated after window-close: ${JSON.stringify(violations)}`);

    // Delta emitted
    const deltas = diffModel(prev, model);
    const windowClosed = deltas.find((d) => d.type === "window.closed");
    assert.ok(windowClosed !== undefined, "expected window.closed delta");

    // Round-trip
    const prevSnap = projectSnapshot(prev, { seq: 1 });
    const nextSnap = projectSnapshot(model, { seq: 2 });
    const reconstructed = applyDeltas(prevSnap, deltas);
    assert.deepEqual(normalizeSnapshot(reconstructed), normalizeSnapshot(nextSnap));
  });

  it("SYNTHETIC: session rename updates name in model and emits session.renamed delta", () => {
    const { ctx } = makeCtx();
    let model = emptyModel();

    model = reduce(model, parseNotification(notifToken("%session-changed $5 old-name")), ctx);
    assert.equal(model.sessions.get(sessionId("s5"))?.name, "old-name");

    const prev = model;
    model = reduce(model, parseNotification(notifToken("%session-renamed $5 new-name")), ctx);
    assert.equal(model.sessions.get(sessionId("s5"))?.name, "new-name");

    const deltas = diffModel(prev, model);
    const renamed = deltas.find((d) => d.type === "session.renamed");
    assert.ok(renamed !== undefined, "expected session.renamed delta");
    if (renamed?.type === "session.renamed") {
      assert.equal(renamed.newName, "new-name");
    }

    // Round-trip
    const prevSnap = projectSnapshot(prev, { seq: 1 });
    const nextSnap = projectSnapshot(model, { seq: 2 });
    const reconstructed = applyDeltas(prevSnap, deltas);
    assert.deepEqual(normalizeSnapshot(reconstructed), normalizeSnapshot(nextSnap));
  });

  it("SYNTHETIC: window rename emits window.renamed delta and round-trips", () => {
    const { ctx } = makeCtx();
    let model = emptyModel();

    const setup: NotificationToken[] = [
      notifToken("%session-changed $0 s"),
      notifToken("%window-add @20"),
      notifToken("%layout-change @20 5914,220x50,0,0,10"),
      notifToken("%window-pane-changed @20 %10"),
    ];
    for (const tok of setup) {
      model = reduce(model, parseNotification(tok), ctx);
    }

    const prev = model;
    model = reduce(model, parseNotification(notifToken("%window-renamed @20 new-win-name")), ctx);

    const deltas = diffModel(prev, model);
    const renamed = deltas.find((d) => d.type === "window.renamed");
    assert.ok(renamed !== undefined, "expected window.renamed delta");
    if (renamed?.type === "window.renamed") {
      assert.equal(renamed.newName, "new-win-name");
    }

    const prevSnap = projectSnapshot(prev, { seq: 1 });
    const nextSnap = projectSnapshot(model, { seq: 2 });
    const reconstructed = applyDeltas(prevSnap, deltas);
    assert.deepEqual(normalizeSnapshot(reconstructed), normalizeSnapshot(nextSnap));

    assert.deepEqual(checkInvariants(model), []);
  });

  it("SYNTHETIC: %exit is a no-op at the model level", () => {
    const { ctx } = makeCtx();
    let model = emptyModel();
    model = reduce(model, parseNotification(notifToken("%session-changed $0 s")), ctx);
    const modelBeforeExit = model;

    const exitEvent = parseNotification(notifToken("%exit"));
    const modelAfterExit = reduce(model, exitEvent, ctx);

    // Model must be unchanged (structural equality by snapshot)
    assert.deepEqual(
      normalizeSnapshot(projectSnapshot(modelBeforeExit, { seq: 1 })),
      normalizeSnapshot(projectSnapshot(modelAfterExit, { seq: 1 })),
      "model must be unchanged after %exit",
    );
    assert.deepEqual(diffModel(modelBeforeExit, modelAfterExit), [], "no deltas from %exit");
  });

  it("SYNTHETIC: sessions-changed is a no-op at the model level", () => {
    const { ctx } = makeCtx();
    let model = emptyModel();
    model = reduce(model, parseNotification(notifToken("%session-changed $0 s")), ctx);
    const before = model;
    const after = reduce(model, parseNotification(notifToken("%sessions-changed")), ctx);
    assert.deepEqual(diffModel(before, after), []);
  });

  it("SYNTHETIC: 2-window session — split pane, focus change, close pane lifecycle", () => {
    // Full lifecycle: session → window → layout-change (adds pane + sets activePaneId)
    // → window-pane-changed AFTER pane exists (focus update works)
    // → split layout-change (adds second pane)
    // → window-pane-changed to new pane (focus switches)
    // → invariants throughout.
    //
    // NOTE: window-pane-changed only updates focus if focus is already established
    // (focus.windowId === windowId). To establish initial focus we must either:
    //   (a) have window-pane-changed arrive AFTER panes exist, or
    //   (b) use a 2nd session-changed after panes exist.
    // We use approach (b): replay session-changed after panes are available.
    const { ctx } = makeCtx();
    let model = emptyModel();

    const setup: NotificationToken[] = [
      notifToken("%session-changed $0 myses"),
      notifToken("%window-add @0"),
      // Layout with single pane %0 — adds pane p0, sets window.activePaneId=p0
      notifToken("%layout-change @0 5914,220x50,0,0,0"),
      // Now re-fire session-changed to establish focus (now that window+pane exist)
      notifToken("%session-changed $0 myses"),
    ];
    for (const tok of setup) {
      model = reduce(model, parseNotification(tok), ctx);
    }

    assert.equal(model.sessions.size, 1);
    assert.equal(model.windows.size, 1);
    assert.equal(model.panes.size, 1);
    // Focus should now be established (session-changed with active window+pane)
    assert.equal(model.focus.paneId, paneId("p0"), "focus.paneId should be p0 after session-changed");
    assert.equal(model.focus.windowId, windowId("w0"), "focus.windowId should be w0");
    assert.deepEqual(checkInvariants(model), []);

    // Simulate a split: new layout with 2 panes (%0 and %1)
    const splitTok = notifToken("%layout-change @0 5914,220x50,0,0{110x50,0,0,0,110x50,111,0,1}");
    model = reduce(model, parseNotification(splitTok), ctx);

    // Conservative add: new pane %1 is added
    assert.equal(model.panes.size, 2, `expected 2 panes after split, got ${model.panes.size}`);
    assert.ok(model.panes.has(paneId("p0")), "pane p0 should still exist");
    assert.ok(model.panes.has(paneId("p1")), "pane p1 should be added by split");
    assert.deepEqual(checkInvariants(model), []);
    // Layout should be updated
    const win = model.windows.get(windowId("w0"));
    assert.ok(win?.layout !== null, "window should have layout after split");

    // Focus switch to new pane — works because focus.windowId === w0
    const focusTok = notifToken("%window-pane-changed @0 %1");
    const prevBeforeFocus = model;
    model = reduce(model, parseNotification(focusTok), ctx);

    assert.equal(model.windows.get(windowId("w0"))?.activePaneId, paneId("p1"), "activePaneId should switch to p1");
    // Focus should update too (focus.windowId === w0 before this event)
    assert.equal(model.focus.paneId, paneId("p1"), "focus.paneId should switch to p1");
    assert.deepEqual(checkInvariants(model), []);

    // Delta round-trip across focus switch
    const deltas = diffModel(prevBeforeFocus, model);
    const prevSnap = projectSnapshot(prevBeforeFocus, { seq: 1 });
    const nextSnap = projectSnapshot(model, { seq: 2 });
    const reconstructed = applyDeltas(prevSnap, deltas);
    assert.deepEqual(normalizeSnapshot(reconstructed), normalizeSnapshot(nextSnap));
  });

  it("SYNTHETIC: %output bytes are appended to the buffer store (buffer grows monotonically)", () => {
    const { ctx, store } = makeCtx();
    let model = emptyModel();

    // Set up a pane
    const setup: NotificationToken[] = [
      notifToken("%session-changed $0 s"),
      notifToken("%window-add @0"),
      notifToken("%layout-change @0 5914,220x50,0,0,0"),
    ];
    for (const tok of setup) {
      model = reduce(model, parseNotification(tok), ctx);
    }

    const pid = paneId("p0");
    const sizeBefore = store.size(pid);

    // Emit %output with known content (ASCII, no octal escaping needed)
    // "hello" in the tmux %output format: all chars > 0x20, not backslash, pass through
    const outputLine = "%output %0 hello";
    const outputTok: NotificationToken = {
      kind: "notification",
      keyword: "output",
      rawLine: enc.encode(outputLine),
    };
    model = reduce(model, parseNotification(outputTok), ctx);

    const sizeAfter = store.size(pid);
    assert.ok(sizeAfter > sizeBefore, `buffer size should grow after %output; was ${sizeBefore}, now ${sizeAfter}`);

    const contents = store.getContents(pid);
    assert.ok(contents instanceof Uint8Array);
    // Decoded content should include "hello"
    const str = new TextDecoder().decode(contents);
    assert.ok(str.includes("hello"), `expected "hello" in buffer, got: ${JSON.stringify(str)}`);
  });
});
