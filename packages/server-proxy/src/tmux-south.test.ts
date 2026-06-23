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

import {
  createSession,
  killSession,
  listSessions,
  setSessionMarker,
  probeTmuxLiveness,
  probeTmuxAlive,
  checkSessionPresence,
} from "./tmux-south.js";

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
// checkSessionPresence (tc-hfxb.18.4)
// ---------------------------------------------------------------------------

describe("tmux-south checkSessionPresence (tc-hfxb.18.4)", () => {
  afterEach(() => {
    for (const sock of [...liveSockets]) killServer(sock);
  });

  it("returns 'present' for an existing session on a live server", { skip: !TMUX_AVAILABLE }, () => {
    const socketName = nextSocketName();
    try {
      const { tmuxId } = createSession(socketName, "present-sess");
      assert.equal(checkSessionPresence(socketName, tmuxId), "present");
      assert.equal(checkSessionPresence(socketName, "present-sess"), "present");
    } finally {
      killServer(socketName);
    }
  });

  it("returns 'absent' for a non-existent session on a live server (server reachable, session gone)", { skip: !TMUX_AVAILABLE }, () => {
    const socketName = nextSocketName();
    try {
      // Bring the server up with one session, then ask about a DIFFERENT name.
      createSession(socketName, "anchor");
      assert.equal(checkSessionPresence(socketName, "ghost-session"), "absent");
    } finally {
      killServer(socketName);
    }
  });

  it("returns 'inconclusive' for a NEVER-spawned socket (error connecting / no such file)", () => {
    // A socket no server has ever listened on: has-session fails with
    // "error connecting to <path> (No such file or directory)" — the cold-boot
    // pre-spawn window.  The socket is missing/unreachable, which is NOT positive
    // evidence of absence (the server may be coming up and publish the session
    // momentarily), so this MUST stay "inconclusive" (tc-hfxb.18.4).
    const socketName = `tmuxcc-test-south-nosock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    assert.equal(checkSessionPresence(socketName, "whatever"), "inconclusive");
  });

  it("returns 'absent' when the server WENT DOWN (last session killed → no server running)", { skip: !TMUX_AVAILABLE }, () => {
    // tc-hfxb.19: a server that was UP and then lost its last session SELF-EXITS;
    // a subsequent has-session prints "no server running on <path>" — distinct
    // from the never-spawned "error connecting / no such file" case above.  A tmux
    // session cannot outlive its server, so a down server has NO sessions: this is
    // POSITIVE, conclusive evidence the session is gone → "absent".  (This is the
    // last-pane/empty-server case the Mode-B reconciliation needed; it does NOT
    // touch the cold-boot transient, which is protected by the reconciliation
    // gate's hasSessionProxy fast-path and is "error connecting"/"present", never
    // "no server running".)
    const socketName = nextSocketName();
    createSession(socketName, "doomed");
    // Kill the only session — the server self-exits (no sessions left).
    killSession(socketName, "doomed");
    assert.equal(checkSessionPresence(socketName, "doomed"), "absent");
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

// ---------------------------------------------------------------------------
// listSessions tmux-binary availability out-param (tc-295a.35)
//
// The broker reports tmux-AVAILABILITY as canonical state (the `tmuxAvailable`
// snapshot field) so the extension can surface the actionable "tmuxcc requires
// tmux." message — replacing the deleted `which tmux` pre-flight WITHOUT making
// the broker exit on tmux-absence.  `listSessions(socketName, out)` classifies
// the binary-missing case (spawnSync ENOENT) into `out.binaryMissing` from the
// SAME shell-out it already makes, distinct from the transient/no-server cases.
//
// We simulate "tmux not installed" by running with an empty PATH so the
// unqualified `spawnSync("tmux", …)` cannot resolve the binary (ENOENT) — we
// do NOT touch the operator's real tmux install.
// ---------------------------------------------------------------------------

describe("tmux-south listSessions tmux-availability (tc-295a.35)", () => {
  afterEach(() => {
    // Restore PATH in case a test left it cleared (each test restores its own,
    // but this is a belt-and-braces guard against an assertion throwing first).
  });

  it("reports binaryMissing=false when tmux is present (no-server socket)", () => {
    const socketName = `tmuxcc-test-south-avail-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const out = { binaryMissing: false };
    const rows = listSessions(socketName, out);
    // No server on this fresh socket → [] (server has no sessions).  tmux IS
    // installed, so binaryMissing must be false.
    assert.deepEqual(rows, [], "no-server socket must yield [] when tmux is present");
    assert.equal(
      out.binaryMissing,
      false,
      "tmux present (ran, reported no-server) ⇒ binaryMissing must be false",
    );
  });

  it("reports binaryMissing=true when the tmux binary is absent (ENOENT)", () => {
    const socketName = `tmuxcc-test-south-noenoent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const savedPath = process.env.PATH;
    try {
      // Empty PATH ⇒ `spawnSync("tmux", …)` cannot find the binary ⇒ ENOENT.
      process.env.PATH = "";
      const out = { binaryMissing: false };
      const rows = listSessions(socketName, out);
      // Spawn-level failure stays `null` (transient contract unchanged) …
      assert.equal(rows, null, "a spawn ENOENT must still return null (transient contract)");
      // … but the out-param distinguishes binary-missing from other transients.
      assert.equal(
        out.binaryMissing,
        true,
        "ENOENT on the tmux binary ⇒ binaryMissing must be true",
      );
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it("does not require the out-param (null/[] contract unchanged for legacy callers)", () => {
    const socketName = `tmuxcc-test-south-noout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // No out-param: behaviour identical to before tc-295a.35.
    const rows = listSessions(socketName);
    assert.deepEqual(rows, [], "no-server socket must yield [] with no out-param supplied");
  });
});

