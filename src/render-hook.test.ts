/**
 * Tests for the render-hook interface, reference implementations, and driver.
 *
 * All dependencies (model/byte/input sources) are synthetic fakes so these
 * tests run independently of concurrent sibling beads (tc-eots, tc-3fb,
 * tc-fpf).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import type {
  PaneId,
  WindowId,
  SessionId,
  WindowLayout,
  PaneMode,
  ModelSource,
  ByteSource,
  InputSink,
  ClientModel,
  PaneInfo,
  WindowInfo,
  FocusInfo,
} from "./render-hook.js";
import {
  NoOpRenderHook,
  EchoRenderHook,
  createRenderHookDriver,
} from "./render-hook.js";

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

function makePaneInfo(
  paneId: PaneId,
  windowId: WindowId,
  sessionId: SessionId,
  cols = 80,
  rows = 24,
  active = false,
): PaneInfo {
  return { paneId, windowId, sessionId, cols, rows, active };
}

function makeWindowInfo(
  windowId: WindowId,
  sessionId: SessionId,
  name = "main",
  active = false,
  layout?: WindowLayout,
): WindowInfo {
  return { windowId, sessionId, name, active, layout: layout ?? makeLayout() };
}

// ---------------------------------------------------------------------------
// Fake ModelSource — fully controllable from tests
// ---------------------------------------------------------------------------

class FakeModelSource implements ModelSource {
  #model: ClientModel;
  #listeners: Set<() => void> = new Set();

  constructor(initial?: Partial<ClientModel>) {
    this.#model = {
      panes: initial?.panes ?? new Map(),
      windows: initial?.windows ?? new Map(),
      focus: initial?.focus ?? { paneId: null, windowId: null, sessionId: null },
    };
  }

  getModel(): ClientModel {
    return this.#model;
  }

  onModelChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** Push a new model state and fire all listeners. */
  push(next: Partial<ClientModel>): void {
    this.#model = { ...this.#model, ...next };
    for (const cb of this.#listeners) cb();
  }
}

// ---------------------------------------------------------------------------
// Fake ByteSource — per-pane emit function vended by subscribe
// ---------------------------------------------------------------------------

class FakeByteSource implements ByteSource {
  /** emit(paneId, bytes) — call this from tests to push bytes. */
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
// Fake InputSink — captures calls
// ---------------------------------------------------------------------------

interface InputCall {
  kind: "input";
  paneId: PaneId;
  data: string;
}
interface ResizeCall {
  kind: "resize";
  paneId: PaneId;
  cols: number;
  rows: number;
}
type SinkCall = InputCall | ResizeCall;

class FakeInputSink implements InputSink {
  readonly calls: SinkCall[] = [];

  sendInput(paneId: PaneId, data: string): void {
    this.calls.push({ kind: "input", paneId, data });
  }

  resizePane(paneId: PaneId, cols: number, rows: number): void {
    this.calls.push({ kind: "resize", paneId, cols, rows });
  }

