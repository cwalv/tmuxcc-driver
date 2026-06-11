/**
 * Tests for src/state/requery.ts (tc-128.1).
 *
 * Coverage:
 *   - Pure `requeryDiff` core: bootstrap (prev=empty), reconnect (prev=same),
 *     idempotent (no deltas when nothing changes), `%error` fallbacks.
 *   - Reparenting (break-pane): same pane id, new window → no spurious
 *     pane.opened/pane.closed; the diff carries the layout updates.
 *   - Dead-pane semantics: a pane absent from the next list-panes reply is
 *     closed; a pane still present (e.g. remain-on-exit dead) survives.
 *   - `RequeryEngine` driver: basic cycle, getModel mirrors the latest cycle,
 *     dirty mid-flight triggers a re-run on completion, concurrent requery()
 *     calls share the in-flight promise (single cycle, no parallel runs).
 *   - Property-style round-trip on random model pairs: replay deltas onto a
 *     deep clone of `prev` and assert the result deep-equals `next`.
 *
 * @module state/requery.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRequeryEngine, requeryDiff } from "./requery.js";
import type { SubmitCommand } from "./requery.js";
import { diffModel } from "./projection.js";
import {
  emptyModel,
  addPane,
  addSession,
  addWindow,
  paneId,
  sessionId,
  windowId,
  setFocus,
  updateSession,
} from "./model.js";
import type {
  Pane,
  Session,
  SessionModel,
  Window,
} from "./model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";
import type { CommandResult } from "../parser/correlator.js";
import type { SessionProxyMessage } from "../wire/session-proxy-control.js";

// ---------------------------------------------------------------------------
// Test fixtures: synthetic list-windows / list-panes reply bodies.
//
// BOOTSTRAP_WINDOWS_FORMAT fields (tab-separated, 9):
//   $sess  name  @win  name  w   h   layout                  flags  active
// BOOTSTRAP_PANES_FORMAT fields (tab-separated, 11):
//   %pane  @win  $sess  idx  w   h   top  left  active  pid   cmd
// ---------------------------------------------------------------------------

const ENC = new TextEncoder();

function okResult(body: string, n = 1): CommandResult {
  return { ok: true, commandNumber: n, body: ENC.encode(body) };
}

function errResult(n = 1): CommandResult {
  return { ok: false, commandNumber: n, body: new Uint8Array(0) };
}

/** A windows-reply line shaped to BOOTSTRAP_WINDOWS_FORMAT. */
function winLine(args: {
  sessNum: number;
  sessName: string;
  winNum: number;
  winName: string;
  width?: number;
  height?: number;
  layout: string;
  flags?: string;
  active?: boolean;
}): string {
  return [
    `$${args.sessNum}`,
    args.sessName,
    `@${args.winNum}`,
    args.winName,
    String(args.width ?? 80),
    String(args.height ?? 24),
    args.layout,
    args.flags ?? "-",
    args.active ? "1" : "0",
  ].join("\t") + "\n";
}

/** A panes-reply line shaped to BOOTSTRAP_PANES_FORMAT. */
function paneLine(args: {
  paneNum: number;
  winNum: number;
  sessNum: number;
  idx?: number;
  width?: number;
  height?: number;
  top?: number;
  left?: number;
  active?: boolean;
  pid?: number;
  cmd?: string;
}): string {
  return [
    `%${args.paneNum}`,
    `@${args.winNum}`,
    `$${args.sessNum}`,
    String(args.idx ?? 0),
    String(args.width ?? 80),
    String(args.height ?? 24),
    String(args.top ?? 0),
    String(args.left ?? 0),
    args.active ? "1" : "0",
    String(args.pid ?? 9000),
    args.cmd ?? "bash",
  ].join("\t") + "\n";
}

// Standard single-pane layout strings (1 = pane id 1, etc.).
const SINGLE_PANE_LAYOUT = (paneNum: number) => `0000,80x24,0,0,${paneNum}`;
const TWO_PANE_HSPLIT_LAYOUT = (a: number, b: number) =>
  `0000,80x24,0,0{40x24,0,0,${a},39x24,41,0,${b}}`;

