/**
 * tc-fwx0 — size-owner viewport resolver (the DIFFERENT-size reattach capture
 * gate's policy layer).
 *
 * `resolveSizeOwnerViewport` decides WHETHER, at `pane.attach` hydration time,
 * to issue a `refresh-client -C` before capture, and to WHAT size. It reads the
 * driver's existing D4 ownership state (the current size owner + each client's
 * last desired viewport) and the model, and returns the owner's viewport ONLY
 * when a pre-capture resize would actually change the captured grid. Every racy
 * / ambiguous case resolves to `undefined` — the fail-soft fallback
 * (reconstruct-at-captured-size, then converge via the live `%output` stream),
 * so a reattach never wedges and never captures at a guessed size.
 *
 * These are the deterministic proofs of that policy; the refresh-before-capture
 * MECHANISM it feeds is pinned in hydration.test.ts §F, and the end-to-end
 * DIFFERENT-size reattach faithfulness is proven by the vscode e2e
 * (reattach-different-size-faithful.flow.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveSizeOwnerViewport } from "./session-proxy.js";
import type { SizeOwnerViewportModel } from "./session-proxy.js";
import { paneId, windowId } from "@tmuxcc/protocol";
import type { PaneId, WindowId } from "@tmuxcc/protocol";

const P1 = paneId("p1");
const P2 = paneId("p2");
const W1 = windowId("@1");

/**
 * Build a minimal model. By default a single-pane window W1 holding P1 at
 * `paneCols`×`paneRows`. `extraPaneInWindow` adds P2 to W1 (a split) to exercise
 * the multi-pane guard.
 */
function makeModel(opts: {
  paneCols: number;
  paneRows: number;
  extraPaneInWindow?: boolean;
  omitPane?: boolean;
}): SizeOwnerViewportModel {
  const paneIds: PaneId[] = opts.extraPaneInWindow ? [P1, P2] : [P1];
  const panes = new Map<
    PaneId,
    { windowId: WindowId; cols: number; rows: number }
  >();
  if (!opts.omitPane) {
    panes.set(P1, { windowId: W1, cols: opts.paneCols, rows: opts.paneRows });
  }
  if (opts.extraPaneInWindow) {
    panes.set(P2, { windowId: W1, cols: opts.paneCols, rows: opts.paneRows });
  }
  const windows = new Map<WindowId, { paneIds: readonly PaneId[] }>([[W1, { paneIds }]]);
  return { panes, windows };
}

describe("tc-fwx0 resolveSizeOwnerViewport", () => {
  it("returns the owner's viewport when it differs from the pane's captured size (single-pane window)", () => {
    const model = makeModel({ paneCols: 80, paneRows: 24 });
    const last = new Map([["owner", { cols: 120, rows: 40 }]]);
    const vp = resolveSizeOwnerViewport(P1, "owner", last, model);
    assert.deepEqual(vp, { cols: 120, rows: 40 });
  });

  it("returns undefined when there is no size owner yet (election has not happened) — fallback", () => {
    const model = makeModel({ paneCols: 80, paneRows: 24 });
    const last = new Map([["owner", { cols: 120, rows: 40 }]]);
    const vp = resolveSizeOwnerViewport(P1, null, last, model);
    assert.equal(vp, undefined);
  });

  it("returns undefined when the owner has no recorded resize.request yet (owner viewport not arrived) — fallback", () => {
    const model = makeModel({ paneCols: 80, paneRows: 24 });
    const last = new Map<string, { cols: number; rows: number }>(); // empty
    const vp = resolveSizeOwnerViewport(P1, "owner", last, model);
    assert.equal(vp, undefined);
  });

  it("returns undefined when the owner's viewport already equals the pane's captured size (refresh would be a no-op)", () => {
    const model = makeModel({ paneCols: 100, paneRows: 30 });
    const last = new Map([["owner", { cols: 100, rows: 30 }]]);
    const vp = resolveSizeOwnerViewport(P1, "owner", last, model);
    assert.equal(vp, undefined);
  });

  it("returns undefined for a multi-pane window (a split reflows via the managed layout path, not this gate)", () => {
    const model = makeModel({ paneCols: 80, paneRows: 24, extraPaneInWindow: true });
    const last = new Map([["owner", { cols: 120, rows: 40 }]]);
    const vp = resolveSizeOwnerViewport(P1, "owner", last, model);
    assert.equal(vp, undefined);
  });

  it("returns undefined when the pane vanished from the model — fallback", () => {
    const model = makeModel({ paneCols: 80, paneRows: 24, omitPane: true });
    const last = new Map([["owner", { cols: 120, rows: 40 }]]);
    const vp = resolveSizeOwnerViewport(P1, "owner", last, model);
    assert.equal(vp, undefined);
  });

  it("differs on rows alone (same cols) still gates a refresh", () => {
    const model = makeModel({ paneCols: 80, paneRows: 24 });
    const last = new Map([["owner", { cols: 80, rows: 50 }]]);
    const vp = resolveSizeOwnerViewport(P1, "owner", last, model);
    assert.deepEqual(vp, { cols: 80, rows: 50 });
  });
});
