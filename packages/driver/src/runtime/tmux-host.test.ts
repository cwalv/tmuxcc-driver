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
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Minimal TmuxHost-like wrapper around a raw ChildProcess.
// Used for hermetic tests only so we can test pipe plumbing without PTY bridge.
// ---------------------------------------------------------------------------

interface FakeHostHandle {
  pid: number | undefined;
  exited: boolean;
  write(data: string): void;
  onData(h: (c: Uint8Array) => void): () => void;
  onExit(h: (code: number | null, signal: string | null) => void): () => void;
  stop(): Promise<void>;
  kill(sig?: NodeJS.Signals): void;
  waitForExit(): Promise<{ code: number | null; signal: string | null }>;
}

function spawnFake(opts: { exitCode?: number } = {}): FakeHostHandle {
  const args = [FAKE_TMUX];
  if (opts.exitCode !== undefined) args.push("--exit-code", String(opts.exitCode));

  const proc: ChildProcess = spawnProc(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const dataHandlers = new Set<(c: Uint8Array) => void>();
  const exitHandlers = new Set<(code: number | null, signal: string | null) => void>();
  let _exited = false;
  let _code: number | null = null;
  let _signal: string | null = null;

  proc.stdout!.on("data", (chunk: Buffer) => {
    const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const h of dataHandlers) { try { h(u8); } catch { /**/ } }
  });
  proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    _exited = true; _code = code; _signal = signal;
    for (const h of exitHandlers) { try { h(code, signal); } catch { /**/ } }
  });

  return {
    get pid() { return proc.pid; },
    get exited() { return _exited; },
    write(data: string) { proc.stdin!.write(data, "utf8"); },
    onData(h) { dataHandlers.add(h); return () => { dataHandlers.delete(h); }; },
    onExit(h) {
      if (_exited) { process.nextTick(() => h(_code, _signal)); return () => {}; }
      exitHandlers.add(h); return () => { exitHandlers.delete(h); };
    },
    stop() {
      if (_exited) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => resolve();
        exitHandlers.add(done);
        proc.stdin!.end();
        const t = setTimeout(() => { if (!_exited) proc.kill("SIGKILL"); }, 3000);
        t.unref();
      });
    },
    kill(sig: NodeJS.Signals = "SIGKILL") { if (!_exited) proc.kill(sig); },
    waitForExit() {
      if (_exited) return Promise.resolve({ code: _code, signal: _signal });
      return new Promise<{ code: number | null; signal: string | null }>((resolve) => {
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
    const types = new Set<string>();
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
    const chunks: Uint8Array[] = [];
    host.onData((c) => chunks.push(c));

    host.write("quit\n");
    await host.waitForExit();

    const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const dcs = Buffer.from([0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]);
    assert.ok(all.indexOf(dcs) >= 0, `DCS intro not found; got: ${all.slice(0, 40).toString("hex")}`);
  });

  it("stdout contains %begin, %end, %sessions-changed, %exit", async () => {
    const host = spawnFake();
    const chunks: Uint8Array[] = [];
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
    const chunks: Uint8Array[] = [];
    host.onData((c) => chunks.push(c));

    host.write("list-sessions\n");
    // Allow fake-tmux time to respond, then quit
    await new Promise<void>((r) => setTimeout(r, 80));
    host.write("quit\n");
    await host.waitForExit();

    const all = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    assert.ok(all.includes("list-sessions"), "echoed command body should appear in output");
  });

  it("onExit fires with code 0 on clean stop", async () => {
    const host = spawnFake();
    let firedCode: number | null | undefined;
    let firedSignal: string | null | undefined;
    host.onExit((code, signal) => { firedCode = code; firedSignal = signal; });

    host.write("quit\n");
    await host.waitForExit();

    assert.equal(firedCode, 0, "exit code should be 0");
    assert.equal(firedSignal, null, "exit signal should be null");
  });

  it("onExit fires with non-zero code when fake exits with error", async () => {
    const host = spawnFake({ exitCode: 42 });
    let firedCode: number | null | undefined;
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

    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(fired, true, "late onExit handler should fire on next tick");
  });

  it("unsubscribe from onData stops delivery", async () => {
    const host = spawnFake();
    const received: Uint8Array[] = [];
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
    let exitCode: number | null = null;
    host.onExit((code) => { exitFired = true; exitCode = code; });
    host.onError(() => { /* absorb any error events */ });

    await host.start(); // must not throw

    // Wait for the quick exit
    await new Promise<void>((r) => setTimeout(r, 200));

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
  } catch {
    return false;
  }
})();

