/**
 * Mirror tests — tc-eots acceptance criteria.
 *
 * Covers:
 *   1. Snapshot initializes the mirror.
 *   2. Each delta type updates the mirror correctly.
 *   3. Round-trip vs sessionProxy: apply snapshot(prev) + diff(prev, next) to the
 *      client mirror → mirror matches snapshot(next). Proves client/session-proxy
 *      consistency.
 *   4. Seq-gap detection: out-of-order delta fires onResyncNeeded; in-order
 *      deltas do not.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  // State model helpers — imported from @tmuxcc/session-proxy by package name.
  paneId,
  windowId,
  sessionId,
  emptyModel,
  addWindow,
  addPane,
  removePane,
  updatePane,
  updateWindow,
  updateSession,
  setFocus,
  projectSnapshot,
  diffModel,
} from "@tmuxcc/session-proxy";

import type {
  SessionModel,
  PaneId,
  WindowId,
  SessionId,
  SnapshotMessage,
  SessionProxyMessage,
  WindowLayout,
} from "@tmuxcc/session-proxy";

import { Mirror, applySnapshot, applyDelta } from "./mirror.js";
import type { ClientModel } from "./mirror.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const S1 = sessionId("s1");
const S2 = sessionId("s2");
const W1 = windowId("w1");
const W2 = windowId("w2");
const P1 = paneId("p1");
const P2 = paneId("p2");
const P3 = paneId("p3");

const LAYOUT_1: WindowLayout = {
  cols: 80,
  rows: 24,
  root: { kind: "pane", paneId: P1, rect: { x: 0, y: 0, cols: 80, rows: 24 } },
};

const LAYOUT_2: WindowLayout = {
  cols: 80,
  rows: 24,
  root: {
    kind: "hsplit",
    rect: { x: 0, y: 0, cols: 80, rows: 24 },
    children: [
      { kind: "pane", paneId: P1, rect: { x: 0, y: 0, cols: 40, rows: 24 } },
      { kind: "pane", paneId: P2, rect: { x: 40, y: 0, cols: 40, rows: 24 } },
    ],
  },
};

/** A representative snapshot: S1 → W1 → [P1, P2], focus P1/W1. (v3 single-session) */
function makeSnapshot(seq = 2): SnapshotMessage {
  return {
    type: "snapshot",
    seq,
    session: { sessionId: S1, name: "main" },
    windows: [
      {
        windowId: W1,
        name: "editor",
        active: true,
        layout: LAYOUT_2,
        synchronizePanes: false,
        monitorActivity: true,  // ── tc-7xv.15 ──
        monitorSilence: 0,      // ── tc-7xv.15 ──
      },
    ],
    panes: [
      { paneId: P1, windowId: W1, cols: 40, rows: 24 },
      { paneId: P2, windowId: W1, cols: 40, rows: 24 },
    ],
    focus: { paneId: P1, windowId: W1 },
  };
}

// ---------------------------------------------------------------------------
// SessionProxy-side model builders (for round-trip test)
// ---------------------------------------------------------------------------

function makeSession(
  id: SessionId,
  windowIds: readonly WindowId[],
  activeWindowId: WindowId | null,
  name = "test-session",
): import("@tmuxcc/session-proxy").Session {
  return { sessionId: id, name, windowIds, activeWindowId };
}

function makeWindow(
  id: WindowId,
  sessId: SessionId,
  paneIds: readonly PaneId[],
  activePaneId: PaneId | null,
  name = "test-window",
  layout: WindowLayout | null = null,
  synchronizePanes = false,
  monitorActivity = true,   // ── tc-7xv.15 ──
  monitorSilence = 0,       // ── tc-7xv.15 ──
): import("@tmuxcc/session-proxy").Window {
  return { windowId: id, sessionId: sessId, name, paneIds, activePaneId, layout, synchronizePanes, monitorActivity, monitorSilence }; // ── tc-7xv.15 ──
}

function makePane(
  id: PaneId,
  winId: WindowId,
  sessId: SessionId,
  cols = 80,
  rows = 24,
): import("@tmuxcc/session-proxy").Pane {
  return {
    paneId: id,
    windowId: winId,
    sessionId: sessId,
    cols,
    rows,
    mode: "normal",
    dead: false,
    exitCode: undefined,
    label: undefined,
    bound: false,
    detach: undefined,
    icon: undefined,
    // scrollbackHandle is optional — omit rather than passing undefined (exactOptionalPropertyTypes)
  };
}

/** Canonical base model: S1 → W1 → [P1(active), P2], layout=LAYOUT_2. Focus P1/W1/S1. */
function baseModel(): SessionModel {
  const sess = makeSession(S1, [W1], W1, "main");
  const win = makeWindow(W1, S1, [P1, P2], P1, "editor", LAYOUT_2);
  const p1 = makePane(P1, W1, S1, 40, 24);
  const p2 = makePane(P2, W1, S1, 40, 24);

  return {
    sessions: new Map([[S1, sess]]),
    windows: new Map([[W1, win]]),
    panes: new Map([[P1, p1], [P2, p2]]),
    focus: { paneId: P1, windowId: W1, sessionId: S1 },
  };
}

// ---------------------------------------------------------------------------
// Helpers for normalizing ClientModel for comparison
// ---------------------------------------------------------------------------

