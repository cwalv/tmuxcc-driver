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
import type {
  RequeryEngine,
  SubmitCommand,
  TeardownConfirmation,
} from "./requery.js";
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
  updatePane,
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
// BOOTSTRAP_PANES_FORMAT fields (tab-separated, 14):
//   %pane  @win  $sess  idx  w   h   top  left  active  pid   cmd  dead  deadStatus  @tmuxcc_label
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
  /** tc-4bv2 / tc-295a.10: pane_dead=1 (remain-on-exit corpse). */
  dead?: boolean;
  /** tc-4bv2 / tc-295a.10: pane_dead_status. Empty string when absent. */
  deadStatus?: number;
  /** tc-1a8z: @tmuxcc_label durable pane name. Empty string when unset. */
  label?: string;
  /** tc-i9aq.1: @tmuxcc-detach RESOLVED close policy. Empty string when unset. */
  detach?: "detach" | "kill";
  /** tc-i9aq.1: @tmuxcc-icon durable icon policy. Empty string when unset. */
  icon?: string;
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
    args.dead ? "1" : "0",
    args.deadStatus !== undefined ? String(args.deadStatus) : "",
    args.label ?? "",
    // tc-i9aq.1 (cold-start.md §4.A): @tmuxcc-detach / -icon.
    // tc-4b6k.2: @tmuxcc-bound is per-client and NOT read by the bulk requery.
    args.detach ?? "",
    args.icon ?? "",
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

// ---------------------------------------------------------------------------
// Dead-pane wire shape (tc-4bv2 W2.5 + tc-295a.10 W2.4 — shared shape)
// ---------------------------------------------------------------------------

describe("requeryDiff: dead-pane wire shape (tc-4bv2 / tc-295a.10)", () => {
  const winSingle = winLine({
    sessNum: 0,
    sessName: "main",
    winNum: 1,
    winName: "shell",
    layout: SINGLE_PANE_LAYOUT(1),
    active: true,
  });

  it("W2.5: an all-dead-pane session bootstraps into a NON-EMPTY snapshot (READY-independent-of-live-panes)", () => {
    // The bead's core symptom: a pre-existing session whose only pane is a
    // remain-on-exit corpse must still appear in the snapshot. The requery
    // does not depend on a live pane — the corpse is in list-panes, so it is
    // in the model, flagged dead.
    const deadPane = paneLine({
      paneNum: 1,
      winNum: 1,
      sessNum: 0,
      active: true,
      dead: true,
      deadStatus: 0,
    });
    const { next, deltas } = requeryDiff(emptyModel(), okResult(winSingle), okResult(deadPane));

    assert.equal(next.sessions.size, 1, "session present despite all panes dead");
    assert.equal(next.windows.size, 1, "window present");
    assert.equal(next.panes.size, 1, "dead pane is in the model");
    const p1 = next.panes.get(paneId("p1"))!;
    assert.equal(p1.dead, true, "pane flagged dead");
    assert.equal(p1.exitCode, 0, "exit code from pane_dead_status");

    // The bootstrap diff (against empty) carries pane.opened with dead:true —
    // the client renders the corpse on first sight.
    const opened = deltas.filter((d) => d.type === "pane.opened");
    assert.equal(opened.length, 1);
    assert.equal((opened[0] as { dead?: boolean }).dead, true, "pane.opened carries dead");
    assert.equal((opened[0] as { exitCode?: number }).exitCode, 0);
    // No pane.closed during a bootstrap of a dead pane (it is NOT an absence).
    assert.equal(deltas.filter((d) => d.type === "pane.closed").length, 0);
  });

  it("live pane → dead corpse in place emits pane.dead-changed (NOT pane.closed)", () => {
    const live = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(live)).next;

    const dead = paneLine({
      paneNum: 1,
      winNum: 1,
      sessNum: 0,
      active: true,
      dead: true,
      deadStatus: 137,
    });
    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(dead));

    assert.ok(next.panes.has(paneId("p1")), "pane survives as corpse");
    assert.equal(next.panes.get(paneId("p1"))!.dead, true);
    const deadChanged = deltas.filter((d) => d.type === "pane.dead-changed");
    assert.equal(deadChanged.length, 1, "exactly one pane.dead-changed");
    assert.equal((deadChanged[0] as { dead: boolean }).dead, true);
    assert.equal((deadChanged[0] as { exitCode?: number }).exitCode, 137);
    assert.equal(deltas.filter((d) => d.type === "pane.closed").length, 0, "no close while corpse survives");
  });

  it("dead corpse → reaped (gone from list-panes) emits exactly one pane.closed carrying the exit code", () => {
    const dead = paneLine({
      paneNum: 1,
      winNum: 1,
      sessNum: 0,
      active: true,
      dead: true,
      deadStatus: 42,
    });
    const prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(dead)).next;
    assert.equal(prev.panes.get(paneId("p1"))!.exitCode, 42);

    // Corpse reaped: window is now empty in tmux → window also gone.
    const { next, deltas } = requeryDiff(prev, okResult(""), okResult(""));
    assert.ok(!next.panes.has(paneId("p1")), "pane removed");
    const closed = deltas.filter((d) => d.type === "pane.closed");
    assert.equal(closed.length, 1, "exactly one pane.closed");
    assert.equal((closed[0] as { exitCode?: number }).exitCode, 42, "exit code carried through from corpse");
  });

  it("respawn-in-place (dead → live) emits pane.dead-changed dead:false with no exitCode", () => {
    const dead = paneLine({
      paneNum: 1, winNum: 1, sessNum: 0, active: true, dead: true, deadStatus: 1,
    });
    const prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(dead)).next;

    const live = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(live));
    assert.equal(next.panes.get(paneId("p1"))!.dead, false);
    const dc = deltas.filter((d) => d.type === "pane.dead-changed");
    assert.equal(dc.length, 1);
    assert.equal((dc[0] as { dead: boolean }).dead, false);
    assert.ok(!("exitCode" in (dc[0] as object)), "no exitCode when alive");
  });
});

// ---------------------------------------------------------------------------
// Durable pane-name re-read from @tmuxcc_label (tc-1a8z)
//
// The durable name lives in the per-pane @tmuxcc_label user-option and is
// re-read on every requery (BOOTSTRAP_PANES_FORMAT field [13]). This is what
// makes it survive a driver restart for FREE: a cold bootstrap (prev=empty)
// re-reads the option straight back into the model. A requery whose option
// value changed emits a pane.label-changed delta.
// ---------------------------------------------------------------------------

