/**
 * tc-bpn — self-tests for sweepOrphanedSockets() boot-sweep logic.
 *
 * # What this proves
 *
 *   B1. sweep skips own-pid socket (never reaps a socket whose pid segment
 *       matches process.pid).
 *
 *   B2. sweep skips a socket belonging to a live other-PID process (spawn a
 *       child node process that stays alive, register a socket with its pid,
 *       assert it survives a sweep call).
 *
 *   B3. sweep kills a socket belonging to a dead PID (spawn-and-exit, wait
 *       for the child to exit, then sweep).
 *
 *   B4. trackSocket("tmuxcc-foo") throws (regex rejects no-pid form).
 *
 *   B5. trackSocket("tmuxcc-test-foo") throws (regex rejects non-numeric pid).
 *
 *   B6. sweep ignores entries that don't start with "tmuxcc-test-" in the
 *       same tmux socket directory.
 *
 * # Isolation
 *
 * These tests manipulate socket files directly in `/tmp/tmux-<uid>/`.  To
 * avoid interfering with real tmux servers or concurrent test agents, the
 * tests only CREATE and then immediately CLEAN UP socket files they minted
 * themselves.  They never run `tmux kill-server` against real servers.
 *
 * @module runtime/test-tmux-cleanup-boot-sweep.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

import {
  sweepOrphanedSockets,
  trackSocket,
} from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UID = process.getuid?.();
const TMUX_DIR = UID !== undefined
  ? `/tmp/tmux-${UID}`
  : `/tmp/tmux-${process.env["USER"] ?? "unknown"}`;

/** Ensure the tmux socket directory exists (it may not on a fresh CI box). */
function ensureTmuxDir(): void {
  mkdirSync(TMUX_DIR, { recursive: true, mode: 0o700 });
}

/** Create a fake socket file in the tmux dir (not a real socket, just a file). */
function touchSocket(name: string): string {
  const p = `${TMUX_DIR}/${name}`;
  writeFileSync(p, "");
  return p;
}

