/**
 * Unit tests for src/state/reducer.ts (tc-8hy / tc-5dd).
 *
 * Coverage:
 *   - One test per NotificationEvent variant.
 *   - Immutability: input model unchanged after reduce().
 *   - %output/%extended-output: bytes reach the PaneBufferStore test double.
 *   - layout-change: real layout string → WindowLayout; pane set reconciled.
 *   - Exhaustiveness: `unknown` events with unrecognized keywords don't throw.
 *   - checkInvariants() passes after every reduce() call.
 *
 * @module state/reducer.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { reduce, type PaneBufferStore, type ReducerContext } from "./reducer.js";
import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  checkInvariants,
  paneId,
  windowId,
  sessionId,
  scrollbackHandle,
} from "./model.js";
import type { SessionModel, Session, Window, Pane } from "./model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";
import type { NotificationEvent } from "../parser/notifications.js";
import { encodeOutputPayload } from "../parser/output-codec.js";

// ---------------------------------------------------------------------------
// PaneBufferStore test double
// ---------------------------------------------------------------------------

class MemPaneBufferStore implements PaneBufferStore {
  private readonly _bufs = new Map<PaneId, Uint8Array>();

  append(id: PaneId, bytes: Uint8Array): void {
    const existing = this._bufs.get(id);
    if (existing === undefined) {
      this._bufs.set(id, new Uint8Array(bytes));
    } else {
      const merged = new Uint8Array(existing.length + bytes.length);
      merged.set(existing, 0);
      merged.set(bytes, existing.length);
      this._bufs.set(id, merged);
    }
  }

  getContents(id: PaneId): Uint8Array {
    return this._bufs.get(id) ?? new Uint8Array(0);
  }

  size(id: PaneId): number {
    return this._bufs.get(id)?.length ?? 0;
  }

  drop(id: PaneId): void {
    this._bufs.delete(id);
  }

  clear(): void {
    this._bufs.clear();
  }
}

function makeCtx(): { ctx: ReducerContext; store: MemPaneBufferStore } {
  const store = new MemPaneBufferStore();
  const ctx: ReducerContext = { buffers: store };
  return { ctx, store };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const S0 = sessionId("s0");
const W1 = windowId("w1");
const P1 = paneId("p1");
const P2 = paneId("p2");

function makeSession(
  sid: SessionId,
  windowIds: readonly WindowId[],
  activeWindowId: WindowId | null,
  name = "sess",
): Session {
  return { sessionId: sid, name, windowIds, activeWindowId };
}

function makeWindow(
  wid: WindowId,
  sid: SessionId,
  paneIds: readonly PaneId[],
  activePaneId: PaneId | null,
  name = "win",
): Window {
  return { windowId: wid, sessionId: sid, name, paneIds, activePaneId, layout: null };
}

function makePane(
  pid: PaneId,
  wid: WindowId,
  sid: SessionId,
  cols = 80,
  rows = 24,
): Pane {
  return { paneId: pid, windowId: wid, sessionId: sid, cols, rows, mode: "normal", scrollbackHandle: undefined };
}

/** Build a model with: session s0 → window w1 → pane p1 */
function baseModel(): SessionModel {
  let m = emptyModel();
  m = addSession(m, makeSession(S0, [], null));
  m = addWindow(m, makeWindow(W1, S0, [], null));
  m = addPane(m, makePane(P1, W1, S0));
  return m;
}

/** Encode raw bytes as an octal-escaped Uint8Array (tmux output payload format). */
function encodePayload(raw: string): Uint8Array {
  const rawBytes = new TextEncoder().encode(raw);
  return encodeOutputPayload(rawBytes);
}

/** Make a Uint8Array from a string (ASCII). */
function asBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// Helper: assert model is unchanged (deep structural equality)
// ---------------------------------------------------------------------------