describe("requeryDiff: durable pane-name (@tmuxcc_label, tc-1a8z)", () => {
  const winSingle = winLine({
    sessNum: 0,
    sessName: "main",
    winNum: 1,
    winName: "shell",
    layout: SINGLE_PANE_LAYOUT(1),
    active: true,
  });

  it("bootstrap re-reads @tmuxcc_label into the model (survives a driver restart)", () => {
    // Simulate a driver restart: a fresh bootstrap (prev=empty) against a pane
    // that already carries @tmuxcc_label. The durable name re-materializes with
    // ZERO extra round-trips — canonical state lived with the pane in tmux.
    const named = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true, label: "deploy" });
    const { next, deltas } = requeryDiff(emptyModel(), okResult(winSingle), okResult(named));

    assert.equal(next.panes.get(paneId("p1"))!.label, "deploy", "durable name re-read on bootstrap");
    // The bootstrap diff carries the name on pane.opened (born-with-label).
    const opened = deltas.filter((d) => d.type === "pane.opened");
    assert.equal(opened.length, 1);
    assert.equal((opened[0] as { label?: string }).label, "deploy", "pane.opened carries the durable name");
  });

  it("an unset @tmuxcc_label leaves label undefined (empty option value)", () => {
    const bare = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true }); // label defaults ""
    const { next } = requeryDiff(emptyModel(), okResult(winSingle), okResult(bare));
    assert.equal(next.panes.get(paneId("p1"))!.label, undefined, "empty option → no durable name");
  });

  it("a changed @tmuxcc_label on a later requery emits exactly one pane.label-changed", () => {
    const bare = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(bare)).next;

    const named = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true, label: "build" });
    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(named));

    assert.equal(next.panes.get(paneId("p1"))!.label, "build");
    const lc = deltas.filter((d) => d.type === "pane.label-changed");
    assert.equal(lc.length, 1, "exactly one pane.label-changed");
    assert.equal((lc[0] as { label?: string }).label, "build");
    // A rename is NOT a structural change — no spurious open/close/resize.
    assert.equal(deltas.filter((d) => d.type === "pane.closed").length, 0);
    assert.equal(deltas.filter((d) => d.type === "pane.opened").length, 0);
  });

  it("clearing @tmuxcc_label on a later requery emits pane.label-changed with label ABSENT", () => {
    const named = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true, label: "build" });
    const prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(named)).next;

    const bare = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true }); // label cleared → ""
    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(bare));

    assert.equal(next.panes.get(paneId("p1"))!.label, undefined, "name cleared");
    const lc = deltas.filter((d) => d.type === "pane.label-changed");
    assert.equal(lc.length, 1);
    assert.ok(!("label" in (lc[0] as object)), "label omitted when cleared");
  });
});

// ---------------------------------------------------------------------------
// Durable policy re-read from @tmuxcc-detach / -icon (tc-i9aq.1) + per-client
// binding carry-forward (tc-4b6k.2)
//
// cold-start.md §4.A: the per-pane @tmuxcc-detach / -icon options are re-read on
// every requery, so close policy / icon policy survive a driver restart. unset →
// empty → undefined. A changed value emits exactly one pane.policy-changed delta.
//
// tc-4b6k.2 (D3): binding intent is per-(pane,client), NOT read by the bulk
// requery — a fresh candidate pane's boundClients is empty, and a surviving
// pane's set is carried forward from the previous model so a topology-only cycle
// never clobbers it (the per-client slot is (re)read on connect elsewhere).
// ---------------------------------------------------------------------------

describe("requeryDiff: durable policy (@tmuxcc-detach/-icon, tc-i9aq.1) + binding carry-forward (tc-4b6k.2)", () => {
  const winSingle = winLine({
    sessNum: 0,
    sessName: "main",
    winNum: 1,
    winName: "shell",
    layout: SINGLE_PANE_LAYOUT(1),
    active: true,
  });

  it("bootstrap re-reads @tmuxcc-detach/-icon; boundClients starts empty (per-client not bulk-read)", () => {
    const line = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true, detach: "kill", icon: "rocket" });
    const { next, deltas } = requeryDiff(emptyModel(), okResult(winSingle), okResult(line));
    const p = next.panes.get(paneId("p1"))!;
    assert.equal(p.boundClients.size, 0, "binding is per-client, not read by the bulk requery");
    assert.equal(p.detach, "kill", "resolved detach re-read on bootstrap");
    assert.equal(p.icon, "rocket", "icon policy re-read on bootstrap");
    // The bootstrap diff carries the policy on pane.opened; bound resolves false
    // (no client id in this metrics/test diff) so it is off.
    const opened = deltas.filter((d) => d.type === "pane.opened");
    assert.equal(opened.length, 1);
    assert.ok(!("bound" in (opened[0] as object)), "pane.opened bound off (no client id)");
    assert.equal((opened[0] as { detach?: string }).detach, "kill", "pane.opened carries detach");
    assert.equal((opened[0] as { icon?: string }).icon, "rocket", "pane.opened carries icon");
  });

  it("unset @tmuxcc-* leaves boundClients empty, detach/icon undefined", () => {
    const bare = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const { next } = requeryDiff(emptyModel(), okResult(winSingle), okResult(bare));
    const p = next.panes.get(paneId("p1"))!;
    assert.equal(p.boundClients.size, 0);
    assert.equal(p.detach, undefined);
    assert.equal(p.icon, undefined);
  });

  it("carries per-client binding forward across a topology-only requery cycle", () => {
    // Bootstrap, then seed a per-client binding on the model (as the connect-read
    // / optimistic write would). A subsequent requery whose reply carries NO
    // per-client binding (the bulk read never does) must preserve it.
    const bare = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    let prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(bare)).next;
    prev = updatePane(prev, paneId("p1"), { boundClients: new Set(["ws-alpha"]) });

    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(bare));
    assert.deepEqual(
      [...next.panes.get(paneId("p1"))!.boundClients],
      ["ws-alpha"],
      "surviving pane keeps its per-client binding across the requery",
    );
    // Topology + binding unchanged → no deltas for the affected client.
    assert.equal(deltas.length, 0, "carry-forward produces no spurious deltas");
  });

  it("a changed detach on a later requery emits exactly one pane.policy-changed", () => {
    const bare = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(bare)).next;

    const marked = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true, detach: "detach" });
    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(marked));

    assert.equal(next.panes.get(paneId("p1"))!.detach, "detach");
    const pc = deltas.filter((d) => d.type === "pane.policy-changed");
    assert.equal(pc.length, 1, "exactly one pane.policy-changed");
    assert.equal((pc[0] as { detach?: string }).detach, "detach");
    // A policy change is NOT structural — no spurious open/close.
    assert.equal(deltas.filter((d) => d.type === "pane.closed").length, 0);
    assert.equal(deltas.filter((d) => d.type === "pane.opened").length, 0);
  });

  it("clearing detach on a later requery emits pane.policy-changed with detach ABSENT", () => {
    const marked = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true, detach: "kill" });
    const prev = requeryDiff(emptyModel(), okResult(winSingle), okResult(marked)).next;

    const bare = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true }); // detach cleared → ""
    const { next, deltas } = requeryDiff(prev, okResult(winSingle), okResult(bare));

    assert.equal(next.panes.get(paneId("p1"))!.detach, undefined, "detach cleared");
    const pc = deltas.filter((d) => d.type === "pane.policy-changed");
    assert.equal(pc.length, 1);
    assert.ok(!("detach" in (pc[0] as object)), "detach omitted when cleared");
  });
});

// ---------------------------------------------------------------------------
// W2.4 (tc-295a.10): pane.closed strong contract — removal matrix
//
// EXACTLY ONE pane.closed per removed slot, across the three removal causes:
//   - shell-exit (no remain-on-exit): slot vanishes directly; exit code
//     unknowable (no corpse phase) → exitCode absent.
//   - external kill-pane: a sibling pane removed from a multi-pane window;
//     window survives; exactly one pane.closed; exitCode absent.
//   - kill-window: the whole window goes; one pane.closed per pane in it +
//     one window.closed; exitCode absent.
//
// "Cause" is structural, not a wire enum — see the bd design comment. The
// matrix asserts cardinality + exitCode presence/absence per cause.
// ---------------------------------------------------------------------------

