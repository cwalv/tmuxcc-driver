/**
 * Integration tests for paneTitle model field and pane.title-changed delta (tc-2mn8).
 *
 * These tests live in src/state/ (not src/parser/) to respect the
 * parser-no-wire boundary rule: src/parser/ must not import src/wire/.
 *
 * Coverage:
 *   - pane.title-changed delta is emitted by diffModel when paneTitle changes.
 *   - No delta when paneTitle is unchanged.
 *   - No delta when paneTitle goes from defined to absent (undefined).
 *   - paneTitle is carried in snapshot (SnapshotPane.paneTitle).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { paneId, windowId, sessionId } from "../wire/ids.js";
import { diffModel, projectSnapshot } from "./projection.js";
import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  updatePane,
} from "./model.js";
import type { SessionModel } from "./model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S1 = sessionId("s0");
const W1 = windowId("w1");
const P1 = paneId("p1");

/** Build a minimal model with one session → window → pane. */
function buildBaseModel(): SessionModel {
  let model = emptyModel();
  model = addSession(model, { sessionId: S1, name: "test", windowIds: [], activeWindowId: null });
  model = addWindow(model, {
    windowId: W1,
    sessionId: S1,
    name: "win",
    paneIds: [],
    activePaneId: null,
    layout: null,
    synchronizePanes: false,
    monitorActivity: true,
    monitorSilence: 0,
  });
  model = addPane(model, {
    paneId: P1,
    windowId: W1,
    sessionId: S1,
    cols: 80,
    rows: 24,
    mode: "normal",
    dead: false,
    exitCode: undefined,
    // paneTitle absent (undefined → no title seen yet)
  });
  return model;
}

// ---------------------------------------------------------------------------
// pane.title-changed delta
// ---------------------------------------------------------------------------

describe("paneTitle – pane.title-changed delta in diffModel (tc-2mn8)", () => {
  it("emits pane.title-changed when paneTitle changes from undefined to a string", () => {
    const prev = buildBaseModel();
    const next = updatePane(prev, P1, { paneTitle: "my shell" });

    const deltas = diffModel(prev, next);
    const titleDelta = deltas.find((d) => d.type === "pane.title-changed");
    assert.ok(titleDelta, "expected a pane.title-changed delta");
    if (titleDelta?.type === "pane.title-changed") {
      assert.equal(titleDelta.paneId, P1);
      assert.equal(titleDelta.title, "my shell");
    }
  });

  it("emits pane.title-changed when paneTitle changes from one string to another", () => {
    const base = buildBaseModel();
    const prev = updatePane(base, P1, { paneTitle: "old-title" });
    const next = updatePane(base, P1, { paneTitle: "new-title" });

    const deltas = diffModel(prev, next);
    const titleDelta = deltas.find((d) => d.type === "pane.title-changed");
    assert.ok(titleDelta, "expected a pane.title-changed delta");
    if (titleDelta?.type === "pane.title-changed") {
      assert.equal(titleDelta.title, "new-title");
    }
  });

  it("emits pane.title-changed with empty string (shell cleared title)", () => {
    const base = buildBaseModel();
    const prev = updatePane(base, P1, { paneTitle: "some-title" });
    const next = updatePane(base, P1, { paneTitle: "" });

    const deltas = diffModel(prev, next);
    const titleDelta = deltas.find((d) => d.type === "pane.title-changed");
    assert.ok(titleDelta, "expected a pane.title-changed delta for empty title");
    if (titleDelta?.type === "pane.title-changed") {
      assert.equal(titleDelta.title, "");
    }
  });

  it("does NOT emit pane.title-changed when paneTitle is unchanged (same string)", () => {
    const model = updatePane(buildBaseModel(), P1, { paneTitle: "same" });
    const deltas = diffModel(model, model);
    const titleDelta = deltas.find((d) => d.type === "pane.title-changed");
    assert.equal(titleDelta, undefined, "no delta when title unchanged (prev === next)");
  });

  it("does NOT emit pane.title-changed when prev has title and next has undefined (title cleared)", () => {
    // Projection only emits title-changed when next paneTitle is defined.
    // Going from defined → undefined is NOT signalled (the field just disappears
    // from the model; the consumer uses the last-known value).
    const prev = updatePane(buildBaseModel(), P1, { paneTitle: "had-a-title" });

    // Manually remove paneTitle from next pane using destructuring (exactOptionalPropertyTypes safe).
    const { paneTitle: _stripped, ...restPane } = prev.panes.get(P1)!;
    const nextPanes = new Map(prev.panes);
    // Cast needed because we're deliberately creating an incomplete Pane for test purposes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nextPanes.set(P1, restPane as any);
    const next: SessionModel = { ...prev, panes: nextPanes };

    const deltas = diffModel(prev, next);
    const titleDelta = deltas.find((d) => d.type === "pane.title-changed");
    assert.equal(titleDelta, undefined, "no delta when paneTitle goes defined → absent");
  });

  it("does NOT emit pane.title-changed for a new pane (new pane carries title in pane.opened)", () => {
    // A new pane getting paneTitle is not diffed as a title-change (it's in pane.opened).
    const prev = buildBaseModel();
    const next = updatePane(prev, P1, { paneTitle: "title-of-new" });
    // Remove P1 from prev to simulate it being new.
    const prevPanes = new Map(prev.panes);
    prevPanes.delete(P1);
    const prevNoPane: SessionModel = { ...prev, panes: prevPanes };

    const deltas = diffModel(prevNoPane, next);
    // There should be a pane.opened but NOT a pane.title-changed for the same pane.
    const openedDelta = deltas.find((d) => d.type === "pane.opened");
    const titleDelta = deltas.find((d) => d.type === "pane.title-changed");
    assert.ok(openedDelta, "expected pane.opened for new pane");
    assert.equal(titleDelta, undefined, "pane.title-changed must NOT fire for a new pane");
  });
});

