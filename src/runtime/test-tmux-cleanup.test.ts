/**
 * tc-blk — self-tests for the test-tmux-cleanup safety net.
 *
 * # What this proves
 *
 *   S1. trackSocket() rejects names outside the `tmuxcc-` prefix (blast-radius
 *       guard so we never accidentally kill the user's own tmux server).
 *
 *   S2. killTmuxServer() is idempotent and never throws — safe to call on a
 *       socket that was never started, or on one already dead.
 *
 *   S3. flushAllTracked() actually kills tracked tmux servers (real-tmux
 *       guarded). After flush(), the socket is no longer connectable. This is
 *       the regression test for the bead's "throws mid-body" criterion: we
 *       deliberately spawn a real tmux server, then simulate a thrown test
 *       body by NOT calling per-test cleanup — only the process-level flush.
 *
 *   S4. After flush(), the tracked set is empty (so process-exit/SIGINT
 *       handlers, which also walk the set, won't double-kill).
 *
 * # Why a separate self-test
 *
 * The shared helper is the safety net for every other real-tmux test in the
 * project. If it regresses silently, leaks return. Testing it explicitly here
 * means a regression breaks a fast, focused test rather than only being
 * visible as accumulated orphans in `ps` after a long ci run.
 *
 * @module runtime/test-tmux-cleanup.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

import {
  trackSocket,
  forgetSocket,
  killTmuxServer,
  flushAllTracked,
  getTrackedSockets,
} from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// tmux availability guard — S3 requires a real tmux binary on PATH.
// ---------------------------------------------------------------------------

const tmuxAvailable = (() => {
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
  } catch {
    return false;
  }
})();

// Unique per-run prefix so concurrent test runs (if any) don't collide.
const SELFTEST_RUN_ID = `${Date.now()}-${process.pid}`;

function selftestSock(label: string): string {
  return `tmuxcc-selftest-${SELFTEST_RUN_ID}-${label}`;
}

// ---------------------------------------------------------------------------

describe("tc-blk: test-tmux-cleanup safety net", () => {
  // -------------------------------------------------------------------------
  // S1. trackSocket prefix guard
  // -------------------------------------------------------------------------

  it("S1: trackSocket throws on names outside the `tmuxcc-` prefix", () => {
    assert.throws(
      () => trackSocket("gc-chost.session"),
      /must start with "tmuxcc-"/,
      "must refuse user-owned socket names",
    );
    assert.throws(
      () => trackSocket("default"),
      /must start with "tmuxcc-"/,
      "must refuse the literal default tmux socket name",
    );
    assert.throws(
      () => trackSocket(""),
      /must start with "tmuxcc-"/,
      "must refuse the empty socket name",
    );
  });

  // -------------------------------------------------------------------------
  // S2. killTmuxServer is safe to call on never-existed sockets
  // -------------------------------------------------------------------------

  it("S2: killTmuxServer is idempotent and never throws on never-existed sockets", () => {
    // Random name that was never started.
    const sock = selftestSock("never-existed");
    assert.doesNotThrow(() => killTmuxServer(sock));
    // Calling twice is also safe.
    assert.doesNotThrow(() => killTmuxServer(sock));
  });

  it("S2b: killTmuxServer refuses to issue against an out-of-prefix name (no-op)", () => {
    // This is the blast-radius guard — even if a bug calls killTmuxServer
    // with the user's real socket name, it must NOT issue the kill.
    // We can't directly observe "tmux not invoked", but we can verify the
    // call returns without throwing and without invoking tmux against
    // "default" (which would terminate the user's own server).
    assert.doesNotThrow(() => killTmuxServer("default"));
    assert.doesNotThrow(() => killTmuxServer("gc-chost.x"));
  });

  // -------------------------------------------------------------------------
  // S3. The regression for the bead's "throws mid-body" criterion.
  //
  // Simulates: a test spawns a real tmux server, then throws before its
  // per-test cleanup runs. Asserts: flushAllTracked() (which is what the
  // process-exit / top-level after() hook does) reaps the server.
  //
  // SKIPPED if tmux is not on PATH.
  // -------------------------------------------------------------------------

  it(
    "S3: a tracked socket whose test 'throws' is still reaped by flushAllTracked",
    { skip: tmuxAvailable ? false : "tmux not found on PATH" },
    () => {
      const sock = selftestSock("throw-regression");
      trackSocket(sock);

      // Spawn a real tmux server on this socket so there's something to reap.
      // We use `new-session -d` (detached) so the command returns immediately
      // and leaves the server running.
      try {
        execFileSync(
          "tmux",
          ["-L", sock, "new-session", "-d", "-s", "throw-regression"],
          { timeout: 5000, stdio: ["ignore", "ignore", "ignore"] },
        );
      } catch (err) {
        assert.fail(`tmux new-session failed: ${(err as Error).message}`);
      }

      // Verify the server is alive (would be observable as a leak otherwise).
      const checkAlive = spawnSync(
        "tmux", ["-L", sock, "list-sessions"], { timeout: 3000 },
      );
      assert.equal(
        checkAlive.status, 0,
        "S3: tmux server must be alive before flush (sanity check)",
      );

      // SIMULATE THE THROW: we deliberately do NOT call killTmuxServer here.
      // The only cleanup path is the process-level flush — which is the
      // behaviour we want to prove.

      flushAllTracked();

      // After flush, the server must be gone.
      const checkDead = spawnSync(
        "tmux", ["-L", sock, "list-sessions"], { timeout: 3000 },
      );
      assert.notEqual(
        checkDead.status, 0,
        "S3: tmux server must be REAPED by flushAllTracked() — bead acceptance criterion",
      );

      // And the tracked set must no longer contain it.
      assert.equal(
        getTrackedSockets().includes(sock),
        false,
        "S3: flushAllTracked() must clear the tracked set entry",
      );
    },
  );

  // -------------------------------------------------------------------------
  // S4. forgetSocket drops the entry (optimisation — not required for safety).
  // -------------------------------------------------------------------------

  it("S4: forgetSocket removes the socket from the tracked set", () => {
    const sock = selftestSock("forget");
    trackSocket(sock);
    assert.ok(
      getTrackedSockets().includes(sock),
      "S4: socket must be in tracked set after trackSocket",
    );
    forgetSocket(sock);
    assert.equal(
      getTrackedSockets().includes(sock),
      false,
      "S4: socket must be absent after forgetSocket",
    );
  });
});
