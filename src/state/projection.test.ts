/**
 * Tests for the model→wire projection (tc-7gp).
 *
 * Covers:
 *   1. Snapshot reflects full state.
 *   2. Deltas are minimal + correct (one change → one delta).
 *   3. Round-trip: applyDeltas(projectSnapshot(prev), diffModel(prev, next))
 *      deep-equals projectSnapshot(next).
 *   4. Ordering: pane.opened precedes focus.changed when a new pane is
 *      immediately focused.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectSnapshot, diffModel } from "./projection.js";
import type { ProjectSnapshotOpts } from "./projection.js";
import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  removePane,
  removeWindow,
  removeSession,
  updatePane,
  updateWindow,
  updateSession,
  setFocus,
} from "./model.js";
import { paneId, windowId, sessionId } from "./model.js";
import type { Session, Window, Pane, SessionModel, FocusState } from "./model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";
import type {
  SnapshotMessage,
  DaemonMessage,
} from "../wire/daemon-control.js";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

const S1 = sessionId("s1");
const S2 = sessionId("s2");
const W1 = windowId("w1");
const W2 = windowId("w2");
const P1 = paneId("p1");
const P2 = paneId("p2");
const P3 = paneId("p3");

const LAYOUT_1 = {
  cols: 80,
  rows: 24,
  root: {
    kind: "pane" as const,
    paneId: P1,
    rect: { x: 0, y: 0, cols: 80, rows: 24 },
  },
};

const LAYOUT_2 = {
  cols: 80,
  rows: 24,
  root: {
    kind: "hsplit" as const,
    rect: { x: 0, y: 0, cols: 80, rows: 24 },
    children: [
      { kind: "pane" as const, paneId: P1, rect: { x: 0, y: 0, cols: 40, rows: 24 } },
      { kind: "pane" as const, paneId: P2, rect: { x: 40, y: 0, cols: 40, rows: 24 } },
    ],
  },
};

function makeSession(
  id: SessionId,
  windowIds: readonly WindowId[],
  activeWindowId: WindowId | null,
  name = "test-session",
): Session {
  return { sessionId: id, name, windowIds, activeWindowId };
}

function makeWindow(
  id: WindowId,
  sessId: SessionId,
  paneIds: readonly PaneId[],
  activePaneId: PaneId | null,
  name = "test-window",
  layout = null as import("../wire/layout.js").WindowLayout | null,
): Window {
  return { windowId: id, sessionId: sessId, name, paneIds, activePaneId, layout };
}

function makePane(
  id: PaneId,
  winId: WindowId,
  sessId: SessionId,
  cols = 80,
  rows = 24,
): Pane {
  return {
    paneId: id,
    windowId: winId,
    sessionId: sessId,
    cols,
    rows,
    mode: "normal",
    scrollbackHandle: undefined,
  };
}

/**
 * Build a canonical model: S1 → W1 → [P1(active), P2], layout=LAYOUT_2.
 * Focus: P1 / W1 / S1.
 */
function baseModel(): SessionModel {
  const sess: Session = makeSession(S1, [W1], W1);
  const win: Window = makeWindow(W1, S1, [P1, P2], P1, "main", LAYOUT_2);
  const p1: Pane = makePane(P1, W1, S1, 80, 24);
  const p2: Pane = makePane(P2, W1, S1, 40, 24);

  const sessions = new Map([[S1, sess]]);
  const windows = new Map([[W1, win]]);
  const panes = new Map<PaneId, Pane>([
    [P1, p1],
    [P2, p2],
  ]);
  const focus: FocusState = { paneId: P1, windowId: W1, sessionId: S1 };

  return { sessions, windows, panes, focus };
}

// ---------------------------------------------------------------------------
// Round-trip helper: apply a sequence of deltas to a snapshot-shaped state.
//
// This is a reference applier used only in tests (not production code). It
// produces a new SnapshotMessage by folding over the delta list.
// ---------------------------------------------------------------------------