// v3 single-session: session is a scalar, no sessionId on windows/panes
function normalizeModel(model: ClientModel) {
  return {
    session: model.session,
    windows: [...model.windows.values()]
      .sort((a, b) => String(a.windowId).localeCompare(String(b.windowId)))
      .map(({ windowId, name, active, layout, synchronizePanes, monitorActivity, monitorSilence }) => ({
        windowId, name, active, layout, synchronizePanes, monitorActivity, monitorSilence, // ── tc-7xv.15 ──
      })),
    panes: [...model.panes.values()]
      .sort((a, b) => String(a.paneId).localeCompare(String(b.paneId)))
      .map(({ paneId, windowId, cols, rows }) => ({
        paneId, windowId, cols, rows,
      })),
    focus: model.focus,
  };
}

/** Normalize a SnapshotMessage into the same shape as normalizeModel (no mode/seq). */
function normalizeSnapshot(snap: SnapshotMessage) {
  return {
    session: snap.session,
    windows: [...snap.windows]
      .sort((a, b) => String(a.windowId).localeCompare(String(b.windowId)))
      .map(({ windowId, name, active, layout, synchronizePanes, monitorActivity, monitorSilence }) => ({
        windowId, name, active, layout, synchronizePanes, monitorActivity, monitorSilence, // ── tc-7xv.15 ──
      })),
    panes: [...snap.panes]
      .sort((a, b) => String(a.paneId).localeCompare(String(b.paneId)))
      .map(({ paneId, windowId, cols, rows }) => ({
        paneId, windowId, cols, rows,
      })),
    focus: snap.focus,
  };
}

// ---------------------------------------------------------------------------
// 1. Snapshot initializes the mirror
// ---------------------------------------------------------------------------

describe("applySnapshot — initializes mirror", () => {
  it("snapshot initializes session, windows, panes, layout, and focus", () => {
    const snap = makeSnapshot(5);
    const { model, seq } = applySnapshot(snap);

    assert.equal(seq, 5);

    // Session (v3: scalar, not a map)
    assert.equal(model.session.sessionId, S1);
    assert.equal(model.session.name, "main");

    // Windows
    assert.equal(model.windows.size, 1);
    const win = model.windows.get(W1);
    assert.ok(win, "window W1 should exist");
    assert.equal(win.name, "editor");
    assert.equal(win.active, true);
    assert.deepEqual(win.layout, LAYOUT_2);

    // Panes
    assert.equal(model.panes.size, 2);
    const pane1 = model.panes.get(P1);
    assert.ok(pane1);
    assert.equal(pane1.cols, 40);
    assert.equal(pane1.rows, 24);
    assert.equal(pane1.mode, "normal"); // default
    const pane2 = model.panes.get(P2);
    assert.ok(pane2);
    assert.equal(pane2.cols, 40);
    assert.equal(pane2.rows, 24);

    // Focus (v3: no sessionId)
    assert.deepEqual(model.focus, { paneId: P1, windowId: W1 });
  });

  it("snapshot with no panes/windows produces minimal model with null focus", () => {
    const snap: SnapshotMessage = {
      type: "snapshot",
      seq: 2,
      session: { sessionId: S1, name: "empty" },
      windows: [],
      panes: [],
      focus: { paneId: null, windowId: null },
    };
    const { model, seq } = applySnapshot(snap);
    assert.equal(seq, 2);
    assert.equal(model.session.sessionId, S1);
    assert.equal(model.windows.size, 0);
    assert.equal(model.panes.size, 0);
    assert.deepEqual(model.focus, { paneId: null, windowId: null });
  });

  it("Mirror.receiveSnapshot initializes and fires onModelChange", () => {
    const mirror = new Mirror();
    let changeCount = 0;
    let lastModel: ClientModel | undefined;
    mirror.onModelChange((m) => {
      changeCount++;
      lastModel = m;
    });

    assert.equal(mirror.initialized, false);
    mirror.receiveSnapshot(makeSnapshot(3));
    assert.equal(mirror.initialized, true);
    assert.equal(changeCount, 1);
    assert.ok(lastModel);
    assert.equal(lastModel.session.sessionId, S1);
    assert.deepEqual(mirror.getModel(), lastModel);
  });

  it("Mirror.receiveSnapshot replaces previous state on re-init", () => {
    const mirror = new Mirror();
    mirror.receiveSnapshot(makeSnapshot(2));
    assert.equal(mirror.getModel().session.sessionId, S1);

    // Re-init with another snapshot
    mirror.receiveSnapshot({
      type: "snapshot",
      seq: 10,
      session: { sessionId: S2, name: "other" },
      windows: [],
      panes: [],
      focus: { paneId: null, windowId: null },
    });
    assert.equal(mirror.getModel().session.sessionId, S2);
  });
});

// ---------------------------------------------------------------------------
// 2. Each delta type updates the mirror correctly
// ---------------------------------------------------------------------------

