/**
 * Tests for TmuxHost (tc-kyp).
 *
 * Two test suites:
 *
 * 1. Hermetic (fake-tmux): exercises pipe/lifecycle/onData/onExit plumbing
 *    against fake-tmux.js — a synthetic fixture that emits canned control-mode
 *    bytes. Spawned directly as a plain child process (piped stdio, no PTY).
 *    Deterministic; no real tmux dependency.
 *
 * 2. Real tmux 3.4: spawns actual tmux on a private socket, verifies the DCS
 *    intro arrives, write() is accepted, stop()/kill() cleanly terminates.
 *    Guarded by tmux availability. Always tears down the server in after().
 *
 * NOTE: the hermetic suite bypasses TmuxHostImpl and wires directly to the
 * child_process so the PTY bridge is NOT involved. That isolates plumbing from
 * the bridge. The real-tmux suite uses createTmuxHost() end-to-end (bridge
 * included).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnProc, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createTmuxHost } from "./tmux-host.js";
// tc-blk — process-level safety net for real-tmux test sockets.
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const FAKE_TMUX = join(__dir, "fixtures", "fake-tmux.js");
function spawnFake(opts = {}) {
    const args = [FAKE_TMUX];
    if (opts.exitCode !== undefined)
        args.push("--exit-code", String(opts.exitCode));
    const proc = spawnProc(process.execPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
    });
    const dataHandlers = new Set();
    const exitHandlers = new Set();
    let _exited = false;
    let _code = null;
    let _signal = null;
    proc.stdout.on("data", (chunk) => {
        const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (const h of dataHandlers) {
            try {
                h(u8);
            }
            catch { /**/ }
        }
    });
    proc.on("close", (code, signal) => {
        _exited = true;
        _code = code;
        _signal = signal;
        for (const h of exitHandlers) {
            try {
                h(code, signal);
            }
            catch { /**/ }
        }
    });
    return {
        get pid() { return proc.pid; },
        get exited() { return _exited; },
        write(data) { proc.stdin.write(data, "utf8"); },
        onData(h) { dataHandlers.add(h); return () => { dataHandlers.delete(h); }; },
        onExit(h) {
            if (_exited) {
                process.nextTick(() => h(_code, _signal));
                return () => { };
            }
            exitHandlers.add(h);
            return () => { exitHandlers.delete(h); };
        },
        stop() {
            if (_exited)
                return Promise.resolve();
            return new Promise((resolve) => {
                const done = () => resolve();
                exitHandlers.add(done);
                proc.stdin.end();
                const t = setTimeout(() => { if (!_exited)
                    proc.kill("SIGKILL"); }, 3000);
                t.unref();
            });
        },
        kill(sig = "SIGKILL") { if (!_exited)
            proc.kill(sig); },
        waitForExit() {
            if (_exited)
                return Promise.resolve({ code: _code, signal: _signal });
            return new Promise((resolve) => {
                exitHandlers.add((code, signal) => resolve({ code, signal }));
            });
        },
    };
}
// ---------------------------------------------------------------------------
// Suite 1 — Hermetic (fake-tmux, piped stdio, no PTY bridge)
// ---------------------------------------------------------------------------
describe("TmuxHost — hermetic (fake-tmux)", () => {
    it("pid is defined and positive", async () => {
        const host = spawnFake();
        assert.ok(host.pid !== undefined && host.pid > 0, "pid should be positive number");
        await host.stop();
    });
    it("exited is false while running, true after stop", async () => {
        const host = spawnFake();
        assert.equal(host.exited, false);
        await host.stop();
        assert.equal(host.exited, true);
    });
    it("onData receives raw Uint8Array chunks", async () => {
        const host = spawnFake();
        const types = new Set();
        host.onData((c) => types.add(Object.prototype.toString.call(c)));
        host.write("quit\n");
        await host.waitForExit();
        assert.ok(types.size > 0, "should receive at least one chunk");
        for (const t of types) {
            assert.equal(t, "[object Uint8Array]", `chunk type should be Uint8Array, got ${t}`);
        }
    });
    it("stdout contains the DCS intro \\x1bP1000p", async () => {
        const host = spawnFake();
        const chunks = [];
        host.onData((c) => chunks.push(c));
        host.write("quit\n");
        await host.waitForExit();
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        const dcs = Buffer.from([0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]);
        assert.ok(all.indexOf(dcs) >= 0, `DCS intro not found; got: ${all.slice(0, 40).toString("hex")}`);
    });
    it("stdout contains %begin, %end, %sessions-changed, %exit", async () => {
        const host = spawnFake();
        const chunks = [];
        host.onData((c) => chunks.push(c));
        host.write("quit\n");
        await host.waitForExit();
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
        assert.ok(all.includes("%begin"), "should contain %begin");
        assert.ok(all.includes("%end"), "should contain %end");
        assert.ok(all.includes("%sessions-changed"), "should contain %sessions-changed");
        assert.ok(all.includes("%exit"), "should contain %exit on quit");
    });
    it("write() sends a command and response arrives via onData", async () => {
        const host = spawnFake();
        const chunks = [];
        host.onData((c) => chunks.push(c));
        host.write("list-sessions\n");
        // Allow fake-tmux time to respond, then quit
        await new Promise((r) => setTimeout(r, 80));
        host.write("quit\n");
        await host.waitForExit();
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
        assert.ok(all.includes("list-sessions"), "echoed command body should appear in output");
    });
    it("onExit fires with code 0 on clean stop", async () => {
        const host = spawnFake();
        let firedCode;
        let firedSignal;
        host.onExit((code, signal) => { firedCode = code; firedSignal = signal; });
        host.write("quit\n");
        await host.waitForExit();
        assert.equal(firedCode, 0, "exit code should be 0");
        assert.equal(firedSignal, null, "exit signal should be null");
    });
    it("onExit fires with non-zero code when fake exits with error", async () => {
        const host = spawnFake({ exitCode: 42 });
        let firedCode;
        host.onExit((code) => { firedCode = code; });
        host.write("quit\n");
        await host.waitForExit();
        assert.equal(firedCode, 42, "should surface exit code 42");
    });
    it("stop() is idempotent (safe to call twice)", async () => {
        const host = spawnFake();
        host.write("quit\n");
        const p1 = host.stop();
        const p2 = host.stop();
        await Promise.all([p1, p2]);
        assert.equal(host.exited, true);
    });
    it("kill() terminates the process", async () => {
        const host = spawnFake();
        assert.equal(host.exited, false);
        host.kill("SIGTERM");
        const { signal } = await host.waitForExit();
        assert.equal(host.exited, true);
        assert.ok(signal === "SIGTERM" || signal === null, "killed by signal or OS synthetic");
    });
    it("kill() is idempotent (safe to call multiple times)", async () => {
        const host = spawnFake();
        host.kill("SIGTERM");
        host.kill("SIGTERM");
        host.kill("SIGKILL");
        await host.waitForExit();
        assert.equal(host.exited, true);
    });
    it("onExit fires when registered after exit (next-tick delivery)", async () => {
        const host = spawnFake();
        host.write("quit\n");
        await host.waitForExit();
        let fired = false;
        host.onExit(() => { fired = true; });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(fired, true, "late onExit handler should fire on next tick");
    });
    it("unsubscribe from onData stops delivery", async () => {
        const host = spawnFake();
        const received = [];
        const unsub = host.onData((c) => received.push(c));
        // Unsub before any I/O
        unsub();
        host.write("quit\n");
        await host.waitForExit();
        assert.equal(received.length, 0, "no chunks should arrive after unsubscribe");
    });
});
// ---------------------------------------------------------------------------
// Suite 2 — Error paths via createTmuxHost (hermetic, no real tmux)
// ---------------------------------------------------------------------------
describe("TmuxHost — error paths", () => {
    it("onExit fires when tmux binary is not found (tc-2x3.1: node-pty spawns, exec fails, exits non-zero)", async () => {
        // node-pty.spawn() does NOT throw when the target binary does not exist.
        // Instead, start() resolves (forkpty succeeded), but the child process
        // immediately exits with a non-zero code because exec() of the nonexistent
        // binary fails.  onExit fires with exitCode !== 0.
        const host = createTmuxHost({
            socketName: `tmuxcc-test-${process.pid}-err-${Date.now()}`,
            sessionName: "tc-kyp-err",
            tmuxPath: "/nonexistent/tmux-xyz-404",
        });
        let exitFired = false;
        let exitCode = null;
        host.onExit((code) => { exitFired = true; exitCode = code; });
        host.onError(() => { });
        await host.start(); // must not throw
        // Wait for the quick exit
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(exitFired, "onExit should fire when the binary is not found");
        assert.notEqual(exitCode, 0, "exit code should be non-zero when binary not found");
    });
    it("write() throws before start()", () => {
        const host = createTmuxHost({
            socketName: `tmuxcc-test-${process.pid}-write-${Date.now()}`,
            sessionName: "tc-kyp-write-pre",
        });
        assert.throws(() => host.write("hello\n"), /before start/i);
    });
});
// ---------------------------------------------------------------------------
// Suite 3 — Real tmux 3.4 (environment-dependent)
// ---------------------------------------------------------------------------
const tmuxAvailable = (() => {
    try {
        const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
        return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
    }
    catch {
        return false;
    }
})();
const RUN_SUFFIX = `${Date.now()}`;
function sockName(label) {
    // tc-bpn — shape: tmuxcc-test-<pid>-<suffix> required by test-tmux-cleanup.
    const sock = `tmuxcc-test-${process.pid}-host-${RUN_SUFFIX}-${label}`;
    // tc-blk — track every real-tmux socket so a thrown / timed-out test still
    // has its server reaped via the process-exit / top-level after() net.
    trackSocket(sock);
    return sock;
}
function killServer(sock) {
    killTmuxServer(sock);
}
/** Wait for predicate over collected chunks to become true, or reject after ms. */
function waitFor(chunks, predicate, timeoutMs, msg) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
            if (predicate(all))
                return resolve();
            if (Date.now() > deadline)
                return reject(new Error(msg));
            setTimeout(check, 50);
        };
        check();
    });
}
const DCS_INTRO = Buffer.from([0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]);
describe("TmuxHost — real tmux 3.4", { skip: !tmuxAvailable ? "tmux not found on PATH" : false }, () => {
    it("start() spawns with defined pid", async () => {
        const sock = sockName("pid");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-pid" });
        host.onError(() => { });
        await host.start();
        assert.ok(typeof host.pid === "number" && host.pid > 0, "pid should be positive number");
        assert.equal(host.exited, false);
        host.kill();
        await new Promise((r) => { host.onExit(() => r()); });
    });
    it("stdout delivers the DCS intro \\x1bP1000p", async () => {
        const sock = sockName("dcs");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-dcs" });
        const chunks = [];
        host.onData((c) => chunks.push(c));
        host.onError(() => { });
        await host.start();
        await waitFor(chunks, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "DCS intro not received within 5s");
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        assert.ok(all.indexOf(DCS_INTRO) >= 0, "\\x1bP1000p DCS intro must appear in stdout");
        host.kill();
        await new Promise((r) => { host.onExit(() => r()); });
    });
    it("stdout chunks are Uint8Array (raw bytes)", async () => {
        const sock = sockName("raw");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-raw" });
        const types = new Set();
        host.onData((c) => types.add(Object.prototype.toString.call(c)));
        host.onError(() => { });
        await host.start();
        // Wait for at least one chunk
        await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error("no data chunk within 5s")), 5000);
            const check = () => {
                if (types.size > 0) {
                    clearTimeout(deadline);
                    return resolve();
                }
                setTimeout(check, 50);
            };
            check();
        });
        for (const t of types) {
            assert.equal(t, "[object Uint8Array]", `chunks must be Uint8Array; got ${t}`);
        }
        host.kill();
        await new Promise((r) => { host.onExit(() => r()); });
    });
    it("write() sends a command and a %begin response arrives", async () => {
        const sock = sockName("write");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-write" });
        const chunks = [];
        host.onData((c) => chunks.push(c));
        host.onError(() => { });
        await host.start();
        // Wait for DCS intro before sending commands
        await waitFor(chunks, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "DCS intro timeout before write");
        host.write("list-sessions\n");
        // Expect a second %begin (first is from startup, second from our cmd)
        await waitFor(chunks, (all) => {
            const s = all.toString("utf8");
            const count = (s.match(/%begin/g) ?? []).length;
            return count >= 2;
        }, 5000, "No %begin response to list-sessions within 5s");
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
        assert.ok(all.includes("%begin"), "should include %begin");
        assert.ok(all.includes("%end"), "should include %end");
        host.kill();
        await new Promise((r) => { host.onExit(() => r()); });
    });
    it("stop() terminates cleanly: exited=true, onExit fires", async () => {
        const sock = sockName("stop");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-stop" });
        host.onError(() => { });
        let exitFired = false;
        host.onExit(() => { exitFired = true; });
        await host.start();
        await new Promise((r) => setTimeout(r, 300));
        const t0 = Date.now();
        await host.stop();
        const elapsed = Date.now() - t0;
        assert.equal(host.exited, true, "exited must be true after stop()");
        assert.equal(exitFired, true, "onExit handler must fire");
        // Regression guard: a clean detach-client completes in tens of ms.
        // If stop() takes >= 1000ms it hit the SIGKILL fallback (3s), not the
        // graceful detach path.  1000ms gives ample margin for slow CI while
        // still catching the regression.
        assert.ok(elapsed < 1000, `stop() must detach cleanly (< 1000ms), not fall through to SIGKILL; elapsed=${elapsed}ms`);
    });
    it("kill() terminates with SIGKILL and onExit fires", async () => {
        const sock = sockName("kill");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-kill" });
        host.onError(() => { });
        let exitFired = false;
        host.onExit(() => { exitFired = true; });
        await host.start();
        host.kill("SIGKILL");
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("onExit not fired within 5s after SIGKILL")), 5000);
            host.onExit(() => { clearTimeout(t); resolve(); });
        });
        assert.equal(exitFired, true);
        assert.equal(host.exited, true);
    });
    it("kill() is idempotent", async () => {
        const sock = sockName("kill2");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-kill2" });
        host.onError(() => { });
        await host.start();
        host.kill("SIGTERM");
        host.kill("SIGTERM"); // no-op — should not throw
        host.kill("SIGKILL");
        await new Promise((r) => { host.onExit(() => r()); });
        assert.equal(host.exited, true);
    });
    it("tmux server is gone after kill-server teardown", async () => {
        const sock = sockName("cleanup");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-cleanup" });
        host.onError(() => { });
        await host.start();
        host.kill();
        await new Promise((r) => { host.onExit(() => r()); });
        killServer(sock);
        const r = spawnSync("tmux", ["-L", sock, "list-sessions"], {
            encoding: "utf8",
            timeout: 2000,
        });
        assert.notEqual(r.status, 0, "tmux server should be gone after kill-server");
    });
    // tc-4bv2: regression — attaching with an inherited $TMUX must NOT fail with
    // "%error … sessions should be nested with care, unset $TMUX to force" + an
    // immediate %exit. Before the fix the host inherited process.env wholesale,
    // so an extension host running inside a tmux session (CI / e2e / tmux-native
    // users) made `attach-session -CC` refuse and exit during bootstrap — the
    // requery's list-* slots never resolved and READY timed out. The host now
    // strips $TMUX / $TMUX_PANE from the spawned tmux's env.
    it("attaches under an inherited $TMUX (no nested-session %error) — tc-4bv2", async () => {
        const sock = sockName("nested");
        const sess = "tc-4bv2-nested";
        after(() => killServer(sock));
        // Pre-create an all-dead-pane session (the operator's reproducer): a pane
        // with remain-on-exit whose shell has exited.
        spawnSync("tmux", ["-L", sock, "new-session", "-d", "-s", sess], { timeout: 4000 });
        spawnSync("tmux", ["-L", sock, "set-option", "-t", sess, "remain-on-exit", "on"], { timeout: 4000 });
        spawnSync("tmux", ["-L", sock, "send-keys", "-t", sess, "exit", "Enter"], { timeout: 4000 });
        // Spin-wait for the corpse so the attach genuinely targets a dead pane.
        const deadline = Date.now() + 3000;
        let dead = false;
        while (Date.now() < deadline) {
            const r = spawnSync("tmux", ["-L", sock, "list-panes", "-t", sess, "-F", "#{pane_dead}"], {
                encoding: "utf8", timeout: 2000,
            });
            if (r.status === 0 && (r.stdout ?? "").trim() === "1") {
                dead = true;
                break;
            }
        }
        assert.equal(dead, true, "test setup: pane should be dead before attach");
        const host = createTmuxHost({
            socketName: sock,
            sessionName: sess,
            attach: true,
            // Simulate the EDH inheriting an outer tmux's environment.
            env: { TMUX: "/tmp/fake-tmux-socket,99999,0", TMUX_PANE: "%9" },
        });
        const chunks = [];
        host.onData((c) => chunks.push(c));
        host.onError(() => { });
        await host.start();
        await waitFor(chunks, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "DCS intro timeout (attach failed?)");
        // Issue the bootstrap-style query and require a clean %end reply.
        host.write("list-panes -s -t =" + sess + " -F '#{pane_id} #{pane_dead}'\n");
        await waitFor(chunks, (all) => (all.toString("utf8").match(/%end/g) ?? []).length >= 2, 5000, "no %end reply to list-panes (nested-attach %error?)");
        const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
        assert.ok(!text.includes("sessions should be nested"), `attach must not emit the nested-session %error; got:\n${text}`);
        assert.ok(text.includes("%0 1") || /%\d+ 1/.test(text), "list-panes should report the dead corpse");
        assert.equal(host.exited, false, "host must not have exited on attach");
        host.kill();
        await new Promise((r) => { host.onExit(() => r()); });
    });
    // tc-crnt.14: a non-EAGAIN/non-EIO error on the pty READ socket must be
    // routed to onError, NOT re-thrown by node-pty as an uncaughtException.
    //
    // node-pty's UnixTerminal installs ONE 'error' listener on its read socket
    // that ignores EAGAIN/EIO (benign pty-close) but RE-THROWS any other error
    // unless a SECOND 'error' listener exists (`listeners('error').length < 2`).
    // tmux-host wires onData/onExit (EventEmitter2 façades) but historically
    // registered NO raw 'error' listener, so a read fault during a teardown race
    // under rapid churn (e.g. EBADF as the -CC child exits) was re-thrown — and
    // in the tc-2x3.3 collapsed topology that exits the WHOLE server-proxy,
    // surfacing as the intermittent "server-proxy process crashed (exit code
    // signal)" (tc-crnt.14).  The fix registers a real 'error' listener that
    // routes the fault into the onError boundary.
    //
    // This test emits a synthetic non-EIO 'error' on the live pty socket and
    // asserts (a) onError fires with that error and (b) the test process does
    // NOT receive an uncaughtException (the re-throw is gone).
    it("routes a non-EIO pty read-socket error to onError without crashing the process — tc-crnt.14", async () => {
        const sock = sockName("ptyerr");
        after(() => killServer(sock));
        const host = createTmuxHost({ socketName: sock, sessionName: "tc-crnt14-ptyerr" });
        let routed = null;
        host.onError((err) => { routed = err; });
        await host.start();
        // If the fix is absent, node-pty re-throws → uncaughtException.  Capture it
        // so the test FAILS LOUDLY (assertion below) instead of aborting the runner.
        let uncaught = null;
        const onUncaught = (err) => { uncaught = err; };
        process.once("uncaughtException", onUncaught);
        // Reach the underlying node-pty terminal (the test seam; production never
        // touches it) and emit a non-EAGAIN/non-EIO socket error the way a real
        // read fault would.  `_pty` is the IPty; node-pty's Terminal forwards
        // `emit` to its read socket (node-pty/lib/terminal.js).
        const pty = host._pty;
        const fault = Object.assign(new Error("simulated pty read fault"), { code: "EBADF" });
        pty.emit("error", fault);
        // Let any deferred re-emit (the no-handler nextTick path) settle.
        await new Promise((r) => setTimeout(r, 50));
        process.removeListener("uncaughtException", onUncaught);
        assert.equal(uncaught, null, "a pty read error must NOT escape as an uncaughtException");
        assert.ok(routed !== null, "onError must fire for a non-EIO pty read error");
        assert.equal(routed.code, "EBADF");
        assert.equal(host.exited, true, "host must mark exited after a fatal pty read error");
        host.kill();
    });
});
//# sourceMappingURL=tmux-host.test.js.map