describe("requeryDiff: pane.closed strong contract matrix (tc-295a.10 W2.4)", () => {
  it("shell-exit (no remain-on-exit): exactly one pane.closed, exitCode absent (no corpse phase)", () => {
    // Single-pane window with a live pane; shell exits and tmux drops the slot
    // (and the now-empty window) in one requery — there was no corpse phase to
    // read pane_dead_status from.
    const win = winLine({
      sessNum: 0, sessName: "main", winNum: 1, winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1), active: true,
    });
    const live = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const prev = requeryDiff(emptyModel(), okResult(win), okResult(live)).next;

    const { deltas } = requeryDiff(prev, okResult(""), okResult(""));
    const closed = deltas.filter((d) => d.type === "pane.closed");
    assert.equal(closed.length, 1, "exactly one pane.closed");
    assert.equal((closed[0] as { paneId: PaneId }).paneId, paneId("p1"));
    assert.ok(!("exitCode" in (closed[0] as object)), "exitCode absent — no corpse to read");
  });

  it("external kill-pane: sibling removed from a multi-pane window → exactly one pane.closed, window survives", () => {
    const winBoth = winLine({
      sessNum: 0, sessName: "main", winNum: 1, winName: "shell",
      layout: TWO_PANE_HSPLIT_LAYOUT(1, 2), active: true,
    });
    const both =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });
    const prev = requeryDiff(emptyModel(), okResult(winBoth), okResult(both)).next;

    // p2 killed externally; window reflows to single pane.
    const winSolo = winLine({
      sessNum: 0, sessName: "main", winNum: 1, winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1), active: true,
    });
    const solo = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const { deltas } = requeryDiff(prev, okResult(winSolo), okResult(solo));

    const closed = deltas.filter((d) => d.type === "pane.closed");
    assert.equal(closed.length, 1, "exactly one pane.closed");
    assert.equal((closed[0] as { paneId: PaneId }).paneId, paneId("p2"));
    assert.ok(!("exitCode" in (closed[0] as object)), "exitCode absent for external kill");
    assert.equal(deltas.filter((d) => d.type === "window.closed").length, 0, "window survives");
  });

  it("kill-window: one pane.closed per pane + one window.closed", () => {
    const winBoth = winLine({
      sessNum: 0, sessName: "main", winNum: 1, winName: "shell",
      layout: TWO_PANE_HSPLIT_LAYOUT(1, 2), active: true,
    });
    const both =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });
    const prev = requeryDiff(emptyModel(), okResult(winBoth), okResult(both)).next;

    // Whole window killed: gone from both list-windows and list-panes.
    const { deltas } = requeryDiff(prev, okResult(""), okResult(""));
    const closed = deltas.filter((d) => d.type === "pane.closed");
    assert.equal(closed.length, 2, "one pane.closed per pane");
    const closedIds = new Set(closed.map((d) => (d as { paneId: PaneId }).paneId));
    assert.ok(closedIds.has(paneId("p1")) && closedIds.has(paneId("p2")));
    for (const d of closed) {
      assert.ok(!("exitCode" in (d as object)), "exitCode absent for kill-window");
    }
    assert.equal(deltas.filter((d) => d.type === "window.closed").length, 1, "exactly one window.closed");
  });

  it("idempotent: a removal seen once does not re-emit pane.closed on the next clean cycle", () => {
    const win = winLine({
      sessNum: 0, sessName: "main", winNum: 1, winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1), active: true,
    });
    const live = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });
    const prev = requeryDiff(emptyModel(), okResult(win), okResult(live)).next;

    const afterClose = requeryDiff(prev, okResult(""), okResult(""));
    assert.equal(afterClose.deltas.filter((d) => d.type === "pane.closed").length, 1);
    // Next requery against the post-close model: nothing to close again.
    const stable = requeryDiff(afterClose.next, okResult(""), okResult(""));
    assert.deepEqual(stable.deltas, [], "no duplicate pane.closed");
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

    // tc-4gor: the re-home MUST surface as a dedicated pane.moved carrying the
    // pane's NEW windowId — the single wire signal that re-points an existing
    // pane's owner. Without it a windowId-deriving client (the Mirror) renders
    // the new window empty with the pane stuck under its old window.
    const moved = deltas.find((d) => d.type === "pane.moved");
    assert.ok(moved !== undefined, `expected a pane.moved delta, got ${types.join(", ")}`);
    assert.equal((moved as { paneId: string }).paneId, paneId("p2"));
    assert.equal((moved as { windowId: string }).windowId, windowId("w2"));

    // Ordering: window.added (announces w2) must precede pane.moved (re-homes
    // p2 into w2) so the client never references a not-yet-announced window.
    assert.ok(
      types.indexOf("window.added") < types.indexOf("pane.moved"),
      `window.added must precede pane.moved; got ${types.join(", ")}`,
    );
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

  it("commit-only-clean (tc-128.5): mid-flight dirty discards intermediate model — getModel() stays unchanged until clean", async () => {
    // Drive cycle 1 to completion with a successful reply pair WHILE dirty,
    // then resolve cycle 2 clean. The engine's `_model` MUST stay at the
    // pre-call snapshot through cycle 1 (the candidate must not be
    // committed — it's possibly-torn). Only cycle 2's clean candidate
    // becomes the new `_model`. This is the "commit only clean snapshots"
    // invariant: clients never observe an intermediate model.
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
    const preCallModel = engine.getModel();

    const inflight = engine.requery();
    assert.equal(d.callCount(), 2);

    // Notification arrives mid-flight; engine becomes dirty before cycle 1
    // can complete.
    engine.markDirty();

    // Resolve cycle 1. The engine parses but must NOT commit (dirty was set).
    d.resolveNext(okResult(win1));
    d.resolveNext(okResult(pane1));

    // After microtask drain: cycle 1's candidate (one pane) was discarded.
    // getModel() is STILL the pre-call model (empty).
    await new Promise((r) => setImmediate(r));
    assert.equal(
      engine.getModel(),
      preCallModel,
      "engine.getModel() must stay at pre-call model while cycle is dirty mid-flight",
    );
    assert.equal(d.callCount(), 4, "engine launched cycle 2 because cycle 1 was dirty");

    // Resolve cycle 2 clean. This is the cycle that commits.
    d.resolveNext(okResult(win2));
    d.resolveNext(okResult(pane2));

    const { next, deltas } = await inflight;
    assert.equal(next.panes.size, 2, "committed model is cycle 2's two-pane state");
    assert.equal(engine.getModel(), next);
    // Cumulative deltas against the pre-call (empty) model: both panes
    // opened, no flicker of the intermediate one-pane state.
    const opened = deltas.filter((dlt) => dlt.type === "pane.opened");
    assert.equal(opened.length, 2);
    assert.ok(!deltas.some((dlt) => dlt.type === "pane.closed"));
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

describe("RequeryEngine: storm / convergence-budget (tc-128.5)", () => {
  it("storm during every cycle → loop exits within budget, returns failed:true, model unchanged", async () => {
    // Simulate a notification storm: every in-flight cycle is dirtied before
    // its replies land. Without a budget the engine would loop at cycle-rate
    // forever (and starve the caller of any resolution). With a budget of N
    // the loop must exit in at most N cycles and return failed:true.
    //
    // The exact N is an implementation detail; we exercise the contract by
    // (a) bounding observed submit() calls per requery() to a small constant,
    // (b) asserting the engine returns failed:true with the model unchanged.
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });

    // Synthesize many ok replies — enough to satisfy any reasonable budget.
    const replies: CommandResult[] = [];
    for (let i = 0; i < 100; i++) replies.push(okResult(win), okResult(pane));
    const { submit, pendingCount } = queueSubmit(replies);

    // Monkey-wrap submit so we can re-dirty the engine after every cycle's
    // FIRST submit (call number 1, 3, 5, ...) — that way each cycle is
    // dirty before its replies are even awaited.
    let engineRef: { ref: RequeryEngine } | null = null;
    let callCount = 0;
    const wrappedSubmit: SubmitCommand = (cmd) => {
      callCount += 1;
      // Re-dirty AFTER cycle's first submit but before either resolves.
      // This guarantees the dirty bit is set when the cycle's await resolves.
      if (engineRef !== null && callCount % 2 === 1) {
        engineRef.ref.markDirty();
      }
      return submit(cmd);
    };

    const engine = createRequeryEngine({ submit: wrappedSubmit });
    engineRef = { ref: engine };
    const preCallModel = engine.getModel();

    const result = await engine.requery();

    // Failure contract: failed:true, no deltas, model unchanged.
    assert.equal(result.failed, true, "storm must surface as failed cycle");
    assert.deepEqual(result.deltas, []);
    assert.equal(result.next, preCallModel, "next must be the pre-call (start) model");
    assert.equal(
      engine.getModel(),
      preCallModel,
      "engine.getModel() must NOT have advanced to any intermediate candidate",
    );

    // Bounded cycle count: must be small (the budget is meant to be ~5; we
    // tolerate up to 20 to allow the implementation room to tune without
    // breaking the test, but explicitly NOT cycle-rate / unbounded).
    const submitCalls = 100 * 2 - pendingCount();
    const cyclesRun = submitCalls / 2;
    assert.ok(
      cyclesRun > 0 && cyclesRun <= 20,
      `expected bounded cycles (≤20), got ${cyclesRun}`,
    );

    // Engine must be dirty so the coalescer's failed-path can schedule a retry.
    assert.equal(engine.isDirty(), true, "engine must re-arm dirty after storm-exit");
  });

  it("failure-after-progress (problem 2): success-then-error must NOT desync model — getModel() stays at pre-call snapshot and a subsequent successful requery emits the full cumulative deltas", async () => {
    // Reproduction of the desync described in the bead:
    //   - Cycle 1 succeeds (M0 → M1 candidate)
    //   - Mid-flight dirty triggers cycle 2
    //   - Cycle 2 hits %error
    // OLD behavior: this._model was swapped to M1 at cycle 1's end (the
    // "commit on each cycle" model), but the failed return reported
    // { next: startModel, deltas: [], failed: true } — so the caller
    // (and the wire) never saw M0→M1 deltas, while all future diffs were
    // computed against M1. Permanent desync.
    //
    // NEW behavior: cycle 1's candidate is NOT committed (it was dirty
    // mid-flight). Cycle 2 fails outright. _model stays at M0. The next
    // successful requery() emits diff(M0, M2) — the full cumulative
    // delta stream, no gap.
    const winSplit = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: TWO_PANE_HSPLIT_LAYOUT(1, 2),
      active: true,
    });
    const paneSplit =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });

    const d = deferredSubmit();
    const engine = createRequeryEngine({ submit: d.submit });
    const preCallModel = engine.getModel();
    assert.equal(preCallModel.panes.size, 0, "pre-call M0 is empty");

    // Cycle 1: kick off requery; reply pair will succeed.
    const inflight = engine.requery();
    assert.equal(d.callCount(), 2);

    // Mid-flight notification — would cause cycle 2.
    engine.markDirty();

    // Resolve cycle 1 successfully — gives a one-pane candidate (M1).
    // In the OLD code, this._model would be set to M1 right here.
    // In the NEW code, M1 is held only as a local candidate; _model stays
    // at the pre-call M0 because the dirty bit is set.
    d.resolveNext(okResult(winSplit));
    d.resolveNext(okResult(paneSplit));

    await new Promise((r) => setImmediate(r));
    assert.equal(d.callCount(), 4, "engine launched cycle 2 because dirty");
    // The key assertion against the OLD bug: getModel() must still be M0.
    assert.equal(
      engine.getModel(),
      preCallModel,
      "PROBLEM 2 regression: getModel() must stay at pre-call M0 across mid-flight dirty",
    );

    // Resolve cycle 2 with %error.
    d.resolveNext(errResult());
    d.resolveNext(errResult());

    const failed = await inflight;
    assert.equal(failed.failed, true);
    assert.deepEqual(failed.deltas, []);
    assert.equal(failed.next, preCallModel);
    assert.equal(
      engine.getModel(),
      preCallModel,
      "after failed requery: getModel() still M0 (model never advanced)",
    );
    assert.equal(engine.isDirty(), true, "engine re-armed dirty for the coalescer's retry");

    // Now: a subsequent successful requery() must emit the FULL cumulative
    // M0→M2 deltas (in our setup M2 is the same two-pane split as M1, but
    // structurally we're asserting the diff is computed against the pre-
    // call baseline that the caller still believes is current).
    const d2 = deferredSubmit();
    const engine2 = createRequeryEngine({
      // Carry over the (correctly unchanged) model from the failing engine.
      initialModel: engine.getModel(),
      submit: d2.submit,
    });

    const retry = engine2.requery();
    d2.resolveNext(okResult(winSplit));
    d2.resolveNext(okResult(paneSplit));
    const { next: m2, deltas: cumulative } = await retry;

    // Cumulative deltas must describe the M0→M2 transition the caller
    // never saw — the same shape that would have come out of a single
    // clean cycle from the start. Two pane.opened, no gap.
    assert.equal(m2.panes.size, 2);
    const opened = cumulative.filter((dlt) => dlt.type === "pane.opened");
    assert.equal(
      opened.length,
      2,
      `expected cumulative deltas to include both panes (no gap), got: ${cumulative.map((dlt) => dlt.type).join(", ")}`,
    );
    assert.ok(!cumulative.some((dlt) => dlt.type === "pane.closed"));
  });

  it("short-burst preserved (regression guard): one dirty mid-flight + next cycle clean → converges in-call with cumulative deltas", async () => {
    // This case is the DESIGN KEYSTONE for splits/pane-death — the leading
    // edge of a real topology change should be served immediately, even
    // when followed by a second notification mid-flight. The fix for the
    // storm/desync bugs must NOT regress this. Same shape as the existing
    // "dirty mid-flight → re-run" test but asserted from the commit-only-
    // clean perspective: cycle 2's candidate is the one that commits.
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
    engine.markDirty();
    d.resolveNext(okResult(win1));
    d.resolveNext(okResult(pane1));

    await new Promise((r) => setImmediate(r));
    // Resolve cycle 2 clean — this is the one that commits.
    d.resolveNext(okResult(win2));
    d.resolveNext(okResult(pane2));

    const { next, deltas } = await inflight;
    assert.equal(next.panes.size, 2);
    assert.equal(engine.getModel(), next);
    // Cumulative deltas against pre-call empty: two pane.opened.
    const opened = deltas.filter((dlt) => dlt.type === "pane.opened");
    assert.equal(opened.length, 2);
    // No spurious close for the cycle-1 candidate that was discarded.
    assert.ok(!deltas.some((dlt) => dlt.type === "pane.closed"));
    // Dirty bit cleared after a successful commit.
    assert.equal(engine.isDirty(), false);
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
        dead: delta.dead ?? false,
        exitCode: delta.dead ? delta.exitCode : undefined,
        label: delta.label,
        // tc-4b6k.2: no-client diffs never resolve bound true, so the
        // round-trip's per-client set stays empty.
        boundClients: new Set<string>(),
        detach: delta.detach,
        icon: delta.icon,
        // scrollbackHandle and paneTitle are optional — omit to avoid
        // exactOptionalPropertyTypes TS2375 when passing undefined explicitly.
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
        dead: false,
        exitCode: undefined,
        label: undefined,
        boundClients: new Set<string>(),
        detach: undefined,
        icon: undefined,
        // scrollbackHandle and paneTitle are optional — omit to avoid
        // exactOptionalPropertyTypes TS2375 when passing undefined explicitly.
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

// ---------------------------------------------------------------------------
// 4. Teardown-confirmation guard (tc-3si.2)
//
// The guard catches the tc-128.4 garbage-snapshot class: a clean cycle whose
// candidate would close ≥ threshold of the previous model's panes/windows is
// NOT committed immediately — the engine runs a confirming cycle first. If
// the confirming cycle agrees (also a teardown) the session-end is real and
// the teardown is served (one extra ~ms of latency). If it disagrees, the
// first candidate was garbage: discard, stay dirty, bump the refuted counter,
// log loudly, return failed. The refuted counter is an expected-zero
// tripwire — its job is to make a future regression of the bug class
// catastrophically visible, not silently absorbed.
// ---------------------------------------------------------------------------

/** Reusable populated baseline: one session, one window, two panes. */
function twoPaneModelBodies(): { winBody: string; paneBody: string } {
  const winBody = winLine({
    sessNum: 0,
    sessName: "main",
    winNum: 1,
    winName: "shell",
    layout: TWO_PANE_HSPLIT_LAYOUT(1, 2),
    active: true,
  });
  const paneBody =
    paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
    paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 });
  return { winBody, paneBody };
}

