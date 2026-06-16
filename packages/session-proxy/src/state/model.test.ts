/**
 * Unit tests for the canonical session model (tc-aib / tc-2cw).
 *
 * Tests verify:
 *   1. A valid model passes checkInvariants with no violations.
 *   2. Each invariant (I1–I7, I9) has at least one failing case that
 *      produces the expected violation kind.
 *   3. Constructor/update helpers preserve invariants.
 *   4. parsedLayoutToWindowLayout bridges parser → wire correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
  checkInvariants,
  parsedLayoutToWindowLayout,
  scrollbackHandle,
} from "./model.js";
import { paneId, windowId, sessionId } from "./model.js";
import type { Session, Window, Pane, SessionModel, FocusState } from "./model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";
import { parseLayout } from "../parser/layout-string.js";

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

const S1 = sessionId("s1");
const S2 = sessionId("s2");
const W1 = windowId("w1");
const W2 = windowId("w2");
const P1 = paneId("p1");
const P2 = paneId("p2");
const P3 = paneId("p3");

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
): Window {
  return {
    windowId: id,
    sessionId: sessId,
    name,
    paneIds,
    activePaneId,
    layout: null,
    synchronizePanes: false,
    monitorActivity: true,   // ── tc-7xv.15 ──
    monitorSilence: 0,       // ── tc-7xv.15 ──
  };
}

function makePane(
  id: PaneId,
  winId: WindowId,
  sessId: SessionId,
  cols = 80,
  rows = 24,
  dead = false,
  exitCode: number | undefined = undefined,
): Pane {
  return {
    paneId: id,
    windowId: winId,
    sessionId: sessId,
    cols,
    rows,
    mode: "normal",
    dead,
    exitCode,
    label: undefined,
    scrollbackHandle: undefined,
  };
}

/**
 * Build a valid two-pane model: S1 → W1 → [P1(active), P2].
 * Focus: P1 / W1 / S1.
 */
function validModel(): SessionModel {
  const sess: Session = makeSession(S1, [W1], W1);
  const win: Window = makeWindow(W1, S1, [P1, P2], P1);
  const p1: Pane = makePane(P1, W1, S1);
  const p2: Pane = makePane(P2, W1, S1);

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
// 1. Valid model passes invariants
// ---------------------------------------------------------------------------

describe("checkInvariants — valid model", () => {
  it("a well-formed session/window/2-pane model has no violations", () => {
    const model = validModel();
    const violations = checkInvariants(model);
    assert.deepEqual(violations, []);
  });

  it("empty model has no violations", () => {
    const violations = checkInvariants(emptyModel());
    assert.deepEqual(violations, []);
  });

  it("null focus with no sessions is valid", () => {
    const model = emptyModel();
    assert.deepEqual(checkInvariants(model), []);
  });
});

// ---------------------------------------------------------------------------
// 2. Failing cases for each invariant
// ---------------------------------------------------------------------------

describe("checkInvariants — I1: pane's windowId must exist", () => {
  it("reports pane-missing-window when pane references a non-existent window", () => {
    const model = validModel();
    // Add a pane whose windowId is not in model.windows
    const orphanPane: Pane = makePane(P3, windowId("nonexistent"), S1);
    const panes = new Map(model.panes);
    panes.set(P3, orphanPane);
    const bad: SessionModel = { ...model, panes };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some((v) => v.kind === "pane-missing-window" && v.paneId === P3),
      `expected pane-missing-window, got: ${JSON.stringify(violations)}`,
    );
  });
});

describe("checkInvariants — I2: window's sessionId must exist", () => {
  it("reports window-missing-session when window references a non-existent session", () => {
    const model = validModel();
    const orphanWin: Window = makeWindow(W2, sessionId("nonexistent"), [], null);
    const windows = new Map(model.windows);
    windows.set(W2, orphanWin);
    const bad: SessionModel = { ...model, windows };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some((v) => v.kind === "window-missing-session" && v.windowId === W2),
    );
  });
});