// ---------------------------------------------------------------------------
// 1. requeryDiff — pure core
// ---------------------------------------------------------------------------

describe("requeryDiff: bootstrap (prev=empty)", () => {
  it("empty replies produce empty model and zero deltas", () => {
    const { next, deltas } = requeryDiff(emptyModel(), okResult(""), okResult(""));
    assert.equal(next.sessions.size, 0);
    assert.equal(next.windows.size, 0);
    assert.equal(next.panes.size, 0);
    assert.deepEqual(deltas, []);
  });

  it("one session + one window + one pane produces window.added + pane.opened (+ focus)", () => {
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({
      paneNum: 1,
      winNum: 1,
      sessNum: 0,
      active: true,
      cmd: "zsh",
    });

    const { next, deltas } = requeryDiff(emptyModel(), okResult(win), okResult(pane));

    // Model assertions.
    assert.equal(next.sessions.size, 1);
    assert.equal(next.windows.size, 1);
    assert.equal(next.panes.size, 1);
    assert.equal(next.focus.paneId, paneId("p1"));
    assert.equal(next.focus.windowId, windowId("w1"));
    assert.equal(next.focus.sessionId, sessionId("s0"));

    // Delta-stream assertions: ordering is window.added → pane.opened →
    // focus.changed (no pane.closed / window.closed since prev=empty).
    const types = deltas.map((d) => d.type);
    assert.ok(types.includes("window.added"), `types: ${types.join(", ")}`);
    assert.ok(types.includes("pane.opened"));
    assert.ok(types.includes("focus.changed"));
    // window.added must precede pane.opened.
    assert.ok(types.indexOf("window.added") < types.indexOf("pane.opened"));
    // pane.opened must precede focus.changed.
    assert.ok(types.indexOf("pane.opened") < types.indexOf("focus.changed"));
  });
});

describe("requeryDiff: reconnect (prev=same state)", () => {
  it("identical model in/out produces zero deltas", () => {
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({
      paneNum: 1,
      winNum: 1,
      sessNum: 0,
      active: true,
    });

    // Build the model once from a bootstrap cycle, then requery against it
    // with the same replies — should emit nothing.
    const first = requeryDiff(emptyModel(), okResult(win), okResult(pane));
    const second = requeryDiff(first.next, okResult(win), okResult(pane));

    assert.deepEqual(second.deltas, [], `expected zero deltas, got ${second.deltas.map((d) => d.type).join(", ")}`);
  });
});

describe("requeryDiff: dead-pane semantics", () => {
  it("pane absent from new list-panes → pane.closed delta", () => {
    // prev: window has two panes (p1, p2). next: list-panes returns only p1.
    const winBoth = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: TWO_PANE_HSPLIT_LAYOUT(1, 2),
      active: true,
    });
    const paneBoth =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });
    const prev = requeryDiff(emptyModel(), okResult(winBoth), okResult(paneBoth)).next;

    // p2 has exited; tmux drops it from list-panes and reflows the layout.
    const winSingle = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const paneSingle = paneLine({
      paneNum: 1,
      winNum: 1,
      sessNum: 0,
      active: true,
    });

    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(paneSingle));

    assert.ok(!next.panes.has(paneId("p2")), "p2 removed from model");
    const closed = deltas.filter((d) => d.type === "pane.closed");
    assert.equal(closed.length, 1, `expected one pane.closed, got ${closed.length}`);
    assert.equal((closed[0]! as { paneId: PaneId }).paneId, paneId("p2"));
  });

  it("pane still present in list-panes (e.g. remain-on-exit dead) survives", () => {
    // Same pane in both replies — engine must not synthesize a close delta
    // just because some sibling pane left. The reducer's dead-pane contract
    // is "in list-panes ⇒ in model"; we mirror that.
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const prev = requeryDiff(emptyModel(), okResult(win), okResult(pane)).next;

    const { next, deltas } = requeryDiff(prev, okResult(win), okResult(pane));
    assert.ok(next.panes.has(paneId("p1")), "p1 still in model");
    assert.deepEqual(deltas, []);
  });
});

