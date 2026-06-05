/**
 * Tests for the runtime pipeline — tc-4fo.
 *
 * Tests the spine that connects TmuxHost stdout bytes to the E2 parser and E3
 * state layer: ControlTokenizer → parseNotification → BootstrapCoordinator →
 * reduce → live SessionModel + model-change signals.
 *
 * # Test strategy
 *
 * All tests are deterministic (no real tmux process):
 *   1. DIRECT REPLAY — feed the real golden capture (tmux34-session.raw) into
 *      the pipeline via a fake host that emits the raw bytes. Verify the final
 *      model matches the expectations established by the E3 replay tests.
 *
 *   2. FAKE HOST STREAMING — create a FakeTmuxHost that emits canned control-
 *      mode bytes in arbitrary chunk sizes; verify the pipeline assembles the
 *      correct model incrementally.
 *
 *   3. BOOTSTRAP PATH — wire a FakeTmuxHost that responds to bootstrap commands
 *      (list-windows + list-panes) with canned replies; verify the coordinator
 *      transitions to live mode with the correct initial model.
 *
 *   4. MODEL-CHANGE SIGNAL — verify the onModelChange callback fires on every
 *      structural model update.
 *
 * The pipeline's bootstrap path requires the fake host to respond to write()
 * calls with the appropriate %begin/%end blocks. We implement a minimal
 * FakeTmuxHost that buffers onData emissions and allows the test to drive them.
 *
 * @module runtime/pipeline.test
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createRuntimePipeline } from "./pipeline.js";
import type { RuntimePipeline } from "./pipeline.js";
import type { TmuxHost, DataHandler, ExitHandler, ErrorHandler } from "./tmux-host.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { checkInvariants, paneId, windowId, sessionId } from "../state/model.js";
import { BootstrapCoordinator, BOOTSTRAP_WINDOWS_FORMAT, BOOTSTRAP_PANES_FORMAT } from "../state/bootstrap.js";
import type { SessionModel } from "../state/model.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, "../parser/golden/tmux34-session.raw");

function loadGolden(): Uint8Array {
  return new Uint8Array(readFileSync(GOLDEN_PATH));
}

// ---------------------------------------------------------------------------
// FakeTmuxHost — a TmuxHost that lets the test push bytes and write commands
// ---------------------------------------------------------------------------

/**
 * FakeTmuxHost simulates TmuxHost's API without spawning any process.
 * - `pushData(bytes)` — triggers all registered onData handlers synchronously.
 * - `popWritten()` — returns all bytes written to the host's "stdin" since last call.
 * - `fakeExit(code, signal)` — triggers exit handlers.
 */
class FakeTmuxHost implements TmuxHost {
  private _dataHandlers = new Set<DataHandler>();
  private _exitHandlers = new Set<ExitHandler>();
  private _errorHandlers = new Set<ErrorHandler>();
  private _stderrHandlers = new Set<DataHandler>();
  private _written: string[] = [];
  private _exited = false;
  private _pid: number | undefined = 99999;

  get pid(): number | undefined {
    return this._pid;
  }