  // tc-9hk: stub — render-hook.test.ts tests don't exercise sendCommand.
  sendCommand(_cmd: import("@tmuxcc/daemon").WireCommand): void {}
}

// ---------------------------------------------------------------------------
// Tests: NoOpRenderHook
// ---------------------------------------------------------------------------

describe("NoOpRenderHook", () => {
  it("satisfies the RenderHook interface (compile check)", () => {
    // All methods are callable without throwing.
    NoOpRenderHook.onPaneOpened(makePaneInfo(pid("p0"), wid("w0"), sid("s0")));
    NoOpRenderHook.onPaneClosed(pid("p0"));
    NoOpRenderHook.onPaneResized(pid("p0"), 80, 24);
    NoOpRenderHook.onPaneModeChanged(pid("p0"), "copy" as PaneMode);
    NoOpRenderHook.onPaneOutput(pid("p0"), new Uint8Array([0x41]));
    NoOpRenderHook.onWindowAdded(makeWindowInfo(wid("w0"), sid("s0")));
    NoOpRenderHook.onWindowClosed(wid("w0"));
    NoOpRenderHook.onWindowRenamed(wid("w0"), "new-name");
    NoOpRenderHook.onLayoutChanged(wid("w0"), makeLayout());
    NoOpRenderHook.onFocusChanged({ paneId: null, windowId: null, sessionId: null });
    NoOpRenderHook.onConnected();
    NoOpRenderHook.onDisconnected("test");
    // No assertion needed: reaching here without throw is the test.
  });
});

// ---------------------------------------------------------------------------
// Tests: EchoRenderHook records calls
// ---------------------------------------------------------------------------

describe("EchoRenderHook", () => {
  it("records onPaneOpened", () => {
    const echo = new EchoRenderHook();
    const pane = makePaneInfo(pid("p1"), wid("w1"), sid("s1"), 120, 40, true);
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
    const win = makeWindowInfo(wid("w2"), sid("s1"), "my-window", true);
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
    const focus: FocusInfo = { paneId: pid("p0"), windowId: wid("w0"), sessionId: sid("s0") };
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
// Tests: createRenderHookDriver — snapshot replay
// ---------------------------------------------------------------------------

describe("createRenderHookDriver — snapshot replay", () => {
  it("fires onWindowAdded, onLayoutChanged, onPaneOpened, onFocusChanged, onConnected in order for initial model", () => {
    const w0 = wid("w0");
    const p0 = pid("p0");
    const s0 = sid("s0");

    const layout = makeLayout(80, 24);
    const pane = makePaneInfo(p0, w0, s0, 80, 24, true);
    const win = makeWindowInfo(w0, s0, "main", true, layout);
    const focus: FocusInfo = { paneId: p0, windowId: w0, sessionId: s0 };

    const model: ClientModel = {
      panes: new Map([[p0, pane]]),
      windows: new Map([[w0, win]]),
      focus,
    };

    const modelSource = new FakeModelSource(model);
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();

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

    session.stop();
  });

  it("fires onDisconnected when stopped", () => {
    const modelSource = new FakeModelSource();
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();
    session.stop();

    assert.equal(echo.calls.length, 1);
    assert.equal(echo.calls[0]?.type, "disconnected");
  });

  it("stop() is idempotent (no double-disconnect)", () => {
    const modelSource = new FakeModelSource();
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();
    session.stop();
    session.stop(); // second call must be no-op

    const disconnects = echo.calls.filter((c) => c.type === "disconnected");
    assert.equal(disconnects.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Tests: driver — model change events
// ---------------------------------------------------------------------------

describe("createRenderHookDriver — model changes", () => {
  it("fires onPaneOpened when a new pane appears in the model", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const pane0 = makePaneInfo(p0, w0, s0);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0]]),
      windows: new Map([[w0, win0]]),
      focus: { paneId: p0, windowId: w0, sessionId: s0 },
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    // New pane appears
    const pane1 = makePaneInfo(p1, w0, s0, 80, 24, false);
    modelSource.push({
      panes: new Map([[p0, pane0], [p1, pane1]]),
    });

    const opened = echo.calls.filter((c) => c.type === "paneOpened");
    assert.equal(opened.length, 1);
    const oc = opened[0];
    assert.ok(oc !== undefined && oc.type === "paneOpened");
    assert.equal(oc.pane.paneId, p1);

    session.stop();
  });

  it("fires onPaneClosed when a pane disappears from the model", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const pane0 = makePaneInfo(p0, w0, s0);
    const pane1 = makePaneInfo(p1, w0, s0);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0], [p1, pane1]]),
      windows: new Map([[w0, win0]]),
      focus: { paneId: p0, windowId: w0, sessionId: s0 },
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    // p1 closes
    modelSource.push({ panes: new Map([[p0, pane0]]) });

    const closed = echo.calls.filter((c) => c.type === "paneClosed");
    assert.equal(closed.length, 1);
    const cc = closed[0];
    assert.ok(cc !== undefined && cc.type === "paneClosed");
    assert.equal(cc.paneId, p1);

    session.stop();
  });

  it("fires onPaneResized when a pane's size changes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");

    const pane0 = makePaneInfo(p0, w0, s0, 80, 24);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0]]),
      windows: new Map([[w0, win0]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    const resized = makePaneInfo(p0, w0, s0, 120, 40);
    modelSource.push({ panes: new Map([[p0, resized]]) });

    const resizes = echo.calls.filter((c) => c.type === "paneResized");
    assert.equal(resizes.length, 1);
    const rc = resizes[0];
    assert.ok(rc !== undefined && rc.type === "paneResized");
    assert.equal(rc.cols, 120);
    assert.equal(rc.rows, 40);

    session.stop();
  });

