/**
 * Tests for the model→wire projection (tc-7gp, updated tc-j9c.2 for single-session).
 *
 * Covers:
 *   1. Snapshot reflects full state (single session in `session` field).
 *   2. Deltas are minimal + correct (one change → one delta; sessionId stripped).
 *   3. Round-trip: applyDeltas(projectSnapshot(prev), diffModel(prev, next))
 *      deep-equals projectSnapshot(next).
 *   4. Ordering: pane.opened precedes focus.changed when a new pane is
 *      immediately focused.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectSnapshot, diffModel } from "./projection.js";
import { emptyModel, addSession, addWindow, addPane, removePane, removeWindow, updatePane, updateWindow, updateSession, setFocus, } from "./model.js";
import { paneId, windowId, sessionId } from "./model.js";
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
        kind: "pane",
        paneId: P1,
        rect: { x: 0, y: 0, cols: 80, rows: 24 },
    },
};
const LAYOUT_2 = {
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
function makeSession(id, windowIds, activeWindowId, name = "test-session") {
    return { sessionId: id, name, windowIds, activeWindowId };
}
function makeWindow(id, sessId, paneIds, activePaneId, name = "test-window", layout = null) {
    return { windowId: id, sessionId: sessId, name, paneIds, activePaneId, layout, synchronizePanes: false, monitorActivity: true, monitorSilence: 0 }; // ── tc-7xv.15 ──
}
function makePane(id, winId, sessId, cols = 80, rows = 24, dead = false, exitCode = undefined) {
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
        boundClients: new Set(),
        detach: undefined,
        icon: undefined,
        // scrollbackHandle and paneTitle are optional — omit to avoid
        // exactOptionalPropertyTypes TS2375 when passing undefined explicitly.
    };
}
/**
 * Build a canonical model: S1 → W1 → [P1(active), P2], layout=LAYOUT_2.
 * Focus: P1 / W1 / S1.
 */
function baseModel() {
    const sess = makeSession(S1, [W1], W1);
    const win = makeWindow(W1, S1, [P1, P2], P1, "main", LAYOUT_2);
    const p1 = makePane(P1, W1, S1, 80, 24);
    const p2 = makePane(P2, W1, S1, 40, 24);
    const sessions = new Map([[S1, sess]]);
    const windows = new Map([[W1, win]]);
    const panes = new Map([
        [P1, p1],
        [P2, p2],
    ]);
    const focus = { paneId: P1, windowId: W1, sessionId: S1 };
    return { sessions, windows, panes, focus };
}
/**
 * tc-4gor: from a baseModel() (S1 → W1 → [P1, P2]), produce the model after a
 * detached break-pane re-homes P2 into a NEW single-pane window W2. W1 keeps
 * P1; P2's `windowId` becomes W2. Structural maps are kept consistent (W1.paneIds
 * drops P2, W2 owns P2, P2.windowId === W2) so the result is a valid model.
 */