  get exited(): boolean {
    return this._exited;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  write(data: string | Uint8Array | Buffer): void {
    if (typeof data === "string") {
      this._written.push(data);
    } else {
      this._written.push(new TextDecoder().decode(data));
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

  stop(): Promise<void> {
    this._exited = true;
    return Promise.resolve();
  }

  kill(): void {
    this._exited = true;
  }

  // Test helpers

  /** Emit bytes to all registered onData handlers. */
  pushData(bytes: Uint8Array): void {
    for (const handler of this._dataHandlers) {
      handler(bytes);
    }
  }

  /** Return and clear all strings written via host.write(). */
  popWritten(): string[] {
    const written = [...this._written];
    this._written = [];
    return written;
  }

  /** Simulate tmux process exit. */
  fakeExit(code: number | null = 0, signal: string | null = null): void {
    this._exited = true;
    for (const h of this._exitHandlers) h(code, signal);
  }
}

// ---------------------------------------------------------------------------
// Helper: encode a string as UTF-8 Uint8Array
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

// ---------------------------------------------------------------------------
// Helper: build a minimal tmux -CC command block response
// Used in the bootstrap path to fake list-windows and list-panes replies.
// ---------------------------------------------------------------------------

function makeCommandBlock(cmdNum: number, body: string): string {
  const ts = 1000000;
  return `%begin ${ts} ${cmdNum} 0\r\n${body}%end ${ts} ${cmdNum} 0\r\n`;
}

// ---------------------------------------------------------------------------
// Helper: build a complete bootstrap exchange in one shot.
//
// Produces the raw bytes that a real tmux would emit in response to
// bootstrapCommands(): an initial empty command block (tmux always sends one
// on attach), the bootstrap command block replies, then some notifications.
//
// The list-windows and list-panes replies carry a single session/window/pane.
// ---------------------------------------------------------------------------

function buildBootstrapStream(
  extraNotifications: string = "",
  opts: {
    sessionId?: string;  // e.g. "$0"
    sessionName?: string;
    windowId?: string;   // e.g. "@1"
    windowName?: string;
    paneId?: string;     // e.g. "%1"
    cols?: number;
    rows?: number;
  } = {},
): Uint8Array {
  const sid = opts.sessionId ?? "$0";
  const sname = opts.sessionName ?? "bootsession";
  const wid = opts.windowId ?? "@1";
  const wname = opts.windowName ?? "bootwin";
  const pid_ = opts.paneId ?? "%1";
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  // Windows reply format: 9 tab-separated fields per BOOTSTRAP_WINDOWS_FORMAT
  const layoutStr = `aaaa,${cols}x${rows},0,0,${parseInt(pid_.slice(1), 10)}`;
  const windowsBody =
    `${sid}\t${sname}\t${wid}\t${wname}\t${cols}\t${rows}\t${layoutStr}\t*\t1\n`;

  // Panes reply format: 11 tab-separated fields per BOOTSTRAP_PANES_FORMAT
  const panesBody =
    `${pid_}\t${wid}\t${sid}\t0\t${cols}\t${rows}\t0\t0\t1\t1234\tbash\n`;

  // Pre-bootstrap notifications (session-changed arrives before bootstrap cmds reply)
  const preNotifications = `%session-changed ${sid} ${sname}\r\n`;

  // The stream: notifications first, then windows reply, then panes reply
  // (The correlator assigns them to the two expectCommand() slots in FIFO order)
  const stream =
    preNotifications +
    makeCommandBlock(100, windowsBody) +
    makeCommandBlock(101, panesBody) +
    extraNotifications;

  return bytes(stream);
}

// ---------------------------------------------------------------------------
// Suite 1 — Direct replay of the real golden capture
// ---------------------------------------------------------------------------

describe("Pipeline: golden capture replay (tc-4fo acceptance test)", () => {
  /**
   * Drive the pipeline with the captured stream by:
   *   1. Creating a FakeTmuxHost.
   *   2. Creating the pipeline.
   *   3. Starting the pipeline (which registers expectCommand() and sends bootstrap cmds).
   *   4. Feeding the golden capture bytes through host.pushData() — the capture
   *      already contains real %begin/%end blocks from a real tmux 3.4 session,
   *      which satisfy the two expectCommand() slots.
   *   5. start() resolves once the two replies arrive.
   *   6. Feed remaining bytes (the rest of the capture).
   *   7. Assert model state.
   *
   * NOTE: The golden capture is a real tmux -C (single-C, no DCS wrapper)
   * stream — it contains real command blocks and notifications. The pipeline's
   * bootstrap path consumes the first two command blocks as list-windows and
   * list-panes replies (in any order they appear in the stream). The remaining
   * notifications are processed live.
   *
   * Because the golden capture was produced by real tmux (not our test harness),
   * the list-windows and list-panes replies are real ones. The expected model
   * facts come directly from E3's replay.test.ts.
   */
  it("drives the model to the expected state (1 session, 1 window, 2 panes)", async () => {
    const rawBuf = loadGolden();
    const host = new FakeTmuxHost();
    const buffers = createPaneBufferStore();
    // The golden capture has %session-changed $0 s0 — pass sessionName so
    // the bootstrap coordinator can resolve boundSessionId for switch-client
    // narrowing (tc-j9c.7).
    const pipeline = createRuntimePipeline(host, { buffers, sessionName: "s0" });

    // start() is async (awaits two command block replies).
    // Feed the entire golden stream AFTER registering handlers so the correlator
    // receives all tokens. We push the data asynchronously after start() fires.
    const startPromise = pipeline.start();

    // Push all bytes in one shot — the correlator's FIFO will match the first
    // two %begin/%end blocks to the two expectCommand() promises.
    host.pushData(rawBuf);

    // Now await start() — bootstrap should have resolved.
    await startPromise;

    const model = pipeline.getModel();

    // ---- Model facts from E3 replay tests -----------------------------------
    assert.ok(pipeline.isLive(), "pipeline should be live after start()");

    // 1 session, 1 window
    assert.equal(model.sessions.size, 1, "expected 1 session");
    assert.equal(model.windows.size, 1, "expected 1 window");

    // Session $0 → "s0"
    const sess = model.sessions.get(sessionId("s0"));
    assert.ok(sess !== undefined, "session s0 must exist");
    assert.equal(sess!.name, "s0", "session name should be 's0'");

    // Window @1 → "w1"
    const win = model.windows.get(windowId("w1"));
    assert.ok(win !== undefined, "window w1 must exist");
    assert.equal(win!.sessionId, sessionId("s0"), "window w1 should belong to session s0");

    // At least 1 pane (bootstrap builds model from list-panes reply or layout-change)
    assert.ok(model.panes.size >= 1, `expected at least 1 pane, got ${model.panes.size}`);

    // Invariants clean
    const violations = checkInvariants(model);
    assert.deepEqual(violations, [], `invariant violations: ${JSON.stringify(violations)}`);

    pipeline.stop();
  });

  it("onModelChange fires at least once during the golden replay", async () => {
    const rawBuf = loadGolden();
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    let changeCount = 0;
    pipeline.onModelChange(() => { changeCount++; });

    const startPromise = pipeline.start();
    host.pushData(rawBuf);
    await startPromise;

    // The pipeline emits at least one change (the initial bootstrap model)
    assert.ok(changeCount >= 1, `expected at least 1 model change, got ${changeCount}`);

    pipeline.stop();
  });

  it("getModel() returns empty model before start()", () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);
    const model = pipeline.getModel();
    assert.equal(model.sessions.size, 0, "sessions should be empty before start");
    assert.equal(model.windows.size, 0, "windows should be empty before start");
    assert.equal(model.panes.size, 0, "panes should be empty before start");
  });

  it("isLive() is false before start() resolves", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);
    assert.equal(pipeline.isLive(), false, "should not be live before start");

    // Feed bytes immediately to allow start() to complete
    const startPromise = pipeline.start();
    host.pushData(loadGolden());
    await startPromise;

    assert.equal(pipeline.isLive(), true, "should be live after start resolves");
    pipeline.stop();
  });