function assertModelUnchanged(original: SessionModel, after: SessionModel, label: string): void {
  // Check that the sessions, windows, panes maps have the same size and content.
  assert.equal(after.sessions.size, original.sessions.size, `${label}: sessions size unchanged`);
  assert.equal(after.windows.size, original.windows.size, `${label}: windows size unchanged`);
  assert.equal(after.panes.size, original.panes.size, `${label}: panes size unchanged`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reducer: output", () => {
  it("%output: bytes appended to buffer, model struct unchanged", () => {
    const model = baseModel();
    const { ctx, store } = makeCtx();

    // Encode "hello" as tmux octal-escaped payload
    const payload = encodePayload("hello");

    const event: NotificationEvent = {
      kind: "output",
      paneId: 1, // tmux pane id 1 → branded p1
      rawPayload: payload,
    };

    const after = reduce(model, event, ctx);

    // Model structure must not change
    assert.equal(after.panes.size, model.panes.size, "panes unchanged");
    assert.equal(after.windows.size, model.windows.size, "windows unchanged");
    assert.equal(after.sessions.size, model.sessions.size, "sessions unchanged");

    // Bytes must reach the buffer store
    const appended = store.getContents(paneId("p1"));
    assert.deepEqual(appended, new TextEncoder().encode("hello"), "decoded bytes in buffer");

    assert.deepEqual(checkInvariants(after), [], "no invariant violations");
  });

  it("%output: immutability — input model object identity preserved on maps", () => {
    const model = baseModel();
    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "output",
      paneId: 1,
      rawPayload: encodePayload("x"),
    };
    const after = reduce(model, event, ctx);
    // output does not touch model maps — same reference expected
    assert.strictEqual(after, model, "output returns same model object (no structural change)");
  });
});