describe("RequeryEngine: teardown-confirmation guard (tc-3si.2)", () => {
  it("legit teardown (both cycles agree) served with exactly one extra cycle of latency", async () => {
    // Setup: model has two panes (the keystone "user has stuff open" baseline).
    // First requery returns it; second (post-kill-session) returns empty —
    // and the confirming cycle also returns empty (the session really did end).
    const { winBody, paneBody } = twoPaneModelBodies();

    // Boot the engine to a populated baseline first.
    const bootD = deferredSubmit();
    const engine = createRequeryEngine({
      submit: bootD.submit,
      onTeardownConfirmation: (info) => outcomes.push(info),
      onTeardownOutcome: (o) => counterCalls.push(o),
    });
    const outcomes: TeardownConfirmation[] = [];
    const counterCalls: Array<"confirmed" | "refuted"> = [];

    // Bootstrap cycle: deliver the two-pane state.
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;
    assert.equal(engine.getModel().panes.size, 2);
    assert.equal(engine.getModel().windows.size, 1);

    // Second requery: tmux genuinely teared down (kill-session etc). Both
    // the first cycle AND the confirming cycle return empty replies.
    const d = deferredSubmit();
    const engine2 = createRequeryEngine({
      initialModel: engine.getModel(),
      submit: d.submit,
      onTeardownConfirmation: (info) => outcomes.push(info),
      onTeardownOutcome: (o) => counterCalls.push(o),
    });

    const inflight = engine2.requery();
    // Cycle 1: empty replies — would close 100% of panes/windows.
    assert.equal(d.callCount(), 2, "cycle 1 issued list-windows + list-panes");
    d.resolveNext(okResult(""));
    d.resolveNext(okResult(""));

    // After microtask drain, the engine must have launched ONE confirming
    // cycle (the "one extra cycle of latency" promise).
    await new Promise((r) => setImmediate(r));
    assert.equal(
      d.callCount(),
      4,
      "engine ran exactly one confirming cycle (4 submits = 2 cycles × 2 commands)",
    );

    // Cycle 2 (confirming): also empty — session-end is real.
    d.resolveNext(okResult(""));
    d.resolveNext(okResult(""));

    const result = await inflight;
    assert.equal(result.failed, undefined, "confirmed teardown is NOT a failure");
    assert.equal(result.next.panes.size, 0, "model committed to empty state");
    assert.equal(result.next.windows.size, 0);

    // Deltas describe the teardown of the pre-call (two-pane) baseline.
    const types = result.deltas.map((dlt) => dlt.type);
    assert.ok(
      types.filter((t) => t === "pane.closed").length === 2,
      `expected 2 pane.closed deltas, got ${types.join(", ")}`,
    );
    assert.ok(types.includes("window.closed"));

    // Counter + observer: ONE confirmed event, ZERO refuted.
    assert.deepEqual(counterCalls, ["confirmed"]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.outcome, "confirmed");
    assert.equal(outcomes[0]!.closedPanesFraction, 1);
    assert.equal(outcomes[0]!.closedWindowsFraction, 1);
    assert.equal(outcomes[0]!.startPanes, 2);
    assert.equal(outcomes[0]!.startWindows, 1);
    // Engine is clean after a confirmed commit — same as a normal cycle.
    assert.equal(engine2.isDirty(), false);
  });

  it("garbage first cycle (refuted) → model untouched, refuted counter incremented, loud log emitted", async () => {
    const { winBody, paneBody } = twoPaneModelBodies();

    // Boot the engine to a populated baseline.
    const bootD = deferredSubmit();
    const engine = createRequeryEngine({ submit: bootD.submit });
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;
    const baseline = engine.getModel();
    assert.equal(baseline.panes.size, 2);

    // Now the actual test: cycle 1 returns garbage (empty), cycle 2
    // (confirming) returns the real two-pane state again.
    const outcomes: TeardownConfirmation[] = [];
    const counterCalls: Array<"confirmed" | "refuted"> = [];
    const d = deferredSubmit();
    const engine2 = createRequeryEngine({
      initialModel: baseline,
      submit: d.submit,
      onTeardownConfirmation: (info) => outcomes.push(info),
      onTeardownOutcome: (o) => counterCalls.push(o),
    });

    // Intercept stderr to verify the loud log.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    let result;
    try {
      const inflight = engine2.requery();
      // Cycle 1: garbage empty (the tc-128.4 mis-bind class).
      d.resolveNext(okResult(""));
      d.resolveNext(okResult(""));
      await new Promise((r) => setImmediate(r));
      // Cycle 2 (confirming): the REAL state — disagrees.
      d.resolveNext(okResult(winBody));
      d.resolveNext(okResult(paneBody));
      result = await inflight;
    } finally {
      process.stderr.write = origWrite;
    }

    // Failure contract: model untouched, no deltas, failed=true, dirty re-armed.
    assert.equal(result.failed, true, "refuted candidate must surface as failed");
    assert.deepEqual(result.deltas, []);
    assert.equal(result.next, baseline, "next is the pre-call (unchanged) model");
    assert.equal(engine2.getModel(), baseline, "engine.getModel() unchanged");
    assert.equal(engine2.isDirty(), true, "dirty re-armed for the coalescer's retry");

    // Telemetry: counter incremented with `refuted`, NO `confirmed`.
    assert.deepEqual(counterCalls, ["refuted"]);
    assert.equal(outcomes.length, 1);
    const info = outcomes[0]!;
    assert.equal(info.outcome, "refuted");
    // The reported fractions describe the FIRST candidate's would-have-been
    // teardown — the snapshot we held back, not the confirming one.
    assert.equal(info.closedPanesFraction, 1, "first candidate would have closed 100% of panes");
    assert.equal(info.closedWindowsFraction, 1);
    assert.equal(info.threshold, 0.8, "default threshold reported");
    assert.equal(info.startPanes, 2);
    assert.equal(info.startWindows, 1);

    // Loud stderr log emitted — names the event, fractions, threshold, bead.
    const logText = captured.join("");
    assert.ok(
      logText.includes("TEARDOWN REFUTED"),
      `expected loud refuted log, got: ${logText}`,
    );
    assert.ok(logText.includes("tc-128.4") || logText.includes("tc-3si.2"));
  });

  it("threshold is configurable (subtotal teardown trips when threshold lowered)", async () => {
    // Build a 5-pane / 2-window baseline. A candidate closing 1/5 panes
    // (20%) and 0/2 windows should NOT trip the default 80% threshold, but
    // SHOULD trip a 0.15 (15%) threshold — flipping the same wire-shape
    // candidate between "commit immediately" and "must be confirmed".
    const winBody =
      winLine({
        sessNum: 0,
        sessName: "main",
        winNum: 1,
        winName: "shell",
        layout: TWO_PANE_HSPLIT_LAYOUT(1, 2),
        active: true,
      }) +
      winLine({
        sessNum: 0,
        sessName: "main",
        winNum: 2,
        winName: "shell2",
        layout: `0000,80x24,0,0{30x24,0,0,3,30x24,31,0,4,19x24,61,0,5}`,
      });
    const paneBody =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, width: 40, active: true }) +
      paneLine({ paneNum: 2, winNum: 1, sessNum: 0, width: 39, left: 41 }) +
      paneLine({ paneNum: 3, winNum: 2, sessNum: 0, width: 30, active: true }) +
      paneLine({ paneNum: 4, winNum: 2, sessNum: 0, width: 30, left: 31 }) +
      paneLine({ paneNum: 5, winNum: 2, sessNum: 0, width: 19, left: 61 });

    const bootD = deferredSubmit();
    const engine = createRequeryEngine({ submit: bootD.submit });
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;
    assert.equal(engine.getModel().panes.size, 5);

    // Subtotal teardown: drop pane 2 only. Panes closed = 1/5 = 20%.
    // Windows untouched (0% closed). Well below the default 0.8 cap.
    const winBodyPartial =
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
        winName: "shell2",
        layout: `0000,80x24,0,0{30x24,0,0,3,30x24,31,0,4,19x24,61,0,5}`,
      });
    const paneBodyPartial =
      paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true }) +
      paneLine({ paneNum: 3, winNum: 2, sessNum: 0, width: 30, active: true }) +
      paneLine({ paneNum: 4, winNum: 2, sessNum: 0, width: 30, left: 31 }) +
      paneLine({ paneNum: 5, winNum: 2, sessNum: 0, width: 19, left: 61 });

    // 1. Default threshold (0.8): subtotal does NOT trip the guard, commits
    //    on the first clean cycle (no extra latency).
    {
      const d = deferredSubmit();
      const outcomes: TeardownConfirmation[] = [];
      const engine2 = createRequeryEngine({
        initialModel: engine.getModel(),
        submit: d.submit,
        onTeardownConfirmation: (info) => outcomes.push(info),
      });
      const inflight = engine2.requery();
      d.resolveNext(okResult(winBodyPartial));
      d.resolveNext(okResult(paneBodyPartial));
      const result = await inflight;
      assert.equal(result.failed, undefined, "subtotal commits at default threshold");
      assert.equal(d.callCount(), 2, "exactly one cycle (no confirming cycle)");
      assert.equal(outcomes.length, 0, "guard did NOT fire");
      assert.equal(engine2.getModel().panes.size, 4);
    }

    // 2. Lowered threshold (0.15): same subtotal NOW trips the guard. Run
    //    the confirming cycle agreeing → confirmed (commit).
    {
      const d = deferredSubmit();
      const outcomes: TeardownConfirmation[] = [];
      const engine2 = createRequeryEngine({
        initialModel: engine.getModel(),
        submit: d.submit,
        teardownThreshold: 0.15,
        onTeardownConfirmation: (info) => outcomes.push(info),
      });
      const inflight = engine2.requery();
      // Cycle 1: subtotal close — trips at threshold=0.15.
      d.resolveNext(okResult(winBodyPartial));
      d.resolveNext(okResult(paneBodyPartial));
      await new Promise((r) => setImmediate(r));
      assert.equal(d.callCount(), 4, "lowered threshold triggered confirming cycle");
      // Confirming cycle: same subtotal → confirmed.
      d.resolveNext(okResult(winBodyPartial));
      d.resolveNext(okResult(paneBodyPartial));
      const result = await inflight;
      assert.equal(result.failed, undefined, "confirmed at lowered threshold");
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.outcome, "confirmed");
      assert.equal(outcomes[0]!.threshold, 0.15);
      assert.equal(outcomes[0]!.closedPanesFraction, 0.2);
      assert.equal(outcomes[0]!.closedWindowsFraction, 0);
    }
  });

  it("invalid threshold values fall back to default (0.8)", async () => {
    const { winBody, paneBody } = twoPaneModelBodies();
    const bootD = deferredSubmit();
    const engine = createRequeryEngine({ submit: bootD.submit });
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;

    // teardownThreshold = 0 (would disable the guard entirely if not clamped)
    // — must fall back to the default.
    const d = deferredSubmit();
    const outcomes: TeardownConfirmation[] = [];
    const engine2 = createRequeryEngine({
      initialModel: engine.getModel(),
      submit: d.submit,
      teardownThreshold: 0,
      onTeardownConfirmation: (info) => outcomes.push(info),
    });
    const inflight = engine2.requery();
    // Garbage empty → would close 100%, far above 0.8 default.
    d.resolveNext(okResult(""));
    d.resolveNext(okResult(""));
    await new Promise((r) => setImmediate(r));
    // Confirming cycle disagrees.
    d.resolveNext(okResult(winBody));
    d.resolveNext(okResult(paneBody));
    // Suppress loud log noise for this test — we only care that the
    // threshold reported is the DEFAULT (0.8), not 0.
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = (() => true) as typeof process.stderr.write;
    try {
      const result = await inflight;
      assert.equal(result.failed, true);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(outcomes.length, 1);
    assert.equal(
      outcomes[0]!.threshold,
      0.8,
      "invalid threshold (0) clamped back to default (0.8)",
    );
  });

  it("guard does NOT fire on cold bootstrap (empty pre-call model)", async () => {
    // The engine's initialModel defaults to emptyModel(); a cold bootstrap
    // would naively trigger the guard (everything closing 0/0 = NaN — which
    // we treat as 0) — but the trip predicate is gated on the pre-call
    // model having SOMETHING to tear down, so the guard is a no-op here.
    const { winBody, paneBody } = twoPaneModelBodies();
    const outcomes: TeardownConfirmation[] = [];
    const counterCalls: Array<"confirmed" | "refuted"> = [];
    const d = deferredSubmit();
    const engine = createRequeryEngine({
      submit: d.submit,
      onTeardownConfirmation: (info) => outcomes.push(info),
      onTeardownOutcome: (o) => counterCalls.push(o),
    });

    const inflight = engine.requery();
    d.resolveNext(okResult(winBody));
    d.resolveNext(okResult(paneBody));
    const result = await inflight;

    assert.equal(result.failed, undefined, "bootstrap commits cleanly");
    assert.equal(d.callCount(), 2, "no confirming cycle on bootstrap");
    assert.equal(outcomes.length, 0, "guard did not fire on cold bootstrap");
    assert.deepEqual(counterCalls, []);
    assert.equal(engine.getModel().panes.size, 2);
  });

  it("guard does NOT fire on a no-change cycle (heartbeat steady state)", async () => {
    const { winBody, paneBody } = twoPaneModelBodies();
    const bootD = deferredSubmit();
    const engine = createRequeryEngine({ submit: bootD.submit });
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;

    // Steady-state heartbeat: replies are identical — zero deltas, zero
    // teardown. Must NOT trigger a confirming cycle.
    const outcomes: TeardownConfirmation[] = [];
    const d = deferredSubmit();
    const engine2 = createRequeryEngine({
      initialModel: engine.getModel(),
      submit: d.submit,
      onTeardownConfirmation: (info) => outcomes.push(info),
    });
    const inflight = engine2.requery();
    d.resolveNext(okResult(winBody));
    d.resolveNext(okResult(paneBody));
    const result = await inflight;

    assert.equal(d.callCount(), 2);
    assert.deepEqual(result.deltas, []);
    assert.equal(outcomes.length, 0);
  });

  it("dirty mid-flight during confirming cycle: confirming candidate discarded, no spurious commit", async () => {
    // Mixing the guard with the convergence loop: cycle 1 tripped the
    // guard, cycle 2 (confirming) is dirtied mid-flight (a notification
    // arrives between sending the list-* commands and the replies). The
    // engine must discard the confirming candidate, drop the pending
    // teardown comparison, and loop — eventually committing whatever the
    // next clean cycle says (or running out of budget if the storm
    // continues).
    const { winBody, paneBody } = twoPaneModelBodies();
    const bootD = deferredSubmit();
    const engine = createRequeryEngine({ submit: bootD.submit });
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;
    const baseline = engine.getModel();

    const outcomes: TeardownConfirmation[] = [];
    const d = deferredSubmit();
    const engine2 = createRequeryEngine({
      initialModel: baseline,
      submit: d.submit,
      onTeardownConfirmation: (info) => outcomes.push(info),
    });

    const inflight = engine2.requery();
    // Cycle 1: garbage empty (trips the guard).
    d.resolveNext(okResult(""));
    d.resolveNext(okResult(""));
    await new Promise((r) => setImmediate(r));
    assert.equal(d.callCount(), 4, "confirming cycle issued");

    // Dirty mid-flight in the confirming cycle.
    engine2.markDirty();
    // Confirming cycle's replies arrive — but the dirty bit means we
    // discard this candidate AND drop the pending teardown comparison.
    d.resolveNext(okResult(winBody));
    d.resolveNext(okResult(paneBody));
    await new Promise((r) => setImmediate(r));
    assert.equal(d.callCount(), 6, "engine looped to a fresh cycle");

    // Final cycle: clean replies match the original — no teardown.
    d.resolveNext(okResult(winBody));
    d.resolveNext(okResult(paneBody));
    const result = await inflight;

    // The model was never wiped; deltas are empty (we ended up at the
    // same state). No confirmation event because the comparison was
    // dropped on mid-flight dirty.
    assert.equal(result.failed, undefined);
    assert.deepEqual(result.deltas, []);
    assert.equal(engine2.getModel().panes.size, 2);
    assert.equal(outcomes.length, 0, "no confirmation outcome when guard reset by mid-flight dirty");
  });

  it("budget exhaustion during pending teardown returns failed without touching the counter", async () => {
    // Storm scenario where the first cycle trips the guard and EVERY
    // subsequent cycle is dirtied mid-flight: we exhaust the budget
    // without ever adjudicating confirm vs refute. The engine must
    // return failed, leave the model untouched, and NOT bump either
    // teardown counter — we never reached a decision.
    const { winBody, paneBody } = twoPaneModelBodies();
    const bootD = deferredSubmit();
    const engine = createRequeryEngine({ submit: bootD.submit });
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;
    const baseline = engine.getModel();

    // Use queueSubmit so we can stuff in plenty of replies and re-dirty
    // after every first submit (mirrors the existing storm test).
    const replies: CommandResult[] = [];
    // Cycle 1: empty (trips guard). Then enough empty pairs to satisfy
    // the budget — every cycle is dirtied mid-flight.
    for (let i = 0; i < 100; i++) replies.push(okResult(""), okResult(""));
    const { submit } = queueSubmit(replies);
    let engineRef: { ref: RequeryEngine } | null = null;
    let callCount = 0;
    const wrappedSubmit: SubmitCommand = (cmd) => {
      callCount += 1;
      if (engineRef !== null && callCount % 2 === 1) {
        engineRef.ref.markDirty();
      }
      return submit(cmd);
    };
    const outcomes: TeardownConfirmation[] = [];
    const counterCalls: Array<"confirmed" | "refuted"> = [];
    const engine2 = createRequeryEngine({
      initialModel: baseline,
      submit: wrappedSubmit,
      onTeardownConfirmation: (info) => outcomes.push(info),
      onTeardownOutcome: (o) => counterCalls.push(o),
    });
    engineRef = { ref: engine2 };

    const result = await engine2.requery();
    assert.equal(result.failed, true);
    assert.equal(engine2.getModel(), baseline, "model untouched after storm exhaustion");
    assert.equal(
      outcomes.length,
      0,
      "no confirmation outcome — budget exhausted before a decision",
    );
    assert.deepEqual(
      counterCalls,
      [],
      "teardown counter NOT bumped on budget exhaustion (we never decided)",
    );
    assert.equal(engine2.isDirty(), true);
  });
});

