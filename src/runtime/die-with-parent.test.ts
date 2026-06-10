/**
 * die-with-parent.test.ts — tc-2c5 die-with-parent enforcement.
 *
 * # Test categories
 *
 * ## Unit (in-process, injected getPpid)
 *
 * U1. Watchdog fires onParentDeath exactly once when the observed ppid
 *     changes, and stops polling afterwards.
 * U2. Watchdog never fires while the ppid is stable.
 * U3. uninstall() stops the watchdog — a later ppid change does not fire.
 *
 * ## Subprocess (real kernel reparenting — the acceptance scenario)
 *
 * S1. A child process that installed installDieWithParent() with PRODUCTION
 *     defaults exits within 3 s of its parent being SIGKILLed.  The parent
 *     delivers no signal (SIGKILL ⇒ silent reparenting), so only the watchdog
 *     can be responsible for the exit.  This is the getppid-poll latency
 *     assertion from the tc-2c5 acceptance (poll path, not prctl — see bead
 *     comment for the decision).
 *
 * ## Bridge (one level down — python tmux-pty-bridge)
 *
 * B1. The PTY bridge exits within 4 s of its parent being SIGKILLed even when
 *     (a) its stdin never sees EOF (the test holds the pipe's write end open
 *     across the SIGKILL — the leaked-fd case where only the bridge's own
 *     getppid watch can detect parent death), and (b) the bridged child
 *     ignores the PTY master close (sleep(1) never reads its tty — the case
 *     where the old unbounded proc.wait() hung forever).  Also asserts the
 *     bridged child itself is reaped before the bridge exits.
 *
 * # Cleanup
 *
 * Every spawned process is SIGKILLed in a finally block, pass or fail.
 * No tmux server is involved in any of these tests.
 *
 * @module runtime/die-with-parent.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

import { installDieWithParent } from "./die-with-parent.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dir, "..", "..");
const PARENT_FIXTURE = join(__dir, "fixtures", "dwp-parent.mjs");
const CHILD_FIXTURE = join(__dir, "fixtures", "dwp-child.mjs");
const BRIDGE_SCRIPT = join(__dir, "fixtures", "tmux-pty-bridge.py");

/**
 * URL of the module under test, handed to dwp-child.mjs for dynamic import.
 * Under tsx import.meta.url is the .ts source URL, so this points at the .ts
 * file — the child is spawned with `--import tsx` to resolve it.
 */