describe("reducer: extended-output", () => {
  it("%extended-output: bytes appended to buffer", () => {
    const model = baseModel();
    const { ctx, store } = makeCtx();

    const payload = encodePayload("world");
    const event: NotificationEvent = {
      kind: "extended-output",
      paneId: 1,
      ageMs: 100n,
      rawPayload: payload,
    };

    const after = reduce(model, event, ctx);

    assert.deepEqual(store.getContents(paneId("p1")), new TextEncoder().encode("world"));
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: window-add", () => {
  it("%window-add: creates window under active session", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    // Note: focus is all-null (no panes yet); window-add picks the first session.

    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "window-add",
      windowId: 5,
      unlinked: false,
    };

    const after = reduce(model, event, ctx);

    const wid = windowId("w5");
    assert.ok(after.windows.has(wid), "window w5 added to model");
    const win = after.windows.get(wid)!;
    assert.equal(win.sessionId, S0, "window belongs to session s0");

    const sess = after.sessions.get(S0)!;
    assert.ok(sess.windowIds.includes(wid), "s0.windowIds includes w5");

    assert.deepEqual(checkInvariants(after), []);
  });

  it("%window-add: idempotent if window already exists", () => {
    const model = baseModel();
    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "window-add",
      windowId: 1, // w1 already exists
      unlinked: false,
    };
    const after = reduce(model, event, ctx);
    assert.equal(after.windows.size, model.windows.size, "no duplicate window created");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: window-close", () => {
  it("%window-close: removes window and its panes", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "window-close",
      windowId: 1, // w1
      unlinked: false,
    };

    const after = reduce(model, event, ctx);

    assert.ok(!after.windows.has(W1), "window w1 removed");
    assert.ok(!after.panes.has(P1), "pane p1 removed with window");
    assert.deepEqual(checkInvariants(after), []);
  });

  it("%window-close: no-op if window does not exist", () => {
    const model = baseModel();
    const { ctx } = makeCtx();
    const event: NotificationEvent = { kind: "window-close", windowId: 99, unlinked: false };
    const after = reduce(model, event, ctx);
    assert.equal(after.windows.size, model.windows.size);
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: window-renamed", () => {
  it("%window-renamed: updates window name", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "window-renamed",
      windowId: 1,
      name: "mywin",
      unlinked: false,
    };

    const after = reduce(model, event, ctx);
    assert.equal(after.windows.get(W1)!.name, "mywin");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: window-pane-changed", () => {
  it("%window-pane-changed: sets activePaneId on window", () => {
    // Model: s0 → w1 → {p1, p2}, active = p1
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    model = addWindow(model, makeWindow(W1, S0, [], null));
    model = addPane(model, makePane(P1, W1, S0));
    model = addPane(model, makePane(P2, W1, S0));

    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "window-pane-changed",
      windowId: 1,
      paneId: 2, // switch to p2
    };

    const after = reduce(model, event, ctx);
    assert.equal(after.windows.get(W1)!.activePaneId, P2);
    assert.deepEqual(checkInvariants(after), []);
  });

  it("%window-pane-changed: updates focus triple when window is focused", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    model = addWindow(model, makeWindow(W1, S0, [], null));
    model = addPane(model, makePane(P1, W1, S0));
    model = addPane(model, makePane(P2, W1, S0));
    // Set focus to w1/p1
    model = { ...model, focus: { paneId: P1, windowId: W1, sessionId: S0 } };

    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "window-pane-changed",
      windowId: 1,
      paneId: 2,
    };

    const after = reduce(model, event, ctx);
    assert.equal(after.focus.paneId, P2, "focus pane updated to p2");
    assert.equal(after.focus.windowId, W1);
    assert.equal(after.focus.sessionId, S0);
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: session-changed", () => {
  it("%session-changed: creates session if absent, sets name, clears focus (no windows)", () => {
    const model = emptyModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "session-changed",
      sessionId: 3,
      name: "mysess",
    };

    const after = reduce(model, event, ctx);
    const sid = sessionId("s3");
    assert.ok(after.sessions.has(sid), "session s3 created");
    assert.equal(after.sessions.get(sid)!.name, "mysess");
    assert.deepEqual(checkInvariants(after), []);
  });

  it("%session-changed: updates existing session name", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "session-changed",
      sessionId: 0,
      name: "renamed",
    };

    const after = reduce(model, event, ctx);
    assert.equal(after.sessions.get(S0)!.name, "renamed");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: client-session-changed", () => {
  it("%client-session-changed: same as session-changed for model", () => {
    const model = emptyModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "client-session-changed",
      clientName: "/dev/ttys001",
      sessionId: 7,
      name: "s7",
    };

    const after = reduce(model, event, ctx);
    const sid = sessionId("s7");
    assert.ok(after.sessions.has(sid));
    assert.equal(after.sessions.get(sid)!.name, "s7");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: session-renamed", () => {
  it("%session-renamed with $id: renames the identified session", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "session-renamed",
      sessionId: 0,
      name: "newname",
    };

    const after = reduce(model, event, ctx);
    assert.equal(after.sessions.get(S0)!.name, "newname");
    assert.deepEqual(checkInvariants(after), []);
  });

  it("%session-renamed without $id (older tmux): renames focused session", () => {
    // Build a model with a fully consistent focus triple so checkInvariants passes.
    let model = baseModel(); // s0 → w1 → p1
    // Set focus to the consistent triple: p1 in w1 in s0
    model = { ...model, focus: { paneId: P1, windowId: W1, sessionId: S0 } };
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "session-renamed",
      sessionId: null, // older format
      name: "oldformat",
    };

    const after = reduce(model, event, ctx);
    assert.equal(after.sessions.get(S0)!.name, "oldformat");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: sessions-changed", () => {
  it("%sessions-changed: no-op (model unchanged)", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = { kind: "sessions-changed" };
    const after = reduce(model, event, ctx);

    assert.strictEqual(after, model, "sessions-changed returns same model");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: session-window-changed", () => {
  it("%session-window-changed: updates activeWindowId on session", () => {
    // Model: s0 → {w1, w2}
    let model = emptyModel();
    const W2 = windowId("w2");
    model = addSession(model, makeSession(S0, [], null));
    model = addWindow(model, makeWindow(W1, S0, [], null));
    model = addWindow(model, makeWindow(W2, S0, [], null));
    model = addPane(model, makePane(P1, W1, S0));
    model = addPane(model, makePane(P2, W2, S0));

    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "session-window-changed",
      sessionId: 0,
      windowId: 2, // switch to w2
    };

    const after = reduce(model, event, ctx);
    assert.equal(after.sessions.get(S0)!.activeWindowId, W2);
    assert.deepEqual(checkInvariants(after), []);
  });

  it("%session-window-changed: no-op if window not in session", () => {
    const model = baseModel();
    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "session-window-changed",
      sessionId: 0,
      windowId: 99, // unknown window
    };
    const after = reduce(model, event, ctx);
    assert.deepEqual(checkInvariants(after), []);
    // activeWindowId should remain whatever it was
  });
});

