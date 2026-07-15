/**
 * Tests for the driver-owned manual-window lifecycle ledger (tc-x9bj).
 *
 * The ledger tracks which windows have `window-size manual` set by the
 * resize-managed-window path and auto-releases the override when:
 *   1. A pane is removed from a marked window (kill-pane / close-pane).
 *   2. A pane is moved out of a marked window (break-pane re-homes it).
 *   3. Bootstrap sweep fires on the first model change.
 *
 * All tests use a fake send() that captures command writes — no real tmux
 * process needed. Model fixtures are built directly as SessionModel objects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createManualWindowLedger } from "./manual-window-ledger.js";
import type { ManualWindowLedger } from "./manual-window-ledger.js";
import { windowId, paneId } from "@tmuxcc/protocol";
import type { WindowId, PaneId } from "@tmuxcc/protocol";
import type { SessionModel } from "../state/model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake send() that records each command string. */
function makeFakeSend(): { sends: string[]; send: (cmd: string) => void } {
  const sends: string[] = [];
  return {
    sends,
    send(cmd) { sends.push(cmd); },
  };
}

/**
 * Build a minimal SessionModel containing only the fields the ledger reads:
 * `model.windows.get(wid)` and `window.paneIds.length`.
 *
 * All other fields are stubbed with `null` / empty values via a cast; the
 * ledger never reads sessions, panes, focus, or invariantViolations.
 */
function makeModel(
  windows: ReadonlyMap<WindowId, { paneIds: readonly PaneId[] }>,
): SessionModel {
  const windowMap = new Map<WindowId, { paneIds: readonly PaneId[] }>();
  for (const [wid, win] of windows) {
    windowMap.set(wid, { paneIds: [...win.paneIds] });
  }
  return {
    windows: windowMap,
    panes: new Map(),
    sessions: new Map(),
    focus: { paneId: null, windowId: null },
    invariantViolations: [],
  } as unknown as SessionModel;
}

// ---------------------------------------------------------------------------
// Suite: markManual + pane removal → release
// ---------------------------------------------------------------------------

describe("createManualWindowLedger — pane death in 2-pane manual window", () => {
  it("marks a window + pane removal triggers set-window-option -u (tc-x9bj pane-death path)", () => {
    // The old tc-pizl.9 path: a pane is deleted from a 2-pane managed strip.
    // The ledger (driver-owned) must send the reset when it observes the model
    // change from 2 panes → 1 pane.
    const W = windowId("w4");
    const P1 = paneId("p1");
    const P2 = paneId("p2");

    const { sends, send } = makeFakeSend();
    const ledger: ManualWindowLedger = createManualWindowLedger(send);

    // The managed batch was sent → mark the window.
    ledger.markManual(W);
    assert.equal(sends.length, 0, "markManual must not send anything");

    // Model before: 2 panes.
    const prev = makeModel(new Map([[W, { paneIds: [P1, P2] }]]));
    // Model after: P2 deleted.
    const next = makeModel(new Map([[W, { paneIds: [P1] }]]));

    ledger.onModelChange(next, prev);

    assert.equal(sends.length, 1, "one release command expected");
    assert.equal(
      sends[0],
      "set-window-option -u -t @4 window-size",
      "must send the idempotent window-size reset",
    );

    // A second onModelChange with no further pane changes must not re-release.
    ledger.onModelChange(next, next);
    assert.equal(sends.length, 1, "no additional release after the first");
  });
});

// ---------------------------------------------------------------------------
// Suite: markManual + break-pane (move-out) → release
// ---------------------------------------------------------------------------

describe("createManualWindowLedger — break-pane move-out from manual window", () => {
  it("pane moved out of a marked window (break-pane) releases the manual lock", () => {
    // The tc-x9bj mechanism: after unsplit, break-pane moves the outlier pane
    // to a NEW window. The marked window (old window) loses one pane.
    // prev: W_old has {P1, P2}, W_old is marked manual.
    // next: P2 moved to W_new → W_old has {P1} only.
    const W_old = windowId("w4");
    const W_new = windowId("w5");
    const P1 = paneId("p1");
    const P2 = paneId("p2");

    const { sends, send } = makeFakeSend();
    const ledger = createManualWindowLedger(send);
    ledger.markManual(W_old);

    const prev = makeModel(new Map([
      [W_old, { paneIds: [P1, P2] }],
    ]));
    const next = makeModel(new Map([
      [W_old, { paneIds: [P1] }],
      [W_new, { paneIds: [P2] }],
    ]));

    ledger.onModelChange(next, prev);

    assert.equal(sends.length, 1, "one release command expected after break-pane");
    assert.equal(sends[0], "set-window-option -u -t @4 window-size");
  });
});

// ---------------------------------------------------------------------------
// Suite: window closed → mark dropped, no send
// ---------------------------------------------------------------------------

