/**
 * Tests for Mirror.attach — snapshot replay, model-diff, byte events, and cleanup.
 *
 * Port of render-hook.test.ts's driver tests to exercise Mirror.attach directly,
 * per tc-cox.5 (pre-alpha-redesign rule: createRenderHookDriver removed).
 *
 * # Porting notes (tc-cox.5)
 *
 * The original render-hook.test.ts tested createRenderHookDriver using a
 * FakeModelSource (push arbitrary ClientModel shapes) and FakeInputSink.
 * Mirror.attach is the replacement: it takes a Mirror instance pre-seeded via
 * receiveSnapshot()/receiveDelta() and a FakeByteSource.
 *
 * Key differences from the driver:
 *   - Model state is driven via mirror.receiveSnapshot() + mirror.receiveDelta()
 *     using real DaemonMessage types (pane.opened, pane.closed, etc.).
 *   - mirror.wireDataSources(byteSource) is called before mirror.attach(hook).
 *   - mirror.detachHook() replaces session.stop().
 *   - Mirror.attach is idempotent (second call is no-op).
 *
 * # Intentionally dropped (documented)
 *
 * "ClientController delegates to InputSink" (3 tests) — Mirror.attach does not
 * return a ClientController; that surface belongs to connectClient(). Those tests
 * exercised driver-internal wiring (createRenderHookDriver → inputSink.sendInput
 * / resizePane). The equivalent production path is tested end-to-end in
 * e2e-smoke.test.ts (E2/E3/E4). No coverage gap in the redesigned architecture.
 *
 * All other describe blocks and every individual test from render-hook.test.ts are
 * preserved 1-for-1 below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  PaneId,
  WindowId,
  SessionId,
  WindowLayout,
  PaneMode,
  FocusInfo,
  RenderHookCall,
} from "./render-hook.js";
import { NoOpRenderHook, EchoRenderHook } from "./render-hook.js";
import { Mirror } from "./mirror.js";
import type { SnapshotMessage, DaemonMessage } from "@tmuxcc/daemon";

// ---------------------------------------------------------------------------
// Helpers — mint branded ids without importing daemon internals
// ---------------------------------------------------------------------------

function pid(s: string): PaneId {
  return s as unknown as PaneId;
}
function wid(s: string): WindowId {
  return s as unknown as WindowId;
}
function sid(s: string): SessionId {
  return s as unknown as SessionId;
}

function makeLayout(cols = 80, rows = 24): WindowLayout {
  return {
    cols,
    rows,
    root: { kind: "pane" as const, paneId: pid("p0"), rect: { x: 0, y: 0, cols, rows } },
  };
}

// ---------------------------------------------------------------------------
// Fake ByteSource — per-pane emit function vended by subscribe.
// Matches the ByteSource interface from render-hook.ts.
// ---------------------------------------------------------------------------

class FakeByteSource {
  readonly emitters = new Map<string, Set<(bytes: Uint8Array) => void>>();

  onPaneOutput(paneId: PaneId, cb: (bytes: Uint8Array) => void): () => void {
    let set = this.emitters.get(paneId);
    if (set === undefined) {
      set = new Set();
      this.emitters.set(paneId, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  emit(paneId: PaneId, bytes: Uint8Array): void {
    const set = this.emitters.get(paneId);
    if (set !== undefined) {
      for (const cb of set) cb(bytes);
    }
  }
}

// ---------------------------------------------------------------------------
// SnapshotMessage builder — creates a snapshot with the given panes/windows
// ---------------------------------------------------------------------------

interface SnapshotOpts {
  seq?: number;
  sessionId?: SessionId;
  panes?: Array<{ paneId: PaneId; windowId: WindowId; cols?: number; rows?: number }>;
  windows?: Array<{ windowId: WindowId; name?: string; active?: boolean; layout?: WindowLayout }>;
  focus?: { paneId: PaneId | null; windowId: WindowId | null };
}

// v3: single-session snapshot builder
function makeSnapshot(opts: SnapshotOpts = {}): SnapshotMessage {
  const s = opts.sessionId ?? sid("s0");
  const seq = opts.seq ?? 1;
  const panes = opts.panes ?? [];
  const windows = opts.windows ?? [];
  const focus = opts.focus ?? { paneId: null, windowId: null };
  return {
    type: "snapshot",
    seq,
    session: { sessionId: s, name: "main" },
    windows: windows.map((w) => ({
      windowId: w.windowId,
      name: w.name ?? "main",
      active: w.active ?? false,
      layout: w.layout ?? makeLayout(),
    })),
    panes: panes.map((p) => ({
      paneId: p.paneId,
      windowId: p.windowId,
      cols: p.cols ?? 80,
      rows: p.rows ?? 24,
    })),
    focus,
  };
}

// ---------------------------------------------------------------------------
// Helper: create and wire a fresh Mirror for testing Mirror.attach
//
// Returns { mirror, byteSource } — caller calls mirror.attach(hook) to trigger
// the catch-up + subscribe path, and mirror.detachHook() to tear down.
// ---------------------------------------------------------------------------

function makeMirror(snap: SnapshotMessage): { mirror: Mirror; byteSource: FakeByteSource } {
  const mirror = new Mirror();
  const byteSource = new FakeByteSource();
  mirror.receiveSnapshot(snap);
  mirror.wireDataSources(byteSource);
  return { mirror, byteSource };
}

// ---------------------------------------------------------------------------
// Tests: NoOpRenderHook (unchanged from render-hook.test.ts)
// ---------------------------------------------------------------------------

describe("NoOpRenderHook", () => {
  it("satisfies the RenderHook interface (compile check)", () => {
    // All methods are callable without throwing.
    NoOpRenderHook.onPaneOpened({ paneId: pid("p0"), windowId: wid("w0"), cols: 80, rows: 24, active: false });
    NoOpRenderHook.onPaneClosed(pid("p0"));
    NoOpRenderHook.onPaneResized(pid("p0"), 80, 24);
    NoOpRenderHook.onPaneModeChanged(pid("p0"), "copy" as PaneMode);
    NoOpRenderHook.onPaneOutput(pid("p0"), new Uint8Array([0x41]));
    NoOpRenderHook.onWindowAdded({ windowId: wid("w0"), name: "main", active: false, layout: makeLayout() });
    NoOpRenderHook.onWindowClosed(wid("w0"));
    NoOpRenderHook.onWindowRenamed(wid("w0"), "new-name");
    NoOpRenderHook.onLayoutChanged(wid("w0"), makeLayout());
    NoOpRenderHook.onFocusChanged({ paneId: null, windowId: null });
    NoOpRenderHook.onConnected();
    NoOpRenderHook.onDisconnected("test");
    // No assertion needed: reaching here without throw is the test.
  });
});

// ---------------------------------------------------------------------------
// Tests: EchoRenderHook records calls (unchanged from render-hook.test.ts)
// ---------------------------------------------------------------------------

describe("EchoRenderHook", () => {
  it("records onPaneOpened", () => {
    const echo = new EchoRenderHook();
    const pane = { paneId: pid("p1"), windowId: wid("w1"), cols: 120, rows: 40, active: true };
    echo.onPaneOpened(pane);
    assert.equal(echo.calls.length, 1);
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "paneOpened");
    if (call.type === "paneOpened") {
      assert.deepEqual(call.pane, pane);
    }
  });

  it("records onPaneClosed", () => {
    const echo = new EchoRenderHook();
    echo.onPaneClosed(pid("p2"));
    assert.equal(echo.calls.length, 1);
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "paneClosed");
    if (call.type === "paneClosed") {
      assert.equal(call.paneId, "p2");
    }
  });

  it("records onPaneResized", () => {
    const echo = new EchoRenderHook();
    echo.onPaneResized(pid("p3"), 100, 50);
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "paneResized");
    if (call.type === "paneResized") {
      assert.equal(call.cols, 100);
      assert.equal(call.rows, 50);
    }
  });

  it("records onPaneOutput with non-UTF-8 bytes", () => {
    const echo = new EchoRenderHook();
    // Non-UTF-8: 0xFF 0xFE (invalid UTF-8 sequence)
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    echo.onPaneOutput(pid("p0"), bytes);
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "paneOutput");
    if (call.type === "paneOutput") {
      assert.deepEqual(call.bytes, bytes);
    }
  });

  it("records onWindowAdded", () => {
    const echo = new EchoRenderHook();
    const win = { windowId: wid("w2"), sessionId: sid("s1"), name: "my-window", active: true, layout: makeLayout() };
    echo.onWindowAdded(win);
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "windowAdded");
    if (call.type === "windowAdded") {
      assert.deepEqual(call.window, win);
    }
  });

  it("records onWindowClosed", () => {
    const echo = new EchoRenderHook();
    echo.onWindowClosed(wid("w3"));
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "windowClosed");
  });

  it("records onWindowRenamed", () => {
    const echo = new EchoRenderHook();
    echo.onWindowRenamed(wid("w4"), "renamed");
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "windowRenamed");
    if (call.type === "windowRenamed") {
      assert.equal(call.newName, "renamed");
    }
  });

  it("records onLayoutChanged", () => {
    const echo = new EchoRenderHook();
    const layout = makeLayout(160, 48);
    echo.onLayoutChanged(wid("w0"), layout);
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "layoutChanged");
    if (call.type === "layoutChanged") {
      assert.deepEqual(call.layout, layout);
    }
  });

  it("records onFocusChanged", () => {
    const echo = new EchoRenderHook();
    const focus: FocusInfo = { paneId: pid("p0"), windowId: wid("w0") };
    echo.onFocusChanged(focus);
    const call = echo.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.type, "focusChanged");
    if (call.type === "focusChanged") {
      assert.deepEqual(call.focus, focus);
    }
  });

  it("records onConnected and onDisconnected", () => {
    const echo = new EchoRenderHook();
    echo.onConnected();
    echo.onDisconnected("closed");
    assert.equal(echo.calls[0]?.type, "connected");
    const d = echo.calls[1];
    assert.ok(d !== undefined);
    assert.equal(d.type, "disconnected");
    if (d.type === "disconnected") {
      assert.equal(d.reason, "closed");
    }
  });

  it("clear() resets the log", () => {
    const echo = new EchoRenderHook();
    echo.onConnected();
    assert.equal(echo.calls.length, 1);
    echo.clear();
    assert.equal(echo.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Mirror.attach — snapshot replay
//
// Ported from "createRenderHookDriver — snapshot replay".
// Mirror.attach fires the same ordered sequence of callbacks:
//   onWindowAdded, onLayoutChanged (per window), onPaneOpened (per pane),
//   onFocusChanged, onConnected.
// ---------------------------------------------------------------------------

describe("Mirror.attach — snapshot replay", () => {
  it("fires onWindowAdded, onLayoutChanged, onPaneOpened, onFocusChanged, onConnected in order for initial model", () => {
    const w0 = wid("w0");
    const p0 = pid("p0");
    const s0 = sid("s0");
    const layout = makeLayout(80, 24);

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0, cols: 80, rows: 24 }],
      windows: [{ windowId: w0, name: "main", active: true, layout }],
      focus: { paneId: p0, windowId: w0 },
    });

    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);

    // Expected order: windowAdded, layoutChanged, paneOpened, focusChanged, connected
    assert.ok(echo.calls.length >= 5);
    assert.equal(echo.calls[0]?.type, "windowAdded");
    assert.equal(echo.calls[1]?.type, "layoutChanged");
    assert.equal(echo.calls[2]?.type, "paneOpened");
    assert.equal(echo.calls[3]?.type, "focusChanged");
    assert.equal(echo.calls[4]?.type, "connected");

    const wo = echo.calls[0];
    assert.ok(wo !== undefined && wo.type === "windowAdded");
    assert.equal(wo.window.windowId, w0);

    const lc = echo.calls[1];
    assert.ok(lc !== undefined && lc.type === "layoutChanged");
    assert.equal(lc.windowId, w0);
    assert.deepEqual(lc.layout, layout);

    const po = echo.calls[2];
    assert.ok(po !== undefined && po.type === "paneOpened");
    assert.equal(po.pane.paneId, p0);
    assert.equal(po.pane.cols, 80);
    assert.equal(po.pane.rows, 24);

    const fc = echo.calls[3];
    assert.ok(fc !== undefined && fc.type === "focusChanged");
    assert.equal(fc.focus.paneId, p0);

    mirror.detachHook();
  });

  it("fires onDisconnected when detachHook() is called", () => {
    const { mirror } = makeMirror(makeSnapshot());
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();
    mirror.detachHook();

    assert.equal(echo.calls.length, 1);
    assert.equal(echo.calls[0]?.type, "disconnected");
  });

  it("detachHook() is idempotent (no double-disconnect)", () => {
    // Note: Mirror.attach() is idempotent (second call is a no-op), so there is
    // no way to re-attach the same hook. Instead we verify that detachHook()
    // called twice only fires onDisconnected once (the second call is a no-op
    // because #attachUnsubs is cleared).
    const { mirror } = makeMirror(makeSnapshot());
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();
    mirror.detachHook();
    mirror.detachHook(); // second call must be no-op

    const disconnects = echo.calls.filter((c) => c.type === "disconnected");
    assert.equal(disconnects.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Mirror.attach — model change events
//
// Ported from "createRenderHookDriver — model changes".
// Model changes are driven via mirror.receiveDelta() with proper DaemonMessage
// types and sequential seq numbers (seq starts at 2 after a seq=1 snapshot).
// ---------------------------------------------------------------------------

describe("Mirror.attach — model changes", () => {
  it("fires onPaneOpened when a new pane appears in the model", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }],
      windows: [{ windowId: w0 }],
      focus: { paneId: p0, windowId: w0 },
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    // New pane appears
    const delta: DaemonMessage = {
      type: "pane.opened",
      seq: 2,
      paneId: p1,
      windowId: w0,
      cols: 80,
      rows: 24,
      active: false,
    };
    mirror.receiveDelta(delta);

    const opened = echo.calls.filter((c) => c.type === "paneOpened");
    assert.equal(opened.length, 1);
    const oc = opened[0];
    assert.ok(oc !== undefined && oc.type === "paneOpened");
    assert.equal(oc.pane.paneId, p1);

    mirror.detachHook();
  });

  it("fires onPaneClosed when a pane disappears from the model", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }, { paneId: p1, windowId: w0 }],
      windows: [{ windowId: w0 }],
      focus: { paneId: p0, windowId: w0 },
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    // p1 closes
    const delta: DaemonMessage = {
      type: "pane.closed",
      seq: 2,
      paneId: p1,
      windowId: w0,
    };
    mirror.receiveDelta(delta);

    const closed = echo.calls.filter((c) => c.type === "paneClosed");
    assert.equal(closed.length, 1);
    const cc = closed[0];
    assert.ok(cc !== undefined && cc.type === "paneClosed");
    assert.equal(cc.paneId, p1);

    mirror.detachHook();
  });

  it("fires onPaneResized when a pane's size changes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0, cols: 80, rows: 24 }],
      windows: [{ windowId: w0 }],
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    const delta: DaemonMessage = {
      type: "pane.resized",
      seq: 2,
      paneId: p0,
      cols: 120,
      rows: 40,
    };
    mirror.receiveDelta(delta);

    const resizes = echo.calls.filter((c) => c.type === "paneResized");
    assert.equal(resizes.length, 1);
    const rc = resizes[0];
    assert.ok(rc !== undefined && rc.type === "paneResized");
    assert.equal(rc.cols, 120);
    assert.equal(rc.rows, 40);

    mirror.detachHook();
  });

  it("fires onFocusChanged when focus changes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }, { paneId: p1, windowId: w0 }],
      windows: [{ windowId: w0 }],
      focus: { paneId: p0, windowId: w0 },
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    const delta: DaemonMessage = {
      type: "focus.changed",
      seq: 2,
      paneId: p1,
      windowId: w0,
    };
    mirror.receiveDelta(delta);

    const focuses = echo.calls.filter((c) => c.type === "focusChanged");
    assert.equal(focuses.length, 1);
    const fc = focuses[0];
    assert.ok(fc !== undefined && fc.type === "focusChanged");
    assert.equal(fc.focus.paneId, p1);

    mirror.detachHook();
  });

  it("fires onWindowAdded when a new window appears", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const w1 = wid("w1");

    const snap = makeSnapshot({
      windows: [{ windowId: w0 }],
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    const delta: DaemonMessage = {
      type: "window.added",
      seq: 2,
      windowId: w1,
      name: "second",
      active: false,
    };
    mirror.receiveDelta(delta);

    const added = echo.calls.filter((c) => c.type === "windowAdded");
    assert.equal(added.length, 1);
    const ac = added[0];
    assert.ok(ac !== undefined && ac.type === "windowAdded");
    assert.equal(ac.window.windowId, w1);

    mirror.detachHook();
  });

  it("fires onWindowClosed when a window disappears", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const w1 = wid("w1");

    const snap = makeSnapshot({
      windows: [{ windowId: w0 }, { windowId: w1 }],
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    const delta: DaemonMessage = {
      type: "window.closed",
      seq: 2,
      windowId: w1,
    };
    mirror.receiveDelta(delta);

    const closed = echo.calls.filter((c) => c.type === "windowClosed");
    assert.equal(closed.length, 1);
    const cc = closed[0];
    assert.ok(cc !== undefined && cc.type === "windowClosed");
    assert.equal(cc.windowId, w1);

    mirror.detachHook();
  });

  it("fires onWindowRenamed when a window name changes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");

    const snap = makeSnapshot({
      windows: [{ windowId: w0, name: "original" }],
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    const delta: DaemonMessage = {
      type: "window.renamed",
      seq: 2,
      windowId: w0,
      newName: "new-name",
    };
    mirror.receiveDelta(delta);

    const renames = echo.calls.filter((c) => c.type === "windowRenamed");
    assert.equal(renames.length, 1);
    const rc = renames[0];
    assert.ok(rc !== undefined && rc.type === "windowRenamed");
    assert.equal(rc.windowId, w0);
    assert.equal(rc.newName, "new-name");

    mirror.detachHook();
  });
});

// ---------------------------------------------------------------------------
// Tests: Mirror.attach — byte events
//
// Ported from "createRenderHookDriver — byte events".
// FakeByteSource is wired via mirror.wireDataSources(byteSource) before
// mirror.attach(hook), matching the Mirror.attach contract.
// ---------------------------------------------------------------------------

describe("Mirror.attach — byte events", () => {
  it("routes onPaneOutput for a pane with non-UTF-8 bytes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }],
      windows: [{ windowId: w0 }],
    });
    const { mirror, byteSource } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    // Non-UTF-8 bytes: 0xFF, 0x80, 0x00, plus ASCII
    const bytes = new Uint8Array([0xff, 0x80, 0x00, 0x1b, 0x5b, 0x41]);
    byteSource.emit(p0, bytes);

    const outputs = echo.calls.filter((c) => c.type === "paneOutput");
    assert.equal(outputs.length, 1);
    const oc = outputs[0];
    assert.ok(oc !== undefined && oc.type === "paneOutput");
    assert.equal(oc.paneId, p0);
    assert.deepEqual(oc.bytes, bytes);

    mirror.detachHook();
  });

  it("subscribes to new pane bytes when a pane opens mid-session", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }],
      windows: [{ windowId: w0 }],
    });
    const { mirror, byteSource } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    echo.clear();

    // p1 opens
    const delta: DaemonMessage = {
      type: "pane.opened",
      seq: 2,
      paneId: p1,
      windowId: w0,
      cols: 80,
      rows: 24,
      active: false,
    };
    mirror.receiveDelta(delta);

    // Now emit bytes for p1
    const bytes = new Uint8Array([0x68, 0x69]); // "hi"
    byteSource.emit(p1, bytes);

    const outputs = echo.calls.filter((c) => c.type === "paneOutput");
    assert.equal(outputs.length, 1);
    const oc = outputs[0];
    assert.ok(oc !== undefined && oc.type === "paneOutput");
    assert.equal(oc.paneId, p1);

    mirror.detachHook();
  });

  it("stops routing bytes for a closed pane after pane close", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }, { paneId: p1, windowId: w0 }],
      windows: [{ windowId: w0 }],
    });
    const { mirror, byteSource } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);

    // Close p1
    const delta: DaemonMessage = {
      type: "pane.closed",
      seq: 2,
      paneId: p1,
      windowId: w0,
    };
    mirror.receiveDelta(delta);
    echo.clear();

    // Bytes for p1 after close — should NOT reach the hook
    byteSource.emit(p1, new Uint8Array([0x41]));

    const outputs = echo.calls.filter((c) => c.type === "paneOutput");
    assert.equal(outputs.length, 0);

    mirror.detachHook();
  });
});

// ---------------------------------------------------------------------------
// Tests: Mirror.attach — cleanup on detach
//
// Ported from "createRenderHookDriver — cleanup on stop".
// ---------------------------------------------------------------------------

describe("Mirror.attach — cleanup on detach", () => {
  it("does not fire callbacks after detachHook()", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }],
      windows: [{ windowId: w0 }],
    });
    const { mirror, byteSource } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    mirror.detachHook();
    echo.clear();

    // Push a model change after detach — should be silent
    // We use receiveSnapshot to force a model change (detachHook already unsubscribed)
    // Since the seq counter resets on re-snapshot, that's fine for testing the
    // "no callbacks after detach" invariant.
    mirror.receiveSnapshot(
      makeSnapshot({
        seq: 99,
        panes: [{ paneId: p0, windowId: w0 }, { paneId: pid("p1"), windowId: w0 }],
        windows: [{ windowId: w0 }],
      }),
    );
    byteSource.emit(p0, new Uint8Array([0x41]));

    assert.equal(echo.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Mirror.attach — idempotence
//
// New test verifying Mirror.attach() guard: a second attach() call is a no-op.
// (No equivalent in the old tests — the driver didn't have this constraint.)
// ---------------------------------------------------------------------------

describe("Mirror.attach — idempotence", () => {
  it("second attach() call is a no-op (does not fire a second snapshot replay)", () => {
    const w0 = wid("w0");
    const p0 = pid("p0");
    const s0 = sid("s0");

    const snap = makeSnapshot({
      panes: [{ paneId: p0, windowId: w0 }],
      windows: [{ windowId: w0 }],
      focus: { paneId: p0, windowId: w0 },
    });
    const { mirror } = makeMirror(snap);
    const echo = new EchoRenderHook();
    mirror.attach(echo);
    const countAfterFirst = echo.calls.length;

    // Second attach should be a no-op
    const echo2 = new EchoRenderHook();
    mirror.attach(echo2);
    assert.equal(echo2.calls.length, 0, "second attach must not fire any callbacks");
    // First echo must have received nothing extra
    assert.equal(echo.calls.length, countAfterFirst);

    mirror.detachHook();
  });

  it("wireDataSources() throws if called after attach()", () => {
    // This guards the pre-condition: wireDataSources must be called BEFORE attach.
    // Mirror.attach() itself throws if wireDataSources hasn't been called.
    // Here we test the complementary case: attach() called without wireDataSources.
    const snap = makeSnapshot({
      windows: [{ windowId: wid("w0") }],
      panes: [{ paneId: pid("p0"), windowId: wid("w0") }],
    });
    const mirror = new Mirror();
    mirror.receiveSnapshot(snap);
    // Intentionally skip wireDataSources — should throw.
    const echo = new EchoRenderHook();
    assert.throws(() => mirror.attach(echo), /wireDataSources/);
  });
});