function applyDeltas(snap: SnapshotMessage, deltas: DaemonMessage[]): SnapshotMessage {
  // Work on mutable copies of the flat arrays.
  let sessions = [...snap.sessions];
  let windows = [...snap.windows];
  let panes = [...snap.panes];
  let focus = { ...snap.focus };

  for (const delta of deltas) {
    switch (delta.type) {
      // --- session lifecycle ---
      case "session.added":
        sessions = [
          // Only clear existing sessions' active flag if the new session is
          // immediately active (i.e. delta.active === true).
          ...sessions.map((s) => (delta.active ? { ...s, active: false } : s)),
          {
            sessionId: delta.sessionId,
            name: delta.name,
            active: delta.active,
          },
        ];
        break;

      case "session.closed":
        sessions = sessions.filter((s) => s.sessionId !== delta.sessionId);
        break;

      case "session.renamed":
        sessions = sessions.map((s) =>
          s.sessionId === delta.sessionId ? { ...s, name: delta.newName } : s,
        );
        break;

      case "session.changed":
        sessions = sessions.map((s) => ({
          ...s,
          active: s.sessionId === delta.newActiveSessionId,
        }));
        break;

      // --- window lifecycle ---
      case "window.added":
        windows = [
          ...windows.map((w) =>
            delta.active && w.sessionId === delta.sessionId
              ? { ...w, active: false }
              : w,
          ),
          {
            windowId: delta.windowId,
            sessionId: delta.sessionId,
            name: delta.name,
            active: delta.active,
            // layout will be filled by a subsequent layout.updated if needed.
            // Use a zero-layout placeholder so the shape is valid.
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

      // --- layout ---
      case "layout.updated":
        windows = windows.map((w) =>
          w.windowId === delta.windowId ? { ...w, layout: delta.layout } : w,
        );
        break;

      // --- pane lifecycle ---
      case "pane.opened":
        panes = [
          ...panes,
          {
            paneId: delta.paneId,
            windowId: delta.windowId,
            sessionId: delta.sessionId,
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
          p.paneId === delta.paneId
            ? { ...p, cols: delta.cols, rows: delta.rows }
            : p,
        );
        break;

      case "pane.mode-changed":
        // SnapshotPane has no mode field; ignore (mode is not in snapshot shape).
        break;

      // --- focus ---
      case "focus.changed":
        focus = {
          paneId: delta.paneId,
          windowId: delta.windowId,
          sessionId: delta.sessionId,
        };
        // Also update active flags in sessions and windows to match the new focus.
        sessions = sessions.map((s) => ({
          ...s,
          active: s.sessionId === delta.sessionId,
        }));
        windows = windows.map((w) => ({
          ...w,
          active: w.windowId === delta.windowId,
        }));
        break;

      // Ignore daemon→client messages not relevant to snapshot state:
      default:
        break;
    }
  }

  return {
    type: "snapshot",
    seq: snap.seq,
    sessions,
    windows,
    panes,
    focus,
  };
}

/**
 * Normalize a SnapshotMessage for deep comparison: sort all arrays by id so
 * order doesn't affect equality. Also strip seq (not part of state).
 */
function normalizeSnapshot(snap: SnapshotMessage) {
  return {
    sessions: [...snap.sessions]
      .sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)))
      .map(({ sessionId, name, active }) => ({ sessionId, name, active })),
    windows: [...snap.windows]
      .sort((a, b) => String(a.windowId).localeCompare(String(b.windowId)))
      .map(({ windowId, sessionId, name, active, layout }) => ({
        windowId,
        sessionId,
        name,
        active,
        layout,
      })),
    panes: [...snap.panes]
      .sort((a, b) => String(a.paneId).localeCompare(String(b.paneId)))
      .map(({ paneId, windowId, sessionId, cols, rows }) => ({
        paneId,
        windowId,
        sessionId,
        cols,
        rows,
      })),
    focus: snap.focus,
  };
}

// ---------------------------------------------------------------------------
// 1. Snapshot reflects full state
// ---------------------------------------------------------------------------