describe("checkInvariants — I3: window.paneIds entries must exist in model.panes", () => {
  it("reports window-pane-not-in-map for a ghost paneId in window.paneIds", () => {
    const model = validModel();
    const ghost = paneId("ghost");
    const win = model.windows.get(W1)!;
    const updatedWin: Window = { ...win, paneIds: [...win.paneIds, ghost] };
    const windows = new Map(model.windows);
    windows.set(W1, updatedWin);
    const bad: SessionModel = { ...model, windows };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some(
        (v) => v.kind === "window-pane-not-in-map" && v.windowId === W1 && v.paneId === ghost,
      ),
    );
  });
});

describe("checkInvariants — I4: session.windowIds entries must exist in model.windows", () => {
  it("reports session-window-not-in-map for a ghost windowId in session.windowIds", () => {
    const model = validModel();
    const ghost = windowId("ghost");
    const sess = model.sessions.get(S1)!;
    const updatedSess: Session = { ...sess, windowIds: [...sess.windowIds, ghost] };
    const sessions = new Map(model.sessions);
    sessions.set(S1, updatedSess);
    const bad: SessionModel = { ...model, sessions };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some(
        (v) =>
          v.kind === "session-window-not-in-map" && v.sessionId === S1 && v.windowId === ghost,
      ),
    );
  });
});

describe("checkInvariants — I5: active pane per window", () => {
  it("reports window-no-active-pane when non-empty window has activePaneId null", () => {
    const model = validModel();
    const win = model.windows.get(W1)!;
    const badWin: Window = { ...win, activePaneId: null };
    const windows = new Map(model.windows);
    windows.set(W1, badWin);
    const bad: SessionModel = { ...model, windows };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some((v) => v.kind === "window-no-active-pane" && v.windowId === W1),
    );
  });

  it("reports window-active-pane-missing when activePaneId is not in paneIds", () => {
    const model = validModel();
    const win = model.windows.get(W1)!;
    const badWin: Window = { ...win, activePaneId: paneId("phantom") };
    const windows = new Map(model.windows);
    windows.set(W1, badWin);
    const bad: SessionModel = { ...model, windows };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some(
        (v) => v.kind === "window-active-pane-missing" && v.windowId === W1,
      ),
    );
  });
});

describe("checkInvariants — I6: active window per session", () => {
  it("reports session-no-active-window when non-empty session has activeWindowId null", () => {
    const model = validModel();
    const sess = model.sessions.get(S1)!;
    const badSess: Session = { ...sess, activeWindowId: null };
    const sessions = new Map(model.sessions);
    sessions.set(S1, badSess);
    const bad: SessionModel = { ...model, sessions };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some((v) => v.kind === "session-no-active-window" && v.sessionId === S1),
    );
  });

  it("reports session-active-window-missing when activeWindowId is not in windowIds", () => {
    const model = validModel();
    const sess = model.sessions.get(S1)!;
    const badSess: Session = { ...sess, activeWindowId: windowId("phantom") };
    const sessions = new Map(model.sessions);
    sessions.set(S1, badSess);
    const bad: SessionModel = { ...model, sessions };

    const violations = checkInvariants(bad);
    assert.ok(
      violations.some(
        (v) => v.kind === "session-active-window-missing" && v.sessionId === S1,
      ),
    );
  });
});