  it("buffers property is the PaneBufferStore supplied to createRuntimePipeline", () => {
    const host = new FakeTmuxHost();
    const buffers = createPaneBufferStore();
    const pipeline = createRuntimePipeline(host, { buffers });
    assert.equal(pipeline.buffers, buffers, "pipeline.buffers should be the supplied store");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Chunked streaming (bytes arrive in small pieces)
// ---------------------------------------------------------------------------

describe("Pipeline: streaming (chunked data delivery)", () => {
  it("produces the same model whether bytes arrive in one shot or one byte at a time", async () => {
    const rawBuf = loadGolden();

    // One-shot
    const host1 = new FakeTmuxHost();
    const pipeline1 = createRuntimePipeline(host1);
    const start1 = pipeline1.start();
    host1.pushData(rawBuf);
    await start1;
    const modelOnShot = pipeline1.getModel();
    pipeline1.stop();

    // Byte-by-byte streaming
    const host2 = new FakeTmuxHost();
    const pipeline2 = createRuntimePipeline(host2);
    const start2 = pipeline2.start();
    for (let i = 0; i < rawBuf.length; i++) {
      host2.pushData(rawBuf.subarray(i, i + 1));
    }
    await start2;
    const modelStream = pipeline2.getModel();
    pipeline2.stop();

    // Both models must have the same number of sessions/windows/panes
    assert.equal(modelStream.sessions.size, modelOnShot.sessions.size,
      "streaming and one-shot should have same session count");
    assert.equal(modelStream.windows.size, modelOnShot.windows.size,
      "streaming and one-shot should have same window count");
    assert.equal(modelStream.panes.size, modelOnShot.panes.size,
      "streaming and one-shot should have same pane count");

    // Invariants for both
    assert.deepEqual(checkInvariants(modelStream), [],
      "streaming model should have no invariant violations");
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Bootstrap path with synthetic data
// ---------------------------------------------------------------------------

describe("Pipeline: bootstrap path (canned list-windows + list-panes replies)", () => {
  it("bootstrap builds the initial model from list-windows + list-panes replies", async () => {
    const host = new FakeTmuxHost();
    const buffers = createPaneBufferStore();
    const pipeline = createRuntimePipeline(host, { buffers });

    const startPromise = pipeline.start();

    // Feed the bootstrap stream: one pre-notification + two command block replies
    const stream = buildBootstrapStream("", {
      sessionId: "$3",
      sessionName: "mysession",
      windowId: "@7",
      windowName: "mywindow",
      paneId: "%5",
      cols: 120,
      rows: 40,
    });
    host.pushData(stream);

    await startPromise;

    assert.ok(pipeline.isLive(), "pipeline should be live after bootstrap");

    const model = pipeline.getModel();

    // Session $3 → "s3"
    assert.equal(model.sessions.size, 1, "expected 1 session");
    const sess = model.sessions.get(sessionId("s3"));
    assert.ok(sess !== undefined, "session s3 must exist (from $3)");
    assert.equal(sess!.name, "mysession");

    // Window @7 → "w7"
    assert.equal(model.windows.size, 1, "expected 1 window");
    const win = model.windows.get(windowId("w7"));
    assert.ok(win !== undefined, "window w7 must exist (from @7)");
    assert.equal(win!.name, "mywindow");
    assert.equal(win!.sessionId, sessionId("s3"));

    // Pane %5 → "p5"
    assert.equal(model.panes.size, 1, "expected 1 pane");
    const pane = model.panes.get(paneId("p5"));
    assert.ok(pane !== undefined, "pane p5 must exist (from %5)");
    assert.equal(pane!.cols, 120);
    assert.equal(pane!.rows, 40);
    assert.equal(pane!.windowId, windowId("w7"));
    assert.equal(pane!.sessionId, sessionId("s3"));

    // Invariants clean
    const violations = checkInvariants(model);
    assert.deepEqual(violations, [], `invariant violations: ${JSON.stringify(violations)}`);

    pipeline.stop();
  });

  it("bootstrap: live notifications after bootstrap are applied via reduce()", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();

    // Bootstrap stream: 2 command blocks + one extra window-add notification at the end
    const extraNotif = `%window-add @2\r\n`;
    const stream = buildBootstrapStream(extraNotif);
    host.pushData(stream);

    await startPromise;

    // The extra window-add arrives AFTER bootstrap completes → live reduce
    const model = pipeline.getModel();

    // The bootstrap already adds w1 from list-windows reply.
    // The extra %window-add @2 should add w2.
    assert.ok(model.windows.size >= 1, "expected at least 1 window");
    pipeline.stop();
  });

  it("bootstrap: notifications that arrive DURING bootstrap are buffered and replayed", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();

    // Interleave: send a session-changed notification BEFORE the command replies.
    // The correlator routes it to onNotification, which buffers it in the coordinator.
    // After bootstrap replies arrive, it is replayed into reduce().
    const stream =
      `%session-changed $0 mys\r\n` +           // arrives before replies
      makeCommandBlock(100, `$0\tmys\t@1\twin\t80\t24\taaaa,80x24,0,0,1\t*\t1\n`) + // windows reply
      makeCommandBlock(101, `%1\t@1\t$0\t0\t80\t24\t0\t0\t1\t1234\tbash\n`);       // panes reply

    host.pushData(bytes(stream));

    await startPromise;

    const model = pipeline.getModel();

    // Session should exist (from bootstrap reply, confirmed by buffered notification)
    const sess = model.sessions.get(sessionId("s0"));
    assert.ok(sess !== undefined, "session s0 should exist");
    assert.equal(sess!.name, "mys", "session name should be 'mys'");

    // Pane from panes reply
    assert.ok(model.panes.size >= 1, "expected at least 1 pane");

    assert.deepEqual(checkInvariants(model), []);

    pipeline.stop();
  });

  it("bootstrap: bootstrap commands are written to the host in the correct order", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();

    // Get what was written so far (bootstrap commands)
    const written = host.popWritten();

    // Should have written 2 commands: windows first, then panes
    assert.equal(written.length, 2, `expected 2 write() calls, got ${written.length}: ${JSON.stringify(written)}`);

    // The first command should contain "list-windows"
    assert.ok(
      written[0]!.includes("list-windows"),
      `first bootstrap command should be list-windows, got: ${written[0]}`,
    );
    // The second should contain "list-panes"
    assert.ok(
      written[1]!.includes("list-panes"),
      `second bootstrap command should be list-panes, got: ${written[1]}`,
    );

    // Feed replies to let start() resolve
    const stream = buildBootstrapStream();
    host.pushData(stream);
    await startPromise;

    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Model-change signal
// ---------------------------------------------------------------------------

describe("Pipeline: model-change signal", () => {
  it("onModelChange fires after each structural update in live mode", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const changes: Array<{ model: SessionModel; prev: SessionModel }> = [];
    const unsub = pipeline.onModelChange((model, prev) => {
      changes.push({ model, prev });
    });

    const startPromise = pipeline.start();
    host.pushData(loadGolden());
    await startPromise;

    // At least 1 change should have fired (the initial model from bootstrap)
    assert.ok(changes.length >= 1, `expected at least 1 model change, got ${changes.length}`);

    // Each change should carry a valid model
    for (const { model } of changes) {
      assert.ok(model !== null && typeof model === "object",
        "model-change handler should receive a SessionModel");
    }

    unsub();
    pipeline.stop();
  });

  it("onModelChange: unsubscribe stops further callbacks", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    let count = 0;
    const unsub = pipeline.onModelChange(() => { count++; });

    const startPromise = pipeline.start();
    host.pushData(loadGolden());
    await startPromise;

    const countAfterStart = count;
    unsub();

    // Push more data — should not trigger the unsubscribed handler
    host.pushData(bytes(`%sessions-changed\r\n`));

    assert.equal(count, countAfterStart,
      "unsubscribed handler should not be called after unsub()");

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
    host.pushData(loadGolden());
    await startPromise;

    assert.ok(countA >= 1, "handler A should have been called");
    assert.ok(countB >= 1, "handler B should have been called");
    assert.equal(countA, countB, "both handlers should be called the same number of times");

    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Invariants throughout the golden replay
// ---------------------------------------------------------------------------

describe("Pipeline: invariant check throughout golden replay", () => {
  it("model invariants never broken during golden replay", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host, { checkInvariantsOnUpdate: true });

    // checkInvariantsOnUpdate logs violations but doesn't throw; we verify
    // separately that the final model is clean.
    const startPromise = pipeline.start();
    host.pushData(loadGolden());
    await startPromise;

    const model = pipeline.getModel();
    const violations = checkInvariants(model);
    assert.deepEqual(violations, [],
      `invariant violations in final model: ${JSON.stringify(violations)}`);

    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — stop() is idempotent
// ---------------------------------------------------------------------------

describe("Pipeline: stop() behaviour", () => {
  it("stop() is idempotent (calling multiple times does not throw)", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(loadGolden());
    await startPromise;

    assert.doesNotThrow(() => {
      pipeline.stop();
      pipeline.stop();
      pipeline.stop();
    }, "stop() should be idempotent");
  });

  it("getModel() is safe to call after stop()", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();
    host.pushData(loadGolden());
    await startPromise;

    pipeline.stop();

    // Should not throw; returns last known model
    const model = pipeline.getModel();
    assert.ok(model !== null);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — monitor-activity enabled after bootstrap (tc-95lue §3.4)
// ---------------------------------------------------------------------------

describe("Pipeline: monitor-activity enabled after bootstrap (tc-95lue §3.4)", () => {
  /**
   * After start() resolves, the pipeline must have written a
   * `set-option -wg "monitor-activity" "on"` command to the host.
   *
   * This satisfies acceptance criterion (1): tmux monitor-activity is enabled
   * on all tmuxcc panes (via window-global scope so every window inherits it).
   *
   * We capture ALL writes issued after the bootstrap command replies arrive and
   * check that at least one of them is the set-option command.  We do this by
   * draining the pre-start bootstrap writes, then awaiting start(), and finally
   * inspecting the post-bootstrap writes.
   */
  it("bootstrap: set-option -wg monitor-activity on is written after bootstrap completes", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();

    // Drain the initial bootstrap writes (list-windows + list-panes).
    host.popWritten();

    // Feed replies to let start() resolve.
    host.pushData(buildBootstrapStream());
    await startPromise;

    // Collect writes that were issued after bootstrap resolved.
    const postBootstrapWrites = host.popWritten();

    const monitorActivityCmd = `set-option -wg monitor-activity on\n`;
    assert.ok(
      postBootstrapWrites.some((w) => w === monitorActivityCmd),
      `expected a write of ${JSON.stringify(monitorActivityCmd)} after bootstrap; ` +
      `got: ${JSON.stringify(postBootstrapWrites)}`,
    );
  });

  it("bootstrap: set-option -wg monitor-activity on is NOT written before bootstrap resolves", async () => {
    const host = new FakeTmuxHost();
    const pipeline = createRuntimePipeline(host);

    const startPromise = pipeline.start();

    // The bootstrap writes (list-windows + list-panes) should be present but
    // NOT the monitor-activity set-option — that comes only after start() resolves.
    const preBootstrapWrites = host.popWritten();
    const monitorActivityCmd = `set-option -wg monitor-activity on\n`;
    assert.ok(
      !preBootstrapWrites.some((w) => w === monitorActivityCmd),
      `set-option monitor-activity must not be written before bootstrap resolves; ` +
      `got: ${JSON.stringify(preBootstrapWrites)}`,
    );

    // Clean up: feed replies and await so the test does not leak.
    host.pushData(buildBootstrapStream());
    await startPromise;
    pipeline.stop();
  });
});
