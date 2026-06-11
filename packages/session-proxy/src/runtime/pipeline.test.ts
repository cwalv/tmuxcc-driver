/**
 * Tests for the runtime pipeline — tc-128.4 (replaces tc-4fo).
 *
 * The per-event reducer + BootstrapCoordinator were retired in tc-128.4; the
 * topology pipeline is now the requery-driven engine + coalescer. These tests
 * exercise the new pipeline as a BLACK BOX: feed bootstrap-shape list-* reply
 * blocks plus notifications, observe the model and onModelChange signal.
 *
 * # tc-3y8 disposition (recorded in close comment)
 *
 *   - Golden capture replay (tc-4fo's Suite 1, Suite 2, Suite 5, Suite 6
 *     under the previous design) — DELETED. The golden capture was assembled
 *     by the per-event reducer interpreting %session-changed / %window-add /
 *     %layout-change to BUILD the model; with the model now sourced from
 *     `list-*` replies (which the golden capture doesn't carry in
 *     BOOTSTRAP_* format), those tests encoded reducer-internal mechanics
 *     and cannot pass as black-box tests of the new pipeline.
 *   - tc-fx4/tc-3y8.9 "%window-add reconcile injects window name + layout"
 *     — DELETED. The new pipeline does NOT issue a targeted list-windows
 *     reconcile in response to %window-add; the coalescer fires a full
 *     session-scoped requery instead. The bug class is structurally
 *     impossible (the engine never trusts event content) so the test no
 *     longer has a thing to assert.
 *   - "%unlinked-window-add is ignored" — RE-PLUMBED below as a session-
 *     scoped requery assertion. With `sessionName` set, the engine's list-*
 *     commands are targeted `-t =<name>` and the unlinked window naturally
 *     never appears.
 *   - "bootstrap notifications buffered and replayed" / "live notifications
 *     after bootstrap" — RE-PLUMBED below: post-bootstrap notifications
 *     fire a requery; the test feeds updated list-* replies and asserts the
 *     resulting delta.
 *
 * @module runtime/pipeline.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRuntimePipeline } from "./pipeline.js";
import type { TmuxHost, DataHandler, ExitHandler, ErrorHandler } from "./tmux-host.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { checkInvariants, paneId, windowId, sessionId } from "../state/model.js";

// ---------------------------------------------------------------------------
// FakeTmuxHost — a TmuxHost that lets the test push bytes and write commands
// ---------------------------------------------------------------------------

class FakeTmuxHost implements TmuxHost {
  private _dataHandlers = new Set<DataHandler>();
  private _exitHandlers = new Set<ExitHandler>();
  private _errorHandlers = new Set<ErrorHandler>();
  private _stderrHandlers = new Set<DataHandler>();
  private _written: string[] = [];
  private _exited = false;
  private _pid: number | undefined = 99999;

  get pid(): number | undefined { return this._pid; }
  get exited(): boolean { return this._exited; }

  start(): Promise<void> { return Promise.resolve(); }

  write(data: string | Uint8Array | Buffer): void {
    const s = typeof data === "string" ? data : new TextDecoder().decode(data);
    this._written.push(s);
    // Auto-ack fire-and-forget setup commands (set-option / refresh-client):
    // the pipeline registers throwaway correlator slots for them (FIFO
    // invariant, see _writeSlottedCommand), so the fake host must answer or
    // the slots stay pending and mis-bind whatever reply the test injects
    // next. list-* replies stay test-scripted (tests assert their content).
    const trimmed = s.trim();
    if (trimmed.startsWith("set-option") || trimmed.startsWith("refresh-client")) {
      const block = makeCommandBlock(nextCmdNum(), "");
      process.nextTick(() => {
        if (!this._exited) this.pushData(bytes(block));
      });
    }
  }

  onData(handler: DataHandler): () => void {
    this._dataHandlers.add(handler);
    return () => this._dataHandlers.delete(handler);
  }

  onExit(handler: ExitHandler): () => void {
    this._exitHandlers.add(handler);
    return () => this._exitHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this._errorHandlers.add(handler);
    return () => this._errorHandlers.delete(handler);
  }

  onStderr(handler: DataHandler): () => void {
    this._stderrHandlers.add(handler);
    return () => this._stderrHandlers.delete(handler);
  }

  stop(): Promise<void> { this._exited = true; return Promise.resolve(); }
  kill(): void { this._exited = true; }

  pushData(bytes: Uint8Array): void {
    for (const handler of this._dataHandlers) handler(bytes);
  }

  popWritten(): string[] {
    const written = [...this._written];
    this._written = [];
    return written;
  }

  fakeExit(code: number | null = 0, signal: string | null = null): void {
    this._exited = true;
    for (const h of this._exitHandlers) h(code, signal);
  }
}

const enc = new TextEncoder();
function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

// ---------------------------------------------------------------------------
// Helpers — build bootstrap-shape list-* reply blocks the engine can parse.
// ---------------------------------------------------------------------------

let _cmdNumCounter = 100;
function nextCmdNum(): number {
  return _cmdNumCounter++;
}

function makeCommandBlock(cmdNum: number, body: string): string {
  const ts = 1000000;
  return `%begin ${ts} ${cmdNum} 1\r\n${body}%end ${ts} ${cmdNum} 1\r\n`;
}

interface BootstrapStreamOpts {
  sessionId?: string;
  sessionName?: string;
  windowId?: string;
  windowName?: string;
  paneId?: string;
  cols?: number;
  rows?: number;
}

/**
 * Build a bootstrap-shape reply pair: one windows block + one panes block in
 * BOOTSTRAP_WINDOWS_FORMAT / BOOTSTRAP_PANES_FORMAT (tab-separated). The
 * engine parses these into a single session/window/pane.
 */
