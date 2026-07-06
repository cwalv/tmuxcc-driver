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
import { spawn as spawnProc, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
// tc-blk — process-level safety net for real-tmux test sockets.
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";
import { createOutputDemux } from "./output-demux.js";
import { createRuntimePipeline } from "./pipeline.js";
import { createControlServer } from "./serve.js";
import { createInputPath } from "./input-path.js";
import { createFlowController } from "./flow-control.js";
import { createSessionProxy } from "./session-proxy.js";
import { createSessionProxyRegistry } from "../metrics/index.js";
// ---------------------------------------------------------------------------
// Wire utilities
// ---------------------------------------------------------------------------
import { createInMemoryTransportPair, runClientHandshake, WIRE_PROTOCOL_VERSION, } from "@tmuxcc/protocol";
import { paneId } from "@tmuxcc/protocol";
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
    features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
};
/**
 * Build a minimal bootstrap stream for one session/window/pane.
 * Matches the format consumed by BootstrapCoordinator (pipeline.test helper).
 */
function makeBootstrapBytes(opts = {}) {
    const sid = opts.sessionId ?? "$0";
    const sname = opts.sessionName ?? "testsession";
    const wid = opts.windowId ?? "@1";
    const wname = opts.windowName ?? "testwin";
    const pid_ = opts.paneId ?? "%1";
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const ts = 1_000_000;
    const layoutStr = `aaaa,${cols}x${rows},0,0,${parseInt(pid_.slice(1), 10)}`;
    // list-windows -a reply (BOOTSTRAP_WINDOWS_FORMAT; tc-pqb4: includes fields [9]–[11])
    const windowsBody = `${sid}\t${sname}\t${wid}\t${wname}\t${cols}\t${rows}\t${layoutStr}\t*\t1\t0\t1\t0\n`;
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
 *
 * tc-128.4 review fix: after bootstrap, the pipeline drains buffered topology
 * events (fake-tmux.js emits %sessions-changed + %session-changed at startup)
 * and fires a healing requery (list-windows + list-panes).  fake-tmux.js echoes
 * commands with flags=0 (startup blocks), which the correlator discards —
 * leaving the engine's requery Promise unresolved and the process hanging.
 *
 * We fix this by auto-injecting proper flags=1 replies for any list-windows /
 * list-panes written AFTER the bootstrap injection has fired (i.e. for the
 * healing requery and any subsequent coalescer cycles). The auto-reply uses the
 * same bootstrapOpts so the model is stable.
 */
function createScriptedHost(bootstrapOpts = {}) {
    // Process is NOT spawned until start() is called — this ensures pipeline.start()
    // registers its onData handler before any bytes arrive from fake-tmux.
    let proc = null;
    const _dataHandlers = new Set();
    const _exitHandlers = new Set();
    const _errorHandlers = new Set();
    const _stderrHandlers = new Set();
    const writtenCommands = [];
    let _exited = false;
    let _exitCode = null;
    let _exitSignal = null;
    let _pid;
    // Track whether we have already injected bootstrap bytes.
    let _bootstrapInjected = false;
    // True once the bootstrap-injection nextTick has fired. All list-commands
    // written after this point are from the healing requery or later coalescer
    // cycles and need an auto-injected reply (fake-tmux.js echoes flags=0 which
    // the correlator discards).
    let _bootstrapFired = false;
    // Auto-reply cmdnum counter (distinct from fake-tmux.js's counter).
    let _autoReplyCmdNum = 200;
    function _injectAutoReply(cmdType) {
        const ts = 1_000_000;
        const cn = _autoReplyCmdNum++;
        const opts = bootstrapOpts;
        const sid = opts.sessionId ?? "$0";
        const sname = opts.sessionName ?? "testsession";
        const wid = opts.windowId ?? "@1";
        const wname = opts.windowName ?? "testwin";
        const pid_ = opts.paneId ?? "%1";
        const cols = opts.cols ?? 80;
        const rows = opts.rows ?? 24;
        const layoutStr = `aaaa,${cols}x${rows},0,0,${parseInt(pid_.slice(1), 10)}`;
        const body = cmdType === "windows"
            // tc-pqb4: include fields [9]–[11] (synchronize-panes / monitor-activity / monitor-silence)
            ? `${sid}\t${sname}\t${wid}\t${wname}\t${cols}\t${rows}\t${layoutStr}\t*\t1\t0\t1\t0\n`
            : cmdType === "panes"
                ? `${pid_}\t${wid}\t${sid}\t0\t${cols}\t${rows}\t0\t0\t1\t1234\tbash\n`
                : "";
        const replyBytes = new TextEncoder().encode(`%begin ${ts} ${cn} 1\r\n${body}%end ${ts} ${cn} 1\r\n`);
        // Inject on nextTick so the write() call stack unwinds first (mirroring
        // how real tmux delivers responses asynchronously).
        process.nextTick(() => {
            for (const h of _dataHandlers) {
                try {
                    h(replyBytes);
                }
                catch { /**/ }
            }
        });
    }
    function _attachProcListeners(p) {
        p.stdout.on("data", (chunk) => {
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
                        _bootstrapFired = true;
                        // noPreNotif: true — fake-tmux.js already sends %sessions-changed +
                        // %session-changed via its own stdout; we don't inject a duplicate
                        // %session-changed here. The pipeline's drain will dispatch the
                        // fake-tmux.js notifications and fire a healing requery; the
                        // createScriptedHost write() interceptor auto-injects proper replies
                        // for those list-* commands so the engine doesn't hang.
                        const bootstrapBytes = makeBootstrapBytes({ ...bootstrapOpts, noPreNotif: true });
                        for (const h of _dataHandlers) {
                            try {
                                h(bootstrapBytes);
                            }
                            catch { /**/ }
                        }
                    });
                }
            }
            for (const h of _dataHandlers) {
                try {
                    h(u8);
                }
                catch { /**/ }
            }
        });
        p.on("close", (code, signal) => {
            _exited = true;
            _exitCode = code;
            _exitSignal = signal;
            for (const h of _exitHandlers) {
                try {
                    h(code, signal);
                }
                catch { /**/ }
            }
        });
        p.on("error", (err) => {
            for (const h of _errorHandlers) {
                try {
                    h(err);
                }
                catch { /**/ }
            }
        });
        p.stderr.on("data", (chunk) => {
            if (_stderrHandlers.size > 0) {
                const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                for (const h of _stderrHandlers) {
                    try {
                        h(u8);
                    }
                    catch { /**/ }
                }
            }
        });
    }
    const handle = {
        get pid() { return _pid; },
        get exited() { return _exited; },
        async start() {
            if (proc !== null)
                return; // idempotent
            proc = spawnProc(process.execPath, [FAKE_TMUX], {
                stdio: ["pipe", "pipe", "pipe"],
            });
            _pid = proc.pid;
            _attachProcListeners(proc);
        },
        write(data) {
            if (!proc)
                throw new Error("ScriptedHost.write() called before start()");
            const s = typeof data === "string" ? data : new TextDecoder().decode(data);
            writtenCommands.push(s);
            proc.stdin.write(typeof data === "string" ? data : data);
            // tc-128.4 review fix: after the bootstrap injection fires, the pipeline
            // issues slotted commands the correlator must see replies for — the
            // healing requery's list-* pair, later coalescer cycles, and the
            // post-bootstrap setup commands (set-option / refresh-client, which
            // register throwaway slots to keep the correlator FIFO aligned).
            // fake-tmux.js echoes commands with flags=0 (startup blocks) which the
            // correlator discards — leaving slots pending forever and hanging the
            // engine (or mis-binding later replies). Auto-inject proper flags=1
            // replies so every slot resolves in write order, mirroring real tmux.
            if (_bootstrapFired) {
                const trimmed = s.trim();
                if (trimmed.startsWith("list-windows")) {
                    _injectAutoReply("windows");
                }
                else if (trimmed.startsWith("list-panes")) {
                    _injectAutoReply("panes");
                }
                else if (trimmed.startsWith("set-option") || trimmed.startsWith("refresh-client")) {
                    _injectAutoReply("empty");
                }
            }
        },
        onData(handler) {
            _dataHandlers.add(handler);
            return () => _dataHandlers.delete(handler);
        },
        onExit(handler) {
            if (_exited) {
                process.nextTick(() => handler(_exitCode, _exitSignal));
                return () => { };
            }
            _exitHandlers.add(handler);
            return () => _exitHandlers.delete(handler);
        },
        onError(handler) {
            _errorHandlers.add(handler);
            return () => _errorHandlers.delete(handler);
        },
        onStderr(handler) {
            _stderrHandlers.add(handler);
            return () => _stderrHandlers.delete(handler);
        },
        stop() {
            if (_exited || !proc)
                return Promise.resolve();
            return new Promise((resolve) => {
                _exitHandlers.add(() => resolve());
                proc.stdin.end();
            });
        },
        kill(signal = "SIGKILL") {
            if (!_exited && proc) {
                try {
                    proc.kill(signal);
                }
                catch { /**/ }
            }
        },
        get writtenCommands() { return writtenCommands; },
        waitForExit() {
            if (_exited)
                return Promise.resolve({ code: _exitCode, signal: _exitSignal });
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
function waitFor(fn, timeoutMs, msg) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            const val = fn();
            if (val !== undefined)
                return resolve(val);
            if (Date.now() > deadline)
                return reject(new Error(`Timeout (${timeoutMs}ms): ${msg}`));
            setTimeout(check, 20);
        };
        check();
    });
}
function createRecordingPair() {
    const { sessionProxy: rawSessionProxy, client: rawClient } = createInMemoryTransportPair();
    const controlMessages = [];
    const dataFrames = [];
    // Tap the session-proxy endpoint's sendControl so every outbound message is recorded.
    // The session-proxy sends control messages TO the client (snapshot, deltas) via
    // sessionProxy.sendControl, which delivers to clientControlHandler.  We wrap
    // sessionProxy.sendControl to also push to our recorder.
    const sessionProxyTransport = {
        sendControl(msg) {
            // Record every message the session-proxy sends (snapshot, deltas, capabilities).
            controlMessages.push(msg);
            return rawSessionProxy.sendControl(msg);
        },
        onControl(handler) { rawSessionProxy.onControl(handler); },
        sendData(paneId, bytes) { return rawSessionProxy.sendData(paneId, bytes); },
        onData(handler) { rawSessionProxy.onData(handler); },
        onClose(handler) { return rawSessionProxy.onClose(handler); },
        close(err) { rawSessionProxy.close(err); },
    };
    // Tap the client endpoint's sendData so data-plane frames are recorded.
    const clientTransport = {
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
        onClose(handler) { return rawClient.onClose(handler); },
        close(err) { rawClient.close(err); },
    };
    // Also tap the session-proxy's sendData so data plane frames are captured.
    // sessionProxy.sendData → rawClient's dataHandler.  We intercept at session-proxy side.
    const originalSessionProxySendData = rawSessionProxy.sendData.bind(rawSessionProxy);
    sessionProxyTransport.sendData = (paneId, bytes) => {
        dataFrames.push({ paneId, bytes });
        return originalSessionProxySendData(paneId, bytes);
    };
    return { sessionProxyTransport, clientTransport, controlMessages, dataFrames };
}
async function wireScriptedSession(bootstrapOpts = {}) {
    const host = createScriptedHost(bootstrapOpts);
    // 1. Output demux — creates tapped PaneBufferStore.
    const demux = createOutputDemux();
    // 2. Pipeline — uses demux.store so reducer writes tap into the demux.
    const pipeline = createRuntimePipeline(host, { buffers: demux.store });
    // 3. Control server.
    const server = createControlServer(pipeline);
    // 4. Input path. tc-3si.1: input-path takes `send`/`sendBatch` from the
    // pipeline rather than the host directly — slot+write is atomic.
    const inputPath = createInputPath({
        send: (cmd) => pipeline.send(cmd),
        sendBatch: (cmds) => pipeline.sendBatch(cmds),
    });
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
        inputPath.handleClientMessage(msg);
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
            const snapshot = deltaMessages.find((m) => m.type === "snapshot");
            assert.ok(snapshot !== undefined, "client must receive a snapshot message");
            assert.equal(snapshot.type, "snapshot");
            assert.equal(snapshot.seq, 1, "snapshot must be seq=1");
            // The bootstrap exchange gives 1 session, 1 window, 1 pane.
            assert.ok(snapshot.session !== undefined, "snapshot must have a session");
            assert.ok(snapshot.windows.length >= 1, "snapshot must have at least 1 window");
            assert.ok(snapshot.panes.length >= 1, "snapshot must have at least 1 pane");
        }
        finally {
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
            assert.equal(snapshot.seq, 1, "snapshot must be seq=1");
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
            await new Promise((r) => setImmediate(r));
            inject(makeBootstrapBytes({ sessionName: "renamed-session", noPreNotif: true }));
            // Wait for a new delta to appear.
            await waitFor(() => deltaMessages.length > beforeCount ? deltaMessages : undefined, 2000, "no delta received after injecting %session-renamed");
            const newDeltas = deltaMessages.slice(beforeCount);
            assert.ok(newDeltas.length > 0, "at least one delta should arrive after activity");
            // All activity deltas must have seq > 1 (snapshot is seq=1).
            for (const delta of newDeltas) {
                assert.ok(delta.seq > 1, `delta seq ${delta.seq} must be > snapshot seq 1`);
            }
            // The control-stream messages (snapshot + deltas — excluding the
            // session-proxy.capabilities handshake message, which has its own seq=1)
            // must be strictly monotonically increasing.
            const controlStreamMsgs = deltaMessages.filter((m) => m.type !== "session-proxy.capabilities");
            const seqs = controlStreamMsgs.map((m) => m.seq);
            for (let i = 1; i < seqs.length; i++) {
                assert.ok((seqs[i] ?? 0) > (seqs[i - 1] ?? 0), `seq must increase: seqs[${i - 1}]=${seqs[i - 1]} seqs[${i}]=${seqs[i]}`);
            }
        }
        finally {
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
            const frame = await waitFor(() => dataFrames.find((f) => f.paneId === paneId("p3")), 2000, "no data frame for pane p3");
            assert.ok(frame !== undefined, "must receive a data frame for pane p3");
            assert.equal(frame.paneId, paneId("p3"), "frame paneId must be p3");
            // Check byte content: "hello" = [104, 101, 108, 108, 111]
            const content = Buffer.concat(dataFrames.filter((f) => f.paneId === paneId("p3")).map((f) => Buffer.from(f.bytes)));
            assert.ok(content.includes(Buffer.from("hello")), `expected "hello" in data frame, got: ${content.toString("hex")}`);
        }
        finally {
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
            const inputMsg = {
                type: "input",
                seq: 1,
                paneId: paneId("p1"),
                data: "hi",
            };
            sess.clientTransport.sendControl(inputMsg);
            // Allow a tick for the message to route through the transport → onControl
            // → inputPath.handleClientMessage → host.write().
            await new Promise((r) => setTimeout(r, 50));
            // The host.write() calls are captured in writtenCommands.
            const written = sess.host.writtenCommands.join("\n");
            // send-keys -H -t %1 <hex-encoded "hi">
            // "h" = 0x68, "i" = 0x69 → hex = "6869"
            assert.ok(written.includes("send-keys") && written.includes("-H"), `expected send-keys -H in written commands; got: ${written}`);
            assert.ok(written.includes("6869") || written.includes("68 69") || written.includes("%1"), `expected hex-encoded "hi" or pane ref in send-keys command; got: ${written}`);
        }
        finally {
            await sess.cleanup();
        }
    });
    // -------------------------------------------------------------------------
    // T5. Resize
    // -------------------------------------------------------------------------
    it("T5: client ResizeRequestMessage → refresh-client -C WxH command reaches host.write()", async () => {
        const sess = await wireScriptedSession();
        try {
            const resizeMsg = {
                type: "resize.request",
                seq: 1,
                paneId: paneId("p1"),
                cols: 120,
                rows: 40,
            };
            sess.clientTransport.sendControl(resizeMsg);
            await new Promise((r) => setTimeout(r, 50));
            const written = sess.host.writtenCommands.join("\n");
            assert.ok(written.includes("refresh-client") && written.includes("-C"), `expected refresh-client -C in written commands; got: ${written}`);
            assert.ok(written.includes("120x40"), `expected 120x40 in refresh-client -C command; got: ${written}`);
        }
        finally {
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
        // tc-3si.1: flow controller takes `send` (atomic slot+write) rather than
        // a host. We bind to the pipeline through a late-binding closure since the
        // pipeline is constructed after the flow controller (the accounting store
        // closes over fc, and pipeline closes over the store).
        let pipelineRef = null;
        const fc = createFlowController((cmd) => {
            if (pipelineRef === null)
                throw new Error("pipeline not yet wired");
            return pipelineRef.send(cmd);
        }, demux, { highWaterBytes: HIGH, lowWaterBytes: LOW });
        // Accounting store: demux.store + fc.onPaneBytes notification.
        const accountingStore = {
            append(pid, bytes) {
                demux.store.append(pid, bytes);
                if (bytes.length > 0)
                    fc.onPaneBytes(pid, bytes.length);
            },
            getContents: demux.store.getContents.bind(demux.store),
            size: demux.store.size.bind(demux.store),
            drop: demux.store.drop.bind(demux.store),
            clear: demux.store.clear.bind(demux.store),
        };
        const pipeline = createRuntimePipeline(host, { buffers: accountingStore });
        pipelineRef = pipeline;
        const server = createControlServer(pipeline);
        // tc-128.4: pane tracking is always-on in the demux; wire model-change so
        // bootstrap-discovered panes get bound (otherwise %output bytes stage
        // indefinitely instead of fanning out to attached transports).
        pipeline.onModelChange((next, prev) => {
            for (const pid of next.panes.keys()) {
                if (!demux.isPaneKnown(pid))
                    demux.notifyPaneBound(pid);
            }
            for (const pid of prev.panes.keys()) {
                if (!next.panes.has(pid))
                    demux.notifyPaneClosed(pid);
            }
        });
        await host.start();
        await pipeline.start();
        // Attach a client.
        const { sessionProxy: dt, client: ct } = createInMemoryTransportPair();
        const receivedData = [];
        ct.onData((pid, bytes) => receivedData.push({ paneId: pid, bytes }));
        const detach = demux.attachTransport(dt);
        const addPromise = server.addClient(dt);
        await runClientHandshake(ct, CLIENT_CAPS);
        await addPromise;
        // Register the client's FC sub-ledger (tc-0wtb; with zero registered
        // clients the controller accounts nothing — FC-6). This test drains it
        // manually below (the attached transport is bare, not the draining
        // wrapper).
        fc.addClient(dt);
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
        assert.ok(pauseCommands.includes("refresh-client") && pauseCommands.includes("pause"), `expected refresh-client -A pause in host writes; got: ${pauseCommands}`);
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
        fc.noteDrained(P5, 600, dt);
        assert.equal(fc.isPanePaused(P5), false, "pane must be resumed after draining below low-water mark");
        assert.equal(demux.isPanePaused(P5), false, "demux gate must be open after resume");
        const resumeCommands = host.writtenCommands.join("\n");
        assert.ok(resumeCommands.includes("refresh-client") && resumeCommands.includes("continue"), `expected refresh-client -A continue in host writes; got: ${resumeCommands}`);
        // --- Phase 5: bytes after resume are delivered again ---
        const postResumeBytes = new Uint8Array(10).fill(0xCD);
        accountingStore.append(P5, postResumeBytes);
        // Pane should not be paused yet (10 < 500).
        assert.equal(fc.isPanePaused(P5), false, "pane must not be re-paused after small append");
        // Post-resume bytes must reach the client.
        await waitFor(() => {
            const all = Buffer.concat(receivedData.map((f) => Buffer.from(f.bytes)));
            return all.includes(Buffer.from([0xCD])) ? true : undefined;
        }, 1000, "post-resume bytes did not reach client");
        // Cleanup.
        detach();
        pipeline.stop();
        ct.close();
        dt.close();
        host.kill();
        await host.waitForExit();
    });
});
async function buildFakePushSession(bootstrapOpts = {}) {
    // Minimal in-memory TmuxHost
    const _dataHandlers = new Set();
    const writtenCommands = [];
    let _ackCmdNum = 700;
    const host = {
        get pid() { return 99998; },
        get exited() { return false; },
        async start() { },
        write(data) {
            const s = typeof data === "string" ? data : new TextDecoder().decode(data);
            writtenCommands.push(s);
            // Auto-ack fire-and-forget setup commands (set-option / refresh-client):
            // the pipeline registers throwaway correlator slots for them (FIFO
            // invariant, see _writeSlottedCommand). Without an ack those slots stay
            // pending and swallow the next reply pair a test injects, starving the
            // requery slots behind them.
            const trimmed = s.trim();
            if (trimmed.startsWith("set-option") || trimmed.startsWith("refresh-client")) {
                const cn = _ackCmdNum++;
                const ack = new TextEncoder().encode(`%begin 1000000 ${cn} 1\r\n%end 1000000 ${cn} 1\r\n`);
                process.nextTick(() => inject(ack));
            }
        },
        onData(handler) {
            _dataHandlers.add(handler);
            return () => _dataHandlers.delete(handler);
        },
        onExit() { return () => { }; },
        onError() { return () => { }; },
        onStderr() { return () => { }; },
        async stop() { },
        kill() { },
    };
    function inject(bytes) {
        for (const h of _dataHandlers) {
            try {
                h(bytes);
            }
            catch { /**/ }
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
            if (!demux.isPaneKnown(pid))
                demux.notifyPaneBound(pid);
        }
        for (const pid of prev.panes.keys()) {
            if (!next.panes.has(pid))
                demux.notifyPaneClosed(pid);
        }
    });
    // start() sends bootstrap commands; we feed the replies via inject().
    // noPreNotif: true omits the leading %session-changed preamble so no
    // topology event is buffered during bootstrap. These tests exercise
    // content-plane + control-plane behavior — the bootstrap-race healing
    // requery is irrelevant here, and the in-memory fake host has no way
    // to answer a second list-* reply pair.
    const startPromise = pipeline.start();
    inject(makeBootstrapBytes({ ...bootstrapOpts, noPreNotif: true }));
    await startPromise;
    // Use a recording pair so snapshot + deltas are captured regardless of
    // handler replacement by the handshake helpers.
    const { sessionProxyTransport: dt, clientTransport: ct, controlMessages: deltaMessages, dataFrames, } = createRecordingPair();
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
        const _dataHandlers2 = new Set();
        const host2 = {
            get pid() { return 99997; },
            get exited() { return false; },
            async start() { },
            write() { },
            onData(handler) {
                _dataHandlers2.add(handler);
                return () => _dataHandlers2.delete(handler);
            },
            onExit() { return () => { }; },
            onError() { return () => { }; },
            onStderr() { return () => { }; },
            async stop() { },
            kill() { },
        };
        function inject2(bytes) {
            for (const h of _dataHandlers2) {
                try {
                    h(bytes);
                }
                catch { /**/ }
            }
        }
        const demuxW1 = createOutputDemux();
        // tc-3si.1: late-binding `send` (the pipeline is constructed below).
        let pipelineW1Ref = null;
        const fcW1 = createFlowController((cmd) => {
            if (pipelineW1Ref === null)
                throw new Error("pipeline not yet wired");
            return pipelineW1Ref.send(cmd);
        }, demuxW1, { highWaterBytes: HIGH, lowWaterBytes: LOW });
        // Accounting store: same as createSessionProxy's accountingStore.
        const accountingW1 = {
            append(pid, bytes) {
                demuxW1.store.append(pid, bytes);
                if (bytes.length > 0)
                    fcW1.onPaneBytes(pid, bytes.length);
            },
            getContents: demuxW1.store.getContents.bind(demuxW1.store),
            size: demuxW1.store.size.bind(demuxW1.store),
            drop: demuxW1.store.drop.bind(demuxW1.store),
            clear: demuxW1.store.clear.bind(demuxW1.store),
        };
        const pipelineW1 = createRuntimePipeline(host2, { buffers: accountingW1 });
        pipelineW1Ref = pipelineW1;
        // Wire pipeline.onNotification → FC (this is the fix from createSessionProxy step 8).
        pipelineW1.onNotification((event) => {
            if (event.kind === "pause") {
                fcW1.onPauseNotification(paneId("p" + event.paneId));
            }
            else if (event.kind === "continue") {
                fcW1.onContinueNotification(paneId("p" + event.paneId));
            }
        });
        // Bootstrap the pipeline.
        const startP = pipelineW1.start();
        inject2(makeBootstrapBytes({ paneId: "%1", noPreNotif: true }));
        await startP;
        const P1 = paneId("p1");
        // Register a client sub-ledger for the flood to fan into (tc-0wtb; with
        // zero registered clients the controller accounts nothing — FC-6). This
        // test never drains it: resume comes via the %continue notification.
        fcW1.addClient({ id: "w1-client" });
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
        assert.equal(fcW1.isPanePaused(P1), false, "W1: pane must be resumed after %continue notification routes through pipeline to FC");
        assert.equal(demuxW1.isPanePaused(P1), false, "W1: demux gate must be open after %continue notification");
        pipelineW1.stop();
    });
    // -------------------------------------------------------------------------
    // W2. %pause notification → FC pauses the pane (honor unsolicited tmux pause)
    //
    // Verifies the other direction: an unsolicited %pause notification from
    // tmux (without backpressure first) correctly gates the demux via FC.
    // -------------------------------------------------------------------------
    it("W2: %pause notification from pipeline gates the demux via FC", async () => {
        const _dataHandlers3 = new Set();
        const host3 = {
            get pid() { return 99996; },
            get exited() { return false; },
            async start() { },
            write() { },
            onData(handler) {
                _dataHandlers3.add(handler);
                return () => _dataHandlers3.delete(handler);
            },
            onExit() { return () => { }; },
            onError() { return () => { }; },
            onStderr() { return () => { }; },
            async stop() { },
            kill() { },
        };
        function inject3(bytes) {
            for (const h of _dataHandlers3) {
                try {
                    h(bytes);
                }
                catch { /**/ }
            }
        }
        const demuxW2 = createOutputDemux();
        // tc-3si.1: late-binding `send`.
        let pipelineW2Ref = null;
        const fcW2 = createFlowController((cmd) => {
            if (pipelineW2Ref === null)
                throw new Error("pipeline not yet wired");
            return pipelineW2Ref.send(cmd);
        }, demuxW2);
        const pipelineW2 = createRuntimePipeline(host3, { buffers: demuxW2.store });
        pipelineW2Ref = pipelineW2;
        // Wire pipeline.onNotification → FC.
        pipelineW2.onNotification((event) => {
            if (event.kind === "pause") {
                fcW2.onPauseNotification(paneId("p" + event.paneId));
            }
            else if (event.kind === "continue") {
                fcW2.onContinueNotification(paneId("p" + event.paneId));
            }
        });
        const startP2 = pipelineW2.start();
        inject3(makeBootstrapBytes({ paneId: "%3", noPreNotif: true }));
        await startP2;
        const P3 = paneId("p3");
        assert.equal(fcW2.isPanePaused(P3), false, "W2: pane must not be paused before notification");
        assert.equal(demuxW2.isPanePaused(P3), false, "W2: demux gate must be open before notification");
        // Inject unsolicited %pause %3 (tmux's own capacity management).
        const pauseBytes = new TextEncoder().encode("%pause %3\r\n");
        inject3(pauseBytes);
        assert.equal(fcW2.isPanePaused(P3), true, "W2: FC must honor unsolicited %pause notification from tmux");
        assert.equal(demuxW2.isPanePaused(P3), true, "W2: demux gate must be closed after %pause notification");
        // Resume via %continue.
        const continueBytes2 = new TextEncoder().encode("%continue %3\r\n");
        inject3(continueBytes2);
        assert.equal(fcW2.isPanePaused(P3), false, "W2: %continue after %pause must resume the pane");
        pipelineW2.stop();
    });
    // -------------------------------------------------------------------------
    // W3. drainingTransport auto-noteDrained — verify that sessionProxy.addClient
    //     wraps sendData to call fc.noteDrained automatically
    //
    // This is a unit-level check of the drainingTransport pattern introduced
    // in createSessionProxy.addClient.  We replicate the pattern directly (a
    // scripted inner transport that returns a shared pending Promise while
    // "backpressured", like SocketTransport) and verify:
    //   - while backpressured, NO credit fires before the real drain: the
    //     counter climbs, crosses HIGH and pauses (deferred-credit branch)
    //   - when the drain promise resolves, the deferred credits fire against
    //     the right (pane × client) and the pane resumes
    //   - an un-backpressured sendData credits synchronously (void branch)
    //
    // This tests the WIRING PATTERN, not createSessionProxy directly (since createSessionProxy
    // creates its own TmuxHost internally and can't easily accept a fake host).
    // -------------------------------------------------------------------------
    it("W3: drainingTransport pattern automatically calls fc.noteDrained on sendData", async () => {
        // tc-3si.1: no host needed — the flow controller takes a `send` callback,
        // and this test never exercises a path that would invoke it (the assertion
        // surface is drain accounting + demux fan-out).
        const HIGH = 500;
        const LOW = 100;
        const demuxW3 = createOutputDemux();
        // tc-3si.1: this test exercises drain accounting and never asserts on
        // pause/continue commands, so a never-resolving `send` stub is sufficient.
        const fcW3 = createFlowController(() => new Promise(() => { }), demuxW3, { highWaterBytes: HIGH, lowWaterBytes: LOW });
        // Accounting store with the PRODUCTION order (session-proxy.ts, tc-t4k1):
        // COUNT BEFORE FAN-OUT, so a synchronous credit can never precede its own
        // debit, and the crossing chunk is gated before it is fanned out.
        const accountingW3 = {
            append(pid, bytes) {
                if (bytes.length > 0)
                    fcW3.onPaneBytes(pid, bytes.length);
                demuxW3.store.append(pid, bytes);
            },
            getContents: demuxW3.store.getContents.bind(demuxW3.store),
            size: demuxW3.store.size.bind(demuxW3.store),
            drop: demuxW3.store.drop.bind(demuxW3.store),
            clear: demuxW3.store.clear.bind(demuxW3.store),
        };
        const P7 = paneId("p7");
        demuxW3.notifyPaneBound(P7);
        // Scripted inner transport with SocketTransport's backpressure contract:
        // while `backpressured`, sendData returns a shared pending Promise that
        // resolves on "drain".
        const { sessionProxy: rawSessionProxy, client: clientW3 } = createInMemoryTransportPair();
        clientW3.onData(() => { }); // sink
        let backpressured = true;
        let drainResolve = null;
        let drainPromise = null;
        /** The socket "drains": release the shared drain promise (SocketTransport's contract). */
        function releaseDrain() {
            const r = drainResolve;
            drainPromise = null;
            drainResolve = null;
            assert.ok(r !== null, "W3: precondition — backpressured sends must have deferred on the drain promise");
            r();
        }
        const innerW3 = {
            ...rawSessionProxy,
            sendData(pid, bytes) {
                void rawSessionProxy.sendData(pid, bytes);
                if (!backpressured || bytes.length === 0)
                    return undefined;
                if (drainPromise === null) {
                    drainPromise = new Promise((res) => {
                        drainResolve = res;
                    });
                }
                return drainPromise;
            },
        };
        // The drainingTransport pattern from createSessionProxy.addClient: register
        // the client and credit ITS sub-ledger when its transport drains (tc-0wtb).
        fcW3.addClient(innerW3);
        const drainingTransport = {
            ...innerW3,
            sendData(pid, bytes) {
                const result = innerW3.sendData(pid, bytes);
                if (bytes.length === 0)
                    return result;
                if (result !== undefined && typeof result.then === "function") {
                    return result.then(() => {
                        fcW3.noteDrained(pid, bytes.length, innerW3);
                    });
                }
                fcW3.noteDrained(pid, bytes.length, innerW3);
                return undefined;
            },
        };
        demuxW3.attachTransport(drainingTransport);
        // Flood in 150-byte chunks against the backpressured client. Chunks 1–3
        // (450 bytes) are fanned out with their credits DEFERRED on the pending
        // drain promise; chunk 4 crosses HIGH inside onPaneBytes, pauses the pane
        // BEFORE its own fan-out (the crossing chunk is gate-dropped and never
        // credited), and clamps the sub-ledger to HIGH (FC-4, tc-2ztp).
        const chunk = new Uint8Array(150).fill(0xBB);
        for (let i = 0; i < 4; i++)
            accountingW3.append(P7, chunk);
        assert.equal(fcW3.isPanePaused(P7), true, "W3: pane must be paused after flood");
        assert.equal(fcW3.bufferedBytes(P7), HIGH, "W3: no credit may fire before the real drain (counter clamps to HIGH at the pause edge)");
        // The socket drains: the deferred credits (3 × 150 = 450) fire against
        // this client's sub-ledger → 500 − 450 = 50 ≤ LOW → auto-resume.
        backpressured = false;
        releaseDrain();
        await new Promise((res) => setImmediate(res)); // run the credit microtasks
        assert.equal(fcW3.bufferedBytes(P7), HIGH - 3 * chunk.length, "W3: deferred credits must debit exactly the fanned-out bytes on drain");
        assert.equal(fcW3.isPanePaused(P7), false, "W3: pane must resume once the deferred credits fall to/below low-water");
        assert.equal(demuxW3.isPanePaused(P7), false, "W3: demux gate must be open after resume");
        // Un-backpressured append: the void branch credits synchronously, so the
        // counter returns to the pre-append residue immediately.
        const preCounter = fcW3.bufferedBytes(P7);
        accountingW3.append(P7, new Uint8Array(30).fill(0xCC));
        assert.equal(fcW3.bufferedBytes(P7), preCounter, "W3: the sync credit must land within the append (count → fan-out → drain)");
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
            const snapshot = controlMessages.find((m) => m.type === "snapshot");
            assert.ok(snapshot !== undefined, "snapshot must arrive via scripted session");
        }
        finally {
            await cleanup();
        }
    });
    it("server.clientCount() tracks connected clients correctly", async () => {
        const sess = await wireScriptedSession();
        try {
            assert.equal(sess.server.clientCount(), 1, "should have 1 client after addClient");
            sess.server.removeClient(sess.sessionProxyTransport);
            assert.equal(sess.server.clientCount(), 0, "should have 0 clients after removeClient");
        }
        finally {
            await sess.cleanup();
        }
    });
    // ---------------------------------------------------------------------------
    // tc-3si.6: latency/throughput histograms + process health in the exposition.
    //
    // Wire a session-proxy through the same scripted-host path, but attach a
    // SessionProxyRegistry to the pipeline + server, drive a bootstrap cycle,
    // and assert the exposition exposes all the families the bead requires
    // (notify-to-delta histogram with edge label, command_round_trip with
    // kind label, deltas_emitted_total, output_bytes_total + frame-size,
    // session_paused_seconds_total, default metrics).
    // ---------------------------------------------------------------------------
    it("tc-3si.6: pipeline + server expose tc-3si.6 histograms via registry.metrics()", async () => {
        const reg = createSessionProxyRegistry();
        const host = createScriptedHost();
        const demux = createOutputDemux();
        const pipeline = createRuntimePipeline(host, {
            buffers: demux.store,
            metrics: reg,
        });
        const server = createControlServer(pipeline, { metrics: reg });
        await host.start();
        await pipeline.start();
        // Attach a client so deltas_fanned_out_total{client="c1"} has a slot.
        const { sessionProxyTransport, clientTransport } = createRecordingPair();
        demux.attachTransport(sessionProxyTransport);
        const addPromise = server.addClient(sessionProxyTransport);
        const clientHandshake = runClientHandshake(clientTransport, CLIENT_CAPS);
        await Promise.all([addPromise, clientHandshake]);
        // Yield so the bootstrap cycle's snapshot + deltas land on the client
        // (deltas_fanned_out_total ticks once per delta send).
        await new Promise((r) => setImmediate(r));
        const text = await reg.metrics();
        // tc-3si.6 — every required family is present in the exposition.
        assert.ok(text.includes("command_round_trip_seconds"), "exposition must contain command_round_trip_seconds histogram");
        // The bootstrap requery issued list-windows + list-panes via the wrapped
        // submit closure — both show up with kind labels.
        assert.ok(text.includes('kind="list-windows"'), "command_round_trip_seconds must have a kind=list-windows sample after bootstrap");
        assert.ok(text.includes('kind="list-panes"'), "command_round_trip_seconds must have a kind=list-panes sample after bootstrap");
        assert.ok(text.includes("topology_notify_to_delta_seconds"), "exposition must contain topology_notify_to_delta_seconds histogram");
        assert.ok(text.includes("deltas_emitted_total"), "exposition must contain deltas_emitted_total counter");
        assert.ok(text.includes("output_bytes_total"), "exposition must contain output_bytes_total counter");
        assert.ok(text.includes("output_frame_size_bytes"), "exposition must contain output_frame_size_bytes histogram");
        assert.ok(text.includes("session_paused_seconds_total"), "exposition must contain session_paused_seconds_total counter");
        // Default metrics (event-loop lag, heap, CPU). Names are stable across
        // prom-client versions.
        assert.ok(text.includes("nodejs_eventloop_lag_seconds") ||
            text.includes("nodejs_eventloop_lag"), "exposition must contain default event-loop lag metric (load-bearing for tc-2x3)");
        assert.ok(text.includes("process_cpu_user_seconds_total") ||
            text.includes("process_cpu_seconds_total"), "exposition must contain default process CPU metric");
        // Bootstrap should have emitted deltas; counter should be > 0.
        const emittedMatch = text.match(/^deltas_emitted_total (\d+)$/m);
        assert.ok(emittedMatch !== null && Number(emittedMatch[1]) > 0, `deltas_emitted_total should be > 0 after bootstrap; got match:\n${emittedMatch?.[0] ?? "(none)"}`);
        // Cardinality rule: no per-pane labels on the aggregate output metrics.
        assert.ok(!/output_bytes_total\{[^}]*pane=/.test(text) &&
            !/output_frame_size_bytes\{[^}]*pane=/.test(text), "aggregate output metrics must not carry a `pane` label (cardinality rule)");
        pipeline.stop();
        sessionProxyTransport.close();
        clientTransport.close();
        host.kill();
        await host.waitForExit();
        reg.stop();
    });
});
// ===========================================================================
// Suite 3 — Real tmux 3.4 smoke test (guarded)
// ===========================================================================
const tmuxAvailable = (() => {
    try {
        const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
        return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
    }
    catch {
        return false;
    }
})();
const REAL_RUN_SUFFIX = `${Date.now()}`;
function realSockName(label) {
    // tc-bpn — shape: tmuxcc-test-<pid>-<suffix> required by test-tmux-cleanup.
    const sock = `tmuxcc-test-${process.pid}-int-${REAL_RUN_SUFFIX}-${label}`;
    // tc-blk — track BEFORE the session-proxy is created so a thrown test still gets
    // its server reaped via the process-exit / top-level after() net.
    trackSocket(sock);
    return sock;
}
function killRealServer(sock) {
    killTmuxServer(sock);
}
/** Poll a Buffer accumulator until predicate returns true or timeout. */
function waitForBuffer(chunks, predicate, timeoutMs, msg) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
            if (predicate(all))
                return resolve();
            if (Date.now() > deadline)
                return reject(new Error(`Timeout (${timeoutMs}ms): ${msg}`));
            setTimeout(check, 50);
        };
        check();
    });
}
describe("tc-93a: Real tmux 3.4 smoke test", { skip: !tmuxAvailable ? "tmux not found on PATH" : false }, () => {
    // -------------------------------------------------------------------------
    // R1. Snapshot on connect — real tmux session has ≥1 window, ≥1 pane
    // -------------------------------------------------------------------------
    it("R1: snapshot reflects a real tmux session (≥1 window, ≥1 pane)", async () => {
        const sock = realSockName("snap");
        after(() => killRealServer(sock));
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "r1session", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => { }); // suppress unhandled error events
        await sessionProxy.start();
        const { sessionProxyTransport: dt, clientTransport: ct, controlMessages } = createRecordingPair();
        sessionProxy.demux.attachTransport(dt);
        const addPromise = sessionProxy.server.addClient(dt);
        const clientPromise = runClientHandshake(ct, CLIENT_CAPS);
        await Promise.all([addPromise, clientPromise]);
        // Snapshot should already be in controlMessages (sent synchronously after handshake).
        const snapshot = controlMessages.find((m) => m.type === "snapshot");
        assert.ok(snapshot !== undefined, "real tmux session must produce a snapshot");
        assert.equal(snapshot.seq, 1, "snapshot seq must be 1");
        assert.ok(snapshot.session !== undefined, "real session must have a session in snapshot");
        assert.ok(snapshot.windows.length >= 1, "real session must have ≥1 window in snapshot");
        assert.ok(snapshot.panes.length >= 1, "real session must have ≥1 pane in snapshot");
        sessionProxy.kill();
        await new Promise((r) => { sessionProxy.host.onExit(() => r()); });
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
        sessionProxy.host.onError(() => { });
        await sessionProxy.start();
        const { sessionProxyTransport: dt, clientTransport: ct, controlMessages, dataFrames } = createRecordingPair();
        sessionProxy.demux.attachTransport(dt);
        const addPromise = sessionProxy.server.addClient(dt);
        const clientPromise = runClientHandshake(ct, CLIENT_CAPS);
        await Promise.all([addPromise, clientPromise]);
        // Get the first pane id from the snapshot.
        const snapshot = controlMessages.find((m) => m.type === "snapshot");
        assert.ok(snapshot !== undefined, "snapshot must arrive before sending keys");
        assert.ok(snapshot.panes.length >= 1, "must have at least 1 pane to send keys to");
        const firstPane = snapshot.panes[0];
        // Convert wire PaneId to tmux numeric: "p1" → "%1"
        const wirePaneId = firstPane.paneId;
        const tmuxPaneNum = parseInt(wirePaneId.slice(1), 10);
        // Send a visible command that produces output through the slotted pipeline path (tc-3si.9).
        void sessionProxy.send(`send-keys -H -t %${tmuxPaneNum} 68 69 0A`); // "hi\n" in hex
        // Wait for data frames to arrive (with a generous timeout for real tmux latency).
        await waitFor(() => dataFrames.length > 0 ? dataFrames : undefined, 8000, "no data frames received from real tmux pane within 8s");
        assert.ok(dataFrames.length > 0, "data plane must receive bytes from real tmux pane output");
        sessionProxy.kill();
        await new Promise((r) => { sessionProxy.host.onExit(() => r()); });
    });
    // -------------------------------------------------------------------------
    // R3. Clean teardown — no leaked tmux servers
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // R4 (tc-3si.6). session-proxy.info exposition surfaces all the
    // tc-3si.6 metric families. End-to-end through createSessionProxy → real
    // tmux → metricsRegistry.metrics() consumed by the .info command path.
    // -------------------------------------------------------------------------
    it("R4 (tc-3si.6): session-proxy.info exposition carries the tc-3si.6 metric families", async () => {
        const sock = realSockName("info-metrics");
        after(() => killRealServer(sock));
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "r4session", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => { });
        await sessionProxy.start();
        // Drive the exposition directly from the registry (the same string the
        // session-proxy.info command would emit — see runtime/session-proxy.ts
        // command.request handler). The real-tmux path is what we're verifying:
        // the registry has been populated by real list-* round-trips and a
        // real bootstrap delta emission.
        const text = await sessionProxy.metrics.metrics();
        assert.ok(text.includes("command_round_trip_seconds"), "info must include command_round_trip_seconds");
        assert.ok(text.includes('kind="list-windows"'), "info must include kind=list-windows histogram entry");
        assert.ok(text.includes('kind="list-panes"'), "info must include kind=list-panes histogram entry");
        assert.ok(text.includes("topology_notify_to_delta_seconds"), "info must include topology_notify_to_delta_seconds");
        assert.ok(text.includes("deltas_emitted_total"), "info must include deltas_emitted_total");
        assert.ok(text.includes("output_bytes_total"), "info must include output_bytes_total");
        assert.ok(text.includes("output_frame_size_bytes"), "info must include output_frame_size_bytes");
        assert.ok(text.includes("session_paused_seconds_total"), "info must include session_paused_seconds_total");
        assert.ok(text.includes("nodejs_eventloop_lag_seconds") || text.includes("nodejs_eventloop_lag"), "info must include default event-loop lag metric");
        sessionProxy.kill();
        await new Promise((r) => { sessionProxy.host.onExit(() => r()); });
    });
    it("R3: clean teardown — host bridge exits cleanly via sessionProxy.stop(); server killed explicitly", async () => {
        const sock = realSockName("teardown");
        after(() => killRealServer(sock)); // belt-and-suspenders
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "r3session", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => { });
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
        assert.ok(check.status !== 0, "tmux server should not be running after stop() + kill-server");
    });
    // -------------------------------------------------------------------------
    // R6 (tc-3si.11). Unexpected host exit must stop the storm alarm metronome
    // -------------------------------------------------------------------------
    it("R6: unexpected host exit stops the storm alarm (no leaked timer pins the process)", async () => {
        const sock = realSockName("alarmstop");
        after(() => killRealServer(sock));
        // Counting clock injected into the storm alarm: tracks armed timers so
        // the test can assert none survive teardown. The host-exit path used to
        // stop only the pipeline; the alarm's self-re-arming 1s tick then kept
        // the embedding process alive forever (wedged the vscode unit suite).
        const live = new Set();
        const countingClock = {
            now: () => Date.now(),
            setTimeout: (fn, ms) => {
                const h = globalThis.setTimeout(() => {
                    live.delete(h);
                    fn();
                }, ms);
                live.add(h);
                return h;
            },
            clearTimeout: (h) => {
                live.delete(h);
                globalThis.clearTimeout(h);
            },
        };
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "r6session", cols: 80, rows: 24 },
            stormAlarm: { clock: countingClock },
        });
        sessionProxy.host.onError(() => { });
        await sessionProxy.start();
        assert.ok(live.size >= 1, "storm alarm tick must be armed after start()");
        // Kill the tmux SERVER externally — teardown must flow through
        // host.onExit, NOT stop()/kill() (the leak was specific to that path).
        killRealServer(sock);
        await new Promise((r) => { sessionProxy.host.onExit(() => r()); });
        // Our onExit handler may run before the session-proxy's own; yield so
        // the proxy's exit teardown (alarm/registry/pipeline stop) completes.
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(live.size, 0, "no storm-alarm timer may remain armed after host exit");
    });
    // -------------------------------------------------------------------------
    // R7 (tc-ozk.1). LOAD-BEARING PROOF: split → bind-by-returned-ID.
    //
    // The whole bead in one test: issue a `split-pane` verb, get the created
    // pane id back IN THE command.response (driver RETURNS its effect), then
    // BIND by that returned id — assert the pane the model materialises is
    // exactly the one the verb said it created.  ZERO observer machinery is
    // engaged: there is no observeNextPaneOpen / beginOwnVerb claim anywhere in
    // this path; binding is purely by the returned id.
    //
    // We deliberately use `sessionProxy.addClient` (the full assembly) because
    // that is where the verb responder is wired (runtime/session-proxy.ts) —
    // `server.addClient` alone would not install it.
    //
    // The verb reply may arrive before OR after the pane's pane.opened delta;
    // we bind by id whenever the pane appears, asserting no ordering dependency.
    // -------------------------------------------------------------------------
    it("R7 (tc-ozk.1): split verb RETURNS the created pane id; bind-by-returned-id finds it (zero observer machinery)", async () => {
        const sock = realSockName("split-bind");
        after(() => killRealServer(sock));
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "r7session", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => { });
        await sessionProxy.start();
        const { sessionProxyTransport: dt, clientTransport: ct, controlMessages } = createRecordingPair();
        sessionProxy.demux.attachTransport(dt);
        // IMPORTANT: sessionProxy.addClient (assembly) installs the verb responder.
        const addPromise = sessionProxy.addClient(dt);
        const clientPromise = runClientHandshake(ct, CLIENT_CAPS);
        await Promise.all([addPromise, clientPromise]);
        // Baseline: snapshot must carry exactly the bootstrap pane.
        const snapshot = controlMessages.find((m) => m.type === "snapshot");
        assert.ok(snapshot !== undefined, "snapshot must arrive before splitting");
        assert.ok(snapshot.panes.length >= 1, "need a pane to split");
        const sourcePane = snapshot.panes[0].paneId;
        const preExistingPaneIds = new Set(snapshot.panes.map((p) => p.paneId));
        // Issue the split verb from the CLIENT side with a known correlationId.
        const correlationId = "verb-split-1";
        const req = {
            type: "command.request",
            seq: 1,
            correlationId,
            command: { kind: "split-pane", paneId: sourcePane, direction: "horizontal" },
        };
        ct.sendControl(req);
        // The driver RETURNS the effect: a command.response with the created ids.
        const response = (await waitFor(() => controlMessages.find((m) => m.type === "command.response" && m.correlationId === correlationId), 8000, "no command.response for the split verb within 8s"));
        assert.equal(response.result.ok, true, `split verb must succeed; got ${JSON.stringify(response.result)}`);
        assert.ok(response.result.ok === true);
        const returnedPaneId = response.result.payload?.paneId;
        const returnedWindowId = response.result.payload?.windowId;
        assert.ok(returnedPaneId !== undefined, "split verb must RETURN the created paneId");
        assert.ok(returnedWindowId !== undefined, "split verb must RETURN the created windowId");
        // The returned pane must be a NEW pane (not the one we split).
        assert.ok(!preExistingPaneIds.has(returnedPaneId), `returned paneId ${returnedPaneId} must be a newly-created pane, not a pre-existing one`);
        // BIND-BY-RETURNED-ID: the model must materialise a pane with EXACTLY the
        // returned id (it may arrive before or after the verb reply — we poll).
        // This is the proof the host can bind by the returned id with no observer.
        const boundPane = await waitFor(() => sessionProxy.pipeline.getModel().panes.get(returnedPaneId), 8000, `model never materialised a pane for the returned id ${returnedPaneId}`);
        assert.ok(boundPane !== undefined, "bind-by-returned-id must find the created pane in the model");
        // Cross-check against tmux ground truth: the returned wire id "p<N>" must
        // correspond to a real tmux pane "%N" that exists in the session.
        const tmuxPaneNum = parseInt(returnedPaneId.slice(1), 10);
        const list = spawnSync("tmux", ["-L", sock, "list-panes", "-s", "-t", "r7session", "-F", "#{pane_id}"], { encoding: "utf8", timeout: 4000 });
        assert.equal(list.status, 0, `list-panes failed: ${list.stderr}`);
        const realPaneIds = (list.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        assert.ok(realPaneIds.includes(`%${tmuxPaneNum}`), `returned pane %${tmuxPaneNum} must exist in real tmux; tmux has: ${realPaneIds.join(", ")}`);
        sessionProxy.kill();
        await new Promise((r) => { sessionProxy.host.onExit(() => r()); });
    });
    // -------------------------------------------------------------------------
    // R8 (tc-4b6k.2, D3). LOAD-BEARING PROOF: per-client binding intent.
    //
    // Two clients presenting DIFFERENT durable identities attach to ONE real
    // tmux session. One binds a pane; the AC is that the two clients see
    // INDEPENDENT bound state for that pane, canonically, across reload:
    //   - the binder's delta stream flips the pane to bound=true;
    //   - the other client sees NO bound change (its slot is untouched);
    //   - a FRESH connection presenting the binder's identity (a VS Code reload —
    //     same workspace-derived id) re-reads bound=true from tmux;
    //   - a fresh connection presenting the other identity re-reads bound=false.
    //
    // This is the S1 dissolution: "bound in window A, detached in window B" is a
    // legal canonical state, not an illegal one reconciled after the fact.
    // -------------------------------------------------------------------------
    it("R8 (tc-4b6k.2): two identities see independent per-client bound state, canonical across reload", async () => {
        const sock = realSockName("per-client-bind");
        after(() => killRealServer(sock));
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "r8session", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => { });
        await sessionProxy.start();
        // Connect a client presenting a durable identity; returns its recorder and
        // the paneId of the first pane in its snapshot.
        const connect = async (identityId) => {
            const { sessionProxyTransport: dt, clientTransport: ct, controlMessages } = createRecordingPair();
            sessionProxy.demux.attachTransport(dt);
            // sessionProxy.addClient (full assembly) installs the verb responder AND
            // runs the per-client binding connect-read (applyClientBinding).
            const addPromise = sessionProxy.addClient(dt);
            const clientPromise = runClientHandshake(ct, CLIENT_CAPS, "session-proxy.capabilities", { id: identityId });
            await Promise.all([addPromise, clientPromise]);
            const snapshot = controlMessages.find((m) => m.type === "snapshot");
            assert.ok(snapshot !== undefined, `client ${identityId} must receive a snapshot`);
            return { ct, controlMessages, snapshot: snapshot };
        };
        const boundInSnapshot = (snapshot, pid) => snapshot.panes.find((p) => p.paneId === pid)?.bound === true;
        // --- Two clients with distinct identities attach to the same session. ---
        const alpha = await connect("ws-alpha");
        const beta = await connect("ws-beta");
        const pane = alpha.snapshot.panes[0].paneId;
        assert.equal(boundInSnapshot(alpha.snapshot, pane), false, "alpha starts unbound");
        assert.equal(boundInSnapshot(beta.snapshot, pane), false, "beta starts unbound");
        // --- alpha binds the pane (durable per-client write + optimistic delta). ---
        const correlationId = "verb-bind-1";
        alpha.ct.sendControl({
            type: "command.request",
            seq: 2,
            correlationId,
            command: { kind: "set-object-policy", scope: "pane", paneId: pane, option: "bound", value: "1" },
        });
        const response = (await waitFor(() => alpha.controlMessages.find((m) => m.type === "command.response" && m.correlationId === correlationId), 8000, "no command.response for the bind verb within 8s"));
        assert.equal(response.result.ok, true, `bind verb must succeed; got ${JSON.stringify(response.result)}`);
        // alpha's delta stream flips the pane to bound=true for ITS identity.
        const alphaBoundDelta = await waitFor(() => alpha.controlMessages.find((m) => m.type === "pane.policy-changed" && m.paneId === pane && m.bound === true), 8000, "alpha never saw its pane.policy-changed bound=true");
        assert.ok(alphaBoundDelta !== undefined, "alpha must see bound=true for the pane it bound");
        // beta (a DIFFERENT identity, still connected) must NOT see a bound flip —
        // its per-client slot is untouched. Give the delta pipeline time to run.
        await new Promise((r) => setTimeout(r, 300));
        const betaSawBound = beta.controlMessages.some((m) => m.type === "pane.policy-changed" && m.paneId === pane && m.bound === true);
        assert.equal(betaSawBound, false, "beta must NOT see alpha's binding — independent per-client state");
        // --- Canonical across reload: fresh connections re-read from tmux. ---
        const alphaReload = await connect("ws-alpha");
        assert.equal(boundInSnapshot(alphaReload.snapshot, pane), true, "a reloaded alpha (same identity) re-reads bound=true canonically from tmux");
        const betaReload = await connect("ws-beta");
        assert.equal(boundInSnapshot(betaReload.snapshot, pane), false, "a reloaded beta (different identity) sees bound=false — binding did not leak across identities");
        sessionProxy.kill();
        await new Promise((r) => { sessionProxy.host.onExit(() => r()); });
    });
    // -------------------------------------------------------------------------
    // R9 (tc-76m8.2). Read-only client behavioral transcript.
    //
    // A client that attaches with flags.readOnly = true is subject to two
    // enforcement regimes installed by sessionProxy.addClient (D4, §2.1):
    //
    //   1. SILENT SWALLOW  — `input.*` messages are dropped; no response.
    //   2. LOUD REJECTION  — mutating `command.request` verbs produce
    //                        command.response { ok: false, code: "read-only" }.
    //   3. READS PASS      — snapshot, `session-proxy.info`, `pane.capture` etc.
    //                        flow normally (handled BEFORE the readOnly gate).
    //
    // A concurrent full-access client (no flags) must be completely unaffected.
    //
    // The D9 feature string "client-read-only" is advertised in the
    // session-proxy's DEFAULT_CAPABILITIES so the extension can offer the mode
    // only when the driver supports it.
    // -------------------------------------------------------------------------
    it("R9 (tc-76m8.2): read-only client behavioral transcript — input swallowed, verbs rejected, reads pass; full client unaffected", async () => {
        const sock = realSockName("read-only");
        after(() => killRealServer(sock));
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "r9session", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => { });
        await sessionProxy.start();
        // ── read-only client ─────────────────────────────────────────────────
        const { sessionProxyTransport: roDt, clientTransport: roCt, controlMessages: roMsgs, } = createRecordingPair();
        sessionProxy.demux.attachTransport(roDt);
        // flags.readOnly activates the two-regime enforcement in addClient's
        // onControl handler.
        const roAddPromise = sessionProxy.addClient(roDt, { flags: { readOnly: true } });
        const roClientPromise = runClientHandshake(roCt, CLIENT_CAPS);
        await Promise.all([roAddPromise, roClientPromise]);
        // ── AC: D9 feature string in session-proxy capabilities ──────────────
        // "client-read-only" is advertised by DEFAULT_CAPABILITIES so the
        // extension knows this driver supports the flag before offering the mode.
        // We check the raw session-proxy.capabilities message, not the negotiated
        // intersection (which depends on the CLIENT also advertising the string).
        const capMsg = roMsgs.find((m) => m.type === "session-proxy.capabilities");
        assert.ok(capMsg !== undefined, "session-proxy.capabilities must be present in outbound messages");
        assert.ok(capMsg.capabilities.features.includes("client-read-only"), `"client-read-only" must be in session-proxy.capabilities.features; got: ${capMsg.capabilities.features.join(", ")}`);
        // ── AC: snapshot flows normally for the read-only client ─────────────
        const roSnapshot = await waitFor(() => roMsgs.find((m) => m.type === "snapshot"), 6000, "read-only client must receive a snapshot");
        assert.ok(roSnapshot.panes.length >= 1, "snapshot must contain at least one pane");
        const sourcePane = roSnapshot.panes[0].paneId;
        // ── AC: input is silently swallowed (no command.response or error) ──────
        // The gate in session-proxy.ts returns immediately.  Other delta messages
        // (pane.title-changed, focus.changed, etc.) may still arrive from the
        // live tmux session — we only assert that NO `command.response` or
        // `error` message is emitted in reaction to the input.
        const rejectCountBefore = roMsgs.filter((m) => m.type === "command.response" || m.type === "error").length;
        roCt.sendControl({
            type: "input",
            seq: 2,
            paneId: sourcePane,
            data: "this keystroke must be swallowed",
        });
        await new Promise((r) => setTimeout(r, 300));
        const rejectCountAfter = roMsgs.filter((m) => m.type === "command.response" || m.type === "error").length;
        assert.equal(rejectCountAfter, rejectCountBefore, "input to a read-only client must be silently dropped — no command.response or error may be emitted");
        // ── AC: mutating verb is rejected with typed error ────────────────────
        const roVerbCid = "ro-split-1";
        roCt.sendControl({
            type: "command.request",
            seq: 3,
            correlationId: roVerbCid,
            command: { kind: "split-pane", paneId: sourcePane, direction: "horizontal" },
        });
        const roReject = (await waitFor(() => roMsgs.find((m) => m.type === "command.response" &&
            m.correlationId === roVerbCid), 4000, "read-only client must receive command.response for its split verb"));
        assert.equal(roReject.result.ok, false, "split-pane verb on read-only client must be rejected");
        assert.equal(roReject.result.ok === false ? roReject.result.code : "", "read-only", `rejection code must be "read-only"; got: ${JSON.stringify(roReject.result)}`);
        // ── AC: reads are exempt — session-proxy.info succeeds ───────────────
        // session-proxy.info is handled BEFORE the readOnly gate in session-proxy.ts
        // (it's a pure diagnostics read, no tmux mutation).
        const roInfoCid = "ro-info-1";
        roCt.sendControl({
            type: "command.request",
            seq: 4,
            correlationId: roInfoCid,
            command: { kind: "session-proxy.info" },
        });
        const roInfo = (await waitFor(() => roMsgs.find((m) => m.type === "command.response" &&
            m.correlationId === roInfoCid), 4000, "session-proxy.info must succeed for a read-only client"));
        assert.equal(roInfo.result.ok, true, `session-proxy.info must succeed for a read-only client; got: ${JSON.stringify(roInfo.result)}`);
        // ── full client is unaffected ─────────────────────────────────────────
        // A concurrent full-access client (no readOnly flag) must be able to send
        // mutating verbs and have them succeed, proving the flag is per-client.
        const { sessionProxyTransport: fullDt, clientTransport: fullCt, controlMessages: fullMsgs, } = createRecordingPair();
        sessionProxy.demux.attachTransport(fullDt);
        const fullAddPromise = sessionProxy.addClient(fullDt);
        const fullClientPromise = runClientHandshake(fullCt, CLIENT_CAPS);
        await Promise.all([fullAddPromise, fullClientPromise]);
        // Wait for the full client's snapshot so we know the session is ready.
        await waitFor(() => fullMsgs.find((m) => m.type === "snapshot"), 6000, "full client must receive a snapshot");
        const fullVerbCid = "full-split-1";
        fullCt.sendControl({
            type: "command.request",
            seq: 2,
            correlationId: fullVerbCid,
            command: { kind: "split-pane", paneId: sourcePane, direction: "horizontal" },
        });
        const fullResponse = (await waitFor(() => fullMsgs.find((m) => m.type === "command.response" &&
            m.correlationId === fullVerbCid), 8000, "concurrent full client must receive command.response for its split verb"));
        assert.equal(fullResponse.result.ok, true, `concurrent full client's split-pane must succeed; got: ${JSON.stringify(fullResponse.result)}`);
        sessionProxy.kill();
        await new Promise((r) => { sessionProxy.host.onExit(() => r()); });
    });
});
//# sourceMappingURL=integration.test.js.map