/** Remove a socket file if it exists. */
function rmSocket(name: string): void {
  try { unlinkSync(`${TMUX_DIR}/${name}`); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------

describe("tc-bpn: sweepOrphanedSockets() — boot-sweep logic", () => {
  before(() => {
    ensureTmuxDir();
  });

  // -------------------------------------------------------------------------
  // B1. sweep skips own-pid socket
  // -------------------------------------------------------------------------

  it("B1: sweep does NOT remove socket whose pid segment matches process.pid", () => {
    const name = `tmuxcc-test-${process.pid}-b1-own-pid`;
    touchSocket(name);
    try {
      sweepOrphanedSockets();
      assert.ok(
        existsSync(`${TMUX_DIR}/${name}`),
        `B1: own-pid socket must survive sweep; file was deleted`,
      );
    } finally {
      rmSocket(name);
    }
  });

  // -------------------------------------------------------------------------
  // B2. sweep skips socket belonging to a live other-pid process
  // -------------------------------------------------------------------------

  it(
    "B2: sweep does NOT remove socket whose pid belongs to an alive process",
    { timeout: 10_000 },
    async () => {
      // Spawn a child process that stays alive until we kill it.
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 60_000)"],
        { detached: false, stdio: "ignore" },
      );

      const childPid = child.pid;
      assert.ok(childPid !== undefined, "B2: child process must have a pid");

      const name = `tmuxcc-test-${childPid}-b2-alive-other`;
      touchSocket(name);

      try {
        sweepOrphanedSockets();
        assert.ok(
          existsSync(`${TMUX_DIR}/${name}`),
          `B2: socket for alive pid ${childPid} must survive sweep`,
        );
      } finally {
        child.kill("SIGKILL");
        rmSocket(name);
        // Wait for child to exit so its pid is no longer live.
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          // Defensive: resolve after 500ms even if exit event is delayed.
          setTimeout(resolve, 500);
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // B3. sweep kills socket belonging to a dead pid
  // -------------------------------------------------------------------------

  it(
    "B3: sweep removes socket whose pid is dead",
    { timeout: 10_000 },
    async () => {
      // Spawn a child and wait for it to exit naturally.
      const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      assert.equal(child.status, 0, "B3: child process must exit cleanly");

      // Obtain a PID that is known to be dead.  We use the child's pid from
      // spawnSync.  Since spawnSync is synchronous the child has fully exited.
      const deadPid = child.pid;
      assert.ok(deadPid !== undefined && deadPid > 0, "B3: spawnSync must return a pid");

      // Verify the pid is indeed dead (ESRCH).
      let pidDead = false;
      try {
        process.kill(deadPid, 0);
        // If we reach here the pid may have been recycled — skip test.
        // This is a rare environment-specific case; we accept it.
      } catch (e) {
        pidDead = (e as NodeJS.ErrnoException).code === "ESRCH";
      }

      if (!pidDead) {
        // PID recycled — skip rather than flap.
        return;
      }

      const name = `tmuxcc-test-${deadPid}-b3-dead-pid`;
      touchSocket(name);

      try {
        sweepOrphanedSockets();
        // The file may have been removed by the sweep OR by killTmuxServer
        // (which is a no-op on a fake socket but still returns).  Either way
        // we expect the file to be gone (sweep calls unlinkSync directly).
        assert.ok(
          !existsSync(`${TMUX_DIR}/${name}`),
          `B3: socket for dead pid ${deadPid} must be removed by sweep`,
        );
      } finally {
        // Clean up in case the sweep did NOT remove it (so the test directory
        // stays clean regardless of outcome).
        rmSocket(name);
      }
    },
  );

  // -------------------------------------------------------------------------
  // B4. trackSocket rejects name without pid segment
  // -------------------------------------------------------------------------

  it("B4: trackSocket('tmuxcc-foo') throws (no pid segment)", () => {
    assert.throws(
      () => trackSocket("tmuxcc-foo"),
      /must match.*tmuxcc-test/,
      "B4: name without pid segment must be rejected",
    );
  });

  // -------------------------------------------------------------------------
  // B5. trackSocket rejects name with non-numeric pid segment
  // -------------------------------------------------------------------------

  it("B5: trackSocket('tmuxcc-test-foo') throws (non-numeric pid segment)", () => {
    assert.throws(
      () => trackSocket("tmuxcc-test-foo"),
      /must match.*tmuxcc-test/,
      "B5: non-numeric pid segment must be rejected",
    );
    // Also test with a dash-terminated non-numeric pid.
    assert.throws(
      () => trackSocket("tmuxcc-test-abc-suffix"),
      /must match.*tmuxcc-test/,
      "B5: non-numeric pid segment with suffix must be rejected",
    );
  });

  // -------------------------------------------------------------------------
  // B6. sweep ignores entries not starting with "tmuxcc-test-"
  // -------------------------------------------------------------------------

  it("B6: sweep ignores entries not starting with 'tmuxcc-test-'", () => {
    // Create a file that looks like a production socket name.
    const prodName = "tmuxcc-vscode-12345-1700000000000";
    const unrelatedName = "some-other-socket";

    touchSocket(prodName);
    touchSocket(unrelatedName);

    try {
      sweepOrphanedSockets();
      assert.ok(
        existsSync(`${TMUX_DIR}/${prodName}`),
        "B6: production-named socket must NOT be touched by sweep",
      );
      assert.ok(
        existsSync(`${TMUX_DIR}/${unrelatedName}`),
        "B6: unrelated entry must NOT be touched by sweep",
      );
    } finally {
      rmSocket(prodName);
      rmSocket(unrelatedName);
    }
  });

  // -------------------------------------------------------------------------
  // B7. Two concurrent processes each register own-pid socket: neither swept
  //     (AC #6 — verified by combining B1 + B2 logic)
  // -------------------------------------------------------------------------

  it(
    "B7: two concurrent test agents do not kill each other's sockets at boot",
    { timeout: 10_000 },
    async () => {
      // This agent represents "us". The child represents "the other agent".
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 60_000)"],
        { detached: false, stdio: "ignore" },
      );

      const childPid = child.pid;
      assert.ok(childPid !== undefined, "B7: child process must have a pid");

      const ownName   = `tmuxcc-test-${process.pid}-b7-concurrent-own`;
      const otherName = `tmuxcc-test-${childPid}-b7-concurrent-other`;

      touchSocket(ownName);
      touchSocket(otherName);

      try {
        sweepOrphanedSockets();

        assert.ok(
          existsSync(`${TMUX_DIR}/${ownName}`),
          "B7: our own socket must survive sweep",
        );
        assert.ok(
          existsSync(`${TMUX_DIR}/${otherName}`),
          "B7: the other live agent's socket must survive sweep",
        );
      } finally {
        child.kill("SIGKILL");
        rmSocket(ownName);
        rmSocket(otherName);
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          setTimeout(resolve, 500);
        });
      }
    },
  );
});