describe("createManualWindowLedger — window closed", () => {
  it("drops the mark without sending when the window disappears from the model", () => {
    // A kill-window removes the window entirely. The ledger must drop the mark
    // but must NOT send a reset (the window is gone — tmux has no target).
    const W = windowId("w7");
    const P1 = paneId("p1");

    const { sends, send } = makeFakeSend();
    const ledger = createManualWindowLedger(send);
    ledger.markManual(W);

    const prev = makeModel(new Map([[W, { paneIds: [P1] }]]));
    const next = makeModel(new Map()); // window gone

    ledger.onModelChange(next, prev);

    assert.equal(sends.length, 0, "no reset sent when the window is gone");

    // Subsequent change with the same window still absent: still no send.
    ledger.onModelChange(next, next);
    assert.equal(sends.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: bootstrap sweep
// ---------------------------------------------------------------------------

describe("createManualWindowLedger — bootstrapSweep", () => {
  it("sends set-window-option -u to every sole-pane window in the initial snapshot", () => {
    // After a proxy crash, any window that was in manual mode stays manual.
    // The bootstrap sweep resets ALL sole-pane (≤1 pane) windows.
    const W1 = windowId("w1"); // 1 pane — must be reset
    const W2 = windowId("w2"); // 2 panes — must NOT be reset
    const W3 = windowId("w3"); // 0 panes — must be reset
    const P1 = paneId("p1");
    const P2 = paneId("p2");
    const P3 = paneId("p3");

    const { sends, send } = makeFakeSend();
    const ledger = createManualWindowLedger(send);

    const model = makeModel(new Map([
      [W1, { paneIds: [P1] }],
      [W2, { paneIds: [P2, P3] }],
      [W3, { paneIds: [] }],
    ]));
    ledger.bootstrapSweep(model);

    // W2 (2 panes) must NOT be reset; W1 and W3 must be.
    assert.equal(sends.length, 2, "exactly 2 sole-pane windows must be reset");
    const cmds = new Set(sends);
    assert.ok(cmds.has("set-window-option -u -t @1 window-size"), "W1 must be reset");
    assert.ok(cmds.has("set-window-option -u -t @3 window-size"), "W3 must be reset");
    assert.ok(!cmds.has("set-window-option -u -t @2 window-size"), "W2 (2-pane) must not be reset");
  });

  it("bootstrap sweep does not add windows to the ledger", () => {
    // The sweep is a cleanup pass, not a mark-acquisition. A subsequent pane
    // removal from a swept window must NOT trigger an additional release,
    // because the window was never marked (no managed batch was sent for it).
    const W = windowId("w9");
    const P1 = paneId("p1");
    const P2 = paneId("p2");

    const { sends, send } = makeFakeSend();
    const ledger = createManualWindowLedger(send);

    // Bootstrap sweep: W has 1 pane — reset sent.
    const initial = makeModel(new Map([[W, { paneIds: [P1] }]]));
    ledger.bootstrapSweep(initial);
    assert.equal(sends.length, 1, "sweep fires once");

    // Now a pane deletion: since W was never marked, no additional release.
    const prev = makeModel(new Map([[W, { paneIds: [P1, P2] }]]));
    const next = makeModel(new Map([[W, { paneIds: [P1] }]]));
    ledger.onModelChange(next, prev);

    assert.equal(sends.length, 1, "no ledger-driven release for an unmarked window");
  });
});

// ---------------------------------------------------------------------------
// Suite: 3→2 strip shrink (transient) releases and re-enters
// ---------------------------------------------------------------------------

describe("createManualWindowLedger — 3→2 strip shrink transient", () => {
  it("releases on 3→2 pane count drop, re-marks on the next managed batch", () => {
    // When a 3-pane strip loses one pane (→2), the ledger releases manually.
    // The client re-enters managed mode on the next setPaneDimensions edge
    // (~50-100ms), re-marking the window. This test confirms the transient
    // and the re-entry are both correct.
    const W = windowId("w2");
    const P1 = paneId("p1");
    const P2 = paneId("p2");
    const P3 = paneId("p3");

    const { sends, send } = makeFakeSend();
    const ledger = createManualWindowLedger(send);

    // 3-pane strip managed batch sent.
    ledger.markManual(W);

    // One pane dies: 3 → 2.
    const prev3 = makeModel(new Map([[W, { paneIds: [P1, P2, P3] }]]));
    const next2 = makeModel(new Map([[W, { paneIds: [P1, P2] }]]));
    ledger.onModelChange(next2, prev3);

    assert.equal(sends.length, 1, "release fires on 3→2 drop");
    assert.equal(sends[0], "set-window-option -u -t @2 window-size");

    // Client re-evaluates the 2-pane strip and sends another managed batch.
    ledger.markManual(W);

    // Another pane dies: 2 → 1.
    const next1 = makeModel(new Map([[W, { paneIds: [P1] }]]));
    ledger.onModelChange(next1, next2);

    assert.equal(sends.length, 2, "second release fires on 2→1 drop");
    assert.equal(sends[1], "set-window-option -u -t @2 window-size");
  });
});
