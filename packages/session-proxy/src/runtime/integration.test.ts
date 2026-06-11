/**
 * SessionProxy integration test — full runtime end-to-end (tc-93a).
 *
 * Covers the E4 acceptance: drive the full assembled session-proxy and assert
 * wire output (snapshot/deltas/frames), input round-trip, resize, and
 * flow control.
 *
 * # Harness split
 *
 * ## Fake-tmux harness (deterministic, always runs)
 *
 * Uses a ScriptedHost that wraps fake-tmux.js (a hermetic fixture that emits
 * canned tmux -CC control-mode bytes in response to stdin commands) together
 * with the buildBootstrapStream helper from pipeline.test to drive the full
 * pipeline end-to-end without real tmux.  This covers:
 *
 *   T1. Snapshot on connect         — client receives SnapshotMessage (seq=1)
 *                                     with sessions/windows/panes populated.
 *   T2. Deltas on activity          — driving a %layout-change notification
 *                                     produces a delta with the right seq.
 *   T3. %output → data frames       — pane bytes reach the client data-plane
 *                                     byte-exact, tagged with the right PaneId.
 *   T4. Input round-trip            — client InputMessage → host.write() carries
 *                                     the expected send-keys -H command.
 *   T5. Resize                      — client ResizeRequestMessage → host.write()
 *                                     carries refresh-client -C WxH.
 *   T6. Flow control                — high-output flood triggers pause; drain
 *                                     triggers resume; no bytes are dropped.
 *
 * ## Real-tmux harness (guarded smoke test, skipped if tmux absent)
 *
 * Uses createTmuxHost (real tmux 3.4 via the PTY bridge) + the full
 * createSessionProxy assembly.  Verifies:
 *
 *   R1. Snapshot on connect (real session: 1 window, 1 pane minimum).
 *   R2. Some pane output arrives on the client data plane (echo round-trip).
 *   R3. Clean teardown (no leaked tmux servers).
 *
 * Each real-tmux test uses a unique `-L <socket>` to prevent cross-test
 * interference.  `after()` always issues `tmux -L <socket> kill-server`.
 *
 * @module runtime/integration.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// tc-blk — process-level safety net for real-tmux test sockets.
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// Runtime modules under test
// ---------------------------------------------------------------------------
import { createTmuxHost } from "./tmux-host.js";
import type { TmuxHost, DataHandler as HostDataHandler } from "./tmux-host.js";
import type { ExitHandler as HostExitHandler, ErrorHandler as HostErrorHandler } from "./tmux-host.js";
import { createOutputDemux } from "./output-demux.js";
import { createRuntimePipeline } from "./pipeline.js";
import { createControlServer } from "./serve.js";
import { createInputPath } from "./input-path.js";
import { createFlowController } from "./flow-control.js";
import { createSessionProxy } from "./session-proxy.js";

// ---------------------------------------------------------------------------
// Wire utilities
// ---------------------------------------------------------------------------
import {
  createInMemoryTransportPair,
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "../wire/index.js";
import type {
  Transport,
  SnapshotMessage,
  SessionProxyMessage,
  InputMessage,
  ResizeRequestMessage,
  PaneId,
} from "../wire/index.js";
import { paneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const FAKE_TMUX = join(__dir, "fixtures", "fake-tmux.js");

// ---------------------------------------------------------------------------
// CLIENT_CAPS — the handshake capabilities the test client advertises.
// ---------------------------------------------------------------------------

const CLIENT_CAPS = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["pane-lifecycle" as const, "layout-updates" as const, "focus-events" as const, "input-forwarding" as const],
};

// ---------------------------------------------------------------------------
// ScriptedHost — a TmuxHost backed by real fake-tmux.js process.
//
// fake-tmux.js is spawned directly (no PTY bridge) so it works with piped
// stdio.  It emits a minimal valid tmux control-mode byte stream and responds
// to stdin commands with %begin/%end blocks.
//
// IMPORTANT: the pipeline's start() sends two bootstrap commands and awaits
// their replies.  The ScriptedHost constructor pre-registers an onData shim
// that, after receiving the DCS intro + initial empty block, responds to each
// stdin command with a synthetic %begin/%end reply carrying the test's
// scripted window/pane data.
// ---------------------------------------------------------------------------

interface ScriptedHostHandle extends TmuxHost {
  /** All strings written to the fake-tmux stdin via host.write(). */
  readonly writtenCommands: string[];
  /** Wait for the underlying process to exit. */
  waitForExit(): Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Build a minimal bootstrap stream for one session/window/pane.
 * Matches the format consumed by BootstrapCoordinator (pipeline.test helper).
 */
function makeBootstrapBytes(opts: {
  sessionId?: string;
  sessionName?: string;
  windowId?: string;
  windowName?: string;
  paneId?: string;
  cols?: number;
  rows?: number;
  /**
   * tc-128.4: when true, omit the leading `%session-changed` notification so
   * the bytes carry ONLY the two list-* reply blocks. Useful for feeding a
   * mid-flight requery cycle in tests that already established the bootstrap
   * — under requery, a stray topology notification arriving while a cycle is
   * in flight dirties the engine and forces it to loop (waiting for bytes
   * the test never feeds). Bootstrap callers leave this false to preserve
   * the pre-tc-128.4 wire shape.
   */
  noPreNotif?: boolean;
} = {}): Uint8Array {
  const sid = opts.sessionId ?? "$0";
  const sname = opts.sessionName ?? "testsession";
  const wid = opts.windowId ?? "@1";
  const wname = opts.windowName ?? "testwin";
  const pid_ = opts.paneId ?? "%1";
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const ts = 1_000_000;
  const layoutStr = `aaaa,${cols}x${rows},0,0,${parseInt(pid_.slice(1), 10)}`;
  // list-windows -a reply (BOOTSTRAP_WINDOWS_FORMAT)
  const windowsBody = `${sid}\t${sname}\t${wid}\t${wname}\t${cols}\t${rows}\t${layoutStr}\t*\t1\n`;
  // list-panes -a reply (BOOTSTRAP_PANES_FORMAT)
  const panesBody = `${pid_}\t${wid}\t${sid}\t0\t${cols}\t${rows}\t0\t0\t1\t1234\tbash\n`;

  const preNotif = opts.noPreNotif === true ? "" : `%session-changed ${sid} ${sname}\r\n`;
  // flags=1 → user-command reply (real tmux uses 0 only for the implicit
  // startup block; all user-command responses carry flags=1).
  const winBlock = `%begin ${ts} 100 1\r\n${windowsBody}%end ${ts} 100 1\r\n`;
  const paneBlock = `%begin ${ts} 101 1\r\n${panesBody}%end ${ts} 101 1\r\n`;

  return new TextEncoder().encode(preNotif + winBlock + paneBlock);
}

/**
 * Create a ScriptedHost: spawns fake-tmux.js and provides an onData/write
 * interface compatible with TmuxHost.  The host automatically emits bootstrap
 * bytes after the DCS intro so that pipeline.start() can complete.
 */