// ---------------------------------------------------------------------------
// tc-3si.5: engine telemetry hooks (failed-cycle reason, budget exhausted)
// ---------------------------------------------------------------------------

describe("RequeryEngine: failure telemetry hooks (tc-3si.5)", () => {
  it("onCycleFailed fires with reason=error when a list-* reply is %error", async () => {
    const failedReasons: ("error" | "budget")[] = [];
    let budgetExhaustedCount = 0;

    const d = deferredSubmit();
    const engine = createRequeryEngine({
      submit: d.submit,
      onCycleFailed: (r) => failedReasons.push(r),
      onBudgetExhausted: () => { budgetExhaustedCount++; },
    });

    const inflight = engine.requery();
    d.resolveNext(errResult()); // %error from list-windows
    d.resolveNext(errResult()); // %error from list-panes too

    const result = await inflight;
    assert.equal(result.failed, true);
    assert.deepEqual(failedReasons, ["error"], "exactly one error-reason fire");
    assert.equal(budgetExhaustedCount, 0, "budget hook must NOT fire on a transient error");
  });

  it("onBudgetExhausted + onCycleFailed(reason=budget) fire together on budget exhaustion", async () => {
    // Replays the storm scenario from the existing storm/convergence-budget
    // suite, asserting that the new tc-3si.5 hooks fire correctly.
    const win = winLine({
      sessNum: 0,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 0, active: true });

    const replies: CommandResult[] = [];
    for (let i = 0; i < 100; i++) replies.push(okResult(win), okResult(pane));
    const { submit } = queueSubmit(replies);

    let engineRef: { ref: RequeryEngine } | null = null;
    let callCount = 0;
    const wrappedSubmit: SubmitCommand = (cmd) => {
      callCount++;
      if (engineRef !== null && callCount % 2 === 1) {
        engineRef.ref.markDirty();
      }
      return submit(cmd);
    };

    const failedReasons: ("error" | "budget")[] = [];
    let budgetExhaustedCount = 0;

    // Capture stderr to verify the loud log emitted by the engine.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    let result;
    try {
      const engine = createRequeryEngine({
        submit: wrappedSubmit,
        onCycleFailed: (r) => failedReasons.push(r),
        onBudgetExhausted: () => { budgetExhaustedCount++; },
      });
      engineRef = { ref: engine };
      result = await engine.requery();
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(result.failed, true);
    assert.equal(budgetExhaustedCount, 1, "budget hook fires exactly once per exhausted call");
    assert.deepEqual(failedReasons, ["budget"], "failed reason is budget, no double-count");
    const logText = captured.join("");
    assert.ok(
      logText.includes("BUDGET EXHAUSTED"),
      `expected loud budget-exhausted log; got: ${logText}`,
    );
  });

  it("onCycleFailed does NOT fire on a clean cycle", async () => {
    const failedReasons: ("error" | "budget")[] = [];

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

    const engine = createRequeryEngine({
      submit,
      onCycleFailed: (r) => failedReasons.push(r),
    });

    const result = await engine.requery();
    assert.equal(result.failed, undefined);
    assert.deepEqual(failedReasons, [], "no failure hook fires on success");
  });

  it("refuted teardown does NOT bump requery_failed_cycles_total{reason} (the dedicated counter handles it)", async () => {
    // The teardown-refuted path returns failed:true but the failure-reason
    // vocabulary is `error|budget` — refuted is its own counter
    // (`requery_teardown_confirmations_total{outcome="refuted"}`). Verifying
    // that the dispatched `onCycleFailed` reason set stays empty for the
    // refuted path keeps the reason vocabulary clean.
    const { winBody, paneBody } = twoPaneModelBodies();

    const bootD = deferredSubmit();
    const engine = createRequeryEngine({ submit: bootD.submit });
    const boot = engine.requery();
    bootD.resolveNext(okResult(winBody));
    bootD.resolveNext(okResult(paneBody));
    await boot;

    const failedReasons: ("error" | "budget")[] = [];
    const d = deferredSubmit();
    const engine2 = createRequeryEngine({
      initialModel: engine.getModel(),
      submit: d.submit,
      onCycleFailed: (r) => failedReasons.push(r),
    });

    // Suppress stderr (the refute path loud-logs).
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = (() => true) as typeof process.stderr.write;
    try {
      const inflight = engine2.requery();
      // Cycle 1: garbage empty.
      d.resolveNext(okResult(""));
      d.resolveNext(okResult(""));
      await new Promise((r) => setImmediate(r));
      // Cycle 2: confirming — disagrees.
      d.resolveNext(okResult(winBody));
      d.resolveNext(okResult(paneBody));
      const result = await inflight;
      assert.equal(result.failed, true);
    } finally {
      process.stderr.write = origWrite;
    }

    assert.deepEqual(
      failedReasons,
      [],
      "refuted teardown must NOT bump the error|budget failed-cycles counter (it has its own surface)",
    );
  });
});

// ---------------------------------------------------------------------------
// tc-0v59: session rename propagation — id-based requery targeting + loud %error
//
// The requery engine must target the session by its IMMUTABLE tmux id ($N),
// captured from the first successful reply, NOT by the mutable session name.
// This is what lets a requery survive a `rename-session`: the id never changes,
// so the next cycle observes the NEW name and emits the `session.renamed` delta.
//
// A queued submit that ALSO records the command strings, so we can assert the
// exact `-t` target the engine emits per cycle. FIFO, like `queueSubmit`.
// ---------------------------------------------------------------------------

function recordingSubmit(results: CommandResult[]): {
  submit: SubmitCommand;
  commands: string[];
} {
  const queue = [...results];
  const commands: string[] = [];
  return {
    submit: (cmd: string) => {
      commands.push(cmd);
      return Promise.resolve(queue.shift() ?? errResult(999));
    },
    commands,
  };
}

describe("RequeryEngine: id-based session targeting (tc-0v59)", () => {
  it("first cold cycle targets =<name>; every cycle AFTER capturing the id targets $<id>", async () => {
    // Bootstrap: tmux session $7 named "main".
    const win = winLine({
      sessNum: 7,
      sessName: "main",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const pane = paneLine({ paneNum: 1, winNum: 1, sessNum: 7, active: true });

    // Two clean cycles' worth of replies.
    const { submit, commands } = recordingSubmit([
      okResult(win),
      okResult(pane),
      okResult(win),
      okResult(pane),
    ]);

    const engine = createRequeryEngine({ submit, sessionName: "main" });

    // Cycle 1 (cold): no id captured yet → must target by name.
    await engine.requery();
    const [winCmd1, paneCmd1] = [commands[0]!, commands[1]!];
    assert.ok(
      winCmd1.includes("-t =main"),
      `cold cycle 1 list-windows should target =main, got: ${winCmd1}`,
    );
    assert.ok(
      paneCmd1.includes("-t =main"),
      `cold cycle 1 list-panes should target =main, got: ${paneCmd1}`,
    );

    // Cycle 2: id ($7) captured from cycle 1's reply → must target by id.
    engine.markDirty();
    await engine.requery();
    const [winCmd2, paneCmd2] = [commands[2]!, commands[3]!];
    assert.ok(
      winCmd2.includes("-t $7"),
      `cycle 2 list-windows should target $7, got: ${winCmd2}`,
    );
    assert.ok(
      !winCmd2.includes("=main"),
      `cycle 2 must NOT target the mutable name, got: ${winCmd2}`,
    );
    assert.ok(
      paneCmd2.includes("-s -t $7"),
      `cycle 2 list-panes should be session-scoped to $7, got: ${paneCmd2}`,
    );
  });

  it("requery SURVIVES a rename: id-targeted reply with the NEW name emits session.renamed", async () => {
    // Bootstrap with the OLD name "before", session $4.
    const winBefore = winLine({
      sessNum: 4,
      sessName: "before",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const paneBefore = paneLine({ paneNum: 1, winNum: 1, sessNum: 4, active: true });

    // After rename: SAME session id $4, NEW name "after". This is exactly what
    // tmux returns for `list-windows -t $4` after `rename-session` — the id is
    // stable, only the name changed. Under the OLD name-targeting code the
    // engine would have issued `-t =before` and gotten %error here.
    const winAfter = winLine({
      sessNum: 4,
      sessName: "after",
      winNum: 1,
      winName: "shell",
      layout: SINGLE_PANE_LAYOUT(1),
      active: true,
    });
    const paneAfter = paneLine({ paneNum: 1, winNum: 1, sessNum: 4, active: true });

    const { submit, commands } = recordingSubmit([
      okResult(winBefore),
      okResult(paneBefore),
      okResult(winAfter),
      okResult(paneAfter),
    ]);

    const engine = createRequeryEngine({ submit, sessionName: "before" });

    // Bootstrap cycle: model has the old name.
    await engine.requery();
    assert.equal(engine.getModel().sessions.get(sessionId("s4"))?.name, "before");

    // Post-rename requery: targets $4 (the captured id), so the reply with the
    // NEW name lands instead of a %error from the stale `=before` target.
    engine.markDirty();
    const { deltas } = await engine.requery();

    // The post-rename cycle must have targeted by id, never the old name.
    assert.ok(
      commands[2]!.includes("-t $4") && !commands[2]!.includes("=before"),
      `post-rename cycle must target $4 not =before, got: ${commands[2]}`,
    );

    // Model now carries the new name AND a session.renamed delta was emitted.
    assert.equal(engine.getModel().sessions.get(sessionId("s4"))?.name, "after");
    const renamed = deltas.find((d) => d.type === "session.renamed");
    assert.ok(
      renamed !== undefined,
      `expected a session.renamed delta, got: ${deltas.map((d) => d.type).join(", ")}`,
    );
    assert.equal(
      (renamed as { newName: string }).newName,
      "after",
      "session.renamed must carry the new name",
    );
  });

  it("a requery %error emits a loud per-incident stderr line (no silent swallow)", async () => {
    const failedReasons: ("error" | "budget")[] = [];
    const d = deferredSubmit();
    const engine = createRequeryEngine({
      submit: d.submit,
      sessionName: "main",
      onCycleFailed: (r) => failedReasons.push(r),
    });

    // Capture stderr to verify the loud log.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    let result;
    try {
      const inflight = engine.requery();
      d.resolveNext(errResult()); // %error from list-windows
      d.resolveNext(okResult("")); // list-panes ok (one side failing is enough)
      result = await inflight;
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(result.failed, true);
    assert.deepEqual(failedReasons, ["error"], "still bumps the error-reason counter");
    const logText = captured.join("");
    assert.ok(
      logText.includes("REQUERY ERROR"),
      `expected a loud REQUERY ERROR stderr line; got: ${JSON.stringify(logText)}`,
    );
    assert.ok(
      logText.includes("list-windows"),
      `loud line should name which reply failed; got: ${logText}`,
    );
  });
});