function buildBootstrapReplies(opts: BootstrapStreamOpts = {}): Uint8Array {
  const sid = opts.sessionId ?? "$0";
  const sname = opts.sessionName ?? "bootsession";
  const wid = opts.windowId ?? "@1";
  const wname = opts.windowName ?? "bootwin";
  const pid_ = opts.paneId ?? "%1";
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const layoutStr = `aaaa,${cols}x${rows},0,0,${parseInt(pid_.slice(1), 10)}`;
  const windowsBody =
    `${sid}\t${sname}\t${wid}\t${wname}\t${cols}\t${rows}\t${layoutStr}\t*\t1\n`;
  const panesBody =
    `${pid_}\t${wid}\t${sid}\t0\t${cols}\t${rows}\t0\t0\t1\t1234\tbash\n`;

  const stream =
    makeCommandBlock(nextCmdNum(), windowsBody) +
    makeCommandBlock(nextCmdNum(), panesBody);

  return bytes(stream);
}

/**
 * Build a windows+panes reply pair for two windows on a single session, each
 * with one pane (a "post-window-add" snapshot used to test the requery path).
 */
function buildTwoWindowReplies(opts: { sessionName?: string } = {}): Uint8Array {
  const sname = opts.sessionName ?? "bootsession";
  const winBody =
    `$0\t${sname}\t@1\twin1\t80\t24\taaaa,80x24,0,0,1\t*\t1\n` +
    `$0\t${sname}\t@2\twin2\t80\t24\tbbbb,80x24,0,0,2\t-\t0\n`;
  const paneBody =
    `%1\t@1\t$0\t0\t80\t24\t0\t0\t1\t1234\tbash\n` +
    `%2\t@2\t$0\t0\t80\t24\t0\t0\t1\t5678\tbash\n`;
  return bytes(
    makeCommandBlock(nextCmdNum(), winBody) +
      makeCommandBlock(nextCmdNum(), paneBody),
  );
}

// ---------------------------------------------------------------------------
// Suite — bootstrap path (canned list-windows + list-panes replies)
// ---------------------------------------------------------------------------

