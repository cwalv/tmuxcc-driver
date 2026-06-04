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

// tc-46t — Belt-and-suspenders: if any code path in this test file ever
// resolves socketName='default' in createRealDaemonHandle, throw loudly
// rather than touching the developer's real '-L default' tmux socket.
process.env["TMUXCC_FORBID_DEFAULT_SOCKET"] = "1";

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
  it("onError fires when python binary is not found", async () => {
    const host = createTmuxHost({
      socketName: `tmuxcc-test-${process.pid}-err-${Date.now()}`,
      sessionName: "tc-kyp-err",
      pythonPath: "/nonexistent/python3-xyz-404",
    });

    let errFired = false;
    host.onError(() => { errFired = true; });

    let startRejected = false;
    try {
      await host.start();
    } catch {
      startRejected = true;
    }

    // Allow a tick for error propagation
    await new Promise<void>((r) => setTimeout(r, 30));

    assert.ok(
      errFired || startRejected,
      "onError should fire OR start() should reject when binary not found",
    );
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

    await host.stop();

    assert.equal(host.exited, true, "exited must be true after stop()");
    assert.equal(exitFired, true, "onExit handler must fire");
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
});