describe("reducer: pane-mode-changed", () => {
  it("%pane-mode-changed: no-op (mode query is E4's job)", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "pane-mode-changed",
      paneId: 1,
    };

    const after = reduce(model, event, ctx);
    // Mode stays "normal" (we don't know the new mode without a follow-up query)
    assert.equal(after.panes.get(P1)!.mode, "normal");
    assert.strictEqual(after, model, "pane-mode-changed returns same model object");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: subscription-changed", () => {
  it("%subscription-changed: no-op", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "subscription-changed",
      name: "mysub",
      sessionId: 0,
      windowId: 1,
      windowIdx: 0,
      paneId: 1,
      value: "42",
    };

    const after = reduce(model, event, ctx);
    assert.strictEqual(after, model);
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: pause / continue", () => {
  it("%pause: no-op at model level", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = { kind: "pause", paneId: 1 };
    const after = reduce(model, event, ctx);
    assert.strictEqual(after, model);
    assert.deepEqual(checkInvariants(after), []);
  });

  it("%continue: no-op at model level", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = { kind: "continue", paneId: 1 };
    const after = reduce(model, event, ctx);
    assert.strictEqual(after, model);
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: exit", () => {
  it("%exit: no-op (model snapshot preserved; E4 handles shutdown)", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = { kind: "exit", reason: "server exited" };
    const after = reduce(model, event, ctx);
    assert.strictEqual(after, model);
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: unknown (non-layout-change)", () => {
  it("unknown keyword: no-op, does not throw", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "future-keyword",
      rawLine: asBytes("%future-keyword some data\n"),
    };

    let after: SessionModel | undefined;
    assert.doesNotThrow(() => {
      after = reduce(model, event, ctx);
    });
    assert.strictEqual(after, model);
    assert.deepEqual(checkInvariants(after!), []);
  });
});