function rehomeP2ToW2(prev) {
    // Add the new window W2 owning P2. A freshly-added window carries a null
    // layout (window.added carries no layout tree; the real layout arrives on a
    // later requery as a layout.updated for the now-existing window) — matching
    // the existing "add a window + pane" round-trip fixture.
    let next = addWindow(prev, makeWindow(W2, S1, [P2], P2, "broken", null));
    // W1 reflows to a single-pane window holding only P1.
    const w1 = next.windows.get(W1);
    const windows = new Map(next.windows);
    windows.set(W1, { ...w1, paneIds: [P1], activePaneId: P1, layout: LAYOUT_1 });
    // P2 is re-homed: same id, new windowId.
    const p2 = next.panes.get(P2);
    const panes = new Map(next.panes);
    panes.set(P2, { ...p2, windowId: W2 });
    next = { ...next, windows, panes };
    return next;
}
// ---------------------------------------------------------------------------
// Round-trip helper: apply a sequence of deltas to a snapshot-shaped state.
//
// This is a reference applier used only in tests (not production code). It
// produces a new SnapshotMessage by folding over the delta list.
// In v3 single-session shape: no sessions array, no sessionId on deltas.
// ---------------------------------------------------------------------------
function applyDeltas(snap, deltas) {
    // Work on mutable copies of the flat arrays.
    let session = snap.session;
    let windows = [...snap.windows];
    let panes = [...snap.panes];
    let focus = { ...snap.focus };
    for (const delta of deltas) {
        switch (delta.type) {
            // --- session lifecycle (only rename on session-proxy wire) ---
            case "session.renamed":
                session = { ...session, newName: delta.newName };
                session = { sessionId: session.sessionId, name: delta.newName };
                break;
            // --- window lifecycle ---
            case "window.added":
                windows = [
                    ...windows.map((w) => delta.active ? { ...w, active: false } : w),
                    {
                        windowId: delta.windowId,
                        name: delta.name,
                        active: delta.active,
                        synchronizePanes: false,
                        monitorActivity: true, // ── tc-7xv.15 ──
                        monitorSilence: 0, // ── tc-7xv.15 ──
                        // layout will be filled by a subsequent layout.updated if needed.
                        layout: {
                            cols: 0,
                            rows: 0,
                            root: {
                                kind: "pane",
                                paneId: "",
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
                windows = windows.map((w) => w.windowId === delta.windowId ? { ...w, name: delta.newName } : w);
                break;
            // --- layout ---
            case "layout.updated":
                windows = windows.map((w) => w.windowId === delta.windowId ? { ...w, layout: delta.layout } : w);
                break;
            // --- pane lifecycle ---
            case "pane.opened":
                panes = [
                    ...panes,
                    {
                        paneId: delta.paneId,
                        windowId: delta.windowId,
                        cols: delta.cols,
                        rows: delta.rows,
                        // tc-4bv2 / tc-295a.10: carry born-dead state into the snapshot so
                        // the round-trip reconstructs SnapshotPane.dead/exitCode exactly.
                        ...(delta.dead ? { dead: true } : {}),
                        ...(delta.dead && delta.exitCode !== undefined ? { exitCode: delta.exitCode } : {}),
                        // tc-1a8z: carry a born durable name so the round-trip reconstructs
                        // SnapshotPane.label exactly.
                        ...(delta.label !== undefined ? { label: delta.label } : {}),
                    },
                ];
                break;
            case "pane.closed":
                panes = panes.filter((p) => p.paneId !== delta.paneId);
                break;
            case "pane.resized":
                panes = panes.map((p) => p.paneId === delta.paneId
                    ? { ...p, cols: delta.cols, rows: delta.rows }
                    : p);
                break;
            // tc-4gor: pane re-homed into a different window — update ONLY the pane's
            // windowId in place (the pane is moved, not recreated; identity preserved).
            case "pane.moved":
                panes = panes.map((p) => p.paneId === delta.paneId ? { ...p, windowId: delta.windowId } : p);
                break;
            // tc-4bv2 / tc-295a.10: dead-state flip on an existing pane. Mirror the
            // projection: present dead/exitCode only when dead, absent when alive.
            case "pane.dead-changed":
                panes = panes.map((p) => {
                    if (p.paneId !== delta.paneId)
                        return p;
                    const { dead: _d, exitCode: _e, ...rest } = p;
                    if (delta.dead) {
                        return delta.exitCode !== undefined
                            ? { ...rest, dead: true, exitCode: delta.exitCode }
                            : { ...rest, dead: true };
                    }
                    return { ...rest };
                });
                break;
            case "pane.mode-changed":
                // SnapshotPane has no mode field; ignore.
                break;
            // tc-1a8z: durable pane-name change. Mirror the projection: set label
            // when present, drop it when absent (name cleared).
            case "pane.label-changed":
                panes = panes.map((p) => {
                    if (p.paneId !== delta.paneId)
                        return p;
                    const { label: _l, ...rest } = p;
                    return delta.label !== undefined ? { ...rest, label: delta.label } : { ...rest };
                });
                break;
            // --- focus ---
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
            // Ignore session-proxy→client messages not relevant to snapshot state:
            default:
                break;
        }
    }
    return {
        type: "snapshot",
        seq: snap.seq,
        session,
        windows,
        panes,
        focus,
    };
}
/**
 * Normalize a SnapshotMessage for deep comparison: sort arrays by id so
 * order doesn't affect equality. Also strip seq (not part of state).
 */
function normalizeSnapshot(snap) {
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
            .map(({ paneId, windowId, cols, rows, dead, exitCode }) => ({
            paneId,
            windowId,
            cols,
            rows,
            // tc-4bv2 / tc-295a.10: include dead-pane state in the round-trip
            // comparison so diff↔snapshot agreement is verified for corpses.
            // Normalize absent → false/undefined so an alive pane on one side
            // compares equal to a pane with the fields omitted on the other.
            dead: dead ?? false,
            exitCode: dead ? exitCode : undefined,
        })),
        focus: snap.focus,
    };
}
// ---------------------------------------------------------------------------
// 1. Snapshot reflects full state
// ---------------------------------------------------------------------------
describe("projectSnapshot — full state (v3 single-session)", () => {
    it("empty model produces empty arrays and null focus", () => {
        const snap = projectSnapshot(emptyModel(), { seq: 1 });
        assert.equal(snap.type, "snapshot");
        assert.equal(snap.seq, 1);
        // Empty model — session is a placeholder with empty strings
        assert.equal(snap.session.sessionId, "");
        assert.deepEqual(snap.windows, []);
        assert.deepEqual(snap.panes, []);
        assert.deepEqual(snap.focus, { paneId: null, windowId: null });
    });
    it("snapshot carries single session in session field (not an array)", () => {
        const model = baseModel();
        const snap = projectSnapshot(model, { seq: 5 });
        assert.equal(snap.type, "snapshot");
        assert.equal(snap.seq, 5);
        // Single session field (not sessions[])
        assert.ok("session" in snap, "snapshot must have 'session' field");
        assert.ok(!("sessions" in snap), "snapshot must NOT have 'sessions' field");
        assert.equal(snap.session.sessionId, S1);
        assert.equal(snap.session.name, "test-session");
        // No 'active' field on SnapshotSession (always bound session)
        assert.ok(!("active" in snap.session), "SnapshotSession must not carry 'active' field");
    });
    it("snapshot contains all windows and panes", () => {
        const model = baseModel();
        const snap = projectSnapshot(model, { seq: 5 });
        // Windows — no sessionId field
        assert.equal(snap.windows.length, 1);
        const w = snap.windows[0];
        assert.equal(w.windowId, W1);
        assert.ok(!("sessionId" in w), "SnapshotWindow must not carry sessionId");
        assert.equal(w.name, "main");
        assert.equal(w.active, true);
        assert.deepEqual(w.layout, LAYOUT_2);
        // Panes — no sessionId field
        assert.equal(snap.panes.length, 2);
        const paneMap = new Map(snap.panes.map((p) => [p.paneId, p]));
        const sp1 = paneMap.get(P1);
        assert.equal(sp1.windowId, W1);
        assert.ok(!("sessionId" in sp1), "SnapshotPane must not carry sessionId");
        assert.equal(sp1.cols, 80);
        assert.equal(sp1.rows, 24);
        const sp2 = paneMap.get(P2);
        assert.equal(sp2.cols, 40);
        assert.equal(sp2.rows, 24);
    });
    it("focus carries paneId and windowId only (no sessionId)", () => {
        const model = baseModel();
        const snap = projectSnapshot(model, { seq: 5 });
        assert.deepEqual(snap.focus, { paneId: P1, windowId: W1 });
        assert.ok(!("sessionId" in snap.focus), "focus must not carry sessionId");
    });
    it("seq defaults to 2 when not provided (snapshot is always second message)", () => {
        const snap = projectSnapshot(emptyModel());
        assert.equal(snap.seq, 2);
    });
    it("snapshot panes carry cols/rows from model", () => {
        const model = baseModel();
        const snap = projectSnapshot(model);
        const p2snap = snap.panes.find((p) => p.paneId === P2);
        assert.ok(p2snap);
        assert.equal(p2snap.cols, 40);
        assert.equal(p2snap.rows, 24);
    });
    it("SnapshotPane has no bytes/content/sessionId field", () => {
        const model = baseModel();
        const snap = projectSnapshot(model);
        const pane = snap.panes[0];
        assert.ok(!("contents" in pane), "SnapshotPane must not carry byte contents");
        assert.ok(!("bytes" in pane), "SnapshotPane must not carry byte contents");
        assert.ok(!("sessionId" in pane), "SnapshotPane must not carry sessionId");
    });
    it("attachedClientCount is included when provided in opts", () => {
        const snap = projectSnapshot(emptyModel(), { seq: 2, attachedClientCount: 3 });
        assert.equal(snap.attachedClientCount, 3);
    });
    it("attachedClientCount is absent when not provided", () => {
        const snap = projectSnapshot(emptyModel(), { seq: 2 });
        assert.ok(!("attachedClientCount" in snap) || snap.attachedClientCount === undefined);
    });
});
// ---------------------------------------------------------------------------
// 2. Deltas are minimal + correct (one change → exactly the right delta)
// ---------------------------------------------------------------------------
describe("diffModel — minimal deltas (v3 single-session)", () => {
    it("identical models produce no deltas", () => {
        const model = baseModel();
        const deltas = diffModel(model, model);
        assert.deepEqual(deltas, []);
    });
    it("add a pane → exactly one pane.opened delta (no sessionId)", () => {
        const prev = baseModel();
        const next = addPane(prev, makePane(P3, W1, S1, 30, 24));
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d = deltas[0];
        assert.equal(d.type, "pane.opened");
        if (d.type === "pane.opened") {
            assert.equal(d.paneId, P3);
            assert.equal(d.windowId, W1);
            assert.ok(!("sessionId" in d), "pane.opened must not carry sessionId");
            assert.equal(d.cols, 30);
            assert.equal(d.rows, 24);
        }
    });
    it("remove a pane → exactly one pane.closed delta (no sessionId)", () => {
        const prev = baseModel();
        const next = removePane(prev, P2);
        const deltas = diffModel(prev, next);
        const closed = deltas.filter((d) => d.type === "pane.closed");
        assert.equal(closed.length, 1);
        const d = closed[0];
        if (d.type === "pane.closed") {
            assert.equal(d.paneId, P2);
            assert.equal(d.windowId, W1);
            assert.ok(!("sessionId" in d), "pane.closed must not carry sessionId");
        }
        assert.equal(deltas.filter((d) => d.type === "pane.opened").length, 0);
    });
    it("resize a pane → exactly one pane.resized delta", () => {
        const prev = baseModel();
        const next = updatePane(prev, P1, { cols: 120, rows: 40 });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d = deltas[0];
        assert.equal(d.type, "pane.resized");
        if (d.type === "pane.resized") {
            assert.equal(d.paneId, P1);
            assert.equal(d.cols, 120);
            assert.equal(d.rows, 40);
        }
    });
    it("break-pane re-home: pane's windowId changes → exactly one pane.moved delta (tc-4gor)", () => {
        // prev: W1 has [P1, P2]. next: P2 re-homed into a new window W2.
        const prev = baseModel();
        const next = rehomeP2ToW2(prev);
        const deltas = diffModel(prev, next);
        const types = deltas.map((d) => d.type);
        // No pane.opened / pane.closed — the pane KEEPS its identity (scrollback).
        assert.ok(!types.includes("pane.opened"), `unexpected pane.opened: ${types.join(", ")}`);
        assert.ok(!types.includes("pane.closed"), `unexpected pane.closed: ${types.join(", ")}`);
        // Exactly one pane.moved carrying P2's NEW windowId.
        const moved = deltas.filter((d) => d.type === "pane.moved");
        assert.equal(moved.length, 1, `expected exactly one pane.moved; got ${types.join(", ")}`);
        const d = moved[0];
        if (d.type === "pane.moved") {
            assert.equal(d.paneId, P2);
            assert.equal(d.windowId, W2);
            assert.ok(!("sessionId" in d), "pane.moved must not carry sessionId");
        }
        // window.added (announces W2) must precede pane.moved (re-homes P2 into W2).
        assert.ok(types.indexOf("window.added") < types.indexOf("pane.moved"), `window.added must precede pane.moved; got ${types.join(", ")}`);
    });
    it("a pane whose windowId is unchanged → no pane.moved delta (tc-4gor)", () => {
        const prev = baseModel();
        // Resize P1 in place — windowId unchanged. Must NOT emit pane.moved.
        const next = updatePane(prev, P1, { cols: 120 });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.filter((d) => d.type === "pane.moved").length, 0, "pane.moved must not fire when windowId is unchanged");
    });
    it("pane mode change → exactly one pane.mode-changed delta", () => {
        const prev = baseModel();
        const next = updatePane(prev, P1, { mode: "copy" });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d = deltas[0];
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
        const d = deltas[0];
        assert.equal(d.type, "window.renamed");
        if (d.type === "window.renamed") {
            assert.equal(d.windowId, W1);
            assert.equal(d.newName, "renamed-window");
        }
    });
    it("add a window → exactly one window.added delta (no sessionId)", () => {
        const prev = baseModel();
        const next = addWindow(prev, makeWindow(W2, S1, [], null, "second-window"));
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d = deltas[0];
        assert.equal(d.type, "window.added");
        if (d.type === "window.added") {
            assert.equal(d.windowId, W2);
            assert.ok(!("sessionId" in d), "window.added must not carry sessionId");
            assert.equal(d.name, "second-window");
        }
    });
    it("remove a window → exactly one window.closed delta (no sessionId)", () => {
        let prev = baseModel();
        prev = addWindow(prev, makeWindow(W2, S1, [], null, "second-window"));
        const next = removeWindow(prev, W2);
        const deltas = diffModel(prev, next);
        const closed = deltas.filter((d) => d.type === "window.closed");
        assert.equal(closed.length, 1);
        const closedMsg = closed[0];
        if (closedMsg.type === "window.closed") {
            assert.equal(closedMsg.windowId, W2);
            assert.ok(!("sessionId" in closedMsg), "window.closed must not carry sessionId");
        }
        assert.equal(deltas.filter((d) => d.type === "window.added").length, 0);
    });
    it("layout change → exactly one layout.updated delta (no sessionId)", () => {
        const prev = baseModel();
        const newLayout = {
            cols: 80,
            rows: 24,
            root: {
                kind: "pane",
                paneId: P1,
                rect: { x: 0, y: 0, cols: 80, rows: 24 },
            },
        };
        const next = updateWindow(prev, W1, { layout: newLayout });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d = deltas[0];
        assert.equal(d.type, "layout.updated");
        if (d.type === "layout.updated") {
            assert.equal(d.windowId, W1);
            assert.ok(!("sessionId" in d), "layout.updated must not carry sessionId");
            assert.deepEqual(d.layout, newLayout);
        }
    });
    it("focus change → exactly one focus.changed delta (no sessionId)", () => {
        const prev = baseModel();
        let next = updateWindow(prev, W1, { activePaneId: P2 });
        next = setFocus(next, { paneId: P2, windowId: W1, sessionId: S1 });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d = deltas[0];
        assert.equal(d.type, "focus.changed");
        if (d.type === "focus.changed") {
            assert.equal(d.paneId, P2);
            assert.equal(d.windowId, W1);
            assert.ok(!("sessionId" in d), "focus.changed must not carry sessionId");
        }
    });
    it("session rename → exactly one session.renamed delta (no sessionId)", () => {
        const prev = baseModel();
        const next = updateSession(prev, S1, { name: "renamed-session" });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d = deltas[0];
        assert.equal(d.type, "session.renamed");
        if (d.type === "session.renamed") {
            assert.ok(!("sessionId" in d), "session.renamed must not carry sessionId");
            assert.equal(d.newName, "renamed-session");
        }
    });
    it("no spurious deltas when unchanged pane exists alongside changed one", () => {
        const prev = baseModel();
        const next = updatePane(prev, P1, { cols: 100, rows: 30 });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.length, 1);
        const d0 = deltas[0];
        assert.equal(d0.type, "pane.resized");
        if (d0.type === "pane.resized") {
            assert.equal(d0.paneId, P1);
        }
    });
});
// ---------------------------------------------------------------------------
// 3. Round-trip: applyDeltas(projectSnapshot(prev), diffModel(prev, next))
//               deep-equals projectSnapshot(next)
// ---------------------------------------------------------------------------
describe("round-trip: applyDeltas(snapshot(prev), diff(prev,next)) == snapshot(next)", () => {
    function roundTrip(prev, next) {
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
    it("add a window + pane (multi-change)", () => {
        const prev = baseModel();
        let next = addWindow(prev, makeWindow(W2, S1, [], null, "win-two"));
        next = addPane(next, makePane(P3, W2, S1, 100, 40));
        roundTrip(prev, next);
    });
    it("break-pane re-home (window-membership change) round-trips (tc-4gor)", () => {
        const prev = baseModel();
        // P2 breaks out of W1 into a new window W2.
        const next = rehomeP2ToW2(prev);
        roundTrip(prev, next);
    });
    it("remove window (multi-change)", () => {
        let prev = baseModel();
        prev = addWindow(prev, makeWindow(W2, S1, [], null, "win-two"));
        prev = addPane(prev, makePane(P3, W2, S1, 100, 40));
        const next = removeWindow(prev, W2);
        roundTrip(prev, next);
    });
    it("simultaneous rename + resize (multi-change)", () => {
        const prev = baseModel();
        let next = updateWindow(prev, W1, { name: "renamed" });
        next = updatePane(next, P1, { cols: 120, rows: 40 });
        roundTrip(prev, next);
    });
    it("session rename round-trips correctly", () => {
        const prev = baseModel();
        const next = updateSession(prev, S1, { name: "new-session-name" });
        roundTrip(prev, next);
    });
    // tc-4bv2 / tc-295a.10: dead-pane state round-trips through diff↔snapshot.
    it("add a dead pane (born-dead with exit code)", () => {
        const prev = baseModel();
        const next = addPane(prev, makePane(P3, W1, S1, 30, 24, true, 0));
        roundTrip(prev, next);
    });
    it("live pane → dead corpse in place", () => {
        const prev = baseModel();
        const next = updatePane(prev, P1, { dead: true, exitCode: 137 });
        roundTrip(prev, next);
    });
    it("dead corpse exitCode becomes known on a later cycle", () => {
        const prev = updatePane(baseModel(), P1, { dead: true, exitCode: undefined });
        const next = updatePane(prev, P1, { dead: true, exitCode: 2 });
        roundTrip(prev, next);
    });
    it("dead corpse respawns back to live", () => {
        const prev = updatePane(baseModel(), P1, { dead: true, exitCode: 1 });
        const next = updatePane(prev, P1, { dead: false, exitCode: undefined });
        roundTrip(prev, next);
    });
});
// ---------------------------------------------------------------------------
// 3b. Dead-pane wire shape (tc-4bv2 W2.5 + tc-295a.10 W2.4)
// ---------------------------------------------------------------------------
describe("dead-pane projection (tc-4bv2 / tc-295a.10)", () => {
    it("projectSnapshot omits dead/exitCode for a live pane", () => {
        const snap = projectSnapshot(baseModel(), { seq: 1 });
        const p = snap.panes.find((x) => x.paneId === P1);
        assert.ok(!("dead" in p), "no dead field for a live pane");
        assert.ok(!("exitCode" in p), "no exitCode field for a live pane");
    });
    it("projectSnapshot surfaces a dead pane with exit code", () => {
        const model = updatePane(baseModel(), P1, { dead: true, exitCode: 0 });
        const snap = projectSnapshot(model, { seq: 1 });
        const p = snap.panes.find((x) => x.paneId === P1);
        assert.equal(p.dead, true);
        assert.equal(p.exitCode, 0);
    });
    it("projectSnapshot surfaces a dead pane with no exit code (unknown status)", () => {
        const model = updatePane(baseModel(), P1, { dead: true, exitCode: undefined });
        const snap = projectSnapshot(model, { seq: 1 });
        const p = snap.panes.find((x) => x.paneId === P1);
        assert.equal(p.dead, true);
        assert.ok(!("exitCode" in p), "exitCode omitted when unknown");
    });
    it("diffModel emits exactly one pane.dead-changed on a live→dead flip", () => {
        const prev = baseModel();
        const next = updatePane(prev, P1, { dead: true, exitCode: 5 });
        const deltas = diffModel(prev, next);
        const dc = deltas.filter((d) => d.type === "pane.dead-changed");
        assert.equal(dc.length, 1);
        const dc0 = dc[0];
        if (dc0.type === "pane.dead-changed") {
            assert.equal(dc0.paneId, P1);
            assert.equal(dc0.dead, true);
            assert.equal(dc0.exitCode, 5);
        }
        // No spurious pane.closed/pane.opened for an in-place transition.
        assert.equal(deltas.filter((d) => d.type === "pane.closed").length, 0);
        assert.equal(deltas.filter((d) => d.type === "pane.opened").length, 0);
    });
    it("diffModel carries exitCode through to pane.closed when a dead corpse is reaped", () => {
        const prev = updatePane(baseModel(), P2, { dead: true, exitCode: 3 });
        const next = removePane(prev, P2);
        const deltas = diffModel(prev, next);
        const closed = deltas.filter((d) => d.type === "pane.closed");
        assert.equal(closed.length, 1);
        const c0 = closed[0];
        if (c0.type === "pane.closed") {
            assert.equal(c0.paneId, P2);
            assert.equal(c0.exitCode, 3);
        }
    });
    it("diffModel omits exitCode on pane.closed for a live pane that vanished", () => {
        const prev = baseModel(); // P2 live
        const next = removePane(prev, P2);
        const deltas = diffModel(prev, next);
        const closed = deltas.filter((d) => d.type === "pane.closed");
        assert.equal(closed.length, 1);
        assert.ok(!("exitCode" in closed[0]), "no exitCode for a live pane removal");
    });
    // tc-u7cu.6: close-cause stamping tests.
    it("diffModel stamps cause on pane.closed when closeCauseLookup returns an origin (client-kill)", () => {
        const prev = baseModel();
        const next = removePane(prev, P2);
        // Use a simple inline CloseCauseLookup that returns a cause for P2.
        const fakeOrigin = { connectionId: "conn1", requestId: "req-42" };
        const deltas = diffModel(prev, next, {
            closeCauseLookup: (id) => (id === P2 ? fakeOrigin : undefined),
        });
        const closed = deltas.filter((d) => d.type === "pane.closed");
        assert.equal(closed.length, 1);
        const c0 = closed[0];
        if (c0.type === "pane.closed") {
            assert.deepEqual(c0.cause, fakeOrigin, "cause must be stamped from the lookup");
        }
    });
    it("diffModel omits cause on pane.closed when closeCauseLookup returns undefined (unsolicited exit)", () => {
        const prev = baseModel();
        const next = removePane(prev, P2);
        const deltas = diffModel(prev, next, { closeCauseLookup: (_id) => undefined });
        const closed = deltas.filter((d) => d.type === "pane.closed");
        assert.equal(closed.length, 1);
        assert.ok(!("cause" in closed[0]), "no cause for an unsolicited close");
    });
    it("diffModel omits cause on pane.closed when no closeCauseLookup is provided", () => {
        const prev = baseModel();
        const next = removePane(prev, P2);
        const deltas = diffModel(prev, next);
        const closed = deltas.filter((d) => d.type === "pane.closed");
        assert.equal(closed.length, 1);
        assert.ok(!("cause" in closed[0]), "no cause when lookup is absent");
    });
});
// ---------------------------------------------------------------------------
// 3c. Durable pane-name projection (tc-1a8z)
// ---------------------------------------------------------------------------
describe("durable pane-name projection (tc-1a8z)", () => {
    it("projectSnapshot omits label for a pane with no durable name", () => {
        const snap = projectSnapshot(baseModel(), { seq: 1 });
        const p = snap.panes.find((x) => x.paneId === P1);
        assert.ok(!("label" in p), "no label field when unset");
    });
    it("projectSnapshot surfaces the durable name when set", () => {
        const model = updatePane(baseModel(), P1, { label: "build" });
        const snap = projectSnapshot(model, { seq: 1 });
        const p = snap.panes.find((x) => x.paneId === P1);
        assert.equal(p.label, "build");
    });
    it("diffModel emits exactly one pane.label-changed on a rename", () => {
        const prev = baseModel();
        const next = updatePane(prev, P1, { label: "deploy" });
        const deltas = diffModel(prev, next);
        const lc = deltas.filter((d) => d.type === "pane.label-changed");
        assert.equal(lc.length, 1);
        const lc0 = lc[0];
        if (lc0.type === "pane.label-changed") {
            assert.equal(lc0.paneId, P1);
            assert.equal(lc0.label, "deploy");
        }
        // A rename is NOT a resize/close/open — none of those spurious deltas.
        assert.equal(deltas.filter((d) => d.type === "pane.resized").length, 0);
        assert.equal(deltas.filter((d) => d.type === "pane.closed").length, 0);
        assert.equal(deltas.filter((d) => d.type === "pane.opened").length, 0);
    });
    it("diffModel emits pane.label-changed with label ABSENT when the name is cleared", () => {
        const prev = updatePane(baseModel(), P1, { label: "deploy" });
        const next = updatePane(prev, P1, { label: undefined });
        const deltas = diffModel(prev, next);
        const lc = deltas.filter((d) => d.type === "pane.label-changed");
        assert.equal(lc.length, 1);
        assert.ok(!("label" in lc[0]), "label omitted when cleared");
    });
    it("diffModel emits no pane.label-changed when the name is unchanged", () => {
        const prev = updatePane(baseModel(), P1, { label: "build" });
        const next = updatePane(prev, P1, { label: "build" });
        const deltas = diffModel(prev, next);
        assert.equal(deltas.filter((d) => d.type === "pane.label-changed").length, 0);
    });
    it("round-trip: applyDeltas(snapshot(prev), diff(prev,next)) === snapshot(next) for a rename", () => {
        const prev = baseModel();
        const next = updatePane(prev, P1, { label: "tests" });
        const reconstructed = applyDeltas(projectSnapshot(prev, { seq: 1 }), diffModel(prev, next));
        assert.deepEqual(reconstructed.panes, projectSnapshot(next, { seq: 2 }).panes);
    });
    it("a born-with-label pane carries label on pane.opened", () => {
        const prev = baseModel();
        let next = addPane(prev, { ...makePane(P3, W1, S1, 30, 24), label: "logs" });
        next = updateWindow(next, W1, { activePaneId: P3 });
        const deltas = diffModel(prev, next);
        const opened = deltas.filter((d) => d.type === "pane.opened");
        assert.equal(opened.length, 1);
        const o0 = opened[0];
        if (o0.type === "pane.opened") {
            assert.equal(o0.label, "logs");
        }
    });
});
// ---------------------------------------------------------------------------
// 4. Ordering: pane.opened precedes focus.changed when a new pane is focused
// ---------------------------------------------------------------------------
describe("delta ordering (v3)", () => {
    it("pane.opened appears before focus.changed in the same diff", () => {
        const prev = baseModel();
        let next = addPane(prev, makePane(P3, W1, S1, 30, 24));
        next = updateWindow(next, W1, { activePaneId: P3 });
        next = setFocus(next, { paneId: P3, windowId: W1, sessionId: S1 });
        const deltas = diffModel(prev, next);
        const openedIdx = deltas.findIndex((d) => d.type === "pane.opened");
        const focusIdx = deltas.findIndex((d) => d.type === "focus.changed");
        assert.ok(openedIdx !== -1, "pane.opened must be present");
        assert.ok(focusIdx !== -1, "focus.changed must be present");
        assert.ok(openedIdx < focusIdx, `pane.opened (idx ${openedIdx}) must precede focus.changed (idx ${focusIdx})`);
    });
    it("window.added appears before pane.opened", () => {
        const prev = emptyModel();
        let next = addSession(prev, makeSession(S1, [], null));
        next = addWindow(next, makeWindow(W1, S1, [], null));
        next = addPane(next, makePane(P1, W1, S1));
        const deltas = diffModel(prev, next);
        const types = deltas.map((d) => d.type);
        const windowIdx = types.indexOf("window.added");
        const paneIdx = types.indexOf("pane.opened");
        assert.ok(windowIdx !== -1, "window.added must be present");
        assert.ok(paneIdx !== -1, "pane.opened must be present");
        assert.ok(windowIdx < paneIdx, "window.added before pane.opened");
    });
    it("pane.closed appears before window.closed", () => {
        let prev = baseModel();
        prev = addWindow(prev, makeWindow(W2, S1, [], null));
        prev = addPane(prev, makePane(P3, W2, S1));
        const next = removeWindow(prev, W2);
        const deltas = diffModel(prev, next);
        const types = deltas.map((d) => d.type);
        const paneClosedIdx = types.indexOf("pane.closed");
        const windowClosedIdx = types.indexOf("window.closed");
        assert.ok(paneClosedIdx !== -1, "pane.closed must be present");
        assert.ok(windowClosedIdx !== -1, "window.closed must be present");
        assert.ok(paneClosedIdx < windowClosedIdx, "pane.closed before window.closed");
    });
});
//# sourceMappingURL=projection.test.js.map