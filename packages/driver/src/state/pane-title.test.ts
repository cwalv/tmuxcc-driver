/**
 * Integration tests for paneTitle model field and pane.title-changed delta
 * (tc-2mn8; format-backed tc-mysc.2).
 *
 * These tests live in src/state/ (not src/parser/) to respect the
 * parser-no-wire boundary rule: src/parser/ must not import src/wire/.
 *
 * Coverage:
 *   - pane.title-changed delta is emitted by diffModel when paneTitle changes.
 *   - No delta when paneTitle is unchanged.
 *   - A defined→absent (cleared) title now emits title-changed "" — the
 *     defined→absent diff-guard was deleted once paneTitle became format-backed
 *     (tc-mysc amendment 5).
 *   - paneTitle is carried in snapshot (SnapshotPane.paneTitle).
 *   - REGRESSION (tc-mysc.2): a model rebuilt by the requery carries titles, and
 *     the requery reaffirms (does not clobber) a subscription-delivered title.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { paneId, windowId, sessionId } from "@tmuxcc/protocol";
import { diffModel, projectSnapshot } from "./projection.js";
import { buildInitialModel, WINDOWS_ROW, PANES_ROW } from "./bootstrap.js";
import { fixtureBytes } from "./reply-row.js";
import {
  emptyModel,
  emptyPaneOverlay,
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
    label: undefined,
    detach: undefined,
    icon: undefined,
    paneTitle: undefined, // no title seen yet
    overlay: emptyPaneOverlay(),
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

  it("emits pane.title-changed with '' when prev has title and next has undefined (cleared)", () => {
    // tc-mysc amendment 5: the defined→absent diff-guard was DELETED once
    // paneTitle became format-backed (the pre-format requery manufactured this
    // transition by rebuilding every pane without a title; format-backing makes
    // that unrepresentable at rebuild). A genuine defined→absent transition now
    // signals a cleared title, mapping the model's `undefined` to the wire's ""
    // cleared sentinel (PaneTitleChangedMessage.title is a string).
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
    assert.ok(titleDelta, "defined → absent now emits a cleared-title delta");
    if (titleDelta?.type === "pane.title-changed") {
      assert.equal(titleDelta.title, "", "model undefined maps to the wire '' cleared sentinel");
    }
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
      label: undefined,
      detach: undefined,
      icon: undefined,
      overlay: emptyPaneOverlay(),
      paneTitle: "born-with-title",
    });
    const snapshot = projectSnapshot(model);
    const pane = snapshot.panes.find((p) => p.paneId === paneId("p2"));
    assert.ok(pane, "pane p2 should be in snapshot");
    assert.equal(pane?.paneTitle, "born-with-title");
  });
});

// ---------------------------------------------------------------------------
// tc-mysc.2 regression: the requery is a canonical title source
// ---------------------------------------------------------------------------

describe("paneTitle – requery is format-backed (tc-mysc.2 regression)", () => {
  const P5 = paneId("p5");
  const windowRows = [
    WINDOWS_ROW.fixtureRow({ tmuxSessionId: 0, sessionName: "s", tmuxWindowId: 1, active: true }),
  ];
  const paneRowWithTitle = (title: string | undefined) =>
    PANES_ROW.fixtureRow({ tmuxPaneId: 5, tmuxWindowId: 1, tmuxSessionId: 0, paneTitle: title });

  it("a snapshot built AFTER a requery carries titles (the live regression fix)", () => {
    // Pre-format, buildInitialModel dropped paneTitle → every requery rebuilt the
    // pane WITHOUT a title, so a client reconnecting after a topology change saw
    // no titles. Now the title arrives verbatim from `#{pane_title}`.
    const model = buildInitialModel(windowRows, [paneRowWithTitle("vim - myfile.ts")]);
    assert.equal(model.panes.get(P5)?.paneTitle, "vim - myfile.ts");

    const snap = projectSnapshot(model);
    const paneSnap = snap.panes.find((p) => p.paneId === P5);
    assert.ok(paneSnap, "requery-built pane is in the snapshot");
    assert.equal(paneSnap?.paneTitle, "vim - myfile.ts", "snapshot after requery carries the title");
  });

  it("a requery REAFFIRMS a subscription-delivered title (does not clobber it)", () => {
    // The title-watch subscription delivered "vim - myfile.ts" via updatePane:
    const afterSubscription = updatePane(
      buildInitialModel(windowRows, [paneRowWithTitle(undefined)]),
      P5,
      { paneTitle: "vim - myfile.ts" },
    );
    // A later topology requery reads the SAME value from tmux (both paths expand
    // the identical `#{pane_title}`):
    const afterRequery = buildInitialModel(windowRows, [paneRowWithTitle("vim - myfile.ts")]);

    assert.equal(
      afterRequery.panes.get(P5)?.paneTitle,
      "vim - myfile.ts",
      "requery carries the title, not undefined",
    );
    const deltas = diffModel(afterSubscription, afterRequery);
    const titleDelta = deltas.find((d) => d.type === "pane.title-changed");
    assert.equal(titleDelta, undefined, "requery reaffirms — no spurious title-changed clobber");
  });

  it("an empty `#{pane_title}` reply decodes to absent (emptyAsUndefined)", () => {
    // Route through the real parse (fixtureRow bypasses the codec): an empty
    // pane_title column decodes to undefined, so buildInitialModel leaves the
    // pane titleless rather than storing "".
    const paneRows = PANES_ROW.parse(
      fixtureBytes(PANES_ROW, [{ tmuxPaneId: 5, tmuxWindowId: 1, tmuxSessionId: 0, paneTitle: "" }]),
    );
    assert.equal(paneRows[0]?.paneTitle, undefined, "empty pane_title column decodes to undefined");
    const model = buildInitialModel(windowRows, paneRows);
    assert.equal(model.panes.get(P5)?.paneTitle, undefined, "empty title → absent in the model");
  });
});