describe("Pipeline: bootstrap (requery-on-attach)", () => {
  it("builds the initial model from the engine's list-windows + list-panes replies", async () => {
    const host = new FakeTmuxHost();
    const buffers = createPaneBufferStore();
    const pipeline = createRuntimePipeline(host, { buffers });

    const startPromise = pipeline.start();

    host.pushData(buildBootstrapReplies({
      sessionId: "$3",
      sessionName: "mysession",
      windowId: "@7",
      windowName: "mywindow",
      paneId: "%5",
      cols: 120,
      rows: 40,
    }));

    await startPromise;

    assert.ok(pipeline.isLive(), "pipeline must be live after bootstrap");

    const model = pipeline.getModel();

    assert.equal(model.sessions.size, 1, "expected 1 session");
    const sess = model.sessions.get(sessionId("s3"));
    assert.ok(sess !== undefined, "session s3 must exist (from $3)");
    assert.equal(sess!.name, "mysession");

    assert.equal(model.windows.size, 1, "expected 1 window");
    const win = model.windows.get(windowId("w7"));
    assert.ok(win !== undefined, "window w7 must exist (from @7)");
    assert.equal(win!.name, "mywindow");
    assert.equal(win!.sessionId, sessionId("s3"));

    assert.equal(model.panes.size, 1, "expected 1 pane");
    const pane = model.panes.get(paneId("p5"));
    assert.ok(pane !== undefined, "pane p5 must exist (from %5)");
    assert.equal(pane!.cols, 120);
    assert.equal(pane!.rows, 40);
    assert.equal(pane!.windowId, windowId("w7"));
    assert.equal(pane!.sessionId, sessionId("s3"));

    assert.deepEqual(checkInvariants(model), []);

    pipeline.stop();
  });

  it("issues list-windows then list-panes in that order on bootstrap", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    const written = host.popWritten();

    assert.equal(written.length, 2, `expected 2 write() calls, got ${written.length}: ${JSON.stringify(written)}`);
    assert.ok(written[0]!.includes("list-windows"), `first bootstrap command should be list-windows, got: ${written[0]}`);
    assert.ok(written[1]!.includes("list-panes"), `second bootstrap command should be list-panes, got: ${written[1]}`);

    host.pushData(buildBootstrapReplies());
    await startPromise;

    pipeline.stop();
  });

  it("getModel() returns empty model before start()", () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);
    const model = pipeline.getModel();
    assert.equal(model.sessions.size, 0, "sessions empty before start");
    assert.equal(model.windows.size, 0);
    assert.equal(model.panes.size, 0);
  });

  it("isLive() is false before start() resolves", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);
    assert.equal(pipeline.isLive(), false, "not live before start");

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    assert.equal(pipeline.isLive(), true, "live after start resolves");
    pipeline.stop();
  });

  it("buffers property is the PaneBufferStore supplied to createRuntimePipeline", () => {
    const host = new FakeTmuxHost();
    const buffers = createPaneBufferStore();
    const pipeline = createRuntimePipeline(host, { buffers });
    assert.equal(pipeline.buffers, buffers);
  });

  it("scopes list-* to the bound session when sessionName is supplied (tc-tfv.3, tc-3y8.9)", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host, { sessionName: "mysession" });

    const startPromise = pipeline.start();
    const written = host.popWritten();
    assert.equal(written.length, 2);
    assert.ok(written[0]!.includes("list-windows"), `got: ${written[0]}`);
    assert.ok(
      written[0]!.includes("-t =mysession"),
      `list-windows must be scoped to the bound session, got: ${written[0]}`,
    );
    assert.ok(written[1]!.includes("list-panes"), `got: ${written[1]}`);
    assert.ok(
      written[1]!.includes("-t =mysession"),
      `list-panes must be scoped to the bound session, got: ${written[1]}`,
    );

    host.pushData(buildBootstrapReplies({ sessionName: "mysession" }));
    await startPromise;

    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite — live requery on topology notifications (replaces tc-3y8.9 reducer
// behaviour with the engine's full-snapshot requery)
// ---------------------------------------------------------------------------

describe("Pipeline: live requery on topology events", () => {
  it("a topology notification fires a requery, and the new snapshot lands in the model", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host, {
      ceilingMs: 50,        // short ceiling so the leading-edge cycle fires fast
      heartbeatMs: 999_999, // disable heartbeat for determinism
    });

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;
    host.popWritten(); // discard bootstrap commands

    // Bootstrap committed one window.
    assert.equal(pipeline.getModel().windows.size, 1, "bootstrap landed @1");

    // Inject a topology notification. The pipeline classifies %window-add as
    // topology, marks dirty, and the leading-edge fires a requery.
    let modelChanged = false;
    pipeline.onModelChange(() => { modelChanged = true; });

    host.pushData(bytes("%window-add @2\r\n"));

    // Yield microtasks so the coalescer's leading-edge fire issues new
    // list-* commands.
    await new Promise<void>((r) => setImmediate(r));

    const written = host.popWritten();
    assert.ok(
      written.some((w) => w.startsWith("list-windows")),
      `requery must issue list-windows, got: ${JSON.stringify(written)}`,
    );
    assert.ok(
      written.some((w) => w.startsWith("list-panes")),
      `requery must issue list-panes, got: ${JSON.stringify(written)}`,
    );

    // Feed the updated snapshot: two windows now.
    host.pushData(buildTwoWindowReplies());

    // Yield to let the engine commit + onDeltas fire.
    await new Promise<void>((r) => setImmediate(r));

    const model = pipeline.getModel();
    assert.equal(model.windows.size, 2, "post-requery model carries both windows");
    assert.ok(model.windows.has(windowId("w1")), "w1 present");
    assert.ok(model.windows.has(windowId("w2")), "w2 present");
    assert.ok(modelChanged, "onModelChange must have fired for the new snapshot");
    assert.deepEqual(checkInvariants(model), []);

    pipeline.stop();
  });

  it("%unlinked-window-add does NOT graft a foreign window into the model (tc-3y8.9)", async () => {
    // With a bound session name, list-* are scoped `-t =name`, so a window
    // that belongs to another session simply doesn't appear in the requery
    // snapshot. The notification itself is classified as topology (treated
    // as a dirty bit only); the truth comes from the session-scoped reply.
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host, {
      sessionName: "bootsession",
      ceilingMs: 50,
      heartbeatMs: 999_999,
    });

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies({ sessionName: "bootsession" }));
    await startPromise;
    host.popWritten();

    // Foreign window-add — would have grafted @9 in the old reducer.
    host.pushData(bytes("%unlinked-window-add @9\r\n"));

    // Wait for the leading-edge requery to fire.
    await new Promise<void>((r) => setImmediate(r));

    // The engine wrote new list-* commands; feed the SAME bootstrap snapshot
    // back (the foreign window is not in our session, so list-windows
    // -t =bootsession still returns just @1).
    host.pushData(buildBootstrapReplies({ sessionName: "bootsession" }));
    await new Promise<void>((r) => setImmediate(r));

    const model = pipeline.getModel();
    assert.equal(model.windows.has(windowId("w9")), false, "unlinked window must not enter the model");
    assert.equal(model.windows.size, 1, "only our session's window is present");

    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite — bootstrap-race regression (tc-128.4 review fix)
//
// A topology notification that arrives DURING the bootstrap requery (while
// list-*/list-panes are in flight) must not be silently discarded.  The drain
// must replay it as a dirty bit so the coalescer issues a healing requery;
// staleness is bounded by the requery round-trip, not the 30 s heartbeat.
// ---------------------------------------------------------------------------

describe("Pipeline: bootstrap-race — topology notification during bootstrap triggers healing requery", () => {
  it("topology notification injected before bootstrap replies → healing requery issued after drain → updated snapshot lands in the model", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host, {
      ceilingMs: 50,
      heartbeatMs: 999_999, // disable heartbeat for determinism
    });

    const startPromise = pipeline.start();

    // Inject a topology notification BEFORE the bootstrap list-* replies arrive.
    // This races the bootstrap requery (the pipeline is still in the
    // _bootstrapBuffer phase), so the event is buffered rather than dispatched.
    host.pushData(bytes("%window-add @2\r\n"));

    // Now feed the bootstrap replies (one window). The engine commits this as
    // the initial snapshot. The notification above was buffered.
    host.pushData(buildBootstrapReplies()); // one window (@1)
    await startPromise;

    // At this point start() has resolved. The buffered %window-add should have
    // been drained through _dispatchEvent → coalescer.notify, marking the
    // engine dirty. Since coalescer._lastRequeryAt is -Infinity (the bootstrap
    // cycle bypassed the coalescer), the leading edge fires immediately.
    //
    // Yield one microtask tick so the coalescer's leading-edge requery issues
    // its list-* commands.
    await new Promise<void>((r) => setImmediate(r));

    const writtenAfterBootstrap = host.popWritten();
    assert.ok(
      writtenAfterBootstrap.some((w) => w.startsWith("list-windows")),
      `healing requery must issue list-windows; got: ${JSON.stringify(writtenAfterBootstrap)}`,
    );
    assert.ok(
      writtenAfterBootstrap.some((w) => w.startsWith("list-panes")),
      `healing requery must issue list-panes; got: ${JSON.stringify(writtenAfterBootstrap)}`,
    );

    // Feed the updated snapshot: two windows now (the raced notification was real).
    host.pushData(buildTwoWindowReplies());
    await new Promise<void>((r) => setImmediate(r));

    const model = pipeline.getModel();
    assert.equal(
      model.windows.size,
      2,
      "healing requery must update model to reflect the raced topology change",
    );
    assert.ok(model.windows.has(windowId("w1")), "w1 must be present after healing requery");
    assert.ok(model.windows.has(windowId("w2")), "w2 must be present after healing requery");

    pipeline.stop();
  });

  it("topology notification during bootstrap increments the onTopologyNotify counter", async () => {
    const host = new FakeTmuxHost();
    const topologyKinds: string[] = [];
    const pipeline = createRuntimePipeline(host, {
      ceilingMs: 50,
      heartbeatMs: 999_999,
      onTopologyNotify: (kind) => { topologyKinds.push(kind); },
    });

    const startPromise = pipeline.start();

    // Inject topology notification during bootstrap window.
    host.pushData(bytes("%window-add @2\r\n"));

    // Bootstrap replies.
    host.pushData(buildBootstrapReplies());
    await startPromise;

    // Yield so coalescer fires the leading-edge requery and the drain runs.
    await new Promise<void>((r) => setImmediate(r));

    // Feed the second reply pair so the requery completes (prevents test hang).
    host.pushData(buildTwoWindowReplies());
    await new Promise<void>((r) => setImmediate(r));

    assert.ok(
      topologyKinds.includes("window-add"),
      `onTopologyNotify must have been called with "window-add"; got: ${JSON.stringify(topologyKinds)}`,
    );

    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite — post-bootstrap commands written by the runtime (tc-95lue, tc-7xv.28)
// ---------------------------------------------------------------------------

describe("Pipeline: post-bootstrap setup commands", () => {
  it("writes set-option -wg monitor-activity on after bootstrap completes", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.popWritten(); // drain bootstrap writes
    host.pushData(buildBootstrapReplies());
    await startPromise;

    const postBootstrapWrites = host.popWritten();
    const monitorActivityCmd = `set-option -wg monitor-activity on\n`;
    assert.ok(
      postBootstrapWrites.some((w) => w === monitorActivityCmd),
      `expected ${JSON.stringify(monitorActivityCmd)} after bootstrap; got: ${JSON.stringify(postBootstrapWrites)}`,
    );
    pipeline.stop();
  });

  it("registers refresh-client -B sync-watch subscription after bootstrap", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.popWritten();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    const postBootstrapWrites = host.popWritten();
    const syncWatchCmd = "refresh-client -B 'sync-watch:@*:#{?synchronize-panes,1,0}'\n";
    assert.ok(
      postBootstrapWrites.some((w) => w === syncWatchCmd),
      `expected sync-watch subscription command; got: ${JSON.stringify(postBootstrapWrites)}`,
    );
    pipeline.stop();
  });

  it("does NOT write monitor-activity / sync-watch before bootstrap resolves", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    const preBootstrapWrites = host.popWritten();
    const monitorActivityCmd = `set-option -wg monitor-activity on\n`;
    assert.ok(
      !preBootstrapWrites.some((w) => w === monitorActivityCmd),
      `monitor-activity must not be written pre-bootstrap; got: ${JSON.stringify(preBootstrapWrites)}`,
    );

    host.pushData(buildBootstrapReplies());
    await startPromise;
    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite — sync-watch subscription (tc-7xv.28) — model patch, NOT topology requery
// ---------------------------------------------------------------------------

describe("Pipeline: sync-watch subscription (tc-7xv.28)", () => {
  function syncWatchLine(tmuxWindowNum: number, value: "0" | "1"): string {
    return `%subscription-changed sync-watch $0 @${tmuxWindowNum} 0 - : ${value}\r\n`;
  }

  it("external sync ON: %subscription-changed sync-watch value=1 patches the model", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies({ windowId: "@1", paneId: "%1" }));
    await startPromise;

    const winBefore = pipeline.getModel().windows.get(windowId("w1"));
    assert.ok(winBefore !== undefined);
    assert.equal(winBefore!.synchronizePanes, false);

    let changeCount = 0;
    pipeline.onModelChange(() => { changeCount++; });

    host.pushData(bytes(syncWatchLine(1, "1")));

    const winAfter = pipeline.getModel().windows.get(windowId("w1"));
    assert.ok(winAfter !== undefined);
    assert.equal(winAfter!.synchronizePanes, true);
    assert.ok(changeCount >= 1, "onModelChange must have fired for the patch");

    pipeline.stop();
  });

  it("external sync OFF: %subscription-changed sync-watch value=0 patches the model", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies({ windowId: "@1", paneId: "%1" }));
    await startPromise;

    // Flip on via the same patch path used by the optimistic update.
    pipeline.patchModel((m) => {
      const w = m.windows.get(windowId("w1"));
      if (!w) return m;
      return {
        ...m,
        windows: new Map(m.windows).set(windowId("w1"), { ...w, synchronizePanes: true }),
      };
    });
    assert.equal(pipeline.getModel().windows.get(windowId("w1"))!.synchronizePanes, true);

    host.pushData(bytes(syncWatchLine(1, "0")));
    assert.equal(pipeline.getModel().windows.get(windowId("w1"))!.synchronizePanes, false);
    pipeline.stop();
  });

  it("no-op: %subscription-changed sync-watch same value does not fire onModelChange", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies({ windowId: "@1", paneId: "%1" }));
    await startPromise;

    let changeCount = 0;
    pipeline.onModelChange(() => { changeCount++; });

    host.pushData(bytes(syncWatchLine(1, "0")));
    assert.equal(changeCount, 0, "no model change expected when state is unchanged");
    pipeline.stop();
  });

  it("unknown window id in sync-watch is silently dropped", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies({ windowId: "@1", paneId: "%1" }));
    await startPromise;

    let changeCount = 0;
    pipeline.onModelChange(() => { changeCount++; });

    host.pushData(bytes(syncWatchLine(99, "1")));
    assert.equal(changeCount, 0);
    assert.ok(pipeline.isLive());
    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite — model-change signal