describe("applyDelta — pane deltas", () => {
  it("pane.opened adds a new pane with mode=normal", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    const msg: SessionProxyMessage = {
      type: "pane.opened",
      seq: 3,
      paneId: P3,
      windowId: W1,
      cols: 30,
      rows: 24,
      active: false,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.panes.size, 3);
    const p3 = model.panes.get(P3);
    assert.ok(p3);
    assert.equal(p3.cols, 30);
    assert.equal(p3.rows, 24);
    assert.equal(p3.mode, "normal");
    assert.equal(p3.windowId, W1);
  });

  it("pane.closed removes a pane", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    const msg: SessionProxyMessage = {
      type: "pane.closed",
      seq: 3,
      paneId: P2,
      windowId: W1,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.panes.size, 1);
    assert.ok(!model.panes.has(P2));
    assert.ok(model.panes.has(P1));
  });

  it("pane.resized updates cols and rows", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "pane.resized",
      seq: 2,
      paneId: P1,
      cols: 120,
      rows: 40,
    };
    const model = applyDelta(init, msg);
    const p1 = model.panes.get(P1);
    assert.ok(p1);
    assert.equal(p1.cols, 120);
    assert.equal(p1.rows, 40);
    // Other pane unchanged
    assert.equal(model.panes.get(P2)!.cols, 40);
  });

  it("pane.mode-changed updates mode on the pane", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "pane.mode-changed",
      seq: 2,
      paneId: P1,
      mode: "copy",
    };
    const model = applyDelta(init, msg);
    assert.equal(model.panes.get(P1)!.mode, "copy");
    assert.equal(model.panes.get(P2)!.mode, "normal"); // unchanged
  });

  // tc-1a8z: durable pane-name channel.
  it("pane.label-changed sets the durable name on the pane", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const model = applyDelta(init, {
      type: "pane.label-changed",
      seq: 2,
      paneId: P1,
      label: "deploy",
    });
    assert.equal(model.panes.get(P1)!.label, "deploy");
    assert.equal(model.panes.get(P2)!.label, undefined); // unchanged
  });

  it("pane.label-changed with label absent clears the durable name", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const named = applyDelta(init, {
      type: "pane.label-changed",
      seq: 2,
      paneId: P1,
      label: "deploy",
    });
    assert.equal(named.panes.get(P1)!.label, "deploy");
    const cleared = applyDelta(named, {
      type: "pane.label-changed",
      seq: 3,
      paneId: P1,
    });
    assert.equal(cleared.panes.get(P1)!.label, undefined, "name cleared when label absent");
  });

  it("applySnapshot carries SnapshotPane.label into the model", () => {
    const base = makeSnapshot(2);
    const snap: SnapshotMessage = {
      ...base,
      panes: base.panes.map((p) => (p.paneId === P1 ? { ...p, label: "tests" } : p)),
    };
    const { model } = applySnapshot(snap);
    assert.equal(model.panes.get(P1)!.label, "tests");
    assert.equal(model.panes.get(P2)!.label, undefined);
  });
});

// ── Dead-pane shape (tc-4bv2 / tc-295a.10) ──────────────────────────────────

describe("dead-pane mirror shape (tc-4bv2 / tc-295a.10)", () => {
  it("applySnapshot reads dead/exitCode from a dead SnapshotPane", () => {
    const snap: SnapshotMessage = {
      type: "snapshot",
      seq: 2,
      session: { sessionId: S1, name: "main" },
      windows: [
        { windowId: W1, name: "shell", active: true, layout: makeSnapshot(2).windows[0]!.layout,
          synchronizePanes: false, monitorActivity: true, monitorSilence: 0 },
      ],
      panes: [
        { paneId: P1, windowId: W1, cols: 80, rows: 24, dead: true, exitCode: 0 },
        { paneId: P2, windowId: W1, cols: 40, rows: 24 },
      ],
      focus: { paneId: P1, windowId: W1 },
    };
    const { model } = applySnapshot(snap);
    assert.equal(model.panes.get(P1)!.dead, true);
    assert.equal(model.panes.get(P1)!.exitCode, 0);
    assert.equal(model.panes.get(P2)!.dead, false, "live pane defaults dead:false");
    assert.equal(model.panes.get(P2)!.exitCode, undefined);
  });

  it("pane.opened born-dead carries dead/exitCode into the model", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    const msg: SessionProxyMessage = {
      type: "pane.opened",
      seq: 3,
      paneId: P3,
      windowId: W1,
      cols: 30,
      rows: 24,
      active: false,
      dead: true,
      exitCode: 7,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.panes.get(P3)!.dead, true);
    assert.equal(model.panes.get(P3)!.exitCode, 7);
  });

  it("pane.dead-changed flips dead in place (pane stays in the model)", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    assert.equal(init.panes.get(P1)!.dead, false);
    const dead = applyDelta(init, {
      type: "pane.dead-changed", seq: 3, paneId: P1, dead: true, exitCode: 137,
    } as SessionProxyMessage);
    assert.ok(dead.panes.has(P1), "pane still present");
    assert.equal(dead.panes.get(P1)!.dead, true);
    assert.equal(dead.panes.get(P1)!.exitCode, 137);

    // Respawn back to live clears the exit code.
    const live = applyDelta(dead, {
      type: "pane.dead-changed", seq: 4, paneId: P1, dead: false,
    } as SessionProxyMessage);
    assert.equal(live.panes.get(P1)!.dead, false);
    assert.equal(live.panes.get(P1)!.exitCode, undefined);
  });

  it("pane.dead-changed for an unknown pane is a no-op", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    const model = applyDelta(init, {
      type: "pane.dead-changed", seq: 3, paneId: P3, dead: true,
    } as SessionProxyMessage);
    assert.equal(model, init, "same reference — no change");
  });
});