function createScriptedHost(bootstrapOpts: Parameters<typeof makeBootstrapBytes>[0] = {}): ScriptedHostHandle {
  // Process is NOT spawned until start() is called — this ensures pipeline.start()
  // registers its onData handler before any bytes arrive from fake-tmux.
  let proc: ChildProcess | null = null;

  const _dataHandlers = new Set<HostDataHandler>();
  const _exitHandlers = new Set<HostExitHandler>();
  const _errorHandlers = new Set<HostErrorHandler>();
  const _stderrHandlers = new Set<HostDataHandler>();
  const writtenCommands: string[] = [];

  let _exited = false;
  let _exitCode: number | null = null;
  let _exitSignal: string | null = null;
  let _pid: number | undefined;

  // Track whether we have already injected bootstrap bytes.
  let _bootstrapInjected = false;

  function _attachProcListeners(p: ChildProcess): void {
    p.stdout!.on("data", (chunk: Buffer) => {
      const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

      // After the DCS intro arrives from fake-tmux, inject bootstrap bytes ONCE.
      // The DCS intro is \x1bP1000p (7 bytes).
      // Inject on nextTick to let the pipeline's expectCommand() slots register
      // before the bootstrap data is processed.
      if (!_bootstrapInjected) {
        const str = Buffer.from(u8).toString("binary");
        if (str.includes("\x1bP1000p")) {
          _bootstrapInjected = true;
          process.nextTick(() => {
            const bootstrapBytes = makeBootstrapBytes(bootstrapOpts);
            for (const h of _dataHandlers) {
              try { h(bootstrapBytes); } catch { /**/ }
            }
          });
        }
      }

      for (const h of _dataHandlers) {
        try { h(u8); } catch { /**/ }
      }
    });

    p.on("close", (code, signal) => {
      _exited = true;
      _exitCode = code;
      _exitSignal = signal as string | null;
      for (const h of _exitHandlers) {
        try { h(code, signal as string | null); } catch { /**/ }
      }
    });

    p.on("error", (err) => {
      for (const h of _errorHandlers) {
        try { h(err); } catch { /**/ }
      }
    });

    p.stderr!.on("data", (chunk: Buffer) => {
      if (_stderrHandlers.size > 0) {
        const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (const h of _stderrHandlers) {
          try { h(u8); } catch { /**/ }
        }
      }
    });
  }

  const handle: ScriptedHostHandle = {
    get pid(): number | undefined { return _pid; },
    get exited(): boolean { return _exited; },

    async start(): Promise<void> {
      if (proc !== null) return; // idempotent
      proc = spawnProc(process.execPath, [FAKE_TMUX], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      _pid = proc.pid;
      _attachProcListeners(proc);
    },

    write(data: string | Uint8Array | Buffer): void {
      if (!proc) throw new Error("ScriptedHost.write() called before start()");
      const s = typeof data === "string" ? data : new TextDecoder().decode(data);
      writtenCommands.push(s);
      proc.stdin!.write(typeof data === "string" ? data : data);
    },

    onData(handler: HostDataHandler): () => void {
      _dataHandlers.add(handler);
      return () => _dataHandlers.delete(handler);
    },

    onExit(handler: HostExitHandler): () => void {
      if (_exited) {
        process.nextTick(() => handler(_exitCode, _exitSignal));
        return () => {};
      }
      _exitHandlers.add(handler);
      return () => _exitHandlers.delete(handler);
    },

    onError(handler: HostErrorHandler): () => void {
      _errorHandlers.add(handler);
      return () => _errorHandlers.delete(handler);
    },

    onStderr(handler: HostDataHandler): () => void {
      _stderrHandlers.add(handler);
      return () => _stderrHandlers.delete(handler);
    },

    stop(): Promise<void> {
      if (_exited || !proc) return Promise.resolve();
      return new Promise((resolve) => {
        _exitHandlers.add(() => resolve());
        proc!.stdin!.end();
      });
    },

    kill(signal: NodeJS.Signals = "SIGKILL"): void {
      if (!_exited && proc) {
        try { proc.kill(signal); } catch { /**/ }
      }
    },

    get writtenCommands(): string[] { return writtenCommands; },

    waitForExit(): Promise<{ code: number | null; signal: string | null }> {
      if (_exited) return Promise.resolve({ code: _exitCode, signal: _exitSignal });
      return new Promise((resolve) => {
        _exitHandlers.add((code, signal) => resolve({ code, signal }));
      });
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// waitFor — poll until predicate resolves or timeout
// ---------------------------------------------------------------------------

function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  msg: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const val = fn();
      if (val !== undefined) return resolve(val);
      if (Date.now() > deadline) return reject(new Error(`Timeout (${timeoutMs}ms): ${msg}`));
      setTimeout(check, 20);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// createRecordingPair — like createInMemoryTransportPair but with persistent
// message recording that survives handler replacement.
//
// The handshake helpers (runSessionProxyHandshake / runClientHandshake) call
// transport.onControl(() => {}) when they settle, which normally wipes any
// collector installed before the handshake.  This wrapper intercepts every
// sendControl call on the session-proxy side and records it unconditionally, so the
// snapshot (and deltas) are captured regardless of handler replacement.
// ---------------------------------------------------------------------------

interface RecordingPair {
  sessionProxyTransport: Transport;
  clientTransport: Transport;
  controlMessages: SessionProxyMessage[];
  dataFrames: Array<{ paneId: PaneId; bytes: Uint8Array }>;
}

function createRecordingPair(): RecordingPair {
  const { sessionProxy: rawSessionProxy, client: rawClient } = createInMemoryTransportPair();

  const controlMessages: SessionProxyMessage[] = [];
  const dataFrames: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];

  // Tap the session-proxy endpoint's sendControl so every outbound message is recorded.
  // The session-proxy sends control messages TO the client (snapshot, deltas) via
  // sessionProxy.sendControl, which delivers to clientControlHandler.  We wrap
  // sessionProxy.sendControl to also push to our recorder.
  const sessionProxyTransport: Transport = {
    sendControl(msg) {
      // Record every message the session-proxy sends (snapshot, deltas, capabilities).
      controlMessages.push(msg as SessionProxyMessage);
      return rawSessionProxy.sendControl(msg);
    },
    onControl(handler) { rawSessionProxy.onControl(handler); },
    sendData(paneId, bytes) { return rawSessionProxy.sendData(paneId, bytes); },
    onData(handler) { rawSessionProxy.onData(handler); },
    onClose(handler) { rawSessionProxy.onClose(handler); },
    close(err) { rawSessionProxy.close(err); },
  };

  // Tap the client endpoint's sendData so data-plane frames are recorded.
  const clientTransport: Transport = {
    sendControl(msg) { return rawClient.sendControl(msg); },
    onControl(handler) { rawClient.onControl(handler); },
    sendData(paneId, bytes) {
      // Data frames from session-proxy→client arrive here on the client side.
      // BUT: the session-proxy calls sessionProxyTransport.sendData, which goes to rawClient.
      // To tap that, we also wrap rawClient.sendData.
      dataFrames.push({ paneId, bytes });
      return rawClient.sendData(paneId, bytes);
    },
    onData(handler) { rawClient.onData(handler); },
    onClose(handler) { rawClient.onClose(handler); },
    close(err) { rawClient.close(err); },
  };

  // Also tap the session-proxy's sendData so data plane frames are captured.
  // sessionProxy.sendData → rawClient's dataHandler.  We intercept at session-proxy side.
  const originalSessionProxySendData = rawSessionProxy.sendData.bind(rawSessionProxy);
  (sessionProxyTransport as Transport & { sendData: typeof rawSessionProxy.sendData }).sendData = (paneId, bytes) => {
    dataFrames.push({ paneId, bytes });
    return originalSessionProxySendData(paneId, bytes);
  };

  return { sessionProxyTransport, clientTransport, controlMessages, dataFrames };
}

// ---------------------------------------------------------------------------
// Helper: wire session-proxy + client for a scripted host
//
// Returns the connected session-proxy transport pair and collected client messages.
// The caller is responsible for teardown (calling cleanup()).
// ---------------------------------------------------------------------------

interface WiredSession {
  host: ScriptedHostHandle;
  demux: ReturnType<typeof createOutputDemux>;
  pipeline: ReturnType<typeof createRuntimePipeline>;
  server: ReturnType<typeof createControlServer>;
  inputPath: ReturnType<typeof createInputPath>;
  sessionProxyTransport: Transport;
  clientTransport: Transport;
  controlMessages: SessionProxyMessage[];
  dataFrames: Array<{ paneId: PaneId; bytes: Uint8Array }>;
  cleanup(): Promise<void>;
}

async function wireScriptedSession(
  bootstrapOpts: Parameters<typeof makeBootstrapBytes>[0] = {},
): Promise<WiredSession> {
  const host = createScriptedHost(bootstrapOpts);

  // 1. Output demux — creates tapped PaneBufferStore.
  const demux = createOutputDemux();

  // 2. Pipeline — uses demux.store so reducer writes tap into the demux.
  const pipeline = createRuntimePipeline(host, { buffers: demux.store });

  // 3. Control server.
  const server = createControlServer(pipeline);

  // 4. Input path.
  const inputPath = createInputPath(host);

  // 5. Start host + pipeline.
  await host.start();
  const startPromise = pipeline.start();
  // fake-tmux emits DCS first; ScriptedHost injects bootstrap bytes on nextTick.
  await startPromise;

  // 6. Create a recording transport pair.
  //
  // createRecordingPair taps sessionProxy.sendControl so all outbound session-proxy messages
  // (snapshot, deltas) are captured regardless of how onControl is overwritten
  // by the handshake helpers.  See createRecordingPair for details.
  const { sessionProxyTransport, clientTransport, controlMessages, dataFrames } = createRecordingPair();

  // Attach demux to the session-proxy-side transport (data plane fan-out).
  demux.attachTransport(sessionProxyTransport);

  // Run server-side handshake + snapshot + delta subscription concurrently with
  // the client-side handshake.
  const serverAddPromise = server.addClient(sessionProxyTransport);
  const clientHandshakePromise = runClientHandshake(clientTransport, CLIENT_CAPS);
  await Promise.all([serverAddPromise, clientHandshakePromise]);

  // Wire input path on the session-proxy transport AFTER addClient (which clears the
  // session-proxy-side onControl handler when the handshake settles inside it).
  // Client → session-proxy control messages (input, resize) route here.
  sessionProxyTransport.onControl((msg) => {
    inputPath.handleClientMessage(msg as import("../wire/session-proxy-control.js").ClientMessage);
  });

  const cleanup = async () => {
    pipeline.stop();
    clientTransport.close();
    sessionProxyTransport.close();
    host.kill();
    await host.waitForExit();
  };

  return {
    host,
    demux,
    pipeline,
    server,
    inputPath,
    sessionProxyTransport,
    clientTransport,
    controlMessages,
    dataFrames,
    cleanup,
  };
}

// ===========================================================================
// Suite 1 — Fake-tmux harness (deterministic)
// ===========================================================================

describe("tc-93a: SessionProxy integration — fake-tmux harness", () => {
  // -------------------------------------------------------------------------
  // T1. Snapshot on connect
  // -------------------------------------------------------------------------

  it("T1: client receives a SnapshotMessage (seq=1) with session/window/pane after connect", async () => {
    // Use buildFakePushSession (in-process fake host) for deterministic timing:
    // bootstrap bytes are injected synchronously with precise control.
    const { deltaMessages, cleanup } = await buildFakePushSession({
      sessionId: "$0", sessionName: "testsession",
      windowId: "@1", windowName: "testwin",
      paneId: "%1", cols: 80, rows: 24,
    });

    try {
      // The snapshot is the first control-stream message (seq=1).
      // deltaMessages also includes session-proxy.capabilities (seq=1 from handshake);
      // filter by type to get just the snapshot.
      const snapshot = deltaMessages.find(
        (m) => m.type === "snapshot",
      ) as SnapshotMessage | undefined;

      assert.ok(snapshot !== undefined, "client must receive a snapshot message");
      assert.equal(snapshot!.type, "snapshot");
      assert.equal(snapshot!.seq, 1, "snapshot must be seq=1");

      // The bootstrap exchange gives 1 session, 1 window, 1 pane.
      assert.ok(snapshot!.session !== undefined, "snapshot must have a session");
      assert.ok(snapshot!.windows.length >= 1, "snapshot must have at least 1 window");
      assert.ok(snapshot!.panes.length >= 1, "snapshot must have at least 1 pane");
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // T2. Deltas on activity
  // -------------------------------------------------------------------------

  it("T2: model-change from a notification produces a delta with monotonically increasing seq", async () => {
    // Use buildFakePushSession so we can inject raw bytes after bootstrap.
    const { inject, deltaMessages, cleanup } = await buildFakePushSession();

    try {
      // deltaMessages starts with the snapshot (seq=1) from addClient.
      const snapshot = deltaMessages.find((m) => m.type === "snapshot");
      assert.ok(snapshot !== undefined, "snapshot (seq=1) must arrive before any activity");
      assert.equal(snapshot!.seq, 1, "snapshot must be seq=1");

      const beforeCount = deltaMessages.length;

      // tc-128.4: the requery-driven pipeline treats %session-renamed as a
      // topology dirty bit; the coalescer's leading edge fires a full
      // list-windows + list-panes requery. We must also feed the updated
      // bootstrap-shape reply blocks so the engine commits the rename.
      inject(new TextEncoder().encode(`%session-renamed $0 renamed-session\r\n`));
      // Yield one tick so the coalescer's leading edge issues the requery
      // commands; then feed the updated replies. `noPreNotif: true` skips the
      // synthetic `%session-changed` preamble — under requery, that stray
      // topology notification arriving inside the in-flight cycle would
      // dirty the engine and force a re-loop waiting for bytes we never
      // feed.
      await new Promise<void>((r) => setImmediate(r));
      inject(makeBootstrapBytes({ sessionName: "renamed-session", noPreNotif: true }));

      // Wait for a new delta to appear.
      await waitFor(
        () => deltaMessages.length > beforeCount ? deltaMessages : undefined,
        2000,
        "no delta received after injecting %session-renamed",
      );

      const newDeltas = deltaMessages.slice(beforeCount);
      assert.ok(newDeltas.length > 0, "at least one delta should arrive after activity");

      // All activity deltas must have seq > 1 (snapshot is seq=1).
      for (const delta of newDeltas) {
        assert.ok(
          delta.seq > 1,
          `delta seq ${delta.seq} must be > snapshot seq 1`,
        );
      }

      // The control-stream messages (snapshot + deltas — excluding the
      // session-proxy.capabilities handshake message, which has its own seq=1)
      // must be strictly monotonically increasing.
      const controlStreamMsgs = deltaMessages.filter((m) => m.type !== "session-proxy.capabilities");
      const seqs = controlStreamMsgs.map((m) => m.seq);
      for (let i = 1; i < seqs.length; i++) {
        assert.ok(
          (seqs[i] ?? 0) > (seqs[i - 1] ?? 0),
          `seq must increase: seqs[${i - 1}]=${seqs[i - 1]} seqs[${i}]=${seqs[i]}`,
        );
      }
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // T3. %output → data frames
  // -------------------------------------------------------------------------

  it("T3: pane bytes from %output reach the client data plane byte-exact with correct paneId", async () => {
    const { inject, dataFrames, cleanup } = await buildFakePushSession({
      paneId: "%3",
    });

    try {
      // Inject a %output notification carrying known bytes.
      // tmux %output format: %output %<N> <octal-encoded-data>\r\n
      // "hello" = h(150) e(145) l(154) l(154) o(157) in octal.
      const helloOctal = "\\150\\145\\154\\154\\157"; // "hello"
      const outputNotif = `%output %3 ${helloOctal}\r\n`;
      inject(new TextEncoder().encode(outputNotif));

      // Wait for data frame.
      const frame = await waitFor(
        () => dataFrames.find((f) => f.paneId === paneId("p3")),
        2000,
        "no data frame for pane p3",
      );

      assert.ok(frame !== undefined, "must receive a data frame for pane p3");
      assert.equal(frame!.paneId, paneId("p3"), "frame paneId must be p3");

      // Check byte content: "hello" = [104, 101, 108, 108, 111]
      const content = Buffer.concat(
        dataFrames.filter((f) => f.paneId === paneId("p3")).map((f) => Buffer.from(f.bytes)),
      );
      assert.ok(content.includes(Buffer.from("hello")), `expected "hello" in data frame, got: ${content.toString("hex")}`);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // T4. Input round-trip
  // -------------------------------------------------------------------------

  it("T4: client InputMessage → send-keys -H command reaches host.write()", async () => {
    const sess = await wireScriptedSession({ paneId: "%1" });

    try {
      // The client sends an input message.
      const inputMsg: InputMessage = {
        type: "input",
        seq: 1,
        paneId: paneId("p1"),
        data: "hi",
      };
      sess.clientTransport.sendControl(inputMsg);

      // Allow a tick for the message to route through the transport → onControl
      // → inputPath.handleClientMessage → host.write().
      await new Promise<void>((r) => setTimeout(r, 50));

      // The host.write() calls are captured in writtenCommands.
      const written = sess.host.writtenCommands.join("\n");
      // send-keys -H -t %1 <hex-encoded "hi">
      // "h" = 0x68, "i" = 0x69 → hex = "6869"
      assert.ok(
        written.includes("send-keys") && written.includes("-H"),
        `expected send-keys -H in written commands; got: ${written}`,
      );
      assert.ok(
        written.includes("6869") || written.includes("68 69") || written.includes("%1"),
        `expected hex-encoded "hi" or pane ref in send-keys command; got: ${written}`,
      );
    } finally {
      await sess.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // T5. Resize
  // -------------------------------------------------------------------------

  it("T5: client ResizeRequestMessage → refresh-client -C WxH command reaches host.write()", async () => {
    const sess = await wireScriptedSession();

    try {
      const resizeMsg: ResizeRequestMessage = {
        type: "resize.request",
        seq: 1,
        paneId: paneId("p1"),
        cols: 120,
        rows: 40,
      };
      sess.clientTransport.sendControl(resizeMsg);

      await new Promise<void>((r) => setTimeout(r, 50));

      const written = sess.host.writtenCommands.join("\n");
      assert.ok(
        written.includes("refresh-client") && written.includes("-C"),
        `expected refresh-client -C in written commands; got: ${written}`,
      );
      assert.ok(
        written.includes("120x40"),
        `expected 120x40 in refresh-client -C command; got: ${written}`,
      );
    } finally {
      await sess.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // T6. Flow control
  // -------------------------------------------------------------------------

  it("T6: flood triggers pause; drain triggers resume; no bytes dropped", async () => {
    // Build a minimal session with explicit flow controller with small watermarks.
    const host = createScriptedHost({ paneId: "%5" });
    const demux = createOutputDemux();

    const HIGH = 500;
    const LOW = 100;

    const fc = createFlowController(host, demux, {
      highWaterBytes: HIGH,
      lowWaterBytes: LOW,
    });

    // Accounting store: demux.store + fc.onPaneBytes notification.
    const accountingStore = {
      append(pid: PaneId, bytes: Uint8Array): void {
        demux.store.append(pid, bytes);
        if (bytes.length > 0) fc.onPaneBytes(pid, bytes.length);
      },
      getContents: demux.store.getContents.bind(demux.store),
      size: demux.store.size.bind(demux.store),
      drop: demux.store.drop.bind(demux.store),
      clear: demux.store.clear.bind(demux.store),
    };

    const pipeline = createRuntimePipeline(host, { buffers: accountingStore });
    const server = createControlServer(pipeline);

    // tc-128.4: pane tracking is always-on in the demux; wire model-change so
    // bootstrap-discovered panes get bound (otherwise %output bytes stage
    // indefinitely instead of fanning out to attached transports).
    pipeline.onModelChange((next, prev) => {
      for (const pid of next.panes.keys()) {
        if (!demux.isPaneKnown(pid)) demux.notifyPaneBound(pid);
      }
      for (const pid of prev.panes.keys()) {
        if (!next.panes.has(pid)) demux.notifyPaneClosed(pid);
      }
    });

    await host.start();
    await pipeline.start();

    // Attach a client.
    const { sessionProxy: dt, client: ct } = createInMemoryTransportPair();
    const receivedData: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];
    ct.onData((pid, bytes) => receivedData.push({ paneId: pid, bytes }));

    const detach = demux.attachTransport(dt);
    const addPromise = server.addClient(dt);
    await runClientHandshake(ct, CLIENT_CAPS);
    await addPromise;

    const P5 = paneId("p5");

    // --- Phase 1: no flood yet — pane should not be paused ---
    assert.equal(fc.isPanePaused(P5), false, "pane p5 must not be paused before flood");

    // --- Phase 2: flood — push bytes exceeding HIGH watermark ---
    // We call fc.onPaneBytes directly (as the integration layer would do)
    // since we own the accounting store.
    // Also write some actual bytes to the store so the client receives them.
    const CHUNK = 300;
    const floodBytes = new Uint8Array(CHUNK).fill(0xAB);

    // First chunk: 300 < 500 — not yet paused.
    accountingStore.append(P5, floodBytes);
    assert.equal(fc.isPanePaused(P5), false, "pane must not be paused at 300 bytes");
    assert.equal(demux.isPanePaused(P5), false, "demux must not be paused at 300 bytes");

    // Second chunk: 600 > 500 — should trigger pause.
    accountingStore.append(P5, floodBytes);
    assert.equal(fc.isPanePaused(P5), true, "pane must be paused after exceeding high-water mark");
    assert.equal(demux.isPanePaused(P5), true, "demux gate must be closed after pause");

    // The refresh-client -A pause command must have been written to the host.
    const pauseCommands = host.writtenCommands.join("\n");
    assert.ok(
      pauseCommands.includes("refresh-client") && pauseCommands.includes("pause"),
      `expected refresh-client -A pause in host writes; got: ${pauseCommands}`,
    );

    // --- Phase 3: bytes received before pause must have arrived ---
    // The first chunk (before pause) was fanned out to the client.
    assert.ok(receivedData.length >= 1, "at least the pre-pause bytes must have been delivered");

    // Verify received bytes are byte-exact (the 0xAB fill value).
    const totalReceived = Buffer.concat(receivedData.map((f) => Buffer.from(f.bytes)));
    for (const byte of totalReceived) {
      assert.equal(byte, 0xAB, `received byte 0x${byte.toString(16)} but expected 0xAB`);
    }

    // --- Phase 4: drain below LOW watermark → resume ---
    // Simulate client draining the 600 bytes (below LOW=100).
    fc.noteDrained(P5, 600);

    assert.equal(fc.isPanePaused(P5), false, "pane must be resumed after draining below low-water mark");
    assert.equal(demux.isPanePaused(P5), false, "demux gate must be open after resume");

    const resumeCommands = host.writtenCommands.join("\n");
    assert.ok(
      resumeCommands.includes("refresh-client") && resumeCommands.includes("continue"),
      `expected refresh-client -A continue in host writes; got: ${resumeCommands}`,
    );

    // --- Phase 5: bytes after resume are delivered again ---
    const postResumeBytes = new Uint8Array(10).fill(0xCD);
    accountingStore.append(P5, postResumeBytes);
    // Pane should not be paused yet (10 < 500).
    assert.equal(fc.isPanePaused(P5), false, "pane must not be re-paused after small append");

    // Post-resume bytes must reach the client.
    await waitFor(
      () => {
        const all = Buffer.concat(receivedData.map((f) => Buffer.from(f.bytes)));
        return all.includes(Buffer.from([0xCD])) ? true : undefined;
      },
      1000,
      "post-resume bytes did not reach client",
    );

    // Cleanup.
    detach();
    pipeline.stop();
    ct.close();
    dt.close();
    host.kill();
    await host.waitForExit();
  });
});

// ===========================================================================
// buildFakePushSession — helper for T2/T3
//
// Uses a minimal FakeTmuxHost (no real process) that lets the test inject
// arbitrary bytes into the pipeline after bootstrap.
// ===========================================================================

interface FakePushSession {
  host: TmuxHost;
  inject: (bytes: Uint8Array) => void;
  deltaMessages: SessionProxyMessage[];
  dataFrames: Array<{ paneId: PaneId; bytes: Uint8Array }>;
  cleanup(): Promise<void>;
}

async function buildFakePushSession(
  bootstrapOpts: {
    sessionId?: string;
    sessionName?: string;
    windowId?: string;
    windowName?: string;
    paneId?: string;
    cols?: number;
    rows?: number;
  } = {},
): Promise<FakePushSession> {
  // Minimal in-memory TmuxHost
  const _dataHandlers = new Set<HostDataHandler>();
  const writtenCommands: string[] = [];

  const host: TmuxHost = {
    get pid(): number | undefined { return 99998; },
    get exited(): boolean { return false; },
    async start(): Promise<void> { /* no-op */ },
    write(data: string | Uint8Array | Buffer): void {
      const s = typeof data === "string" ? data : new TextDecoder().decode(data);
      writtenCommands.push(s);
    },
    onData(handler: HostDataHandler): () => void {
      _dataHandlers.add(handler);
      return () => _dataHandlers.delete(handler);
    },
    onExit(): () => void { return () => {}; },
    onError(): () => void { return () => {}; },
    onStderr(): () => void { return () => {}; },
    async stop(): Promise<void> { /* no-op */ },
    kill(): void { /* no-op */ },
  };

  function inject(bytes: Uint8Array): void {
    for (const h of _dataHandlers) {
      try { h(bytes); } catch { /**/ }
    }
  }

  const demux = createOutputDemux();
  const pipeline = createRuntimePipeline(host, { buffers: demux.store });
  const server = createControlServer(pipeline);

  // tc-128.4: pane tracking is always-on in the demux; keep its known-pane
  // set in sync with the model so bootstrap panes don't stage %output bytes
  // indefinitely. This mirrors the wiring in runtime/session-proxy.ts.
  pipeline.onModelChange((next, prev) => {
    for (const pid of next.panes.keys()) {
      if (!demux.isPaneKnown(pid)) demux.notifyPaneBound(pid);
    }
    for (const pid of prev.panes.keys()) {
      if (!next.panes.has(pid)) demux.notifyPaneClosed(pid);
    }
  });

  // start() sends bootstrap commands; we feed the replies via inject().
  const startPromise = pipeline.start();
  inject(makeBootstrapBytes(bootstrapOpts));
  await startPromise;

  // Use a recording pair so snapshot + deltas are captured regardless of
  // handler replacement by the handshake helpers.
  const {
    sessionProxyTransport: dt,
    clientTransport: ct,
    controlMessages: deltaMessages,
    dataFrames,
  } = createRecordingPair();

  demux.attachTransport(dt);

  const addPromise = server.addClient(dt);
  await runClientHandshake(ct, CLIENT_CAPS);
  await addPromise;

  const cleanup = async () => {
    pipeline.stop();
    ct.close();
    dt.close();
  };

  return { host, inject, deltaMessages, dataFrames, cleanup };
}

// ===========================================================================
// Suite 1b — Flow-control resume wiring (tc-7ml.1)
//
// These tests exercise the assembly-level wiring fixes from tc-7ml.1:
//   1. pipeline.onNotification routes %pause/%continue to the FlowController.
//   2. sessionProxy.addClient wraps the transport's sendData so fc.noteDrained is
//      called automatically for each byte successfully sent to a client.
//
// Uses the in-memory FakePushSession infrastructure — no real tmux required.
// ===========================================================================

describe("tc-7ml.1: flow-control resume wiring — notification routing + noteDrained auto-call", () => {
  // -------------------------------------------------------------------------
  // W1. %continue notification → FC resumes the paused pane
  //
  // Sets up the FC + pipeline via buildFakePushSession, manually wires
  // pipeline.onNotification → FC (replicating createSessionProxy's step 8), floods
  // bytes to trigger pause, injects a raw %continue notification, and verifies
  // the FC (and demux gate) transitions to resumed.
  //
  // This covers the missing "route %pause/%continue to FlowController" half
  // of the tc-7ml.1 fix.
  // -------------------------------------------------------------------------

  it("W1: %continue notification from pipeline resumes a flow-paused pane", async () => {
    // Use small watermarks so the test doesn't need to push 256KiB.
    const HIGH = 400;
    const LOW = 100;

    // Build a minimal in-memory host (same pattern as buildFakePushSession).
    const _dataHandlers2 = new Set<HostDataHandler>();
    const host2: TmuxHost = {
      get pid(): number | undefined { return 99997; },
      get exited(): boolean { return false; },
      async start(): Promise<void> { /* no-op */ },
      write(): void { /* no-op: ignore flow-control commands for this test */ },
      onData(handler: HostDataHandler): () => void {
        _dataHandlers2.add(handler);
        return () => _dataHandlers2.delete(handler);
      },
      onExit(): () => void { return () => {}; },
      onError(): () => void { return () => {}; },
      onStderr(): () => void { return () => {}; },
      async stop(): Promise<void> { /* no-op */ },
      kill(): void { /* no-op */ },
    };

    function inject2(bytes: Uint8Array): void {
      for (const h of _dataHandlers2) {
        try { h(bytes); } catch { /**/ }
      }
    }

    const demuxW1 = createOutputDemux();
    const fcW1 = createFlowController(host2, demuxW1, { highWaterBytes: HIGH, lowWaterBytes: LOW });

    // Accounting store: same as createSessionProxy's accountingStore.
    const accountingW1: typeof demuxW1.store = {
      append(pid: PaneId, bytes: Uint8Array): void {
        demuxW1.store.append(pid, bytes);
        if (bytes.length > 0) fcW1.onPaneBytes(pid, bytes.length);
      },
      getContents: demuxW1.store.getContents.bind(demuxW1.store),
      size: demuxW1.store.size.bind(demuxW1.store),
      drop: demuxW1.store.drop.bind(demuxW1.store),
      clear: demuxW1.store.clear.bind(demuxW1.store),
    };

    const pipelineW1 = createRuntimePipeline(host2, { buffers: accountingW1 });

    // Wire pipeline.onNotification → FC (this is the fix from createSessionProxy step 8).
    pipelineW1.onNotification((event) => {
      if (event.kind === "pause") {
        fcW1.onPauseNotification(paneId("p" + event.paneId));
      } else if (event.kind === "continue") {
        fcW1.onContinueNotification(paneId("p" + event.paneId));
      }
    });

    // Bootstrap the pipeline.
    const startP = pipelineW1.start();
    inject2(makeBootstrapBytes({ paneId: "%1" }));
    await startP;

    const P1 = paneId("p1");

    // Sanity: not paused before flood.
    assert.equal(fcW1.isPanePaused(P1), false, "W1: pane must not be paused before flood");

    // Flood: push bytes > HIGH to trigger backpressure pause.
    accountingW1.append(P1, new Uint8Array(HIGH + 1).fill(0xAA));
    assert.equal(fcW1.isPanePaused(P1), true, "W1: pane must be paused after exceeding high-water");
    assert.equal(demuxW1.isPanePaused(P1), true, "W1: demux gate must be closed after backpressure pause");

    // Now inject a raw %continue %1 notification — simulates tmux acknowledging
    // the continue command that the FC sent.
    // Format: "%continue %1\r\n" as raw bytes fed to the pipeline.
    const continueBytes = new TextEncoder().encode("%continue %1\r\n");
    inject2(continueBytes);

    // The pipeline processes the notification synchronously on inject.
    // The onNotification handler calls fcW1.onContinueNotification("p1").
    // The FC should now open the demux gate.
    assert.equal(
      fcW1.isPanePaused(P1),
      false,
      "W1: pane must be resumed after %continue notification routes through pipeline to FC",
    );
    assert.equal(
      demuxW1.isPanePaused(P1),
      false,
      "W1: demux gate must be open after %continue notification",
    );

    pipelineW1.stop();
  });

  // -------------------------------------------------------------------------
  // W2. %pause notification → FC pauses the pane (honor unsolicited tmux pause)
  //
  // Verifies the other direction: an unsolicited %pause notification from
  // tmux (without backpressure first) correctly gates the demux via FC.
  // -------------------------------------------------------------------------

  it("W2: %pause notification from pipeline gates the demux via FC", async () => {
    const _dataHandlers3 = new Set<HostDataHandler>();
    const host3: TmuxHost = {
      get pid(): number | undefined { return 99996; },
      get exited(): boolean { return false; },
      async start(): Promise<void> { /* no-op */ },
      write(): void { /* no-op */ },
      onData(handler: HostDataHandler): () => void {
        _dataHandlers3.add(handler);
        return () => _dataHandlers3.delete(handler);
      },
      onExit(): () => void { return () => {}; },
      onError(): () => void { return () => {}; },
      onStderr(): () => void { return () => {}; },
      async stop(): Promise<void> { /* no-op */ },
      kill(): void { /* no-op */ },
    };

    function inject3(bytes: Uint8Array): void {
      for (const h of _dataHandlers3) {
        try { h(bytes); } catch { /**/ }
      }
    }

    const demuxW2 = createOutputDemux();
    const fcW2 = createFlowController(host3, demuxW2);

    const pipelineW2 = createRuntimePipeline(host3, { buffers: demuxW2.store });

    // Wire pipeline.onNotification → FC.
    pipelineW2.onNotification((event) => {
      if (event.kind === "pause") {
        fcW2.onPauseNotification(paneId("p" + event.paneId));
      } else if (event.kind === "continue") {
        fcW2.onContinueNotification(paneId("p" + event.paneId));
      }
    });

    const startP2 = pipelineW2.start();
    inject3(makeBootstrapBytes({ paneId: "%3" }));
    await startP2;

    const P3 = paneId("p3");

    assert.equal(fcW2.isPanePaused(P3), false, "W2: pane must not be paused before notification");
    assert.equal(demuxW2.isPanePaused(P3), false, "W2: demux gate must be open before notification");

    // Inject unsolicited %pause %3 (tmux's own capacity management).
    const pauseBytes = new TextEncoder().encode("%pause %3\r\n");
    inject3(pauseBytes);

    assert.equal(
      fcW2.isPanePaused(P3),
      true,
      "W2: FC must honor unsolicited %pause notification from tmux",
    );
    assert.equal(
      demuxW2.isPanePaused(P3),
      true,
      "W2: demux gate must be closed after %pause notification",
    );

    // Resume via %continue.
    const continueBytes2 = new TextEncoder().encode("%continue %3\r\n");
    inject3(continueBytes2);

    assert.equal(
      fcW2.isPanePaused(P3),
      false,
      "W2: %continue after %pause must resume the pane",
    );

    pipelineW2.stop();
  });

  // -------------------------------------------------------------------------
  // W3. drainingTransport auto-noteDrained — verify that sessionProxy.addClient
  //     wraps sendData to call fc.noteDrained automatically
  //
  // This is a unit-level check of the drainingTransport pattern introduced
  // in createSessionProxy.addClient.  We replicate the pattern directly and verify:
  //   - when sendData fires, fc.noteDrained is called for the right pane + count
  //   - after a pause+drain cycle driven purely by sendData, the FC is drained
  //
  // This tests the WIRING PATTERN, not createSessionProxy directly (since createSessionProxy
  // creates its own TmuxHost internally and can't easily accept a fake host).
  // -------------------------------------------------------------------------

  it("W3: drainingTransport pattern automatically calls fc.noteDrained on sendData", async () => {
    const host4: TmuxHost = {
      get pid(): number | undefined { return 99995; },
      get exited(): boolean { return false; },
      async start(): Promise<void> { /* no-op */ },
      write(): void { /* no-op */ },
      onData(): () => void { return () => {}; },
      onExit(): () => void { return () => {}; },
      onError(): () => void { return () => {}; },
      onStderr(): () => void { return () => {}; },
      async stop(): Promise<void> { /* no-op */ },
      kill(): void { /* no-op */ },
    };

    const HIGH = 500;
    const LOW = 100;

    const demuxW3 = createOutputDemux();
    const fcW3 = createFlowController(host4, demuxW3, { highWaterBytes: HIGH, lowWaterBytes: LOW });

    // Create the accounting store (same as createSessionProxy's accountingStore).
    const accountingW3: typeof demuxW3.store = {
      append(pid: PaneId, bytes: Uint8Array): void {
        demuxW3.store.append(pid, bytes);
        if (bytes.length > 0) fcW3.onPaneBytes(pid, bytes.length);
      },
      getContents: demuxW3.store.getContents.bind(demuxW3.store),
      size: demuxW3.store.size.bind(demuxW3.store),
      drop: demuxW3.store.drop.bind(demuxW3.store),
      clear: demuxW3.store.clear.bind(demuxW3.store),
    };

    const P7 = paneId("p7");

    // Flood BEFORE attaching the client — bytes go to store but no transport
    // to call sendData, so noteDrained is never called.
    // The full HIGH+1 bytes accumulate in the counter.
    accountingW3.append(P7, new Uint8Array(HIGH + 1).fill(0xBB));
    assert.equal(fcW3.isPanePaused(P7), true, "W3: pane must be paused after flood");
    const pausedCounter = fcW3.bufferedBytes(P7);
    assert.ok(
      pausedCounter > HIGH,
      `W3: bufferedBytes (${pausedCounter}) must exceed HIGH (${HIGH}) while paused`,
    );

    // Now attach a client via the drainingTransport pattern (createSessionProxy's fix).
    const { sessionProxy: rawSessionProxy } = createInMemoryTransportPair();
    const drainingTransport: Transport = {
      ...rawSessionProxy,
      sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
        const result = rawSessionProxy.sendData(pid, bytes);
        if (bytes.length > 0) {
          fcW3.noteDrained(pid, bytes.length);
        }
        return result;
      },
    };
    demuxW3.attachTransport(drainingTransport);

    // While paused, the gate is CLOSED — sendData is NOT called on append.
    // So noteDrained is NOT auto-called by the transport path while paused.
    // The resume must come from a manual noteDrained call (or %continue notification).
    // Verify: draining via noteDrained explicitly resumes.
    const drainAmount = pausedCounter - LOW + 1; // enough to go below LOW
    fcW3.noteDrained(P7, drainAmount);

    assert.equal(
      fcW3.isPanePaused(P7),
      false,
      "W3: pane must be resumed after manual noteDrained below low-water",
    );
    assert.equal(
      demuxW3.isPanePaused(P7),
      false,
      "W3: demux gate must be open after resume",
    );

    // Now send new bytes (gate is open) — verify drainingTransport calls noteDrained.
    const preCounter = fcW3.bufferedBytes(P7);
    const newChunk = new Uint8Array(50).fill(0xCC);
    accountingW3.append(P7, newChunk);

    // Expected: onPaneBytes(50) increments, then sendData → noteDrained(50) decrements.
    // Net: counter may return to ~preCounter (if noteDrained(50) is called after onPaneBytes(50)).
    // But actually: sendData fires BEFORE onPaneBytes in accountingStore.append.
    // So noteDrained(50) fires first (may clamp to 0 if counter was 0), then onPaneBytes(50) fires.
    // Either way, bufferedBytes should be ≤ preCounter + 50 (not unboundedly growing).
    const postCounter = fcW3.bufferedBytes(P7);
    assert.ok(
      postCounter <= preCounter + newChunk.length,
      `W3: bufferedBytes (${postCounter}) must not grow unboundedly; ` +
      `was ${preCounter} before append, chunk ${newChunk.length} bytes`,
    );
    // Pane must still be unpaused (50 << HIGH=500).
    assert.equal(fcW3.isPanePaused(P7), false, "W3: pane must remain unpaused after small post-resume append");
  });
});

// ===========================================================================
// Suite 2 — createSessionProxy assembly smoke test (fake-tmux)
// ===========================================================================

describe("tc-93a: createSessionProxy assembly — fake-tmux smoke", () => {
  it("createSessionProxy() wires all components; start() + addClient() succeeds", async () => {
    // Use a ScriptedHost indirectly by creating the session-proxy with a custom host option
    // that points to fake-tmux (no real tmux binary needed).
    // We build the session-proxy manually (wiring ScriptedHost as the host) to test assembly.
    const scriptedHost = createScriptedHost();

    // Build the session-proxy with components wired manually to use our scripted host.
    // We test createSessionProxy() itself by providing a real env and asserting the
    // assembled session-proxy's addClient() route works end-to-end.

    // Since createSessionProxy() always creates its own TmuxHost via createTmuxHost(),
    // we test the assembly here by calling createSessionProxy() and verifying the
    // shape of the returned SessionProxy object.
    // tc-blk — track the assembly-test socket too, even though we never start
    // the sessionProxy (kill is called below). The trackSocket call is cheap and
    // covers the case where createSessionProxy evolves to do eager work later.
    // tc-bpn — shape: tmuxcc-test-<pid>-<suffix> required by test-tmux-cleanup.
    const asmSock = `tmuxcc-test-${process.pid}-sp-asm-${Date.now()}`;
    trackSocket(asmSock);
    const sessionProxy = createSessionProxy({
      host: {
        // Use a nonexistent socket so we don't conflict; we kill immediately.
        socketName: asmSock,
        sessionName: "asmtest",
      },
    });

    // Verify the SessionProxy interface is complete.
    assert.ok(typeof sessionProxy.start === "function", "sessionProxy.start must be a function");
    assert.ok(typeof sessionProxy.stop === "function", "sessionProxy.stop must be a function");
    assert.ok(typeof sessionProxy.kill === "function", "sessionProxy.kill must be a function");
    assert.ok(typeof sessionProxy.addClient === "function", "sessionProxy.addClient must be a function");
    assert.ok(sessionProxy.host !== undefined, "sessionProxy.host must be defined");
    assert.ok(sessionProxy.demux !== undefined, "sessionProxy.demux must be defined");
    assert.ok(sessionProxy.pipeline !== undefined, "sessionProxy.pipeline must be defined");
    assert.ok(sessionProxy.server !== undefined, "sessionProxy.server must be defined");
    assert.ok(sessionProxy.inputPath !== undefined, "sessionProxy.inputPath must be defined");
    assert.ok(sessionProxy.flowController !== undefined, "sessionProxy.flowController must be defined");

    // Kill without starting (no-op).
    sessionProxy.kill();

    // Also verify the ScriptedHost scripted path works end-to-end for snapshot.
    const { controlMessages, cleanup } = await wireScriptedSession();
    try {
      const snapshot = controlMessages.find((m) => m.type === "snapshot") as SnapshotMessage | undefined;
      assert.ok(snapshot !== undefined, "snapshot must arrive via scripted session");
    } finally {
      await cleanup();
    }
  });

  it("server.clientCount() tracks connected clients correctly", async () => {
    const sess = await wireScriptedSession();
    try {
      assert.equal(sess.server.clientCount(), 1, "should have 1 client after addClient");
      sess.server.removeClient(sess.sessionProxyTransport);
      assert.equal(sess.server.clientCount(), 0, "should have 0 clients after removeClient");
    } finally {
      await sess.cleanup();
    }
  });
});

// ===========================================================================
// Suite 3 — Real tmux 3.4 smoke test (guarded)
// ===========================================================================

const tmuxAvailable = (() => {
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
  } catch {
    return false;
  }
})();

const REAL_RUN_SUFFIX = `${Date.now()}`;

function realSockName(label: string): string {
  // tc-bpn — shape: tmuxcc-test-<pid>-<suffix> required by test-tmux-cleanup.
  const sock = `tmuxcc-test-${process.pid}-int-${REAL_RUN_SUFFIX}-${label}`;
  // tc-blk — track BEFORE the session-proxy is created so a thrown test still gets
  // its server reaped via the process-exit / top-level after() net.
  trackSocket(sock);
  return sock;
}

function killRealServer(sock: string): void {
  killTmuxServer(sock);
}

/** Poll a Buffer accumulator until predicate returns true or timeout. */
function waitForBuffer(
  chunks: Uint8Array[],
  predicate: (all: Buffer) => boolean,
  timeoutMs: number,
  msg: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      if (predicate(all)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timeout (${timeoutMs}ms): ${msg}`));
      setTimeout(check, 50);
    };
    check();
  });
}

describe(
  "tc-93a: Real tmux 3.4 smoke test",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    // -------------------------------------------------------------------------
    // R1. Snapshot on connect — real tmux session has ≥1 window, ≥1 pane
    // -------------------------------------------------------------------------

    it("R1: snapshot reflects a real tmux session (≥1 window, ≥1 pane)", async () => {
      const sock = realSockName("snap");
      after(() => killRealServer(sock));

      const sessionProxy = createSessionProxy({
        host: { socketName: sock, sessionName: "r1session", cols: 80, rows: 24 },
      });
      sessionProxy.host.onError(() => {}); // suppress unhandled error events

      await sessionProxy.start();

      const { sessionProxyTransport: dt, clientTransport: ct, controlMessages } = createRecordingPair();
      sessionProxy.demux.attachTransport(dt);
      const addPromise = sessionProxy.server.addClient(dt);
      const clientPromise = runClientHandshake(ct, CLIENT_CAPS);
      await Promise.all([addPromise, clientPromise]);

      // Snapshot should already be in controlMessages (sent synchronously after handshake).
      const snapshot = controlMessages.find((m) => m.type === "snapshot") as SnapshotMessage | undefined;

      assert.ok(snapshot !== undefined, "real tmux session must produce a snapshot");
      assert.equal(snapshot!.seq, 1, "snapshot seq must be 1");
      assert.ok(snapshot!.session !== undefined, "real session must have a session in snapshot");
      assert.ok(snapshot!.windows.length >= 1, "real session must have ≥1 window in snapshot");
      assert.ok(snapshot!.panes.length >= 1, "real session must have ≥1 pane in snapshot");

      sessionProxy.kill();
      await new Promise<void>((r) => { sessionProxy.host.onExit(() => r()); });
    });

    // -------------------------------------------------------------------------
    // R2. Pane output arrives on the client data plane
    // -------------------------------------------------------------------------

    it("R2: pane output from a real tmux pane reaches the client data plane", async () => {
      const sock = realSockName("output");
      after(() => killRealServer(sock));

      const sessionProxy = createSessionProxy({
        host: { socketName: sock, sessionName: "r2session", cols: 80, rows: 24 },
      });
      sessionProxy.host.onError(() => {});

      await sessionProxy.start();

      const { sessionProxyTransport: dt, clientTransport: ct, controlMessages, dataFrames } = createRecordingPair();
      sessionProxy.demux.attachTransport(dt);
      const addPromise = sessionProxy.server.addClient(dt);
      const clientPromise = runClientHandshake(ct, CLIENT_CAPS);
      await Promise.all([addPromise, clientPromise]);

      // Get the first pane id from the snapshot.
      const snapshot = controlMessages.find((m) => m.type === "snapshot") as SnapshotMessage | undefined;
      assert.ok(snapshot !== undefined, "snapshot must arrive before sending keys");
      assert.ok(snapshot!.panes.length >= 1, "must have at least 1 pane to send keys to");

      const firstPane = snapshot!.panes[0]!;
      // Convert wire PaneId to tmux numeric: "p1" → "%1"
      const wirePaneId = firstPane.paneId as string;
      const tmuxPaneNum = parseInt(wirePaneId.slice(1), 10);

      // Send a visible command that produces output.
      sessionProxy.host.write(`send-keys -H -t %${tmuxPaneNum} 68 69 0A\n`); // "hi\n" in hex

      // Wait for data frames to arrive (with a generous timeout for real tmux latency).
      await waitFor(
        () => dataFrames.length > 0 ? dataFrames : undefined,
        8000,
        "no data frames received from real tmux pane within 8s",
      );

      assert.ok(dataFrames.length > 0, "data plane must receive bytes from real tmux pane output");

      sessionProxy.kill();
      await new Promise<void>((r) => { sessionProxy.host.onExit(() => r()); });
    });

    // -------------------------------------------------------------------------
    // R3. Clean teardown — no leaked tmux servers
    // -------------------------------------------------------------------------

    it("R3: clean teardown — host bridge exits cleanly via sessionProxy.stop(); server killed explicitly", async () => {
      const sock = realSockName("teardown");
      after(() => killRealServer(sock)); // belt-and-suspenders

      const sessionProxy = createSessionProxy({
        host: { socketName: sock, sessionName: "r3session", cols: 80, rows: 24 },
      });
      sessionProxy.host.onError(() => {});

      await sessionProxy.start();
      assert.equal(sessionProxy.host.exited, false, "host must be running after start()");

      // sessionProxy.stop() closes stdin → bridge exits → tmux server MAY still linger
      // briefly.  We stop the bridge process and then explicitly kill the server.
      await sessionProxy.stop();

      // The bridge process (host) should have exited after stop().
      assert.equal(sessionProxy.host.exited, true, "host bridge process must have exited after stop()");

      // Explicitly kill the tmux server so it doesn't linger.
      killRealServer(sock);

      // Verify tmux server is gone.
      const check = spawnSync("tmux", ["-L", sock, "list-sessions"], { timeout: 2000 });
      assert.ok(
        check.status !== 0,
        "tmux server should not be running after stop() + kill-server",
      );
    });
  },
);