// ---------------------------------------------------------------------------

describe("Pipeline: model-change signal", () => {
  it("onModelChange fires at least once on bootstrap (empty → snapshot)", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    let changeCount = 0;
    pipeline.onModelChange(() => { changeCount++; });

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    assert.ok(changeCount >= 1, `expected at least 1 model change at bootstrap, got ${changeCount}`);
    pipeline.stop();
  });

  it("unsubscribe stops further callbacks", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host, { ceilingMs: 50, heartbeatMs: 999_999 });

    let count = 0;
    const unsub = pipeline.onModelChange(() => { count++; });

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    const countAfterStart = count;
    unsub();

    // A topology notification would otherwise trigger another model change.
    host.pushData(bytes("%window-add @2\r\n"));
    host.pushData(buildTwoWindowReplies());
    await new Promise<void>((r) => setImmediate(r));

    assert.equal(count, countAfterStart, "unsubscribed handler must not fire");
    pipeline.stop();
  });

  it("multiple onModelChange handlers are all called", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    let countA = 0;
    let countB = 0;
    pipeline.onModelChange(() => { countA++; });
    pipeline.onModelChange(() => { countB++; });

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    assert.ok(countA >= 1);
    assert.ok(countB >= 1);
    assert.equal(countA, countB);
    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite — stop() behaviour
// ---------------------------------------------------------------------------

describe("Pipeline: stop() behaviour", () => {
  it("stop() is idempotent", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    assert.doesNotThrow(() => {
      pipeline.stop();
      pipeline.stop();
      pipeline.stop();
    });
  });

  it("getModel() is safe to call after stop()", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    pipeline.stop();
    const model = pipeline.getModel();
    assert.ok(model !== null);
  });
});

// ---------------------------------------------------------------------------
// Suite — invariants
// ---------------------------------------------------------------------------

describe("Pipeline: invariants", () => {
  it("model invariants hold after bootstrap", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host, { checkInvariantsOnUpdate: true });

    const startPromise = pipeline.start();
    host.pushData(buildBootstrapReplies());
    await startPromise;

    const violations = checkInvariants(pipeline.getModel());
    assert.deepEqual(violations, [], `invariant violations: ${JSON.stringify(violations)}`);
    pipeline.stop();
  });
});