describe("applyDelta — window deltas", () => {
  it("window.added adds a new window with zero-layout placeholder", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    const msg: SessionProxyMessage = {
      type: "window.added",
      seq: 3,
      windowId: W2,
      name: "terminal",
      active: false,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.size, 2);
    const w2 = model.windows.get(W2);
    assert.ok(w2);
    assert.equal(w2.name, "terminal");
    assert.equal(w2.active, false);
    assert.equal(w2.layout.cols, 0); // zero-layout placeholder
  });

  it("window.added with active=true clears other windows' active flags", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    assert.equal(init.windows.get(W1)!.active, true);

    const msg: SessionProxyMessage = {
      type: "window.added",
      seq: 3,
      windowId: W2,
      name: "terminal",
      active: true,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.active, false); // cleared
    assert.equal(model.windows.get(W2)!.active, true);
  });

  it("window.closed removes the window", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    const msg: SessionProxyMessage = {
      type: "window.closed",
      seq: 3,
      windowId: W1,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.size, 0);
    assert.ok(!model.windows.has(W1));
  });

  it("window.renamed updates the window name", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.renamed",
      seq: 2,
      windowId: W1,
      newName: "shell",
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.name, "shell");
  });

  // tc-7xv.12 — synchronize-panes toggle
  it("window.sync.changed sets synchronizePanes to true", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    assert.equal(init.windows.get(W1)!.synchronizePanes, false); // default

    const msg: SessionProxyMessage = {
      type: "window.sync.changed",
      seq: 2,
      windowId: W1,
      on: true,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.synchronizePanes, true);
    // other window fields must be preserved
    assert.equal(model.windows.get(W1)!.name, "editor");
  });

  it("window.sync.changed sets synchronizePanes to false", () => {
    // Start with sync on — use a snapshot that has synchronizePanes: true
    const snap: SnapshotMessage = {
      ...makeSnapshot(1),
      windows: [{ windowId: W1, name: "editor", active: true, layout: LAYOUT_2, synchronizePanes: true, monitorActivity: true, monitorSilence: 0 }], // ── tc-7xv.15 ──
    };
    const { model: init } = applySnapshot(snap);
    assert.equal(init.windows.get(W1)!.synchronizePanes, true);

    const msg: SessionProxyMessage = {
      type: "window.sync.changed",
      seq: 2,
      windowId: W1,
      on: false,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.synchronizePanes, false);
  });

  it("window.sync.changed is no-op when value unchanged", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.sync.changed",
      seq: 2,
      windowId: W1,
      on: false, // already false
    };
    const model = applyDelta(init, msg);
    // Reference equality: same model returned since nothing changed.
    assert.strictEqual(model, init);
  });

  it("window.sync.changed is no-op for unknown window", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.sync.changed",
      seq: 2,
      windowId: W2, // not in model
      on: true,
    };
    const model = applyDelta(init, msg);
    assert.strictEqual(model, init);
  });

  it("snapshot populates synchronizePanes from snapshot windows", () => {
    const snap: SnapshotMessage = {
      ...makeSnapshot(1),
      windows: [{ windowId: W1, name: "editor", active: true, layout: LAYOUT_2, synchronizePanes: true, monitorActivity: true, monitorSilence: 0 }], // ── tc-7xv.15 ──
    };
    const { model } = applySnapshot(snap);
    assert.equal(model.windows.get(W1)!.synchronizePanes, true);
  });

  it("window.added defaults synchronizePanes to false", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.added",
      seq: 2,
      windowId: W2,
      name: "new",
      active: false,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W2)!.synchronizePanes, false);
  });
});

// ── tc-7xv.15 ────────────────────────────────────────────────────────────────

describe("applyDelta — window.monitor.activity.changed (tc-7xv.15)", () => {
  it("sets monitorActivity to false", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    assert.equal(init.windows.get(W1)!.monitorActivity, true); // snapshot default

    const msg: SessionProxyMessage = {
      type: "window.monitor.activity.changed",
      seq: 2,
      windowId: W1,
      on: false,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.monitorActivity, false);
    // Other window fields preserved
    assert.equal(model.windows.get(W1)!.name, "editor");
  });

  it("sets monitorActivity to true", () => {
    // Start with monitorActivity: false
    const snap: SnapshotMessage = {
      ...makeSnapshot(1),
      windows: [{ windowId: W1, name: "editor", active: true, layout: LAYOUT_2, synchronizePanes: false, monitorActivity: false, monitorSilence: 0 }],
    };
    const { model: init } = applySnapshot(snap);
    assert.equal(init.windows.get(W1)!.monitorActivity, false);

    const msg: SessionProxyMessage = {
      type: "window.monitor.activity.changed",
      seq: 2,
      windowId: W1,
      on: true,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.monitorActivity, true);
  });

  it("is no-op when value unchanged (reference equality)", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    // monitorActivity is already true in default snapshot
    const msg: SessionProxyMessage = {
      type: "window.monitor.activity.changed",
      seq: 2,
      windowId: W1,
      on: true,
    };
    const model = applyDelta(init, msg);
    assert.strictEqual(model, init, "same reference on no-op");
  });

  it("is no-op for unknown window", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.monitor.activity.changed",
      seq: 2,
      windowId: W2, // not in model
      on: false,
    };
    const model = applyDelta(init, msg);
    assert.strictEqual(model, init);
  });

  it("snapshot populates monitorActivity from snapshot windows", () => {
    const snap: SnapshotMessage = {
      ...makeSnapshot(1),
      windows: [{ windowId: W1, name: "editor", active: true, layout: LAYOUT_2, synchronizePanes: false, monitorActivity: false, monitorSilence: 0 }],
    };
    const { model } = applySnapshot(snap);
    assert.equal(model.windows.get(W1)!.monitorActivity, false);
  });

  it("window.added defaults monitorActivity to true", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.added",
      seq: 2,
      windowId: W2,
      name: "new",
      active: false,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W2)!.monitorActivity, true);
  });
});