// ---------------------------------------------------------------------------
// paneTitle in snapshots
// ---------------------------------------------------------------------------

describe("paneTitle – SnapshotPane carries paneTitle (tc-2mn8)", () => {
  it("paneTitle appears in SnapshotPane when set", () => {
    const model = updatePane(buildBaseModel(), P1, { paneTitle: "shell-title" });
    const snapshot = projectSnapshot(model);
    const paneSnap = snapshot.panes.find((p) => p.paneId === P1);
    assert.ok(paneSnap, "pane should be in snapshot");
    assert.equal(paneSnap?.paneTitle, "shell-title");
  });

  it("paneTitle is absent from SnapshotPane when not set", () => {
    const model = buildBaseModel(); // no paneTitle set
    const snapshot = projectSnapshot(model);
    const paneSnap = snapshot.panes.find((p) => p.paneId === P1);
    assert.ok(paneSnap, "pane should be in snapshot");
    assert.equal(paneSnap?.paneTitle, undefined, "paneTitle should be absent when not set");
  });

  it("paneTitle is carried through when pane is opened with a title", () => {
    // A pane that already has a paneTitle when it first enters the model
    // should emit pane.opened (which already carries it via SnapshotPane shape
    // in the diff -- pane.opened in diffModel does NOT include paneTitle, so
    // this tests the snapshot path only).
    const model = addPane(buildBaseModel(), {
      paneId: paneId("p2"),
      windowId: W1,
      sessionId: S1,
      cols: 80,
      rows: 24,
      mode: "normal",
      dead: false,
      exitCode: undefined,
      paneTitle: "born-with-title",
    });
    const snapshot = projectSnapshot(model);
    const pane = snapshot.panes.find((p) => p.paneId === paneId("p2"));
    assert.ok(pane, "pane p2 should be in snapshot");
    assert.equal(pane?.paneTitle, "born-with-title");
  });
});