describe("checkInvariants — I7: focus consistency", () => {
  it("reports focus-partial-null when only some focus fields are null", () => {
    const model = validModel();
    const bad: SessionModel = {
      ...model,
      focus: { paneId: P1, windowId: null, sessionId: null },
    };
    const violations = checkInvariants(bad);
    assert.ok(violations.some((v) => v.kind === "focus-partial-null"));
  });

  it("reports focus-pane-not-found when focus paneId doesn't exist", () => {
    const model = validModel();
    const bad: SessionModel = {
      ...model,
      focus: { paneId: paneId("missing"), windowId: W1, sessionId: S1 },
    };
    const violations = checkInvariants(bad);
    assert.ok(violations.some((v) => v.kind === "focus-pane-not-found"));
  });

  it("reports focus-window-not-found when focus windowId doesn't exist", () => {
    const model = validModel();
    const bad: SessionModel = {
      ...model,
      focus: { paneId: P1, windowId: windowId("missing"), sessionId: S1 },
    };
    const violations = checkInvariants(bad);
    assert.ok(violations.some((v) => v.kind === "focus-window-not-found"));
  });

  it("reports focus-session-not-found when focus sessionId doesn't exist", () => {
    const model = validModel();
    const bad: SessionModel = {
      ...model,
      focus: { paneId: P1, windowId: W1, sessionId: sessionId("missing") },
    };
    const violations = checkInvariants(bad);
    assert.ok(violations.some((v) => v.kind === "focus-session-not-found"));
  });

  it("reports focus-pane-wrong-window when focus pane is not in focus window", () => {
    const model = validModel();
    // Add second window with P3, focus P3 but set windowId to W1
    const p3: Pane = makePane(P3, W2, S1);
    const w2: Window = makeWindow(W2, S1, [P3], P3);
    const sess = model.sessions.get(S1)!;
    const updatedSess: Session = { ...sess, windowIds: [W1, W2] };

    const windows = new Map(model.windows);
    windows.set(W2, w2);
    const panes = new Map(model.panes);
    panes.set(P3, p3);
    const sessions = new Map(model.sessions);
    sessions.set(S1, updatedSess);

    const bad: SessionModel = {
      sessions,
      windows,
      panes,
      // focus.paneId is P3 (in W2) but focus.windowId is W1
      focus: { paneId: P3, windowId: W1, sessionId: S1 },
    };
    const violations = checkInvariants(bad);
    assert.ok(violations.some((v) => v.kind === "focus-pane-wrong-window"));
  });

  it("reports focus-window-wrong-session when focus window is not in focus session", () => {
    const model = validModel();
    // Add second session, focus W1 but set sessionId to S2
    const s2: Session = makeSession(S2, [], null);
    const sessions = new Map(model.sessions);
    sessions.set(S2, s2);

    const bad: SessionModel = {
      ...model,
      sessions,
      focus: { paneId: P1, windowId: W1, sessionId: S2 },
    };
    const violations = checkInvariants(bad);
    assert.ok(violations.some((v) => v.kind === "focus-window-wrong-session"));
  });

  it("reports focus-pane-not-active when focus pane exists in window but is not activePaneId", () => {
    const model = validModel();
    // P2 is in W1 but not active (P1 is active)
    const bad: SessionModel = {
      ...model,
      focus: { paneId: P2, windowId: W1, sessionId: S1 },
    };
    const violations = checkInvariants(bad);
    assert.ok(violations.some((v) => v.kind === "focus-pane-not-active"));
  });
});

describe("checkInvariants — I9: layout consistency (opt-in)", () => {
  it("reports layout-pane-mismatch when layout leaf ids differ from paneIds", () => {
    const model = validModel();
    // Build a layout that only references P1 (not P2)
    const onlyP1Layout = {
      cols: 80,
      rows: 24,
      root: {
        kind: "pane" as const,
        paneId: P1,
        rect: { x: 0, y: 0, cols: 80, rows: 24 },
      },
    };
    const win = model.windows.get(W1)!;
    const windows = new Map(model.windows);
    windows.set(W1, { ...win, layout: onlyP1Layout });
    const bad: SessionModel = { ...model, windows };

    // Without opt-in: no violation
    assert.deepEqual(checkInvariants(bad).filter((v) => v.kind === "layout-pane-mismatch"), []);

    // With opt-in: violation reported
    const violations = checkInvariants(bad, { checkLayoutConsistency: true });
    assert.ok(violations.some((v) => v.kind === "layout-pane-mismatch" && v.windowId === W1));
  });
});

// ---------------------------------------------------------------------------
// 3. Constructor/update helpers preserve invariants
// ---------------------------------------------------------------------------