describe("applyDelta — window.monitor.silence.changed (tc-7xv.15)", () => {
  it("sets monitorSilence to 30", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    assert.equal(init.windows.get(W1)!.monitorSilence, 0); // default is 0 (off)

    const msg: SessionProxyMessage = {
      type: "window.monitor.silence.changed",
      seq: 2,
      windowId: W1,
      seconds: 30,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.monitorSilence, 30);
    // Other window fields preserved
    assert.equal(model.windows.get(W1)!.name, "editor");
  });

  it("sets monitorSilence back to 0 (disable)", () => {
    // Start with monitorSilence: 60
    const snap: SnapshotMessage = {
      ...makeSnapshot(1),
      windows: [{ windowId: W1, name: "editor", active: true, layout: LAYOUT_2, synchronizePanes: false, monitorActivity: true, monitorSilence: 60 }],
    };
    const { model: init } = applySnapshot(snap);
    assert.equal(init.windows.get(W1)!.monitorSilence, 60);

    const msg: SessionProxyMessage = {
      type: "window.monitor.silence.changed",
      seq: 2,
      windowId: W1,
      seconds: 0,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W1)!.monitorSilence, 0);
  });

  it("is no-op when value unchanged (reference equality)", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    // monitorSilence is already 0 in default snapshot
    const msg: SessionProxyMessage = {
      type: "window.monitor.silence.changed",
      seq: 2,
      windowId: W1,
      seconds: 0,
    };
    const model = applyDelta(init, msg);
    assert.strictEqual(model, init, "same reference on no-op");
  });

  it("is no-op for unknown window", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.monitor.silence.changed",
      seq: 2,
      windowId: W2, // not in model
      seconds: 45,
    };
    const model = applyDelta(init, msg);
    assert.strictEqual(model, init);
  });

  it("snapshot populates monitorSilence from snapshot windows", () => {
    const snap: SnapshotMessage = {
      ...makeSnapshot(1),
      windows: [{ windowId: W1, name: "editor", active: true, layout: LAYOUT_2, synchronizePanes: false, monitorActivity: true, monitorSilence: 120 }],
    };
    const { model } = applySnapshot(snap);
    assert.equal(model.windows.get(W1)!.monitorSilence, 120);
  });

  it("window.added defaults monitorSilence to 0", () => {
    const { model: init } = applySnapshot(makeSnapshot(1));
    const msg: SessionProxyMessage = {
      type: "window.added",
      seq: 2,
      windowId: W2,
      name: "new",
      active: false,
    };
    const model = applyDelta(init, msg);
    assert.equal(model.windows.get(W2)!.monitorSilence, 0);
  });
});

// ── end tc-7xv.15 ────────────────────────────────────────────────────────────

describe("applyDelta — layout delta", () => {
  it("layout.updated replaces the window layout", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    assert.deepEqual(init.windows.get(W1)!.layout, LAYOUT_2);

    const msg: SessionProxyMessage = {
      type: "layout.updated",
      seq: 3,
      windowId: W1,
      layout: LAYOUT_1,
    };
    const model = applyDelta(init, msg);
    assert.deepEqual(model.windows.get(W1)!.layout, LAYOUT_1);
  });
});

describe("applyDelta — focus delta", () => {
  it("focus.changed updates focus pair and active flags on windows (v3: no sessionId)", () => {
    // Two-window snapshot (single session, v3)
    const snap: SnapshotMessage = {
      type: "snapshot",
      seq: 2,
      session: { sessionId: S1, name: "main" },
      windows: [
        { windowId: W1, name: "editor", active: true, layout: LAYOUT_1, synchronizePanes: false, monitorActivity: true, monitorSilence: 0 },
        { windowId: W2, name: "shell", active: false, layout: LAYOUT_1, synchronizePanes: false, monitorActivity: true, monitorSilence: 0 },
      ],
      panes: [
        { paneId: P1, windowId: W1, cols: 80, rows: 24 },
        { paneId: P2, windowId: W2, cols: 80, rows: 24 },
      ],
      focus: { paneId: P1, windowId: W1 },
    };
    const { model: init } = applySnapshot(snap);

    const msg: SessionProxyMessage = {
      type: "focus.changed",
      seq: 3,
      paneId: P2,
      windowId: W2,
    };
    const model = applyDelta(init, msg);

    // Focus pair updated (v3: no sessionId)
    assert.deepEqual(model.focus, { paneId: P2, windowId: W2 });
    // Window active flags updated
    assert.equal(model.windows.get(W1)!.active, false);
    assert.equal(model.windows.get(W2)!.active, true);
  });
});

describe("applyDelta — session deltas (v3: only session.renamed on session-proxy wire)", () => {
  it("session.renamed updates the bound session name (no sessionId in v3)", () => {
    const { model: init } = applySnapshot(makeSnapshot(2));
    assert.equal(init.session.name, "main");

    const msg: SessionProxyMessage = {
      type: "session.renamed",
      seq: 3,
      newName: "production",
    };
    const model = applyDelta(init, msg);
    assert.equal(model.session.name, "production");
    assert.equal(model.session.sessionId, S1); // sessionId unchanged
  });
});