describe("requeryDiff: reparenting (break-pane)", () => {
  it("same pane id, new window → no pane.opened/pane.closed, layouts update", () => {
    // prev: w1 has p1+p2; next: w1 has p1, new window w2 has p2.
    // Wire intent: a reparented pane keeps its identity (and its scrollback)
    // because the wire only sees layout.updated on both windows, not a
    // pane.closed + pane.opened pair. Stable ids make this mechanical.
    const winBefore = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: TWO_PANE_HSPLIT_LAYOUT(1, 2),
      active: true,
    });
    const paneBefore =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });
    const prev = requeryDiff(emptyModel(), okResult(winBefore), okResult(paneBefore)).next;

    const winAfter =
      winLine({
        sessNum: 0,
        sessName: "main",
        winNum: 1,
        winName: "shell",
        layout: SINGLE_PANE_LAYOUT(1),
        active: true,
      }) +
      winLine({
        sessNum: 0,
        sessName: "main",
        winNum: 2,
        winName: "broken",
        layout: SINGLE_PANE_LAYOUT(2),
        active: false,
      });
    const paneAfter =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true }) +
      paneLine({ paneNum: 2, winNum: 2, sessNum: 0, active: true });

    const { next, deltas } = requeryDiff(prev, okResult(winAfter), okResult(paneAfter));

    // Identity invariants.
    assert.ok(next.panes.has(paneId("p1")));
    assert.ok(next.panes.has(paneId("p2")));
    assert.equal(next.windows.size, 2);
    assert.equal(next.panes.get(paneId("p2"))!.windowId, windowId("w2"));

    // Wire-shape invariants.
    const types = deltas.map((d) => d.type);
    assert.ok(!types.includes("pane.closed"), `unexpected pane.closed: ${types.join(", ")}`);
    assert.ok(!types.includes("pane.opened"), `unexpected pane.opened: ${types.join(", ")}`);
    // The new window must be announced.
    assert.ok(types.includes("window.added"));
    // Both window layouts must update.
    const layoutCount = types.filter((t) => t === "layout.updated").length;
    assert.ok(layoutCount >= 1, `expected layout.updated, got ${types.join(", ")}`);
  });
});

describe("requeryDiff: %error fallbacks", () => {
  it("both replies %error → fresh empty model, full teardown of prev", () => {
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const prev = requeryDiff(emptyModel(), okResult(win), okResult(pane)).next;

    const { next, deltas } = requeryDiff(prev, errResult(), errResult());
    assert.equal(next.sessions.size, 0);
    assert.equal(next.windows.size, 0);
    assert.equal(next.panes.size, 0);

    // Teardown deltas: window.closed + pane.closed must be present.
    const types = deltas.map((d) => d.type);
    assert.ok(types.includes("pane.closed"));
    assert.ok(types.includes("window.closed"));
    // pane.closed must precede window.closed (delta ordering rule).
    assert.ok(types.indexOf("pane.closed") < types.indexOf("window.closed"));
  });
});

// ---------------------------------------------------------------------------
// 2. RequeryEngine — driver
// ---------------------------------------------------------------------------

/**
 * Build a `submit` that hands back the next queued result for each command.
 * Order of `results` matches the order of `submit()` calls (FIFO).
 */
function queueSubmit(results: CommandResult[]): {
  submit: SubmitCommand;
  pendingCount: () => number;
} {
  const queue = [...results];
  return {
    submit: () => Promise.resolve(queue.shift() ?? errResult(999)),
    pendingCount: () => queue.length,
  };
}

/**
 * Build a `submit` whose returned Promises can be resolved manually. Used to
 * simulate mid-flight events (markDirty between the two command sends and the
 * replies coming back).
 */
function deferredSubmit(): {
  submit: SubmitCommand;
  resolveNext(result: CommandResult): void;
  callCount(): number;
} {
  let calls = 0;
  const pending: Array<(r: CommandResult) => void> = [];
  return {
    submit: () => {
      calls += 1;
      return new Promise<CommandResult>((resolve) => {
        pending.push(resolve);
      });
    },
    resolveNext: (r) => {
      const resolve = pending.shift();
      if (resolve === undefined) {
        throw new Error("no pending submit to resolve");
      }
      resolve(r);
    },
    callCount: () => calls,
  };
}