  it("fires onFocusChanged when focus changes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const pane0 = makePaneInfo(p0, w0, s0);
    const pane1 = makePaneInfo(p1, w0, s0);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0], [p1, pane1]]),
      windows: new Map([[w0, win0]]),
      focus: { paneId: p0, windowId: w0, sessionId: s0 },
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    modelSource.push({ focus: { paneId: p1, windowId: w0, sessionId: s0 } });

    const focuses = echo.calls.filter((c) => c.type === "focusChanged");
    assert.equal(focuses.length, 1);
    const fc = focuses[0];
    assert.ok(fc !== undefined && fc.type === "focusChanged");
    assert.equal(fc.focus.paneId, p1);

    session.stop();
  });

  it("fires onWindowAdded when a new window appears", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const w1 = wid("w1");

    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      windows: new Map([[w0, win0]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    const win1 = makeWindowInfo(w1, s0, "second");
    modelSource.push({ windows: new Map([[w0, win0], [w1, win1]]) });

    const added = echo.calls.filter((c) => c.type === "windowAdded");
    assert.equal(added.length, 1);
    const ac = added[0];
    assert.ok(ac !== undefined && ac.type === "windowAdded");
    assert.equal(ac.window.windowId, w1);

    session.stop();
  });

  it("fires onWindowClosed when a window disappears", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const w1 = wid("w1");

    const win0 = makeWindowInfo(w0, s0);
    const win1 = makeWindowInfo(w1, s0);

    const modelSource = new FakeModelSource({
      windows: new Map([[w0, win0], [w1, win1]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    modelSource.push({ windows: new Map([[w0, win0]]) });

    const closed = echo.calls.filter((c) => c.type === "windowClosed");
    assert.equal(closed.length, 1);
    const cc = closed[0];
    assert.ok(cc !== undefined && cc.type === "windowClosed");
    assert.equal(cc.windowId, w1);

    session.stop();
  });

  it("fires onWindowRenamed when a window name changes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const win0 = makeWindowInfo(w0, s0, "original");

    const modelSource = new FakeModelSource({
      windows: new Map([[w0, win0]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    const renamed = makeWindowInfo(w0, s0, "new-name");
    modelSource.push({ windows: new Map([[w0, renamed]]) });

    const renames = echo.calls.filter((c) => c.type === "windowRenamed");
    assert.equal(renames.length, 1);
    const rc = renames[0];
    assert.ok(rc !== undefined && rc.type === "windowRenamed");
    assert.equal(rc.windowId, w0);
    assert.equal(rc.newName, "new-name");

    session.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: driver — byte events
// ---------------------------------------------------------------------------

describe("createRenderHookDriver — byte events", () => {
  it("routes onPaneOutput for a pane with non-UTF-8 bytes", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");

    const pane0 = makePaneInfo(p0, w0, s0);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0]]),
      windows: new Map([[w0, win0]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
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

    session.stop();
  });

  it("subscribes to new pane bytes when a pane opens mid-session", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const pane0 = makePaneInfo(p0, w0, s0);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0]]),
      windows: new Map([[w0, win0]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    echo.clear();

    // p1 opens
    const pane1 = makePaneInfo(p1, w0, s0);
    modelSource.push({ panes: new Map([[p0, pane0], [p1, pane1]]) });

    // Now emit bytes for p1
    const bytes = new Uint8Array([0x68, 0x69]); // "hi"
    byteSource.emit(p1, bytes);

    const outputs = echo.calls.filter((c) => c.type === "paneOutput");
    assert.equal(outputs.length, 1);
    const oc = outputs[0];
    assert.ok(oc !== undefined && oc.type === "paneOutput");
    assert.equal(oc.paneId, p1);

    session.stop();
  });

  it("stops routing bytes for a closed pane after pane close", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");
    const p1 = pid("p1");

    const pane0 = makePaneInfo(p0, w0, s0);
    const pane1 = makePaneInfo(p1, w0, s0);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0], [p1, pane1]]),
      windows: new Map([[w0, win0]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();

    // Close p1
    modelSource.push({ panes: new Map([[p0, pane0]]) });
    echo.clear();

    // Bytes for p1 after close — should NOT reach the hook
    byteSource.emit(p1, new Uint8Array([0x41]));

    const outputs = echo.calls.filter((c) => c.type === "paneOutput");
    assert.equal(outputs.length, 0);

    session.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: input/resize surface — controller delegates to InputSink
// ---------------------------------------------------------------------------

describe("ClientController delegates to InputSink", () => {
  it("sendInput is forwarded to the InputSink", () => {
    const modelSource = new FakeModelSource();
    const byteSource = new FakeByteSource();
    const sink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, sink);
    const session = driver.start();

    session.controller.sendInput(pid("p0"), "hello");

    assert.equal(sink.calls.length, 1);
    const call = sink.calls[0];
    assert.ok(call !== undefined && call.kind === "input");
    assert.equal(call.paneId, "p0");
    assert.equal(call.data, "hello");

    session.stop();
  });

  it("resizePane is forwarded to the InputSink", () => {
    const modelSource = new FakeModelSource();
    const byteSource = new FakeByteSource();
    const sink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, sink);
    const session = driver.start();

    session.controller.resizePane(pid("p1"), 200, 50);

    assert.equal(sink.calls.length, 1);
    const call = sink.calls[0];
    assert.ok(call !== undefined && call.kind === "resize");
    assert.equal(call.paneId, "p1");
    assert.equal(call.cols, 200);
    assert.equal(call.rows, 50);

    session.stop();
  });

  it("multiple sendInput calls are all captured in order", () => {
    const modelSource = new FakeModelSource();
    const byteSource = new FakeByteSource();
    const sink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, sink);
    const session = driver.start();

    session.controller.sendInput(pid("p0"), "a");
    session.controller.sendInput(pid("p0"), "b");
    session.controller.sendInput(pid("p0"), "c");

    assert.equal(sink.calls.length, 3);
    assert.equal((sink.calls[0] as InputCall | undefined)?.data, "a");
    assert.equal((sink.calls[1] as InputCall | undefined)?.data, "b");
    assert.equal((sink.calls[2] as InputCall | undefined)?.data, "c");

    session.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: model unsubscription on stop
// ---------------------------------------------------------------------------

describe("createRenderHookDriver — cleanup on stop", () => {
  it("does not fire callbacks after stop()", () => {
    const s0 = sid("s0");
    const w0 = wid("w0");
    const p0 = pid("p0");

    const pane0 = makePaneInfo(p0, w0, s0);
    const win0 = makeWindowInfo(w0, s0);

    const modelSource = new FakeModelSource({
      panes: new Map([[p0, pane0]]),
      windows: new Map([[w0, win0]]),
    });
    const byteSource = new FakeByteSource();
    const inputSink = new FakeInputSink();
    const echo = new EchoRenderHook();

    const driver = createRenderHookDriver(echo, modelSource, byteSource, inputSink);
    const session = driver.start();
    session.stop();
    echo.clear();

    // Push a model change after stop — should be silent
    const pane1 = makePaneInfo(pid("p1"), w0, s0);
    modelSource.push({
      panes: new Map([[p0, pane0], [pid("p1"), pane1]]),
    });
    byteSource.emit(p0, new Uint8Array([0x41]));

    assert.equal(echo.calls.length, 0);
  });
});
