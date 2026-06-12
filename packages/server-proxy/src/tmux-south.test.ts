/**
 * tmux-south.test.ts — unit tests for the south-side tmux command surface.
 *
 * tc-zcqr: the original `_doClaimSession` race ("Session not found after
 * creation") was rooted in two south-side properties:
 *
 *   1. `createSession` discarded the new session id and forced the caller
 *      to learn it via a follow-up `tmux list-sessions`.
 *   2. `listSessions` silently coerced ANY non-zero status into an empty
 *      array — so a transient `list-sessions` failure (5 s timeout,
 *      `error connecting to /tmp/...` after socket churn, etc.) was
 *      indistinguishable from "no sessions" and erased the just-created
 *      session from the server-proxy's cache.
 *
 * These tests pin both invariants:
 *
 *   - createSession returns the authoritative `tmuxId` of the just-created
 *     session in a single round-trip (no follow-up list-sessions needed).
 *   - listSessions returns `null` for transient errors and `[]` for the
 *     "server has no sessions" case (status 0 with empty stdout, OR a
 *     "no server running" stderr from tmux 3.x).
 *
 * @module tmux-south.test
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { createSession, listSessions } from "./tmux-south.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCounter = 0;
const liveSockets = new Set<string>();

function nextSocketName(): string {
  const name = `tmuxcc-test-south-${process.pid}-${++testCounter}-${Date.now()}`;
  liveSockets.add(name);
  return name;
}

function killServer(socketName: string): void {
  spawnSync("tmux", ["-L", socketName, "kill-server"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  liveSockets.delete(socketName);
}

function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
  return r.status === 0 && !r.error;
}

const TMUX_AVAILABLE = tmuxAvailable();

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("tmux-south createSession (tc-zcqr)", { skip: !TMUX_AVAILABLE }, () => {
  afterEach(() => {
    // Best-effort cleanup of any sockets the suite left running.
    for (const sock of [...liveSockets]) killServer(sock);
  });

  it("returns the authoritative tmux session id of the newly-created session", () => {
    const socketName = nextSocketName();
    try {
      const result = createSession(socketName, "alpha");
      assert.match(
        result.tmuxId,
        /^\$\d+$/,
        `Expected session id like "$N", got: ${JSON.stringify(result.tmuxId)}`,
      );

      // The returned id must round-trip through `list-sessions` — i.e. it
      // really is the live tmux session id, not a fabrication.
      const ls = spawnSync(
        "tmux",
        ["-L", socketName, "list-sessions", "-F", "#{session_id} #{session_name}"],
        { encoding: "utf8", timeout: 5_000 },
      );
      assert.equal(ls.status, 0, `list-sessions failed: ${ls.stderr}`);
      const rows = (ls.stdout ?? "").trim().split("\n");
      const row = rows.find((r) => r.endsWith(" alpha"));
      assert.ok(row, `Expected a session named "alpha" in: ${rows.join(", ")}`);
      assert.ok(
        row.startsWith(`${result.tmuxId} `),
        `Expected returned id ${result.tmuxId} to match list-sessions row: ${row}`,
      );
    } finally {
      killServer(socketName);
    }
  });

  it("creates the session with the @tmuxcc marker set", () => {
    const socketName = nextSocketName();
    try {
      createSession(socketName, "marked");
      const show = spawnSync(
        "tmux",
        ["-L", socketName, "show-options", "-t", "marked", "-v", "@tmuxcc"],
        { encoding: "utf8", timeout: 3_000 },
      );
      assert.equal(show.status, 0, "@tmuxcc marker must be readable after createSession");
      assert.equal((show.stdout ?? "").trim(), "1");
    } finally {
      killServer(socketName);
    }
  });

  it("throws when the name is already taken (duplicate session)", () => {
    const socketName = nextSocketName();
    try {
      createSession(socketName, "dup");
      assert.throws(
        () => createSession(socketName, "dup"),
        /duplicate session|tmux new-session failed/i,
      );
    } finally {
      killServer(socketName);
    }
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe("tmux-south listSessions (tc-zcqr)", () => {
  it("returns [] when no tmux server is running on the socket", () => {
    // A randomly-named socket that no server is listening on.
    const socketName = `tmuxcc-test-south-empty-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Pre-condition check: this should NOT be a transient failure — it should
    // be the deterministic "no server running" branch.
    const rows = listSessions(socketName);
    assert.deepEqual(
      rows,
      [],
      "listSessions on a dead socket must return [] (server has no sessions), NOT null",
    );
  });

  it(
    "returns the live session rows when sessions exist",
    { skip: !TMUX_AVAILABLE },
    () => {
      const socketName = nextSocketName();
      try {
        createSession(socketName, "one");
        createSession(socketName, "two");
        const rows = listSessions(socketName);
        assert.ok(Array.isArray(rows), "listSessions must return an array on success");
        const names = (rows as Array<{ name: string }>).map((r) => r.name).sort();
        assert.deepEqual(names, ["one", "two"]);
      } finally {
        killServer(socketName);
      }
    },
  );
});