describe("reducer: layout-change (via unknown keyword)", () => {
  it("%layout-change: sets WindowLayout and reconciles pane set (single pane)", () => {
    // Start with a window but no panes (pre-bootstrap state)
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    model = addWindow(model, makeWindow(W1, S0, [], null));

    const { ctx } = makeCtx();

    // Real tmux single-pane layout: 80x24,0,0,1 (pane id=1, 80 cols, 24 rows)
    // checksum for "80x24,0,0,1": compute via tmux algorithm
    // We'll use dumpLayout to get a valid string. For the test we encode manually.
    // Format: %layout-change @<winId> <layoutString>
    // Window id = 1, layout = "bb62,80x24,0,0,1" (hand-authored; checksum doesn't matter
    // for the test — parseLayout only throws on structural errors, not checksum mismatch).
    // Use a real structural layout string (checksum mismatch is allowed by parseLayout).
    const layoutStr = "0000,80x24,0,0,1"; // checksum 0000 (mismatch ok per parseLayout contract)
    const rawLine = asBytes(`%layout-change @1 ${layoutStr}\n`);

    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine,
    };

    const after = reduce(model, event, ctx);

    // Window should have a layout set
    const win = after.windows.get(W1)!;
    assert.ok(win.layout !== null, "layout set on window");
    assert.equal(win.layout!.cols, 80);
    assert.equal(win.layout!.rows, 24);
    assert.equal(win.layout!.root.kind, "pane");
    if (win.layout!.root.kind === "pane") {
      assert.equal(win.layout!.root.paneId, paneId("p1"));
    }

    // Pane p1 should have been added via layout reconciliation
    assert.ok(after.panes.has(paneId("p1")), "pane p1 added from layout");
    const p = after.panes.get(paneId("p1"))!;
    assert.equal(p.cols, 80);
    assert.equal(p.rows, 24);
    assert.equal(p.mode, "normal");

    assert.deepEqual(checkInvariants(after, { checkLayoutConsistency: true }), []);
  });

  it("%layout-change: hsplit layout (two panes side-by-side)", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    model = addWindow(model, makeWindow(W1, S0, [], null));

    const { ctx } = makeCtx();

    // Two panes side-by-side (hsplit): 80x24,0,0{40x24,0,0,1,39x24,41,0,2}
    const layoutStr = "0000,80x24,0,0{40x24,0,0,1,39x24,41,0,2}";
    const rawLine = asBytes(`%layout-change @1 ${layoutStr}\n`);

    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine,
    };

    const after = reduce(model, event, ctx);

    assert.ok(after.panes.has(paneId("p1")), "pane p1 added");
    assert.ok(after.panes.has(paneId("p2")), "pane p2 added");
    assert.equal(after.panes.size, 2);

    const win = after.windows.get(W1)!;
    assert.ok(win.layout !== null);
    assert.equal(win.layout!.root.kind, "hsplit");

    assert.deepEqual(checkInvariants(after, { checkLayoutConsistency: true }), []);
  });

  it("%layout-change: existing panes preserved, new panes added", () => {
    // Start with p1 already in model
    const model = baseModel(); // s0 → w1 → p1
    const { ctx } = makeCtx();

    // Layout now has p1 + p2 (split happened)
    const layoutStr = "0000,80x24,0,0[80x12,0,0,1,80x11,0,13,2]";
    const rawLine = asBytes(`%layout-change @1 ${layoutStr}\n`);

    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine,
    };

    const after = reduce(model, event, ctx);

    assert.ok(after.panes.has(paneId("p1")), "p1 still present");
    assert.ok(after.panes.has(paneId("p2")), "p2 added from layout");
    assert.equal(after.panes.size, 2);

    const win = after.windows.get(W1)!;
    assert.equal(win.paneIds.length, 2);
    assert.ok(win.layout !== null);
    assert.equal(win.layout!.root.kind, "vsplit", "vertical split");

    assert.deepEqual(checkInvariants(after, { checkLayoutConsistency: true }), []);
  });

  it("%layout-change before %window-add: skip-and-wait — no synthetic s0 created", () => {
    // Regression test for the early-layout race (tc-7qz.3):
    // A %layout-change that names a window not yet in the model must NOT mint a
    // synthetic session ("s0"). The model must remain empty. Once %window-add
    // arrives for the real session, the final state must be correct with no s0.

    const { ctx } = makeCtx();

    // Step 1: apply %layout-change on an empty model (no sessions, no windows).
    // Before the fix this would synthesize session "s0" and mis-parent the window.
    let model = emptyModel();
    const layoutStr = "0000,80x24,0,0,1";
    const earlyLayout: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine: asBytes(`%layout-change @1 ${layoutStr}\n`),
    };
    model = reduce(model, earlyLayout, ctx);

    // The model must remain empty — no synthetic sessions, windows, or panes.
    assert.equal(model.sessions.size, 0, "no synthetic session minted by early layout-change");
    assert.equal(model.windows.size, 0, "no synthetic window minted by early layout-change");
    assert.equal(model.panes.size, 0, "no panes minted by early layout-change");
    // Specifically, "s0" must NOT exist.
    assert.ok(!model.sessions.has(sessionId("s0")), 'synthetic session "s0" must not exist');

    assert.deepEqual(checkInvariants(model), [], "invariants hold after early layout-change no-op");

    // Step 2: %session-changed arrives — creates the real session s3.
    model = reduce(model, {
      kind: "session-changed",
      sessionId: 3,
      name: "main",
    }, ctx);
    assert.ok(model.sessions.has(sessionId("s3")), "real session s3 exists");

    // Step 3: %window-add for window 1 arrives — window is parented to real session s3.
    model = reduce(model, {
      kind: "window-add",
      windowId: 1,
      unlinked: false,
    }, ctx);
    assert.ok(model.windows.has(windowId("w1")), "window w1 registered");
    assert.equal(
      model.windows.get(windowId("w1"))!.sessionId,
      sessionId("s3"),
      "window w1 is parented to real session s3, not synthetic s0",
    );

    // Step 4: %layout-change arrives again (now the window exists).
    model = reduce(model, earlyLayout, ctx);
    assert.ok(model.windows.get(windowId("w1"))!.layout !== null, "layout applied after window-add");
    assert.ok(model.panes.has(paneId("p1")), "pane p1 added from post-add layout-change");

    // Confirm s0 never appeared anywhere across the whole sequence.
    assert.ok(!model.sessions.has(sessionId("s0")), 'synthetic "s0" never created throughout sequence');

    assert.deepEqual(checkInvariants(model, { checkLayoutConsistency: true }), [], "final invariants hold");
  });

  it("%layout-change before %window-add: model object identity preserved (strict no-op)", () => {
    // Verify that the early-layout no-op returns exactly the same model reference.
    const model = emptyModel();
    const { ctx } = makeCtx();
    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine: asBytes("%layout-change @42 0000,80x24,0,0,5\n"),
    };
    const after = reduce(model, event, ctx);
    assert.strictEqual(after, model, "early layout-change on empty model returns same object (no allocation)");
  });

  it("%layout-change: malformed raw line → no-op", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine: asBytes("%layout-change malformed-no-window-id\n"),
    };

    const after = reduce(model, event, ctx);
    assert.strictEqual(after, model, "malformed line returns original model");
    assert.deepEqual(checkInvariants(after), []);
  });

  it("%layout-change: malformed layout string → no-op for layout (window preserved)", () => {
    const model = baseModel();
    const { ctx } = makeCtx();

    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine: asBytes("%layout-change @1 XXXXBADLAYOUT\n"),
    };

    const after = reduce(model, event, ctx);
    // Window w1 still present; layout unchanged
    assert.ok(after.windows.has(W1));
    assert.equal(after.windows.get(W1)!.layout, null, "layout unchanged (still null)");
    assert.deepEqual(checkInvariants(after), []);
  });
});