describe("update helpers — invariant preservation", () => {
  it("addSession → valid model", () => {
    let model = emptyModel();
    const sess: Session = makeSession(S1, [], null);
    model = addSession(model, sess);
    assert.deepEqual(checkInvariants(model), []);
  });

  it("addWindow + addPane → valid model", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S1, [], null));

    const win: Window = makeWindow(W1, S1, [], null);
    model = addWindow(model, win);
    assert.deepEqual(checkInvariants(model), [], "after addWindow");

    const p1: Pane = makePane(P1, W1, S1);
    model = addPane(model, p1);
    assert.deepEqual(checkInvariants(model), [], "after addPane P1");

    const p2: Pane = makePane(P2, W1, S1);
    model = addPane(model, p2);
    assert.deepEqual(checkInvariants(model), [], "after addPane P2");
  });

  it("removePane reassigns active or sets null, preserves invariants", () => {
    const model = validModel();
    // Remove active pane P1; helper should set activePaneId to P2
    const after = removePane(model, P1);
    const violations = checkInvariants(after);
    assert.deepEqual(violations, []);
    const win = after.windows.get(W1)!;
    assert.equal(win.activePaneId, P2, "active pane should have shifted to P2");
    assert.equal(win.paneIds.length, 1);
  });

  it("removePane on the last pane in a window → activePaneId null, valid", () => {
    const model = validModel();
    let m = removePane(model, P1);
    m = removePane(m, P2);
    const violations = checkInvariants(m);
    assert.deepEqual(violations, []);
    const win = m.windows.get(W1)!;
    assert.equal(win.paneIds.length, 0);
    assert.equal(win.activePaneId, null);
  });

  it("removeWindow cleans up panes and updates session, preserves invariants", () => {
    const model = validModel();
    const after = removeWindow(model, W1);
    assert.deepEqual(checkInvariants(after), []);
    assert.ok(!after.windows.has(W1));
    assert.ok(!after.panes.has(P1));
    assert.ok(!after.panes.has(P2));
    const sess = after.sessions.get(S1)!;
    assert.equal(sess.windowIds.length, 0);
    assert.equal(sess.activeWindowId, null);
  });

  it("removeSession cleans up all windows and panes, preserves invariants", () => {
    const model = validModel();
    const after = removeSession(model, S1);
    assert.deepEqual(checkInvariants(after), []);
    assert.ok(!after.sessions.has(S1));
    assert.ok(!after.windows.has(W1));
    assert.ok(!after.panes.has(P1));
    assert.ok(!after.panes.has(P2));
  });

  it("updatePane (resize) preserves invariants", () => {
    const model = validModel();
    const after = updatePane(model, P1, { cols: 120, rows: 40 });
    assert.deepEqual(checkInvariants(after), []);
    assert.equal(after.panes.get(P1)!.cols, 120);
    assert.equal(after.panes.get(P1)!.rows, 40);
  });

  it("updatePane (mode change) preserves invariants", () => {
    const model = validModel();
    const after = updatePane(model, P1, { mode: "copy" });
    assert.deepEqual(checkInvariants(after), []);
    assert.equal(after.panes.get(P1)!.mode, "copy");
  });

  it("updatePane (scrollbackHandle) preserves invariants", () => {
    const model = validModel();
    const handle = scrollbackHandle(42);
    const after = updatePane(model, P1, { scrollbackHandle: handle });
    assert.deepEqual(checkInvariants(after), []);
    assert.equal(after.panes.get(P1)!.scrollbackHandle, 42);
  });

  it("updateWindow (rename) preserves invariants", () => {
    const model = validModel();
    const after = updateWindow(model, W1, { name: "renamed" });
    assert.deepEqual(checkInvariants(after), []);
    assert.equal(after.windows.get(W1)!.name, "renamed");
  });

  it("updateSession (rename) preserves invariants", () => {
    const model = validModel();
    const after = updateSession(model, S1, { name: "new-session-name" });
    assert.deepEqual(checkInvariants(after), []);
    assert.equal(after.sessions.get(S1)!.name, "new-session-name");
  });

  it("setFocus preserves invariants when setting valid focus", () => {
    const model = validModel();
    const after = setFocus(model, { paneId: P2, windowId: W1, sessionId: S1 });
    // P2 is in W1 but not the activePaneId; focus-pane-not-active would fire,
    // but we also need to update the window's activePaneId for full validity.
    // setFocus alone doesn't fix the window's activePaneId — the reducer must.
    // So update the window too.
    const withActive = updateWindow(after, W1, { activePaneId: P2 });
    assert.deepEqual(checkInvariants(withActive), []);
  });

  it("setFocus to all-null is valid (no sessions)", () => {
    const model = emptyModel();
    const after = setFocus(model, { paneId: null, windowId: null, sessionId: null });
    assert.deepEqual(checkInvariants(after), []);
  });
});

// ---------------------------------------------------------------------------
// 4. parsedLayoutToWindowLayout
// ---------------------------------------------------------------------------