// ---------------------------------------------------------------------------
// listSessions enriched fields (tc-295a.4 / W1.3)
// ---------------------------------------------------------------------------

describe("tmux-south listSessions enriched fields (tc-295a.4)", { skip: !TMUX_AVAILABLE }, () => {
  afterEach(() => {
    for (const sock of [...liveSockets]) killServer(sock);
  });

  it("tmuxccMarked is true for a session created by createSession (which stamps @tmuxcc 1)", () => {
    const socketName = nextSocketName();
    try {
      createSession(socketName, "marked-sess");
      const rows = listSessions(socketName);
      assert.ok(Array.isArray(rows) && rows.length > 0, "Expected at least one row");
      const row = rows!.find((r) => r.name === "marked-sess");
      assert.ok(row, "Expected a row for 'marked-sess'");
      assert.equal(
        row!.tmuxccMarked,
        true,
        "createSession stamps @tmuxcc 1 — tmuxccMarked must be true",
      );
    } finally {
      killServer(socketName);
    }
  });

  it("tmuxccMarked is false for a session created outside tmuxcc (no @tmuxcc option set)", () => {
    const socketName = nextSocketName();
    try {
      // Create a session without the tmuxcc marker by calling tmux new-session directly.
      const r = spawnSync(
        "tmux",
        ["-L", socketName, "new-session", "-d", "-s", "foreign-sess"],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(r.status, 0, `tmux new-session failed: ${r.stderr}`);

      const rows = listSessions(socketName);
      assert.ok(Array.isArray(rows) && rows.length > 0, "Expected at least one row");
      const row = rows!.find((r) => r.name === "foreign-sess");
      assert.ok(row, "Expected a row for 'foreign-sess'");
      assert.equal(
        row!.tmuxccMarked,
        false,
        "Session created without @tmuxcc option — tmuxccMarked must be false",
      );
    } finally {
      killServer(socketName);
    }
  });

  it("tmuxccMarked transitions to true after setSessionMarker is called on a foreign session", () => {
    const socketName = nextSocketName();
    try {
      // Create a foreign session.
      const r = spawnSync(
        "tmux",
        ["-L", socketName, "new-session", "-d", "-s", "adopt-sess"],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(r.status, 0, `tmux new-session failed: ${r.stderr}`);

      // Verify it starts unmarked.
      const before = listSessions(socketName);
      const rowBefore = before!.find((r) => r.name === "adopt-sess");
      assert.ok(rowBefore, "Expected a row for 'adopt-sess' before marking");
      assert.equal(rowBefore!.tmuxccMarked, false, "Must be false before mark-on-attach");

      // Apply the marker (mirrors mark-on-attach in _doClaimSession).
      setSessionMarker(socketName, "adopt-sess");

      // Now tmuxccMarked must be true.
      const after = listSessions(socketName);
      const rowAfter = after!.find((r) => r.name === "adopt-sess");
      assert.ok(rowAfter, "Expected a row for 'adopt-sess' after marking");
      assert.equal(
        rowAfter!.tmuxccMarked,
        true,
        "setSessionMarker must flip tmuxccMarked to true",
      );
    } finally {
      killServer(socketName);
    }
  });

  it("paneCount is >= 1 for a newly-created session (at least 1 pane from new-session)", () => {
    const socketName = nextSocketName();
    try {
      createSession(socketName, "pane-sess");
      const rows = listSessions(socketName);
      assert.ok(Array.isArray(rows) && rows.length > 0, "Expected at least one row");
      const row = rows!.find((r) => r.name === "pane-sess");
      assert.ok(row, "Expected a row for 'pane-sess'");
      assert.ok(
        row!.paneCount >= 1,
        `paneCount must be >= 1 for a fresh session, got ${String(row!.paneCount)}`,
      );
    } finally {
      killServer(socketName);
    }
  });

  it("lastActivity is a positive Unix epoch for a live session", () => {
    const socketName = nextSocketName();
    try {
      const beforeEpoch = Math.floor(Date.now() / 1_000) - 2; // 2s slack for clock jitter
      createSession(socketName, "activity-sess");
      const rows = listSessions(socketName);
      assert.ok(Array.isArray(rows) && rows.length > 0, "Expected at least one row");
      const row = rows!.find((r) => r.name === "activity-sess");
      assert.ok(row, "Expected a row for 'activity-sess'");
      assert.ok(
        row!.lastActivity > beforeEpoch,
        `lastActivity (${String(row!.lastActivity)}) must be a recent Unix epoch > ${beforeEpoch}`,
      );
    } finally {
      killServer(socketName);
    }
  });
});

// ---------------------------------------------------------------------------
// probeTmuxLiveness — three-way liveness (tc-vw10)
// ---------------------------------------------------------------------------
//
// The broker-exit classifier must presume tmux gone ONLY on POSITIVE evidence
// (a probe that RAN and found no server), never on a probe it could not run to
// a verdict (spawn failure / spawn-timeout under host load).  `probeTmuxAlive`
// collapses both into `false`; `probeTmuxLiveness` keeps them distinct so the
// classifier can route an inconclusive result to "reconnect" rather than the
// misleading "your sessions are gone".
describe("tmux-south probeTmuxLiveness (tc-vw10)", () => {
  it('returns "gone" when the probe RUNS and finds no server (positive evidence)', { skip: !TMUX_AVAILABLE }, async () => {
    // A fresh, never-used socket name: `tmux ls` runs and exits non-zero with
    // "no server running on …" — a verdict, not a failure-to-run.
    const socketName = `tmuxcc-test-south-probe-gone-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const liveness = await probeTmuxLiveness(socketName, 5_000);
    assert.equal(
      liveness,
      "gone",
      'a ran-and-found-no-server probe must report "gone", not "inconclusive"',
    );
  });

  it('returns "alive" when the tmux server is up', { skip: !TMUX_AVAILABLE }, async () => {
    const socketName = nextSocketName();
    try {
      createSession(socketName, "probe-alive");
      const liveness = await probeTmuxLiveness(socketName, 5_000);
      assert.equal(liveness, "alive", "a reachable tmux server must report alive");
    } finally {
      killServer(socketName);
    }
  });

  it('returns "inconclusive" — NOT "gone" — on a spawn failure (binary unreachable)', async () => {
    // Empty PATH ⇒ `spawn("tmux", …)` cannot resolve the binary ⇒ the spawn
    // emits `error` (ENOENT).  The probe never ran: this is INCONCLUSIVE, the
    // same bucket a loaded-host spawn-TIMEOUT lands in.  The whole point of
    // tc-vw10 is that this is distinct from "gone".
    const socketName = `tmuxcc-test-south-probe-inconc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const liveness = await probeTmuxLiveness(socketName, 5_000);
      assert.equal(
        liveness,
        "inconclusive",
        'a spawn failure (could not run the probe) must be "inconclusive", never "gone"',
      );
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it("probeTmuxAlive stays a true/false alias (true iff liveness === alive)", { skip: !TMUX_AVAILABLE }, async () => {
    // The legacy boolean contract is preserved for the broker's watcher-EOF
    // disambiguation: only a positive "alive" verdict yields `true`; "gone" and
    // "inconclusive" both yield `false` ("presume gone").
    const goneSocket = `tmuxcc-test-south-alias-gone-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    assert.equal(await probeTmuxAlive(goneSocket, 5_000), false, "no server ⇒ false");

    const liveSocket = nextSocketName();
    try {
      createSession(liveSocket, "alias-alive");
      assert.equal(await probeTmuxAlive(liveSocket, 5_000), true, "live server ⇒ true");
    } finally {
      killServer(liveSocket);
    }
  });
});