const RUN_SUFFIX = `${Date.now()}`;

function sockName(label: string) {
  // tc-bpn — shape: tmuxcc-test-<pid>-<suffix> required by test-tmux-cleanup.
  const sock = `tmuxcc-test-${process.pid}-host-${RUN_SUFFIX}-${label}`;
  // tc-blk — track every real-tmux socket so a thrown / timed-out test still
  // has its server reaped via the process-exit / top-level after() net.
  trackSocket(sock);
  return sock;
}

function killServer(sock: string) {
  killTmuxServer(sock);
}

/** Wait for predicate over collected chunks to become true, or reject after ms. */
function waitFor(
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
      if (Date.now() > deadline) return reject(new Error(msg));
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
    host.onError(() => {});

    await host.start();
    assert.ok(typeof host.pid === "number" && host.pid > 0, "pid should be positive number");
    assert.equal(host.exited, false);

    host.kill();
    await new Promise<void>((r) => { host.onExit(() => r()); });
  });

  it("stdout delivers the DCS intro \\x1bP1000p", async () => {
    const sock = sockName("dcs");
    after(() => killServer(sock));

    const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-dcs" });
    const chunks: Uint8Array[] = [];
    host.onData((c) => chunks.push(c));
    host.onError(() => {});

    await host.start();

    await waitFor(chunks, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "DCS intro not received within 5s");

    const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    assert.ok(all.indexOf(DCS_INTRO) >= 0, "\\x1bP1000p DCS intro must appear in stdout");

    host.kill();
    await new Promise<void>((r) => { host.onExit(() => r()); });
  });

  it("stdout chunks are Uint8Array (raw bytes)", async () => {
    const sock = sockName("raw");
    after(() => killServer(sock));

    const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-raw" });
    const types = new Set<string>();
    host.onData((c) => types.add(Object.prototype.toString.call(c)));
    host.onError(() => {});

    await host.start();

    // Wait for at least one chunk
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("no data chunk within 5s")), 5000);
      const check = () => {
        if (types.size > 0) { clearTimeout(deadline); return resolve(); }
        setTimeout(check, 50);
      };
      check();
    });

    for (const t of types) {
      assert.equal(t, "[object Uint8Array]", `chunks must be Uint8Array; got ${t}`);
    }

    host.kill();
    await new Promise<void>((r) => { host.onExit(() => r()); });
  });

  it("write() sends a command and a %begin response arrives", async () => {
    const sock = sockName("write");
    after(() => killServer(sock));

    const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-write" });
    const chunks: Uint8Array[] = [];
    host.onData((c) => chunks.push(c));
    host.onError(() => {});

    await host.start();

    // Wait for DCS intro before sending commands
    await waitFor(chunks, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "DCS intro timeout before write");

    host.write("list-sessions\n");

    // Expect a second %begin (first is from startup, second from our cmd)
    await waitFor(
      chunks,
      (all) => {
        const s = all.toString("utf8");
        const count = (s.match(/%begin/g) ?? []).length;
        return count >= 2;
      },
      5000,
      "No %begin response to list-sessions within 5s",
    );

    const all = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    assert.ok(all.includes("%begin"), "should include %begin");
    assert.ok(all.includes("%end"), "should include %end");

    host.kill();
    await new Promise<void>((r) => { host.onExit(() => r()); });
  });

  it("stop() terminates cleanly: exited=true, onExit fires", async () => {
    const sock = sockName("stop");
    after(() => killServer(sock));

    const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-stop" });
    host.onError(() => {});

    let exitFired = false;
    host.onExit(() => { exitFired = true; });

    await host.start();
    await new Promise<void>((r) => setTimeout(r, 300));

    const t0 = Date.now();
    await host.stop();
    const elapsed = Date.now() - t0;

    assert.equal(host.exited, true, "exited must be true after stop()");
    assert.equal(exitFired, true, "onExit handler must fire");
    // Regression guard: a clean detach-client completes in tens of ms.
    // If stop() takes >= 1000ms it hit the SIGKILL fallback (3s), not the
    // graceful detach path.  1000ms lies between the two ranges (tens of ms
    // vs 3 s) and catches the regression on any host.
    assert.ok(
      elapsed < 1000,
      `stop() must detach cleanly (< 1000ms), not fall through to SIGKILL; elapsed=${elapsed}ms`,
    );
  });

  it("kill() terminates with SIGKILL and onExit fires", async () => {
    const sock = sockName("kill");
    after(() => killServer(sock));

    const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-kill" });
    host.onError(() => {});

    let exitFired = false;
    host.onExit(() => { exitFired = true; });

    await host.start();
    host.kill("SIGKILL");

    await new Promise<void>((resolve, reject) => {
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
    host.onError(() => {});

    await host.start();
    host.kill("SIGTERM");
    host.kill("SIGTERM"); // no-op — should not throw
    host.kill("SIGKILL");

    await new Promise<void>((r) => { host.onExit(() => r()); });
    assert.equal(host.exited, true);
  });

  it("tmux server is gone after kill-server teardown", async () => {
    const sock = sockName("cleanup");
    after(() => killServer(sock));

    const host = createTmuxHost({ socketName: sock, sessionName: "tc-kyp-cleanup" });
    host.onError(() => {});

    await host.start();
    host.kill();
    await new Promise<void>((r) => { host.onExit(() => r()); });

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
      if (r.status === 0 && (r.stdout ?? "").trim() === "1") { dead = true; break; }
    }
    assert.equal(dead, true, "test setup: pane should be dead before attach");

    const host = createTmuxHost({
      socketName: sock,
      sessionName: sess,
      attach: true,
      // Simulate the EDH inheriting an outer tmux's environment.
      env: { TMUX: "/tmp/fake-tmux-socket,99999,0", TMUX_PANE: "%9" },
    });
    const chunks: Uint8Array[] = [];
    host.onData((c) => chunks.push(c));
    host.onError(() => {});

    await host.start();
    await waitFor(chunks, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "DCS intro timeout (attach failed?)");

    // Issue the bootstrap-style query and require a clean %end reply.
    host.write("list-panes -s -t =" + sess + " -F '#{pane_id} #{pane_dead}'\n");
    await waitFor(
      chunks,
      (all) => (all.toString("utf8").match(/%end/g) ?? []).length >= 2,
      5000,
      "no %end reply to list-panes (nested-attach %error?)",
    );

    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    assert.ok(
      !text.includes("sessions should be nested"),
      `attach must not emit the nested-session %error; got:\n${text}`,
    );
    assert.ok(text.includes("%0 1") || /%\d+ 1/.test(text), "list-panes should report the dead corpse");
    assert.equal(host.exited, false, "host must not have exited on attach");

    host.kill();
    await new Promise<void>((r) => { host.onExit(() => r()); });
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
    let routed: Error | null = null;
    host.onError((err) => { routed = err; });

    await host.start();

    // If the fix is absent, node-pty re-throws → uncaughtException.  Capture it
    // so the test FAILS LOUDLY (assertion below) instead of aborting the runner.
    let uncaught: Error | null = null;
    const onUncaught = (err: Error): void => { uncaught = err; };
    process.once("uncaughtException", onUncaught);

    // Reach the underlying node-pty terminal (the test seam; production never
    // touches it) and emit a non-EAGAIN/non-EIO socket error the way a real
    // read fault would.  `_pty` is the IPty; node-pty's Terminal forwards
    // `emit` to its read socket (node-pty/lib/terminal.js).
    const pty = (host as unknown as { _pty: { emit(event: string, err: Error): void } })._pty;
    const fault = Object.assign(new Error("simulated pty read fault"), { code: "EBADF" });
    pty.emit("error", fault);

    // Let any deferred re-emit (the no-handler nextTick path) settle.
    await new Promise<void>((r) => setTimeout(r, 50));
    process.removeListener("uncaughtException", onUncaught);

    assert.equal(uncaught, null, "a pty read error must NOT escape as an uncaughtException");
    assert.ok(routed !== null, "onError must fire for a non-EIO pty read error");
    assert.equal((routed as unknown as { code?: string }).code, "EBADF");
    assert.equal(host.exited, true, "host must mark exited after a fatal pty read error");

    host.kill();
  });

  // -------------------------------------------------------------------------
  // tc-76m8.20 — pty write-after-close fd lifecycle (node-pty+1.1.0.patch).
  //
  // node-pty's CustomWriteStream writes to the RAW pty-master fd number, from
  // a queue whose dispatch is asynchronous.  Unpatched, the queue was never
  // retired when the pty died, so writes enqueued just before a tmux child's
  // death dispatched AFTER the read side closed the fd.  Two failure modes,
  // both observed in one instrumented integration.test.ts run (the R2 flake):
  //
  //   1. fd still closed → EBADF → node-pty console.error's "Unhandled pty
  //      write error" and silently drops the queue (caller never told).
  //   2. fd number already RECYCLED by the next forkpty() in this process
  //      (the very next test's tmux) → the dead session's queued commands are
  //      injected into the NEW session's -CC stdin.  tmux answers them with
  //      un-slotted %begin/%end blocks that shift the FIFO correlator pairing,
  //      so the new session's list-panes slot binds an EMPTY reply → snapshot
  //      with 0 panes → integration R2's "must have at least 1 pane" flake.
  //
  // The patch retires the write queue on every death path (child reap, read
  // socket error, socket close, destroy) and writes synchronously in the event
  // loop (fs.writeSync) so a syscall can never straddle the fd close/recycle
  // (a threadpool fs.write already submitted cannot be revoked by any flag —
  // that exact straddle was observed: dispatched .890, fd closed .891, next
  // pty spawned on the fd .901, write landed in it .902).
  //
  // These tests provoke both races BY CONSTRUCTION (no statistical flake):
  // each drives the dead host's write stream directly after the fd close —
  // the deterministic equivalent of the observed threadpool straddle — with
  // the fd's two possible fates (still closed → EBADF drop; recycled by the
  // next spawn → injection).  Unpatched node-pty fails both.  (A parked-queue
  // provocation via SIGSTOP + pty-buffer overflow does NOT work here: the
  // tmux SERVER holds a dup of the client tty and keeps draining it even
  // while the -CC client is stopped.)
  // -------------------------------------------------------------------------

  // Both tests verify behavior that lives in the node-pty patch
  // (projects/tmuxcc/patches/node-pty+1.1.0.patch, applied to node_modules by
  // patch-package's root postinstall) — not in this repo's source.  A stale
  // node_modules whose node-pty predates the patch reproduces both failures
  // below deterministically, on any host at any load (tc-qmld: byte-identical
  // EBADF drop + recycled-fd injection, once misread as "host fd/pty
  // pressure").  Check the premise via the patch's structural marker — the
  // `_disposed` field it adds to CustomWriteStream — so patch ABSENCE fails
  // fast with the actual cause.  Deliberately an existence check, not
  // `_disposed === true`: a patched-but-regressed dispose path must still
  // fail the behavioral assertions as a product bug, not be excused as
  // environment.
  function assertFdLifecyclePatchApplied(writeStream: object): void {
    assert.ok(
      "_disposed" in writeStream,
      "premise: the loaded node-pty lacks the fd-lifecycle patch (projects/tmuxcc/patches/node-pty+1.1.0.patch) — stale node_modules? npm install from the workspace root, then re-run",
    );
  }

  it("a stale write stream is retired on pty death — no EBADF queue drop (tc-76m8.20)", async () => {
    const sock = sockName("wac-ebadf");
    after(() => killServer(sock));

    const host = createTmuxHost({ socketName: sock, sessionName: "tc-76m820-ebadf" });
    host.onError(() => {});
    const chunks: Uint8Array[] = [];
    host.onData((c) => chunks.push(c));

    await host.start();
    await waitFor(chunks, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "DCS intro timeout");

    const ptyInternals = (host as unknown as {
      _pty: { _writeStream: { write(data: string): void } };
    })._pty;
    assertFdLifecyclePatchApplied(ptyInternals._writeStream);

    host.kill();
    await new Promise<void>((r) => { host.onExit(() => r()); });
    // node-pty emits 'exit' only after the read socket has closed, so the
    // master fd is closed (and its number free for recycling) from here on.

    // Capture node-pty's direct console.error reporting.
    const consoleErrors: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(" ")); };

    try {
      // The deterministic equivalent of a write enqueued moments before death
      // whose syscall dispatches after the fd close (the observed threadpool
      // straddle), with the fd NOT yet recycled: unpatched, this fs.write hits
      // EBADF, logs "Unhandled pty write error", and silently drops the queue.
      // Patched, the write stream was retired on death and no syscall happens.
      ptyInternals._writeStream.write("refresh-client\n");

      // Let any (buggy) dispatch and its threadpool callback settle.
      await new Promise<void>((r) => setTimeout(r, 200));
    } finally {
      console.error = realConsoleError;
    }

    const ptyWriteErrors = consoleErrors.filter((line) => line.includes("Unhandled pty write error"));
    assert.deepEqual(
      ptyWriteErrors,
      [],
      "a write against a dead pty must be dropped by the retired write stream, not dispatched against the closed fd",
    );
  });

  it("a stale write stream cannot inject into a recycled pty fd (tc-76m8.20)", async () => {
    const sockA = sockName("wac-inj-a");
    const sockB = sockName("wac-inj-b");
    after(() => { killServer(sockA); killServer(sockB); });

    // Internal seams (test-only): node-pty's UnixTerminal exposes the master
    // fd; its CustomWriteStream is the write path under test.
    type PtyInternals = { fd: number; _writeStream: { write(data: string): void } };

    // ── Host A: spawn, note its master fd, kill it. ─────────────────────────
    const hostA = createTmuxHost({ socketName: sockA, sessionName: "tc-76m820-inj-a" });
    hostA.onError(() => {});
    const chunksA: Uint8Array[] = [];
    hostA.onData((c) => chunksA.push(c));
    await hostA.start();
    await waitFor(chunksA, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "A: DCS intro timeout");

    const ptyA = (hostA as unknown as { _pty: PtyInternals })._pty;
    assertFdLifecyclePatchApplied(ptyA._writeStream);
    const fdA = ptyA.fd;

    hostA.kill();
    await new Promise<void>((r) => { hostA.onExit(() => r()); });
    // node-pty emits 'exit' only after the read socket has closed, so fd fdA
    // is free for recycling from here on.

    // ── Host B: the next forkpty() takes the lowest free fd — fdA. ─────────
    // Bounded retry in case an unrelated open grabbed the number first.
    let hostB = createTmuxHost({ socketName: sockB, sessionName: "tc-76m820-inj-b" });
    hostB.onError(() => {});
    let chunksB: Uint8Array[] = [];
    hostB.onData((c) => chunksB.push(c));
    await hostB.start();
    for (let attempt = 0; (hostB as unknown as { _pty: PtyInternals })._pty.fd !== fdA && attempt < 3; attempt++) {
      hostB.kill();
      await new Promise<void>((r) => { hostB.onExit(() => r()); });
      // The -CC client is dead but its server (and session) survive on sockB;
      // reap it so the respawned new-session doesn't collide.
      killServer(sockB);
      hostB = createTmuxHost({ socketName: sockB, sessionName: "tc-76m820-inj-b" });
      hostB.onError(() => {});
      chunksB = [];
      hostB.onData((c) => chunksB.push(c));
      await hostB.start();
    }
    const fdB = (hostB as unknown as { _pty: PtyInternals })._pty.fd;
    assert.equal(fdB, fdA, "test premise: B's pty must recycle A's fd number");
    await waitFor(chunksB, (all) => all.indexOf(DCS_INTRO) >= 0, 5000, "B: DCS intro timeout");

    // ── The provoked race ───────────────────────────────────────────────────
    // Drive A's (dead) write stream directly.  This is the deterministic
    // equivalent of a write enqueued moments before A's death whose syscall
    // dispatches after B recycled the fd — the observed integration-R2
    // injection, with the threadpool latency compressed to a direct call.
    // Unpatched, this fs.write(fdA) SUCCEEDS into B's tmux -CC stdin and the
    // marker comes back in B's reply stream.
    ptyA._writeStream.write("display-message -p TC76M820-INJECTED\n");

    // Prove B stays clean: give an injected command ample time to round-trip,
    // while confirming B is live via its own echoed marker.
    hostB.write("display-message -p TC76M820-OWN\n");
    await waitFor(chunksB, (all) => all.includes("TC76M820-OWN"), 5000, "B: own display-message timeout");

    const bStream = Buffer.concat(chunksB.map((c) => Buffer.from(c))).toString("utf8");
    assert.ok(
      !bStream.includes("TC76M820-INJECTED"),
      "a dead pty's write stream must never inject bytes into a recycled fd",
    );

    hostB.kill();
    await new Promise<void>((r) => { hostB.onExit(() => r()); });
  });
});