describe("reducer: immutability", () => {
  it("window-add does not mutate input model's sessions map", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    const originalWindowCount = model.windows.size;
    const originalSessionWindowIds = [...(model.sessions.get(S0)?.windowIds ?? [])];

    const { ctx } = makeCtx();
    const after = reduce(model, { kind: "window-add", windowId: 9, unlinked: false }, ctx);

    // Original model's session is unaffected
    assert.equal(model.windows.size, originalWindowCount, "original windows map unchanged");
    assert.deepEqual(
      [...(model.sessions.get(S0)?.windowIds ?? [])],
      originalSessionWindowIds,
      "original session.windowIds unchanged",
    );
    // After model has the new window
    assert.ok(after.windows.has(windowId("w9")));
  });

  it("window-close does not mutate input model", () => {
    const model = baseModel();
    const snapPanesSize = model.panes.size;
    const snapWindowsSize = model.windows.size;

    const { ctx } = makeCtx();
    const after = reduce(model, { kind: "window-close", windowId: 1, unlinked: false }, ctx);

    assert.equal(model.panes.size, snapPanesSize, "original panes map unchanged");
    assert.equal(model.windows.size, snapWindowsSize, "original windows map unchanged");
    assert.equal(after.panes.size, 0, "after: pane removed");
  });

  it("layout-change does not mutate input model's window", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    model = addWindow(model, makeWindow(W1, S0, [], null));
    const originalWindow = model.windows.get(W1)!;

    const { ctx } = makeCtx();
    const layoutStr = "0000,80x24,0,0,1";
    const event: NotificationEvent = {
      kind: "unknown",
      keyword: "layout-change",
      rawLine: asBytes(`%layout-change @1 ${layoutStr}\n`),
    };
    reduce(model, event, ctx);

    // Original window object must not have been mutated
    assert.equal(originalWindow.layout, null, "original window.layout still null");
    assert.equal(originalWindow.paneIds.length, 0, "original window.paneIds still empty");
  });
});

describe("reducer: multiple events sequenced", () => {
  it("window-add + layout-change + window-renamed sequence", () => {
    let model = emptyModel();
    model = addSession(model, makeSession(S0, [], null));
    // Leave focus all-null (valid); window-add picks the first session.

    const { ctx } = makeCtx();

    // Step 1: window-add
    model = reduce(model, { kind: "window-add", windowId: 1, unlinked: false }, ctx);
    assert.ok(model.windows.has(W1));

    // Step 2: layout-change
    const layoutStr = "0000,80x24,0,0,1";
    model = reduce(model, {
      kind: "unknown",
      keyword: "layout-change",
      rawLine: asBytes(`%layout-change @1 ${layoutStr}\n`),
    }, ctx);
    assert.ok(model.panes.has(P1));
    assert.ok(model.windows.get(W1)!.layout !== null);

    // Step 3: window-renamed
    model = reduce(model, { kind: "window-renamed", windowId: 1, name: "bash", unlinked: false }, ctx);
    assert.equal(model.windows.get(W1)!.name, "bash");

    assert.deepEqual(checkInvariants(model, { checkLayoutConsistency: true }), []);
  });

  it("output accumulates bytes across multiple events", () => {
    const model = baseModel();
    const { ctx, store } = makeCtx();

    const enc = new TextEncoder();
    reduce(model, { kind: "output", paneId: 1, rawPayload: encodeOutputPayload(enc.encode("foo")) }, ctx);
    reduce(model, { kind: "output", paneId: 1, rawPayload: encodeOutputPayload(enc.encode("bar")) }, ctx);

    const bytes = store.getContents(P1);
    assert.deepEqual(bytes, enc.encode("foobar"), "bytes accumulated in order");
  });
});