describe("projectSnapshot — full state", () => {
  it("empty model produces empty arrays and null focus", () => {
    const snap = projectSnapshot(emptyModel(), { seq: 1 });
    assert.equal(snap.type, "snapshot");
    assert.equal(snap.seq, 1);
    assert.deepEqual(snap.sessions, []);
    assert.deepEqual(snap.windows, []);
    assert.deepEqual(snap.panes, []);
    assert.deepEqual(snap.focus, { paneId: null, windowId: null, sessionId: null });
  });

  it("snapshot contains all entities and correct focus triple", () => {
    const model = baseModel();
    const snap = projectSnapshot(model, { seq: 5 });

    assert.equal(snap.type, "snapshot");
    assert.equal(snap.seq, 5);

    // Sessions
    assert.equal(snap.sessions.length, 1);
    const s = snap.sessions[0]!;
    assert.equal(s.sessionId, S1);
    assert.equal(s.name, "test-session");
    assert.equal(s.active, true); // S1 is focused

    // Windows
    assert.equal(snap.windows.length, 1);
    const w = snap.windows[0]!;
    assert.equal(w.windowId, W1);
    assert.equal(w.sessionId, S1);
    assert.equal(w.name, "main");
    assert.equal(w.active, true); // W1 is the active window in S1
    assert.deepEqual(w.layout, LAYOUT_2);

    // Panes
    assert.equal(snap.panes.length, 2);
    const paneMap = new Map(snap.panes.map((p) => [p.paneId, p]));
    const sp1 = paneMap.get(P1)!;
    assert.equal(sp1.windowId, W1);
    assert.equal(sp1.sessionId, S1);
    assert.equal(sp1.cols, 80);
    assert.equal(sp1.rows, 24);
    const sp2 = paneMap.get(P2)!;
    assert.equal(sp2.cols, 40);
    assert.equal(sp2.rows, 24);

    // Focus
    assert.deepEqual(snap.focus, { paneId: P1, windowId: W1, sessionId: S1 });
  });

  it("multi-session model: active flags on sessions are set correctly", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S1, [], null, "session-one"));
    model = addSession(model, makeSession(S2, [], null, "session-two"));
    // Only S2 is focused
    model = { ...model, focus: { paneId: null, windowId: null, sessionId: null } };
    // Sessions are present but no focus
    const snap = projectSnapshot(model, { seq: 1 });
    assert.equal(snap.sessions.length, 2);
    // Neither is active (no focus)
    for (const s of snap.sessions) {
      assert.equal(s.active, false);
    }
  });

  it("seq defaults to 1 when not provided", () => {
    const snap = projectSnapshot(emptyModel());
    assert.equal(snap.seq, 1);
  });

  it("snapshot panes carry cols/rows from model", () => {
    const model = baseModel();
    const snap = projectSnapshot(model);
    const p2snap = snap.panes.find((p) => p.paneId === P2);
    assert.ok(p2snap);
    assert.equal(p2snap.cols, 40);
    assert.equal(p2snap.rows, 24);
  });

  it("SnapshotPane has no bytes/content field (data-plane responsibility)", () => {
    const model = baseModel();
    const snap = projectSnapshot(model);
    const pane = snap.panes[0]!;
    // The SnapshotPane type has exactly: paneId, windowId, sessionId, cols, rows.
    // Confirm no extra content field leaked in.
    assert.ok(!("contents" in pane), "SnapshotPane must not carry byte contents");
    assert.ok(!("bytes" in pane), "SnapshotPane must not carry byte contents");
  });
});

// ---------------------------------------------------------------------------
// 2. Deltas are minimal + correct (one change → exactly the right delta)
// ---------------------------------------------------------------------------