// ---------------------------------------------------------------------------
// 3. Round-trip vs session-proxy
//
// Build two session-proxy-side SessionModels (prev/next), compute:
//   snapshot = projectSnapshot(prev)
//   deltas   = diffModel(prev, next)
// Apply snapshot to client mirror, then apply each delta.
// Assert that the final client mirror matches projectSnapshot(next).
//
// This proves client and session-proxy agree on the round-trip consistency property.
// ---------------------------------------------------------------------------

describe("round-trip vs sessionProxy: client mirror == projectSnapshot(next)", () => {
  /**
   * Run a round-trip: prev → client mirror after snapshot+deltas == next's snapshot.
   */
  function roundTrip(prev: SessionModel, next: SessionModel): void {
    // SessionProxy side: produce snapshot + deltas
    const snapPrev = projectSnapshot(prev, { seq: 1 });
    const deltas = diffModel(prev, next);

    // Stamp sequential seq values onto the deltas (diffModel returns seq:0
    // placeholders; the E4 runtime would stamp real values).
    let seq = snapPrev.seq;
    const stampedDeltas: SessionProxyMessage[] = deltas.map((d) => ({
      ...d,
      seq: ++seq,
    }));

    // Client side: initialize mirror from snapshot, apply each delta
    const mirror = new Mirror();
    mirror.receiveSnapshot(snapPrev);
    for (const delta of stampedDeltas) {
      mirror.receiveDelta(delta);
    }

    // Ground truth: what the session-proxy would send as a fresh snapshot for `next`
    const snapNext = projectSnapshot(next, { seq: 1 });

    // Compare (normalized, without mode — SnapshotPane has no mode field)
    assert.deepEqual(
      normalizeModel(mirror.getModel()),
      normalizeSnapshot(snapNext),
    );
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
    const next = updateWindow(prev, W1, { name: "shell" });
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

  it("add window + pane (multi-change within single session)", () => {
    // v3: single-session. Add a second window and pane to the bound session.
    const prev = baseModel();
    let next = addWindow(prev, makeWindow(W2, S1, [], null, "shell", null));
    next = addPane(next, makePane(P3, W2, S1, 100, 40));
    roundTrip(prev, next);
  });

  it("simultaneous rename + resize (multi-change)", () => {
    const prev = baseModel();
    let next = updateWindow(prev, W1, { name: "renamed" });
    next = updatePane(next, P1, { cols: 120, rows: 40 });
    roundTrip(prev, next);
  });

  it("session rename", () => {
    const prev = baseModel();
    const next = updateSession(prev, S1, { name: "renamed-session" });
    roundTrip(prev, next);
  });

  // tc-7xv.12: synchronize-panes toggle
  it("synchronizePanes toggle off→on (window.sync.changed round-trip)", () => {
    const prev = baseModel(); // synchronizePanes defaults to false
    const next = updateWindow(prev, W1, { synchronizePanes: true });
    roundTrip(prev, next);
  });

  it("synchronizePanes toggle on→off (window.sync.changed round-trip)", () => {
    const prev = updateWindow(baseModel(), W1, { synchronizePanes: true });
    const next = updateWindow(prev, W1, { synchronizePanes: false });
    roundTrip(prev, next);
  });
});

// ---------------------------------------------------------------------------
// 4. Seq-gap detection
// ---------------------------------------------------------------------------

describe("seq-gap detection", () => {
  it("in-order deltas do not trigger onResyncNeeded", () => {
    const mirror = new Mirror();
    let resyncFired = false;
    mirror.onResyncNeeded(() => {
      resyncFired = true;
    });

    mirror.receiveSnapshot(makeSnapshot(5));

    // Apply two in-order deltas: seq 6, then 7
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 6,
      paneId: P1,
      cols: 100,
      rows: 30,
    });
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 7,
      paneId: P2,
      cols: 50,
      rows: 30,
    });

    assert.equal(resyncFired, false);
    // Changes were applied
    assert.equal(mirror.getModel().panes.get(P1)!.cols, 100);
    assert.equal(mirror.getModel().panes.get(P2)!.cols, 50);
  });

  it("delta with seq gap (N+2 after N) fires onResyncNeeded and is NOT applied", () => {
    const mirror = new Mirror();
    let gapExpected: number | undefined;
    let gapReceived: number | undefined;
    mirror.onResyncNeeded((gap) => {
      gapExpected = gap.expected;
      gapReceived = gap.received;
    });

    mirror.receiveSnapshot(makeSnapshot(5)); // lastSeq = 5

    // Apply seq 6 (ok), then skip to seq 8 (gap: expected 7, got 8)
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 6,
      paneId: P1,
      cols: 100,
      rows: 30,
    });

    assert.equal(gapExpected, undefined); // no gap yet

    mirror.receiveDelta({
      type: "pane.resized",
      seq: 8, // gap! expected 7
      paneId: P2,
      cols: 200,
      rows: 50,
    });

    // Gap detected
    assert.ok(gapExpected !== undefined);
    assert.equal(gapExpected, 7);
    assert.equal(gapReceived, 8);

    // The out-of-order delta was NOT applied — P2 size unchanged
    assert.equal(mirror.getModel().panes.get(P2)!.cols, 40);
  });

  it("tc-295a.31: an interleaved command.response consumes a seq slot and does NOT cause a false gap", () => {
    // Regression for the W2 integration break (tc-295a.31): the server stamps
    // command.response from the same per-connection monotonic seq counter as
    // snapshot+deltas (serve.ts), so the mirror MUST advance #lastSeq for it.
    // Pre-fix the mirror skipped command.response without advancing #lastSeq,
    // so the NEXT real delta read as a gap → resync → the split's pane.opened
    // was dropped (pane in tmux but absent from the tree).
    const mirror = new Mirror();
    let resyncFired = false;
    mirror.onResyncNeeded(() => {
      resyncFired = true;
    });
    let respSeen: string | undefined;
    mirror.onCommandResponse((m) => {
      respSeen = m.correlationId;
    });

    mirror.receiveSnapshot(makeSnapshot(2)); // lastSeq = 2

    // seq 3: a real delta (the split's pane.opened analogue) applies.
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 3,
      paneId: P1,
      cols: 100,
      rows: 30,
    });
    assert.equal(mirror.getModel().panes.get(P1)!.cols, 100);

    // seq 4: the creating verb's command.response. It is forwarded to the
    // handler AND consumes its seq slot (advances #lastSeq to 4).
    mirror.receiveDelta({
      type: "command.response",
      seq: 4,
      correlationId: "42",
      result: { ok: true, payload: { paneId: P2, windowId: W1 } },
    });
    assert.equal(respSeen, "42"); // handler fired
    assert.equal(resyncFired, false); // no gap

    // seq 5: the NEXT real delta must apply (pre-fix this read as a gap because
    // #lastSeq was stuck at 3).
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 5,
      paneId: P2,
      cols: 200,
      rows: 50,
    });
    assert.equal(resyncFired, false); // STILL no gap — the bug is fixed
    assert.equal(mirror.getModel().panes.get(P2)!.cols, 200); // applied
  });

  it("tc-295a.31: an interleaved error message consumes a seq slot and does NOT cause a false gap", () => {
    // Same seq-accounting contract as command.response: broadcastError stamps
    // and increments state.nextSeq, so the mirror must advance #lastSeq for it.
    const mirror = new Mirror();
    let resyncFired = false;
    mirror.onResyncNeeded(() => {
      resyncFired = true;
    });

    mirror.receiveSnapshot(makeSnapshot(2)); // lastSeq = 2

    mirror.receiveDelta({
      type: "error",
      seq: 3,
      code: "internal",
      message: "boom",
    });
    assert.equal(resyncFired, false);

    // seq 4 must apply (pre-fix #lastSeq stuck at 2 → false gap).
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 4,
      paneId: P1,
      cols: 77,
      rows: 25,
    });
    assert.equal(resyncFired, false);
    assert.equal(mirror.getModel().panes.get(P1)!.cols, 77);
  });

  it("delta before snapshot is silently ignored (mirror not initialized)", () => {
    const mirror = new Mirror();
    let resyncFired = false;
    mirror.onResyncNeeded(() => {
      resyncFired = true;
    });

    // No snapshot yet — delta should be silently dropped, no resync
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 1,
      paneId: P1,
      cols: 100,
      rows: 30,
    });

    assert.equal(resyncFired, false);
    assert.equal(mirror.initialized, false);
  });

  it("out-of-order delta (seq too low) fires onResyncNeeded", () => {
    const mirror = new Mirror();
    let gapExpected2: number | undefined;
    let gapReceived2: number | undefined;
    mirror.onResyncNeeded((gap) => {
      gapExpected2 = gap.expected;
      gapReceived2 = gap.received;
    });

    mirror.receiveSnapshot(makeSnapshot(10)); // lastSeq = 10

    // Delta with seq 9 (lower than expected 11) — also a gap
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 9,
      paneId: P1,
      cols: 100,
      rows: 30,
    });

    assert.ok(gapExpected2 !== undefined);
    assert.equal(gapExpected2, 11);
    assert.equal(gapReceived2, 9);
  });

  it("onResyncNeeded unsubscribe stops the handler from firing", () => {
    const mirror = new Mirror();
    let fireCount = 0;
    const unsub = mirror.onResyncNeeded(() => {
      fireCount++;
    });

    mirror.receiveSnapshot(makeSnapshot(1));
    unsub(); // unsubscribe before the gap

    // Now send a gap — handler should NOT fire
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 99, // big gap
      paneId: P1,
      cols: 100,
      rows: 30,
    });

    assert.equal(fireCount, 0);
  });

  it("multiple onResyncNeeded handlers all fire on gap", () => {
    const mirror = new Mirror();
    let count = 0;
    mirror.onResyncNeeded(() => count++);
    mirror.onResyncNeeded(() => count++);
    mirror.onResyncNeeded(() => count++);

    mirror.receiveSnapshot(makeSnapshot(1));
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 5, // gap: expected 2
      paneId: P1,
      cols: 100,
      rows: 30,
    });

    assert.equal(count, 3);
  });

  it("after resync (new snapshot), seq tracking resets and in-order deltas work", () => {
    const mirror = new Mirror();
    let resyncFired = false;
    mirror.onResyncNeeded(() => {
      resyncFired = true;
    });

    mirror.receiveSnapshot(makeSnapshot(1)); // lastSeq = 1
    // Gap
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 5,
      paneId: P1,
      cols: 100,
      rows: 30,
    });
    assert.equal(resyncFired, true);

    // Simulate resync: new snapshot
    resyncFired = false;
    mirror.receiveSnapshot(makeSnapshot(20)); // lastSeq = 20

    // Now in-order delta seq=21 should work
    mirror.receiveDelta({
      type: "pane.resized",
      seq: 21,
      paneId: P1,
      cols: 999,
      rows: 30,
    });

    assert.equal(resyncFired, false);
    assert.equal(mirror.getModel().panes.get(P1)!.cols, 999);
  });
});