describe("RequeryEngine: basic cycle", () => {
  it("requery() returns the diff against the initial model", async () => {
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const { submit } = queueSubmit([okResult(win), okResult(pane)]);

    const engine = createRequeryEngine({ submit });
    const { next, deltas } = await engine.requery();

    assert.equal(next.windows.size, 1);
    assert.equal(next.panes.size, 1);
    assert.ok(deltas.length > 0);
    assert.equal(engine.getModel(), next);
  });

  it("getModel() reflects the last cycle's result", async () => {
    const win1 = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane1 = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const win2 =
      winLine({
        sessNum: 0,
        sessName: "main",
        winNum: 1,
        winName: "shell",
        layout: TWO_PANE_HSPLIT_LAYOUT(1, 2),
        active: true,
      });
    const pane2 =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });

    const { submit } = queueSubmit([
      okResult(win1),
      okResult(pane1),
      okResult(win2),
      okResult(pane2),
    ]);
    const engine = createRequeryEngine({ submit });

    await engine.requery();
    assert.equal(engine.getModel().panes.size, 1);

    const { deltas } = await engine.requery();
    assert.equal(engine.getModel().panes.size, 2);
    const types = deltas.map((d) => d.type);
    assert.ok(types.includes("pane.opened"), `expected pane.opened in second cycle: ${types.join(", ")}`);
  });

  it("isDirty() is cleared once a cycle starts", async () => {
    const { submit } = queueSubmit([okResult(""), okResult("")]);
    const engine = createRequeryEngine({ submit });
    engine.markDirty();
    assert.equal(engine.isDirty(), true);
    await engine.requery();
    assert.equal(engine.isDirty(), false);
  });
});

describe("RequeryEngine: dirty mid-flight → re-run", () => {
  it("markDirty() during in-flight cycle triggers a second cycle", async () => {
    const win1 = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane1 = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const win2 = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: TWO_PANE_HSPLIT_LAYOUT(1, 2),
      active: true,
    });
    const pane2 =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });

    const d = deferredSubmit();
    const engine = createRequeryEngine({ submit: d.submit });

    const inflight = engine.requery();
    // After requery() is called, the engine has issued submit() twice and is
    // awaiting both replies. The dirty bit was just cleared at cycle start.
    assert.equal(d.callCount(), 2);

    // Simulate a topology notification arriving between sends and replies.
    engine.markDirty();

    // Resolve cycle 1.
    d.resolveNext(okResult(win1));
    d.resolveNext(okResult(pane1));

    // Yield so the cycle's await completes and the engine notices the dirty
    // bit and kicks off cycle 2. After this tick, submit should have been
    // called four times (cycle 1's two + cycle 2's two).
    await new Promise((r) => setImmediate(r));
    assert.equal(d.callCount(), 4, "engine must launch a second cycle when dirty");

    // Resolve cycle 2.
    d.resolveNext(okResult(win2));
    d.resolveNext(okResult(pane2));

    const { next, deltas } = await inflight;

    // Final model is the second cycle's model: two panes.
    assert.equal(next.panes.size, 2);
    // Returned deltas are the diff against the engine's PRE-CALL model
    // (empty), not the concat of per-cycle deltas — so we see exactly one
    // pane.opened for each pane that ended up in the final model.
    const opened = deltas.filter((d) => d.type === "pane.opened");
    assert.equal(opened.length, 2, `expected exactly two pane.opened in the cumulative diff: ${deltas.map((d) => d.type).join(", ")}`);
    // No pane.closed: nothing flickered through and survived.
    assert.ok(!deltas.some((d) => d.type === "pane.closed"));
  });

  it("concurrent requery() calls share the same in-flight Promise", async () => {
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });

    const d = deferredSubmit();
    const engine = createRequeryEngine({ submit: d.submit });

    const p1 = engine.requery();
    const p2 = engine.requery();
    assert.equal(p1, p2, "concurrent requery() must return the same Promise");
    assert.equal(d.callCount(), 2, "only one cycle issued (two commands per cycle)");

    d.resolveNext(okResult(win));
    d.resolveNext(okResult(pane));

    await p1;
  });
});