const DWP_MODULE_URL = pathToFileURL(join(__dir, "die-with-parent.ts")).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${msg}`);
}

/** True if a process with this pid exists (EPERM counts as alive). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Poll until pid is gone; returns elapsed ms.  Throws if still alive after
 * `timeoutMs` — the timeout is deliberately LARGER than the latency budget
 * under test so a slow-but-working path produces a precise assertion message
 * (actual latency) rather than a bare poll timeout.
 */
async function waitUntilGone(pid: number, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!alive(pid)) return Date.now() - t0;
    await sleep(25);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

function killQuiet(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Collect a process's stdout line-by-line until `predicate` extracts a value.
 */
function readStdoutUntil<T>(
  proc: ChildProcess,
  predicate: (line: string) => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${what}; stdout so far: ${buf}`));
    }, timeoutMs);
    timer.unref();

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        const v = predicate(line.trim());
        if (v !== undefined) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
          return;
        }
      }
    });
    proc.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Process exited (code=${code}, signal=${signal}) before ${what}; stdout: ${buf}`));
    });
  });
}

/** First child pid of `parentPid` via pgrep -P, or undefined. */
function firstChildPid(parentPid: number): number | undefined {
  const r = spawnSync("pgrep", ["-P", String(parentPid)], { encoding: "utf8", timeout: 3_000 });
  const line = (r.stdout ?? "").trim().split("\n")[0];
  const pid = line ? parseInt(line, 10) : NaN;
  return Number.isNaN(pid) ? undefined : pid;
}

const python3Available = (() => {
  const r = spawnSync("python3", ["--version"], { stdio: "ignore", timeout: 2_000 });
  return r.status === 0 && !r.error;
})();

// ---------------------------------------------------------------------------
// Unit tests — injected getPpid
// ---------------------------------------------------------------------------

describe("tc-2c5: installDieWithParent — unit (injected getPpid)", () => {
  it("U1: fires onParentDeath exactly once when ppid changes, then stops polling", async () => {
    let ppid = 4242;
    let calls = 0;
    const uninstall = installDieWithParent({
      pollIntervalMs: 10,
      getPpid: () => ppid,
      onParentDeath: () => {
        calls += 1;
      },
    });
    try {
      ppid = 1; // simulate reparenting to init
      await waitFor(() => calls > 0, 2_000, "onParentDeath did not fire");
      // Several more poll intervals: must NOT fire again (interval cleared).
      await sleep(100);
      assert.equal(calls, 1, "onParentDeath must fire exactly once");
    } finally {
      uninstall();
    }
  });

  it("U2: does not fire while ppid is stable", async () => {
    let calls = 0;
    const uninstall = installDieWithParent({
      pollIntervalMs: 10,
      getPpid: () => 4242,
      onParentDeath: () => {
        calls += 1;
      },
    });
    try {
      await sleep(150); // ~15 poll intervals
      assert.equal(calls, 0, "watchdog must not fire while parent is alive");
    } finally {
      uninstall();
    }
  });

  it("U3: uninstall() stops the watchdog before a ppid change", async () => {
    let ppid = 4242;
    let calls = 0;
    const uninstall = installDieWithParent({
      pollIntervalMs: 10,
      getPpid: () => ppid,
      onParentDeath: () => {
        calls += 1;
      },
    });
    uninstall();
    ppid = 1;
    await sleep(150);
    assert.equal(calls, 0, "uninstalled watchdog must not fire");
  });
});

// ---------------------------------------------------------------------------
// Subprocess test — real SIGKILL of the parent (acceptance scenario)
// ---------------------------------------------------------------------------

describe("tc-2c5: installDieWithParent — subprocess (real reparenting)", () => {
  it(
    "S1: child with production defaults exits ≤ 3 s after its parent is SIGKILLed",
    { timeout: 25_000 },
    async () => {
      // parent(node dwp-parent.mjs) → child(node --import tsx dwp-child.mjs)
      const parent = spawn(
        process.execPath,
        [
          PARENT_FIXTURE,
          process.execPath,
          "--import",
          "tsx",
          CHILD_FIXTURE,
          DWP_MODULE_URL,
        ],
        { stdio: ["pipe", "pipe", "pipe"], cwd: PACKAGE_ROOT },
      );
      let childPid: number | undefined;
      let stderrBuf = "";
      parent.stderr?.on("data", (c: Buffer) => {
        stderrBuf += c.toString("utf8");
      });

      try {
        // CHILD_PID is printed by the parent; CHILD_READY by the child AFTER
        // installDieWithParent() ran.  We must not SIGKILL the parent before
        // the watchdog captured its initial (live-parent) ppid.
        childPid = await readStdoutUntil(
          parent,
          (l) => (l.startsWith("CHILD_PID=") ? parseInt(l.slice("CHILD_PID=".length), 10) : undefined),
          10_000,
          "CHILD_PID",
        );
        await readStdoutUntil(parent, (l) => (l === "CHILD_READY" ? true : undefined), 15_000, "CHILD_READY");

        assert.ok(alive(childPid), "sanity: child must be alive before the parent is killed");

        parent.kill("SIGKILL");

        // SIGKILL ⇒ the child receives NO signal; only the 1 s getppid poll
        // (+ default self-SIGTERM) can take it down.  tc-2c5 acceptance:
        // poll-exit latency ≤ 3 s.
        const elapsed = await waitUntilGone(childPid, 10_000);
        assert.ok(
          elapsed <= 3_000,
          `daemon-side child must exit ≤ 3000 ms after parent SIGKILL; took ${elapsed} ms` +
            (stderrBuf.trim() ? `; stderr: ${stderrBuf.trim()}` : ""),
        );
      } finally {
        killQuiet(parent.pid);
        killQuiet(childPid);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Bridge test — one level down (python tmux-pty-bridge)
// ---------------------------------------------------------------------------

describe(
  "tc-2c5: tmux-pty-bridge — die-with-parent one level down",
  { skip: !python3Available ? "python3 not found on PATH" : false },
  () => {
    it(
      "B1: bridge exits ≤ 4 s after parent SIGKILL — no stdin EOF, EOF-deaf child",
      { timeout: 25_000 },
      async () => {
        // parent(node dwp-parent.mjs) → bridge(python3 tmux-pty-bridge.py sleep 600)
        //
        // The bridge inherits the parent's stdin, which is THIS process's pipe
        // (dwp-parent spawns with stdio "inherit").  We keep the write end open
        // for the whole test, so the bridge NEVER sees stdin EOF — parent death
        // is only observable via the bridge's getppid watch.  And `sleep`
        // never reads its tty, so the PTY-master close is invisible to it —
        // exercising the bounded SIGTERM/SIGKILL escalation that replaced the
        // unbounded proc.wait().
        const parent = spawn(
          process.execPath,
          [PARENT_FIXTURE, "python3", BRIDGE_SCRIPT, "sleep", "600"],
          { stdio: ["pipe", "pipe", "pipe"], cwd: PACKAGE_ROOT },
        );
        let bridgePid: number | undefined;
        let sleepPid: number | undefined;

        try {
          bridgePid = await readStdoutUntil(
            parent,
            (l) => (l.startsWith("CHILD_PID=") ? parseInt(l.slice("CHILD_PID=".length), 10) : undefined),
            10_000,
            "CHILD_PID (bridge)",
          );

          // Wait for the bridge to spawn its sleep child so we can track it.
          await waitFor(
            () => {
              sleepPid = firstChildPid(bridgePid!);
              return sleepPid !== undefined;
            },
            5_000,
            "bridge did not spawn its child",
          );

          assert.ok(alive(bridgePid), "sanity: bridge must be alive before the parent is killed");

          parent.kill("SIGKILL");

          // Budget: ppid watch fires within one ~50 ms select tick, then the
          // bounded teardown runs (2 s EOF grace → SIGTERM).  ≈ 2.1 s typical.
          const elapsed = await waitUntilGone(bridgePid, 10_000);
          assert.ok(
            elapsed <= 4_000,
            `bridge must exit ≤ 4000 ms after parent SIGKILL; took ${elapsed} ms`,
          );

          // The bridge reaps its child BEFORE exiting (proc.wait in the
          // escalation path) — so by now the sleep child must be gone too.
          assert.ok(sleepPid !== undefined, "sanity: sleep child pid was captured");
          assert.ok(
            !alive(sleepPid!),
            `bridged child (pid ${sleepPid}) must not outlive the bridge`,
          );
        } finally {
          killQuiet(parent.pid);
          killQuiet(bridgePid);
          killQuiet(sleepPid);
        }
      },
    );
  },
);