describe("diffModel — minimal deltas", () => {
  it("identical models produce no deltas", () => {
    const model = baseModel();
    const deltas = diffModel(model, model);
    assert.deepEqual(deltas, []);
  });

  it("add a pane → exactly one pane.opened delta", () => {
    const prev = baseModel();
    const next = addPane(prev, makePane(P3, W1, S1, 30, 24));
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "pane.opened");
    if (d.type === "pane.opened") {
      assert.equal(d.paneId, P3);
      assert.equal(d.windowId, W1);
      assert.equal(d.sessionId, S1);
      assert.equal(d.cols, 30);
      assert.equal(d.rows, 24);
    }
  });

  it("remove a pane → exactly one pane.closed delta", () => {
    const prev = baseModel();
    const next = removePane(prev, P2);
    const deltas = diffModel(prev, next);
    // Also possibly a focus.changed if P2 was focused — but P1 is focused in base.
    const closed = deltas.filter((d) => d.type === "pane.closed");
    assert.equal(closed.length, 1);
    const d = closed[0]!;
    if (d.type === "pane.closed") {
      assert.equal(d.paneId, P2);
      assert.equal(d.windowId, W1);
      assert.equal(d.sessionId, S1);
    }
    // No spurious pane.opened
    assert.equal(deltas.filter((d) => d.type === "pane.opened").length, 0);
  });

  it("resize a pane → exactly one pane.resized delta", () => {
    const prev = baseModel();
    const next = updatePane(prev, P1, { cols: 120, rows: 40 });
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "pane.resized");
    if (d.type === "pane.resized") {
      assert.equal(d.paneId, P1);
      assert.equal(d.cols, 120);
      assert.equal(d.rows, 40);
    }
  });

  it("pane mode change → exactly one pane.mode-changed delta", () => {
    const prev = baseModel();
    const next = updatePane(prev, P1, { mode: "copy" });
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "pane.mode-changed");
    if (d.type === "pane.mode-changed") {
      assert.equal(d.paneId, P1);
      assert.equal(d.mode, "copy");
    }
  });

  it("rename a window → exactly one window.renamed delta", () => {
    const prev = baseModel();
    const next = updateWindow(prev, W1, { name: "renamed-window" });
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "window.renamed");
    if (d.type === "window.renamed") {
      assert.equal(d.windowId, W1);
      assert.equal(d.newName, "renamed-window");
    }
  });

  it("add a window → exactly one window.added delta", () => {
    const prev = baseModel();
    const next = addWindow(prev, makeWindow(W2, S1, [], null, "second-window"));
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "window.added");
    if (d.type === "window.added") {
      assert.equal(d.windowId, W2);
      assert.equal(d.sessionId, S1);
      assert.equal(d.name, "second-window");
    }
  });

  it("remove a window → exactly one window.closed delta", () => {
    // Add a second window so P1/W1 still exists and focus doesn't get nulled
    let prev = baseModel();
    prev = addWindow(prev, makeWindow(W2, S1, [], null, "second-window"));
    const next = removeWindow(prev, W2);
    const deltas = diffModel(prev, next);
    const closed = deltas.filter((d) => d.type === "window.closed");
    assert.equal(closed.length, 1);
    const closedMsg = closed[0]!;
    if (closedMsg.type === "window.closed") {
      assert.equal(closedMsg.windowId, W2);
    }
    // No spurious window.added
    assert.equal(deltas.filter((d) => d.type === "window.added").length, 0);
  });

  it("layout change → exactly one layout.updated delta", () => {
    const prev = baseModel();
    const newLayout = {
      cols: 80,
      rows: 24,
      root: {
        kind: "pane" as const,
        paneId: P1,
        rect: { x: 0, y: 0, cols: 80, rows: 24 },
      },
    };
    const next = updateWindow(prev, W1, { layout: newLayout });
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "layout.updated");
    if (d.type === "layout.updated") {
      assert.equal(d.windowId, W1);
      assert.deepEqual(d.layout, newLayout);
    }
  });

  it("focus change → exactly one focus.changed delta", () => {
    const prev = baseModel();
    // Switch focus to P2 (must also update activePaneId)
    let next = updateWindow(prev, W1, { activePaneId: P2 });
    next = setFocus(next, { paneId: P2, windowId: W1, sessionId: S1 });
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "focus.changed");
    if (d.type === "focus.changed") {
      assert.equal(d.paneId, P2);
      assert.equal(d.windowId, W1);
      assert.equal(d.sessionId, S1);
    }
  });

  it("add a session → exactly one session.added delta", () => {
    const prev = baseModel();
    const next = addSession(prev, makeSession(S2, [], null, "second-session"));
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "session.added");
    if (d.type === "session.added") {
      assert.equal(d.sessionId, S2);
      assert.equal(d.name, "second-session");
    }
  });

  it("remove a session → session.closed delta (plus possible focus.changed)", () => {
    let prev = baseModel();
    // Add a second session so removal of S2 doesn't require clearing S1
    prev = addSession(prev, makeSession(S2, [], null, "second-session"));
    const next = removeSession(prev, S2);
    const closed = diffModel(prev, next).filter((d) => d.type === "session.closed");
    assert.equal(closed.length, 1);
    const closedMsg = closed[0]!;
    if (closedMsg.type === "session.closed") {
      assert.equal(closedMsg.sessionId, S2);
    }
  });

  it("session rename → exactly one session.renamed delta", () => {
    const prev = baseModel();
    const next = updateSession(prev, S1, { name: "renamed-session" });
    const deltas = diffModel(prev, next);
    assert.equal(deltas.length, 1);
    const d = deltas[0]!;
    assert.equal(d.type, "session.renamed");
    if (d.type === "session.renamed") {
      assert.equal(d.sessionId, S1);
      assert.equal(d.newName, "renamed-session");
    }
  });

  it("no spurious deltas when an unchanged pane exists alongside a changed one", () => {
    const prev = baseModel();
    const next = updatePane(prev, P1, { cols: 100, rows: 30 });
    const deltas = diffModel(prev, next);
    // Only P1 changed; P2 unchanged → only one delta for P1
    assert.equal(deltas.length, 1);
    const d0 = deltas[0]!;
    assert.equal(d0.type, "pane.resized");
    if (d0.type === "pane.resized") {
      assert.equal(d0.paneId, P1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Round-trip: applyDeltas(projectSnapshot(prev), diffModel(prev, next))
//               deep-equals projectSnapshot(next)
//
// Proof approach: normalize both snapshots (sort arrays, strip seq) and
// assert structural equality.
// ---------------------------------------------------------------------------

describe("round-trip: applyDeltas(snapshot(prev), diff(prev,next)) == snapshot(next)", () => {
  function roundTrip(prev: SessionModel, next: SessionModel): void {
    const snapPrev = projectSnapshot(prev, { seq: 1 });
    const deltas = diffModel(prev, next);
    const reconstructed = applyDeltas(snapPrev, deltas);
    const expected = projectSnapshot(next, { seq: 1 });
    assert.deepEqual(normalizeSnapshot(reconstructed), normalizeSnapshot(expected));
  }

  it("empty → empty (no change)", () => {
    roundTrip(emptyModel(), emptyModel());
  });

  it("add a pane", () => {
    const prev = baseModel();
    const next = addPane(prev, makePane(P3, W1, S1, 30, 24));
    roundTrip(prev, next);
  });

  it("close a pane", () => {
    const prev = baseModel();
    const next = removePane(prev, P2);
    roundTrip(prev, next);
  });

  it("resize a pane", () => {
    const prev = baseModel();
    const next = updatePane(prev, P1, { cols: 120, rows: 40 });
    roundTrip(prev, next);
  });

  it("rename a window", () => {
    const prev = baseModel();
    const next = updateWindow(prev, W1, { name: "new-name" });
    roundTrip(prev, next);
  });

  it("layout update", () => {
    const prev = baseModel();
    const next = updateWindow(prev, W1, { layout: LAYOUT_1 });
    roundTrip(prev, next);
  });

  it("focus change", () => {
    const prev = baseModel();
    let next = updateWindow(prev, W1, { activePaneId: P2 });
    next = setFocus(next, { paneId: P2, windowId: W1, sessionId: S1 });
    roundTrip(prev, next);
  });

  it("add a session + window + pane (multi-change)", () => {
    const prev = baseModel();
    let next = addSession(prev, makeSession(S2, [], null, "session-two"));
    next = addWindow(next, makeWindow(W2, S2, [], null, "win-two"));
    next = addPane(next, makePane(P3, W2, S2, 100, 40));
    roundTrip(prev, next);
  });

  it("remove session (multi-change)", () => {
    // Build a two-session model, then remove one
    let prev = baseModel();
    prev = addSession(prev, makeSession(S2, [], null, "session-two"));
    prev = addWindow(prev, makeWindow(W2, S2, [], null, "win-two"));
    prev = addPane(prev, makePane(P3, W2, S2, 100, 40));
    const next = removeSession(prev, S2);
    roundTrip(prev, next);
  });

  it("simultaneous rename + resize (multi-change)", () => {
    const prev = baseModel();
    let next = updateWindow(prev, W1, { name: "renamed" });
    next = updatePane(next, P1, { cols: 120, rows: 40 });
    roundTrip(prev, next);
  });
});

// ---------------------------------------------------------------------------
// 4. Ordering: pane.opened precedes focus.changed when a new pane is focused
// ---------------------------------------------------------------------------

describe("delta ordering", () => {
  it("pane.opened appears before focus.changed in the same diff", () => {
    const prev = baseModel();
    // Add P3 and immediately focus it
    let next = addPane(prev, makePane(P3, W1, S1, 30, 24));
    next = updateWindow(next, W1, { activePaneId: P3 });
    next = setFocus(next, { paneId: P3, windowId: W1, sessionId: S1 });

    const deltas = diffModel(prev, next);

    const openedIdx = deltas.findIndex((d) => d.type === "pane.opened");
    const focusIdx = deltas.findIndex((d) => d.type === "focus.changed");

    assert.ok(openedIdx !== -1, "pane.opened must be present");
    assert.ok(focusIdx !== -1, "focus.changed must be present");
    assert.ok(
      openedIdx < focusIdx,
      `pane.opened (idx ${openedIdx}) must precede focus.changed (idx ${focusIdx})`,
    );
  });

  it("session.added appears before window.added which appears before pane.opened", () => {
    const prev = emptyModel();
    let next = addSession(prev, makeSession(S1, [], null));
    next = addWindow(next, makeWindow(W1, S1, [], null));
    next = addPane(next, makePane(P1, W1, S1));

    const deltas = diffModel(prev, next);
    const types = deltas.map((d) => d.type);

    const sessionIdx = types.indexOf("session.added");
    const windowIdx = types.indexOf("window.added");
    const paneIdx = types.indexOf("pane.opened");

    assert.ok(sessionIdx !== -1, "session.added must be present");
    assert.ok(windowIdx !== -1, "window.added must be present");
    assert.ok(paneIdx !== -1, "pane.opened must be present");
    assert.ok(sessionIdx < windowIdx, "session.added before window.added");
    assert.ok(windowIdx < paneIdx, "window.added before pane.opened");
  });

  it("pane.closed appears before window.closed which appears before session.closed", () => {
    let prev = baseModel();
    prev = addSession(prev, makeSession(S2, [], null));
    prev = addWindow(prev, makeWindow(W2, S2, [], null));
    prev = addPane(prev, makePane(P3, W2, S2));

    const next = removeSession(prev, S2);

    const deltas = diffModel(prev, next);
    const types = deltas.map((d) => d.type);

    const paneClosedIdx = types.indexOf("pane.closed");
    const windowClosedIdx = types.indexOf("window.closed");
    const sessionClosedIdx = types.indexOf("session.closed");

    assert.ok(paneClosedIdx !== -1, "pane.closed must be present");
    assert.ok(windowClosedIdx !== -1, "window.closed must be present");
    assert.ok(sessionClosedIdx !== -1, "session.closed must be present");
    assert.ok(paneClosedIdx < windowClosedIdx, "pane.closed before window.closed");
    assert.ok(windowClosedIdx < sessionClosedIdx, "window.closed before session.closed");
  });
});