// ---------------------------------------------------------------------------
// 5. Mirror.onModelChange
// ---------------------------------------------------------------------------

describe("Mirror.onModelChange", () => {
  it("fires after receiveSnapshot with new model", () => {
    const mirror = new Mirror();
    let fired = false;
    mirror.onModelChange((m) => {
      fired = true;
      assert.ok(m.session.sessionId !== "");
    });
    mirror.receiveSnapshot(makeSnapshot(1));
    assert.equal(fired, true);
  });

  it("fires after each successful receiveDelta", () => {
    const mirror = new Mirror();
    let count = 0;
    mirror.onModelChange(() => count++);

    mirror.receiveSnapshot(makeSnapshot(1));
    assert.equal(count, 1);

    mirror.receiveDelta({ type: "pane.resized", seq: 2, paneId: P1, cols: 99, rows: 24 });
    assert.equal(count, 2);

    mirror.receiveDelta({ type: "pane.resized", seq: 3, paneId: P2, cols: 50, rows: 24 });
    assert.equal(count, 3);
  });

  it("does NOT fire after a gap (delta not applied)", () => {
    const mirror = new Mirror();
    let count = 0;
    mirror.onModelChange(() => count++);

    mirror.receiveSnapshot(makeSnapshot(1));
    assert.equal(count, 1);

    // Gap: expected seq 2, got 5
    mirror.receiveDelta({ type: "pane.resized", seq: 5, paneId: P1, cols: 99, rows: 24 });
    assert.equal(count, 1); // no change fired
  });

  it("unsubscribe stops the handler", () => {
    const mirror = new Mirror();
    let count = 0;
    const unsub = mirror.onModelChange(() => count++);

    mirror.receiveSnapshot(makeSnapshot(1));
    assert.equal(count, 1);

    unsub();
    mirror.receiveDelta({ type: "pane.resized", seq: 2, paneId: P1, cols: 99, rows: 24 });
    assert.equal(count, 1); // not called after unsub
  });

  it("multiple handlers all fire in registration order", () => {
    const mirror = new Mirror();
    const order: number[] = [];
    mirror.onModelChange(() => order.push(1));
    mirror.onModelChange(() => order.push(2));
    mirror.onModelChange(() => order.push(3));

    mirror.receiveSnapshot(makeSnapshot(1));
    assert.deepEqual(order, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Per-pane attach + hydration protocol (tc-295a.8 / tc-295a.9)
// ---------------------------------------------------------------------------

describe("hydration / attach protocol events", () => {
  it("pane.hydration.begin/end surface on onHydrationEvent and advance seq (no false gap)", () => {
    const mirror = new Mirror();
    const events: Array<{ kind: string; paneId: string }> = [];
    mirror.onHydrationEvent((e) => events.push({ kind: e.kind, paneId: e.paneId as string }));
    let resyncFired = false;
    mirror.onResyncNeeded(() => { resyncFired = true; });

    mirror.receiveSnapshot(makeSnapshot(5)); // lastSeq = 5

    mirror.receiveDelta({ type: "pane.hydration.begin", seq: 6, paneId: P1 });
    mirror.receiveDelta({ type: "pane.hydration.end", seq: 7, paneId: P1 });
    // A real topology delta at seq 8 must NOT be seen as a gap — the sentinels
    // advanced the seq counter.
    mirror.receiveDelta({ type: "pane.resized", seq: 8, paneId: P1, cols: 99, rows: 30 });

    assert.equal(resyncFired, false, "sentinels must advance seq so no false gap");
    assert.deepEqual(events, [
      { kind: "begin", paneId: P1 },
      { kind: "end", paneId: P1 },
    ]);
    assert.equal(mirror.getModel().panes.get(P1)!.cols, 99, "the post-hydration delta applied");
  });

  it("pane.attach.failed surfaces a not-found event with code + message", () => {
    const mirror = new Mirror();
    const events: Array<{ kind: string; paneId: string; code?: string | undefined }> = [];
    mirror.onHydrationEvent((e) => events.push({ kind: e.kind, paneId: e.paneId as string, code: e.code }));

    mirror.receiveSnapshot(makeSnapshot(5));
    mirror.receiveDelta({
      type: "pane.attach.failed",
      seq: 6,
      paneId: P2,
      code: "pane.not-found",
      message: "Pane p2 is not present in the session model.",
    });

    assert.deepEqual(events, [{ kind: "not-found", paneId: P2, code: "pane.not-found" }]);
  });

  it("sentinels do not fire onModelChange (not state-bearing)", () => {
    const mirror = new Mirror();
    let changes = 0;
    mirror.receiveSnapshot(makeSnapshot(5));
    mirror.onModelChange(() => { changes++; });

    mirror.receiveDelta({ type: "pane.hydration.begin", seq: 6, paneId: P1 });
    mirror.receiveDelta({ type: "pane.hydration.end", seq: 7, paneId: P1 });

    assert.equal(changes, 0, "hydration sentinels must not trigger a model-change render");
  });
});