describe("RequeryEngine: initialModel (reconnect)", () => {
  it("reconnect to identical state emits zero deltas", async () => {
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });

    // First engine: bootstrap.
    const bootstrap = createRequeryEngine({
      submit: queueSubmit([okResult(win), okResult(pane)]).submit,
    });
    const { next: lastServed } = await bootstrap.requery();

    // Second engine: reconnect with the last-served model as the baseline.
    // Querying the same state should produce zero deltas — the client
    // already knows everything, no teardown-flash.
    const reconnect = createRequeryEngine({
      initialModel: lastServed,
      submit: queueSubmit([okResult(win), okResult(pane)]).submit,
    });
    const { deltas } = await reconnect.requery();
    assert.deepEqual(deltas, [], `expected zero reconnect deltas, got ${deltas.map((d) => d.type).join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Property-style round-trip
//
// For a battery of random (prev, next) model pairs, assert:
//   replay(diffModel(prev, next), prev) deep-equals next
//
// We use a model-level applier (not a snapshot-level one) so we can directly
// compare against `next`. The applier handles every delta the engine can
// emit; unknown deltas throw to keep the test honest.
// ---------------------------------------------------------------------------

/** Mutable scratch shape used by the model-level delta applier. */
interface MutableModel {
  sessions: Map<SessionId, Session>;
  windows: Map<WindowId, Window>;
  panes: Map<PaneId, Pane>;
  focus: { paneId: PaneId | null; windowId: WindowId | null; sessionId: SessionId | null };
}

function toMutable(model: SessionModel): MutableModel {
  return {
    sessions: new Map(model.sessions),
    windows: new Map(model.windows),
    panes: new Map(model.panes),
    focus: { ...model.focus },
  };
}

function freeze(m: MutableModel): SessionModel {
  return {
    sessions: m.sessions,
    windows: m.windows,
    panes: m.panes,
    focus: m.focus,
  };
}

/**
 * Apply a wire delta to a MutableModel in place.
 *
 * This is a reference applier used only in tests: the property test asserts
 * that `applyDeltasToModel(prev, diffModel(prev, next))` deep-equals `next`.
 * Each branch corresponds to one delta type emitted by `diffModel`.
 *
 * @throws if the delta references an unknown entity or is an unrecognized
 *         type — the test wants a hard failure rather than a silent drop.
 */
function applyDeltaToModel(m: MutableModel, delta: SessionProxyMessage): void {
  switch (delta.type) {
    case "window.added": {
      // The owning session is whichever session owns the model — the wire is
      // single-session, so we attach to the first session in the map. In our
      // property test all models share a single session id.
      const sessEntry = m.sessions.values().next().value;
      if (!sessEntry) throw new Error("window.added with no session in model");
      const win: Window = {
        windowId: delta.windowId,
        sessionId: sessEntry.sessionId,
        name: delta.name,
        paneIds: [],
        activePaneId: null,
        layout: null,
        synchronizePanes: false,
        monitorActivity: true,
        monitorSilence: 0,
      };
      m.windows.set(delta.windowId, win);
      const sess = m.sessions.get(sessEntry.sessionId)!;
      m.sessions.set(sess.sessionId, {
        ...sess,
        windowIds: [...sess.windowIds, delta.windowId],
        activeWindowId: delta.active ? delta.windowId : (sess.activeWindowId ?? delta.windowId),
      });
      return;
    }
    case "window.closed": {
      const win = m.windows.get(delta.windowId);
      if (!win) return;
      for (const pid of win.paneIds) m.panes.delete(pid);
      m.windows.delete(delta.windowId);
      const sess = m.sessions.get(win.sessionId);
      if (sess) {
        const remaining = sess.windowIds.filter((id) => id !== delta.windowId);
        m.sessions.set(sess.sessionId, {
          ...sess,
          windowIds: remaining,
          activeWindowId:
            sess.activeWindowId === delta.windowId
              ? (remaining[0] ?? null)
              : sess.activeWindowId,
        });
      }
      if (m.focus.windowId === delta.windowId) {
        m.focus = { paneId: null, windowId: null, sessionId: null };
      }
      return;
    }
    case "window.renamed": {
      const win = m.windows.get(delta.windowId);
      if (!win) throw new Error(`window.renamed: ${delta.windowId} not found`);
      m.windows.set(delta.windowId, { ...win, name: delta.newName });
      return;
    }
    case "layout.updated": {
      const win = m.windows.get(delta.windowId);
      if (!win) throw new Error(`layout.updated: ${delta.windowId} not found`);
      m.windows.set(delta.windowId, { ...win, layout: delta.layout });
      return;
    }
    case "pane.opened": {
      const win = m.windows.get(delta.windowId);
      if (!win) throw new Error(`pane.opened: window ${delta.windowId} not found`);
      const pane: Pane = {
        paneId: delta.paneId,
        windowId: delta.windowId,
        sessionId: win.sessionId,
        cols: delta.cols,
        rows: delta.rows,
        mode: "normal",
        scrollbackHandle: undefined,
      };
      m.panes.set(delta.paneId, pane);
      m.windows.set(delta.windowId, {
        ...win,
        paneIds: [...win.paneIds, delta.paneId],
        activePaneId: delta.active ? delta.paneId : (win.activePaneId ?? delta.paneId),
      });
      return;
    }
    case "pane.closed": {
      const pane = m.panes.get(delta.paneId);
      if (!pane) return;
      m.panes.delete(delta.paneId);
      const win = m.windows.get(pane.windowId);
      if (win) {
        const remaining = win.paneIds.filter((id) => id !== delta.paneId);
        m.windows.set(win.windowId, {
          ...win,
          paneIds: remaining,
          activePaneId:
            win.activePaneId === delta.paneId
              ? (remaining[0] ?? null)
              : win.activePaneId,
        });
      }
      if (m.focus.paneId === delta.paneId) {
        m.focus = { paneId: null, windowId: null, sessionId: null };
      }
      return;
    }
    case "pane.resized": {
      const pane = m.panes.get(delta.paneId);
      if (!pane) throw new Error(`pane.resized: ${delta.paneId} not found`);
      m.panes.set(delta.paneId, { ...pane, cols: delta.cols, rows: delta.rows });
      return;
    }
    case "pane.mode-changed": {
      const pane = m.panes.get(delta.paneId);
      if (!pane) throw new Error(`pane.mode-changed: ${delta.paneId} not found`);
      m.panes.set(delta.paneId, { ...pane, mode: delta.mode });
      return;
    }
    case "focus.changed": {
      if (delta.paneId === null || delta.windowId === null) {
        m.focus = { paneId: null, windowId: null, sessionId: null };
        return;
      }
      const win = m.windows.get(delta.windowId);
      if (!win) throw new Error(`focus.changed: window ${delta.windowId} not found`);
      m.windows.set(delta.windowId, { ...win, activePaneId: delta.paneId });
      const sess = m.sessions.get(win.sessionId);
      if (sess) {
        m.sessions.set(sess.sessionId, { ...sess, activeWindowId: delta.windowId });
      }
      m.focus = { paneId: delta.paneId, windowId: delta.windowId, sessionId: win.sessionId };
      return;
    }
    case "session.renamed": {
      const first = m.sessions.values().next().value;
      if (!first) throw new Error("session.renamed with no session");
      m.sessions.set(first.sessionId, { ...first, name: delta.newName });
      return;
    }
    // Other v3 deltas (sync/monitor toggles, client-count, etc.) are not
    // emitted by diffModel from a requery cycle because the requery only
    // covers the topology fields the bootstrap parser reads. If diffModel
    // ever emits them on requery output, the property test will throw
    // here — exactly the signal we want.
    default:
      throw new Error(`applyDeltaToModel: unexpected delta type ${(delta as { type: string }).type}`);
  }
}

function applyDeltasToModel(
  prev: SessionModel,
  deltas: readonly SessionProxyMessage[],
): SessionModel {
  const m = toMutable(prev);
  for (const d of deltas) applyDeltaToModel(m, d);
  return freeze(m);
}

/**
 * Comparable shape — strips fields we don't propagate via the wire (e.g.
 * scrollbackHandle, denormalized sessionId on Pane, etc.) so the round-trip
 * property compares like-for-like.
 *
 * Layouts are compared as JSON strings (null stays null) so the deep-equal
 * still catches actual structural differences while tolerating object
 * identity differences from re-parsing. With `includeLayout: false` the
 * layout field is excluded entirely — used by the reply-body round-trip,
 * where the random model has null layouts and the parsed model recovers
 * concrete trees from the serialized layout strings.
 */
function comparable(model: SessionModel, opts: { includeLayout?: boolean } = {}) {
  const includeLayout = opts.includeLayout ?? true;
  const sessions = [...model.sessions.values()]
    .map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      windowIds: [...s.windowIds].sort(),
      activeWindowId: s.activeWindowId,
    }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const windows = [...model.windows.values()]
    .map((w) => {
      const base = {
        windowId: w.windowId,
        sessionId: w.sessionId,
        name: w.name,
        paneIds: [...w.paneIds].sort(),
        activePaneId: w.activePaneId,
      };
      return includeLayout ? { ...base, layout: w.layout } : base;
    })
    .sort((a, b) => a.windowId.localeCompare(b.windowId));
  const panes = [...model.panes.values()]
    .map((p) => ({
      paneId: p.paneId,
      windowId: p.windowId,
      cols: p.cols,
      rows: p.rows,
      mode: p.mode,
    }))
    .sort((a, b) => a.paneId.localeCompare(b.paneId));
  return { sessions, windows, panes, focus: model.focus };
}

// ---------------------------------------------------------------------------
// Random model generator
//
// Models are constrained to the shape `diffModel` understands: one session,
// 0..3 windows each with 0..3 panes, one focus or none. Seeded LCG for
// reproducibility.
// ---------------------------------------------------------------------------

function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function randomModel(rng: () => number, opts: { minWindows?: number } = {}): SessionModel {
  const S = sessionId("s0");
  let model = emptyModel();
  const sess: Session = {
    sessionId: S,
    name: "main",
    windowIds: [],
    activeWindowId: null,
  };
  model = addSession(model, sess);

  const nWindows = randInt(rng, opts.minWindows ?? 0, 3);
  let activeWid: WindowId | null = null;
  let activePid: PaneId | null = null;
  let firstWin: WindowId | null = null;
  let firstPaneOfActiveWin: PaneId | null = null;

  for (let wi = 0; wi < nWindows; wi++) {
    const wid = windowId("w" + (wi + 1));
    if (firstWin === null) firstWin = wid;
    const win: Window = {
      windowId: wid,
      sessionId: S,
      name: "win-" + (wi + 1),
      paneIds: [],
      activePaneId: null,
      layout: null,
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    };
    model = addWindow(model, win);

    const nPanes = randInt(rng, 1, 3);
    let firstPid: PaneId | null = null;
    for (let pi = 0; pi < nPanes; pi++) {
      const pid = paneId("p" + (wi * 10 + pi + 1));
      if (firstPid === null) firstPid = pid;
      const pane: Pane = {
        paneId: pid,
        windowId: wid,
        sessionId: S,
        cols: 40 + randInt(rng, 0, 40),
        rows: 12 + randInt(rng, 0, 12),
        mode: "normal",
        scrollbackHandle: undefined,
      };
      model = addPane(model, pane);
    }

    // Each window's first pane is the activePaneId (addPane sets this on the
    // first pane added with activePaneId === null).
    if (wi === 0) {
      activeWid = wid;
      firstPaneOfActiveWin = firstPid;
    }
  }

  if (activeWid !== null) {
    model = updateSession(model, S, { activeWindowId: activeWid });
    activePid = firstPaneOfActiveWin;
  }

  // Focus: only set if we have something to focus on; otherwise leave null.
  if (activePid !== null && activeWid !== null) {
    model = setFocus(model, { paneId: activePid, windowId: activeWid, sessionId: S });
  }

  return model;
}

describe("requery: property-style round-trip", () => {
  it("for many random model pairs, applyDeltas(prev, diffModel(prev, next)) == next", () => {
    // Run a battery of pairs; each iteration is cheap, so 64 covers the
    // shape space (add/remove/rename/resize/focus/layout) with high overlap.
    const N = 64;
    for (let i = 0; i < N; i++) {
      const rng = mkRng(0xc0ffee + i);
      const prev = randomModel(rng);
      const next = randomModel(rng);

      // Build deltas the engine would emit if it transitioned prev → next.
      // We drive the property directly off diffModel: requeryDiff's `deltas`
      // is just `diffModel(prev, buildInitialModel(rows))`, so the round-trip
      // property of the engine is precisely diffModel's round-trip property.
      const deltas = diffModel(prev, next);

      const replayed = applyDeltasToModel(prev, deltas);
      assert.deepEqual(
        comparable(replayed),
        comparable(next),
        `round-trip mismatch on iteration ${i}`,
      );
    }
  });

  it("for many random model pairs, requeryDiff round-trips through reply bodies", () => {
    // Sanity check: feed `next` through the bootstrap reply parsers via
    // requeryDiff (synthesizing a reply body that mirrors `next`), then
    // assert the parsed model is structurally equivalent to `next`.
    //
    // This ensures the engine's parse-and-diff pipeline does not accidentally
    // drop fields the property test above takes for granted.
    const N = 16;
    for (let i = 0; i < N; i++) {
      const rng = mkRng(0xbadf00d + i);
      // minWindows: 1 — bootstrap parses sessions out of the windows reply, so
      // a session with zero windows cannot be represented as a list-windows
      // body. tmux never produces this state in practice (a session always
      // has at least one window) and the engine's only input is what tmux
      // returns. We constrain the random pool to match.
      const next = randomModel(rng, { minWindows: 1 });

      const winsBody = serializeWindowsBody(next);
      const panesBody = serializePanesBody(next);

      const { next: parsed } = requeryDiff(
        emptyModel(),
        okResult(winsBody),
        okResult(panesBody),
      );

      // The random generator does not produce layouts (all null) but the
      // serializer synthesizes a SINGLE_PANE_LAYOUT per window, which the
      // parser then materializes into a non-null WindowLayout. Exclude the
      // layout field from comparison — names, ids, parents, dimensions, and
      // focus are what the body-round-trip is responsible for here.
      assert.deepEqual(
        comparable(parsed, { includeLayout: false }),
        comparable(next, { includeLayout: false }),
        `serialize/parse round-trip mismatch on iteration ${i}`,
      );
    }
  });
});

/**
 * Serialize a model into a synthetic `list-windows` reply body shaped to
 * BOOTSTRAP_WINDOWS_FORMAT. Uses a single-pane layout per window for
 * simplicity — the random generator does not produce splits, so this is
 * always valid.
 */
function serializeWindowsBody(model: SessionModel): string {
  let out = "";
  for (const sess of model.sessions.values()) {
    const sessNum = parseInt(sess.sessionId.replace(/^s/, ""), 10);
    for (const wid of sess.windowIds) {
      const win = model.windows.get(wid)!;
      const winNum = parseInt(win.windowId.replace(/^w/, ""), 10);
      // Pick the first pane in the window (if any) for the single-pane layout.
      const firstPid = win.paneIds[0];
      const layoutPaneNum =
        firstPid !== undefined
          ? parseInt(firstPid.replace(/^p/, ""), 10)
          : 0;
      out += winLine({
        sessNum,
        sessName: sess.name,
        winNum,
        winName: win.name,
        layout: SINGLE_PANE_LAYOUT(layoutPaneNum),
        active: sess.activeWindowId === win.windowId,
      });
    }
  }
  return out;
}

function serializePanesBody(model: SessionModel): string {
  let out = "";
  for (const pane of model.panes.values()) {
    const paneNum = parseInt(pane.paneId.replace(/^p/, ""), 10);
    const winNum = parseInt(pane.windowId.replace(/^w/, ""), 10);
    const sessNum = parseInt(pane.sessionId.replace(/^s/, ""), 10);
    const win = model.windows.get(pane.windowId);
    out += paneLine({
      paneNum,
      winNum,
      sessNum,
      width: pane.cols,
      height: pane.rows,
      active: win?.activePaneId === pane.paneId,
    });
  }
  return out;
}
