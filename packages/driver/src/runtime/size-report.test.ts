/**
 * Tests for the per-window size reporter (tc-cvny).
 *
 * Pins the report ledger contract: resolve pane→window and report the box
 * per-window (change-gated); report EVERY known window once participating (so
 * none snaps to the driver's global size); never emit a clear while attached;
 * prune ledger entries for closed windows. The reporter holds no sizing policy —
 * it is a cache of our own last-reported sizes.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { paneId, windowId } from "@tmuxcc/protocol";
import type { PaneId, WindowId } from "@tmuxcc/protocol";
import type { SessionModel } from "../state/model.js";
import { createSizeReporter } from "./size-report.js";

// ---------------------------------------------------------------------------
// Minimal mutable model fixture — only the fields the reporter reads.
// ---------------------------------------------------------------------------

interface FakeModel {
  panes: Map<PaneId, { windowId: WindowId }>;
  windows: Map<WindowId, { layout: { cols: number; rows: number } | null }>;
}

function makeModel(): FakeModel {
  return { panes: new Map(), windows: new Map() };
}

/** Add a single-pane window at `dims` (null = layout not known yet). */
function addWindow(
  model: FakeModel,
  win: WindowId,
  pane: PaneId,
  dims: { cols: number; rows: number } | null,
): void {
  model.windows.set(win, { layout: dims });
  model.panes.set(pane, { windowId: win });
}

/** Collect every command the reporter emits, flattened across batches. */
function makeReporter(model: FakeModel): { reporter: ReturnType<typeof createSizeReporter>; cmds: string[] } {
  const cmds: string[] = [];
  const reporter = createSizeReporter({
    getModel: () => model as unknown as SessionModel,
    sendBatch: (batch) => cmds.push(...batch),
  });
  return { reporter, cmds };
}

const P1 = paneId("p1");
const P2 = paneId("p2");
const P3 = paneId("p3");
const W1 = windowId("w1");
const W2 = windowId("w2");
const W3 = windowId("w3");

describe("SizeReporter — reportForPane", () => {
  let model: FakeModel;
  beforeEach(() => {
    model = makeModel();
  });

  it("reports the pane's window box via refresh-client -C @<win>:WxH", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P1, 120, 40);

    assert.deepEqual(cmds, ["refresh-client -C @1:120x40"]);
    assert.deepEqual(reporter.reportedSizeForWindow(1), { cols: 120, rows: 40 });
  });

  it("change-gates: an identical re-report emits nothing", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P1, 120, 40);
    reporter.reportForPane(P1, 120, 40);

    assert.deepEqual(cmds, ["refresh-client -C @1:120x40"]);
  });

  it("re-reports when the box changes", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P1, 120, 40);
    reporter.reportForPane(P1, 100, 30);

    assert.deepEqual(cmds, ["refresh-client -C @1:120x40", "refresh-client -C @1:100x30"]);
  });

  it("first report also reports every OTHER known window at its current dims", () => {
    // Two windows the extension never rendered plus the one being resized.
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    addWindow(model, W2, P2, { cols: 90, rows: 25 });
    addWindow(model, W3, P3, { cols: 100, rows: 26 });
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P2, 200, 50);

    // W2 at its box; W1 and W3 locked at their current dims so neither snaps.
    assert.deepEqual(cmds.slice().sort(), [
      "refresh-client -C @1:80x24",
      "refresh-client -C @2:200x50",
      "refresh-client -C @3:100x26",
    ]);
  });

  it("skips a window whose layout is not known yet (caught on a later model change)", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    addWindow(model, W2, P2, null); // layout unknown
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P1, 120, 40);

    assert.deepEqual(cmds, ["refresh-client -C @1:120x40"]);
    assert.equal(reporter.reportedSizeForWindow(2), undefined);
  });

  it("drops a resize for a pane not in the model", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P2, 120, 40); // p2 unknown

    assert.deepEqual(cmds, []);
  });
});

describe("SizeReporter — onModelChange", () => {
  let model: FakeModel;
  beforeEach(() => {
    model = makeModel();
  });

  it("is a no-op before participation begins (no report yet)", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    const { reporter, cmds } = makeReporter(model);

    reporter.onModelChange();

    assert.deepEqual(cmds, []);
  });

  it("reports a newly-appeared window at its current dims once participating", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P1, 120, 40); // begins participation, reports W1
    cmds.length = 0;

    // A never-revealed window appears.
    addWindow(model, W2, P2, { cols: 90, rows: 25 });
    reporter.onModelChange();

    assert.deepEqual(cmds, ["refresh-client -C @2:90x25"]);
    // W1's report is untouched (sync never re-reports a reported window).
    assert.deepEqual(reporter.reportedSizeForWindow(1), { cols: 120, rows: 40 });
  });

  it("prunes the ledger entry for a window that leaves the model, without emitting a clear", () => {
    addWindow(model, W1, P1, { cols: 80, rows: 24 });
    addWindow(model, W2, P2, { cols: 90, rows: 25 });
    const { reporter, cmds } = makeReporter(model);

    reporter.reportForPane(P1, 120, 40); // reports W1 + W2
    assert.deepEqual(reporter.reportedSizeForWindow(2), { cols: 90, rows: 25 });
    cmds.length = 0;

    // W2 closes.
    model.windows.delete(W2);
    model.panes.delete(P2);
    reporter.onModelChange();

    assert.equal(reporter.reportedSizeForWindow(2), undefined);
    // Never a wire clear (`@2:` with no size) — pruning is bookkeeping only.
    assert.deepEqual(cmds, []);
  });
});