describe("parsedLayoutToWindowLayout", () => {
  it("converts a single-pane layout string to wire WindowLayout", () => {
    // "bb62,80x24,0,0,0" — single pane, tmux id 0
    const parsed = parseLayout("bb62,80x24,0,0,0");
    const result = parsedLayoutToWindowLayout(parsed, (id) => paneId(`p${id}`));
    assert.equal(result.cols, 80);
    assert.equal(result.rows, 24);
    assert.equal(result.root.kind, "pane");
    if (result.root.kind === "pane") {
      assert.equal(result.root.paneId, "p0");
      assert.deepEqual(result.root.rect, { x: 0, y: 0, cols: 80, rows: 24 });
    }
  });

  it("converts a two-pane horizontal split layout", () => {
    // Two panes side-by-side: "xxxx,80x24,0,0{40x24,0,0,1,39x24,41,0,2}"
    // Construct a layout string we know is valid
    const layoutStr = "e5d3,159x48,0,0{79x48,0,0,1,79x48,80,0,2}";
    const parsed = parseLayout(layoutStr);
    const result = parsedLayoutToWindowLayout(parsed, (id) => paneId(`p${id}`));
    assert.equal(result.cols, 159);
    assert.equal(result.rows, 48);
    assert.equal(result.root.kind, "hsplit");
    if (result.root.kind === "hsplit") {
      assert.equal(result.root.children.length, 2);
      const [left, right] = result.root.children;
      assert.equal(left!.kind, "pane");
      assert.equal(right!.kind, "pane");
      if (left!.kind === "pane") assert.equal(left!.paneId, "p1");
      if (right!.kind === "pane") assert.equal(right!.paneId, "p2");
    }
  });

  it("converts a nested split layout (vertical inside horizontal)", () => {
    // "e5d3,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}"
    const layoutStr = "e5d3,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}";
    const parsed = parseLayout(layoutStr);
    const result = parsedLayoutToWindowLayout(parsed, (id) => paneId(`p${id}`));
    assert.equal(result.root.kind, "hsplit");
    if (result.root.kind === "hsplit") {
      const right = result.root.children[1]!;
      assert.equal(right.kind, "vsplit");
      if (right.kind === "vsplit") {
        assert.equal(right.children.length, 2);
        assert.equal(right.children[0]!.kind, "pane");
        assert.equal(right.children[1]!.kind, "pane");
      }
    }
  });

  it("applies the tmuxPaneIdToWireId mapping correctly", () => {
    const parsed = parseLayout("bb62,80x24,0,0,7");
    // tmux id 7 should map to "my-pane"
    const result = parsedLayoutToWindowLayout(parsed, (_id) => paneId("my-pane"));
    assert.equal(result.root.kind, "pane");
    if (result.root.kind === "pane") {
      assert.equal(result.root.paneId, "my-pane");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Full helper-chain: build model via helpers, verify structure
// ---------------------------------------------------------------------------

describe("full helper chain — build model with helpers", () => {
  it("builds a multi-window multi-session model via helpers and passes invariants", () => {
    let model = emptyModel();

    // Add two sessions
    model = addSession(model, makeSession(S1, [], null, "session-one"));
    model = addSession(model, makeSession(S2, [], null, "session-two"));

    // Add windows and panes
    model = addWindow(model, makeWindow(W1, S1, [], null, "win-one"));
    model = addWindow(model, makeWindow(W2, S2, [], null, "win-two"));

    model = addPane(model, makePane(P1, W1, S1, 80, 24));
    model = addPane(model, makePane(P2, W1, S1, 80, 24));
    model = addPane(model, makePane(P3, W2, S2, 120, 40));

    // Set focus
    const win1 = model.windows.get(W1)!;
    model = updateWindow(model, W1, { activePaneId: P1 });
    model = setFocus(model, { paneId: P1, windowId: W1, sessionId: S1 });

    const violations = checkInvariants(model);
    assert.deepEqual(violations, []);

    // Check structure
    assert.equal(model.sessions.size, 2);
    assert.equal(model.windows.size, 2);
    assert.equal(model.panes.size, 3);
    assert.equal(model.windows.get(W1)!.paneIds.length, 2);
    assert.equal(model.windows.get(W2)!.paneIds.length, 1);
    assert.equal(model.panes.get(P3)!.cols, 120);
  });
});
