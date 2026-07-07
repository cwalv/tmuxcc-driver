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
  setGlobalScrollOnClear,
  setSessionMarker,
  setSessionWorkspace,
  probeTmuxLiveness,
  probeTmuxAlive,
  checkSessionPresence,
} from "./tmux-south.js";
import { mintSocket } from "./runtime/test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function killServer(socketName: string): void {
  spawnSync("tmux", ["-L", socketName, "kill-server"], {
    stdio: "ignore",
    timeout: 5_000,
  });
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
  it("returns the authoritative tmux session id of the newly-created session", async () => {
    const socketName = mintSocket("south");
    try {
      const result = await createSession(socketName, "alpha");
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

  it("creates the session with the @tmuxcc marker set", async () => {
    const socketName = mintSocket("south");
    try {
      await createSession(socketName, "marked");
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

  it("sets the server-global scroll-on-clear off default (tc-w3ir.1)", async () => {
    const socketName = mintSocket("south");
    try {
      await createSession(socketName, "soc");

      // Global window option is off.
      const showGlobal = spawnSync(
        "tmux",
        ["-L", socketName, "show-options", "-wg", "-v", "scroll-on-clear"],
        { encoding: "utf8", timeout: 3_000 },
      );
      assert.equal(showGlobal.status, 0, "global scroll-on-clear must be readable");
      assert.equal((showGlobal.stdout ?? "").trim(), "off");

      // The session's window inherits it (no per-window override needed):
      // `show-options -A -w` resolves inherited globals and tags them with `*`.
      const showWindow = spawnSync(
        "tmux",
        ["-L", socketName, "show-options", "-A", "-w", "-t", "soc"],
        { encoding: "utf8", timeout: 3_000 },
      );
      assert.equal(showWindow.status, 0, "window options must be readable");
      assert.match(
        showWindow.stdout ?? "",
        /scroll-on-clear\*?\s+off/,
        `managed window must inherit scroll-on-clear off, got:\n${showWindow.stdout}`,
      );

      // A second window created later on the same server also inherits it.
      const nw = spawnSync(
        "tmux",
        ["-L", socketName, "new-window", "-t", "soc"],
        { encoding: "utf8", timeout: 3_000 },
      );
      assert.equal(nw.status, 0, `new-window failed: ${nw.stderr}`);
      const showWindow2 = spawnSync(
        "tmux",
        ["-L", socketName, "show-options", "-A", "-w", "-t", "soc"],
        { encoding: "utf8", timeout: 3_000 },
      );
      assert.match(
        showWindow2.stdout ?? "",
        /scroll-on-clear\*?\s+off/,
        `later windows must inherit scroll-on-clear off, got:\n${showWindow2.stdout}`,
      );
    } finally {
      killServer(socketName);
    }
  });

  it("rejects when the name is already taken (duplicate session)", async () => {
    const socketName = mintSocket("south");
    try {
      await createSession(socketName, "dup");
      await assert.rejects(
        () => createSession(socketName, "dup"),
        /duplicate session|tmux new-session failed/i,
      );
    } finally {
      killServer(socketName);
    }
  });

  // tc-gjdx.2: real-tmux moat — env stored in the session environment (real tmux)
  it("tc-gjdx.2: env is stored in the session environment (real tmux)", async () => {
    const socketName = mintSocket("south");
    try {
      await createSession(socketName, "env-test", undefined, { TMUXCC_TEST_ENV: "moat-value" });

      // `tmux show-environment` inspects the session's environment delta —
      // it returns "VAR=value" on stdout (exit 0) when the var is set, exit 1
      // when it is absent.  This is the canonical way to verify -e landed.
      const show = spawnSync(
        "tmux",
        ["-L", socketName, "show-environment", "-t", "env-test", "TMUXCC_TEST_ENV"],
        { encoding: "utf8", timeout: 5_000 },
      );
      assert.equal(
        show.status,
        0,
        `show-environment TMUXCC_TEST_ENV returned non-zero (env not injected?): stdout=${show.stdout} stderr=${show.stderr}`,
      );
      assert.equal(
        (show.stdout ?? "").trim(),
        "TMUXCC_TEST_ENV=moat-value",
        `Expected TMUXCC_TEST_ENV=moat-value, got: ${JSON.stringify(show.stdout)}`,
      );
    } finally {
      killServer(socketName);
    }
  });

  // tc-u4ny.2: duplicate-session classification — the adapter must emit a
  // structured CommandError("tmux.duplicate-session") so claim-session can
  // discriminate via isCommandError rather than substring-matching tmux stderr.
  // This is the "lost-create-race path" discriminant: claim-session catches
  // this code and recovers (or throws "internal" if the session still cannot
  // be found), rather than re-wrapping the prose as "tmux.unavailable".
  it("throws CommandError tmux.duplicate-session when a session name is already taken", async () => {
    const socketName = nextSocketName();
    try {
      // First create succeeds; second create on the same name must yield the
      // structured code, not a generic error.
      await createSession(socketName, "dup-test");
      const err = await createSession(socketName, "dup-test").then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof Error, `Expected an Error, got: ${String(err)}`);
      assert.equal(
        (err as { code?: string }).code,
        "tmux.duplicate-session",
        `Expected structured code "tmux.duplicate-session", got: ${JSON.stringify((err as { code?: string }).code)}`,
      );
    } finally {
      killServer(socketName);
    }
  });

});

// ---------------------------------------------------------------------------
// createSession env capability gate — unit tests (no tmux required, tc-gjdx.2)
// ---------------------------------------------------------------------------

describe("tmux-south createSession env capability gate (tc-gjdx.2)", () => {
  // tc-gjdx.2: below-floor fail-loud — env-carrying create against tmux < 3.2
  // must throw before any I/O (pure capability check, no real tmux needed).
  it("throws capability-required when newSessionEnvFlag is false", async () => {
    // Simulate pre-3.2 capabilities: newSessionEnvFlag absent.
    const below32Caps = {
      windowSize: true,
      noOutputFlag: true,
      windowSizeLatest: true,
      ignoreSizeFlag: false,
      readOnlyFlag: false,
      pauseAfterFlag: false,
      activePaneFlag: false,
      newSessionEnvFlag: false,
      scrollOnClear: false,
      noDetachOnDestroy: false,
    };

    // The capability guard fires before any tmux call when capabilities are
    // provided and the flag is false; the nonexistent socket name is irrelevant.
    const err = await createSession(
      "tmuxcc-nonexistent-socket",
      "some-session",
      below32Caps,
      { MY_VAR: "value" },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof Error, `Expected an Error, got: ${String(err)}`);
    assert.ok(
      (err as NodeJS.ErrnoException & { code?: string }).code === "tmux.capability-required",
      `Expected code "tmux.capability-required", got: ${JSON.stringify((err as { code?: string }).code)}`,
    );
    // details.capability names the missing TmuxCapabilityMap key.
    assert.equal(
      ((err as { details?: { capability?: string } }).details ?? {}).capability,
      "newSessionEnvFlag",
      `Expected details.capability "newSessionEnvFlag", got: ${JSON.stringify((err as { details?: unknown }).details)}`,
    );
  });

  it("does not throw when env is undefined (no gate needed)", async () => {
    // When env is omitted entirely, the guard must be silent even with a
    // below-floor capability map — the socket doesn't exist, but the error
    // (if any) comes from tmux, not from our gate.
    const below32Caps = {
      windowSize: true,
      noOutputFlag: true,
      windowSizeLatest: true,
      ignoreSizeFlag: false,
      readOnlyFlag: false,
      pauseAfterFlag: false,
      activePaneFlag: false,
      newSessionEnvFlag: false,
      scrollOnClear: false,
      noDetachOnDestroy: false,
    };

    const err = await createSession(
      "tmuxcc-nonexistent-socket",
      "some-session",
      below32Caps,
      undefined,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    // If an error is thrown, it must NOT be a capability-required error —
    // that would mean the guard fired spuriously.
    if (err !== null) {
      const code = (err as { code?: string }).code;
      assert.ok(
        code !== "tmux.capability-required",
        `Guard must not fire for undefined env; got code "${code}"`,
      );
    }
  });

  it("does not throw when env is an empty map (no -e flags emitted)", async () => {
    // An empty env map must also bypass the gate — nothing to inject.
    const below32Caps = {
      windowSize: true,
      noOutputFlag: true,
      windowSizeLatest: true,
      ignoreSizeFlag: false,
      readOnlyFlag: false,
      pauseAfterFlag: false,
      activePaneFlag: false,
      newSessionEnvFlag: false,
      scrollOnClear: false,
      noDetachOnDestroy: false,
    };

    const err = await createSession(
      "tmuxcc-nonexistent-socket",
      "some-session",
      below32Caps,
      {},
    ).then(
      () => null,
      (e: unknown) => e,
    );

    if (err !== null) {
      const code = (err as { code?: string }).code;
      assert.ok(
        code !== "tmux.capability-required",
        `Guard must not fire for empty env; got code "${code}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// checkSessionPresence (tc-hfxb.18.4)
// ---------------------------------------------------------------------------

describe("tmux-south checkSessionPresence (tc-hfxb.18.4)", () => {
  it("returns 'present' for an existing session on a live server", { skip: !TMUX_AVAILABLE }, async () => {
    const socketName = mintSocket("south");
    try {
      const { tmuxId } = await createSession(socketName, "present-sess");
      assert.equal(await checkSessionPresence(socketName, tmuxId), "present");
      assert.equal(await checkSessionPresence(socketName, "present-sess"), "present");
    } finally {
      killServer(socketName);
    }
  });

  it("returns 'absent' for a non-existent session on a live server (server reachable, session gone)", { skip: !TMUX_AVAILABLE }, async () => {
    const socketName = mintSocket("south");
    try {
      // Bring the server up with one session, then ask about a DIFFERENT name.
      await createSession(socketName, "anchor");
      assert.equal(await checkSessionPresence(socketName, "ghost-session"), "absent");
    } finally {
      killServer(socketName);
    }
  });

  it("returns 'inconclusive' for a NEVER-spawned socket (error connecting / no such file)", async () => {
    // A socket no server has ever listened on: has-session fails with
    // "error connecting to <path> (No such file or directory)" — the cold-boot
    // pre-spawn window.  The socket is missing/unreachable, which is NOT positive
    // evidence of absence (the server may be coming up and publish the session
    // momentarily), so this MUST stay "inconclusive" (tc-hfxb.18.4).
    const socketName = mintSocket("south-nosock");
    assert.equal(await checkSessionPresence(socketName, "whatever"), "inconclusive");
  });

  it("returns 'absent' when the server WENT DOWN (last session killed → no server running)", { skip: !TMUX_AVAILABLE }, async () => {
    // tc-hfxb.19: a server that was UP and then lost its last session SELF-EXITS;
    // a subsequent has-session prints "no server running on <path>" — distinct
    // from the never-spawned "error connecting / no such file" case above.  A tmux
    // session cannot outlive its server, so a down server has NO sessions: this is
    // POSITIVE, conclusive evidence the session is gone → "absent".  (This is the
    // last-pane/empty-server case the Mode-B reconciliation needed; it does NOT
    // touch the cold-boot transient, which is protected by the reconciliation
    // gate's hasSessionProxy fast-path and is "error connecting"/"present", never
    // "no server running".)
    const socketName = mintSocket("south");
    await createSession(socketName, "doomed");
    // Kill the only session — the server self-exits (no sessions left).
    await killSession(socketName, "doomed");
    assert.equal(await checkSessionPresence(socketName, "doomed"), "absent");
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe("tmux-south listSessions (tc-zcqr)", () => {
  it("returns [] when no tmux server is running on the socket", async () => {
    // A randomly-named socket that no server is listening on.
    const socketName = mintSocket("south-empty");
    // Pre-condition check: this should NOT be a transient failure — it should
    // be the deterministic "no server running" branch.
    const rows = await listSessions(socketName);
    assert.deepEqual(
      rows,
      [],
      "listSessions on a dead socket must return [] (server has no sessions), NOT null",
    );
  });

  it(
    "returns the live session rows when sessions exist",
    { skip: !TMUX_AVAILABLE },
    async () => {
      const socketName = mintSocket("south");
      try {
        await createSession(socketName, "one");
        await createSession(socketName, "two");
        const rows = await listSessions(socketName);
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

  it("reports binaryMissing=false when tmux is present (no-server socket)", async () => {
    const socketName = mintSocket("south-avail");
    const out = { binaryMissing: false };
    const rows = await listSessions(socketName, out);
    // No server on this fresh socket → [] (server has no sessions).  tmux IS
    // installed, so binaryMissing must be false.
    assert.deepEqual(rows, [], "no-server socket must yield [] when tmux is present");
    assert.equal(
      out.binaryMissing,
      false,
      "tmux present (ran, reported no-server) ⇒ binaryMissing must be false",
    );
  });

  it("reports binaryMissing=true when the tmux binary is absent (ENOENT)", async () => {
    const socketName = mintSocket("south-noenoent");
    const savedPath = process.env.PATH;
    try {
      // Empty PATH ⇒ `spawn("tmux", …)` cannot find the binary ⇒ ENOENT.
      process.env.PATH = "";
      const out = { binaryMissing: false };
      const rows = await listSessions(socketName, out);
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

  it("does not require the out-param (null/[] contract unchanged for legacy callers)", async () => {
    const socketName = mintSocket("south-noout");
    // No out-param: behaviour identical to before tc-295a.35.
    const rows = await listSessions(socketName);
    assert.deepEqual(rows, [], "no-server socket must yield [] with no out-param supplied");
  });
});

// ---------------------------------------------------------------------------
// listSessions enriched fields (tc-295a.4 / W1.3)
// ---------------------------------------------------------------------------

describe("tmux-south listSessions enriched fields (tc-295a.4)", { skip: !TMUX_AVAILABLE }, () => {
  it("tmuxccMarked is true for a session created by createSession (which stamps @tmuxcc 1)", async () => {
    const socketName = mintSocket("south");
    try {
      await createSession(socketName, "marked-sess");
      const rows = await listSessions(socketName);
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

  it("tmuxccMarked is false for a session created outside tmuxcc (no @tmuxcc option set)", async () => {
    const socketName = mintSocket("south");
    try {
      // Create a session without the tmuxcc marker by calling tmux new-session directly.
      const r = spawnSync(
        "tmux",
        ["-L", socketName, "new-session", "-d", "-s", "foreign-sess"],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(r.status, 0, `tmux new-session failed: ${r.stderr}`);

      const rows = await listSessions(socketName);
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

  it("tmuxccMarked transitions to true after setSessionMarker is called on a foreign session", async () => {
    const socketName = mintSocket("south");
    try {
      // Create a foreign session.
      const r = spawnSync(
        "tmux",
        ["-L", socketName, "new-session", "-d", "-s", "adopt-sess"],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(r.status, 0, `tmux new-session failed: ${r.stderr}`);

      // Verify it starts unmarked.
      const before = await listSessions(socketName);
      const rowBefore = before!.find((r) => r.name === "adopt-sess");
      assert.ok(rowBefore, "Expected a row for 'adopt-sess' before marking");
      assert.equal(rowBefore!.tmuxccMarked, false, "Must be false before mark-on-attach");

      // Apply the marker (mirrors mark-on-attach in _doClaimSession).
      await setSessionMarker(socketName, "adopt-sess");

      // Now tmuxccMarked must be true.
      const after = await listSessions(socketName);
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

  it("paneCount is >= 1 for a newly-created session (at least 1 pane from new-session)", async () => {
    const socketName = mintSocket("south");
    try {
      await createSession(socketName, "pane-sess");
      const rows = await listSessions(socketName);
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

  it("lastActivity is a positive Unix epoch for a live session", async () => {
    const socketName = mintSocket("south");
    try {
      const beforeEpoch = Math.floor(Date.now() / 1_000) - 2; // 2s slack for clock jitter
      await createSession(socketName, "activity-sess");
      const rows = await listSessions(socketName);
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
    const socketName = mintSocket("south-probe-gone");
    const liveness = await probeTmuxLiveness(socketName, 5_000);
    assert.equal(
      liveness,
      "gone",
      'a ran-and-found-no-server probe must report "gone", not "inconclusive"',
    );
  });

  it('returns "alive" when the tmux server is up', { skip: !TMUX_AVAILABLE }, async () => {
    const socketName = mintSocket("south");
    try {
      await createSession(socketName, "probe-alive");
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
    const socketName = mintSocket("south-probe-inconc");
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
    // The boolean alias collapses both non-alive verdicts: only a positive
    // "alive" yields `true`; "gone" and "inconclusive" both yield `false`.
    // (Since tc-hfxb.22 the broker's watcher-EOF disambiguation uses the
    // three-valued `probeTmuxLiveness` directly — never presume-gone on an
    // inconclusive probe — so this alias is no longer on that path; the test
    // pins the collapsing contract for any remaining boolean caller.)
    const goneSocket = mintSocket("south-alias-gone");
    assert.equal(await probeTmuxAlive(goneSocket, 5_000), false, "no server ⇒ false");

    const liveSocket = mintSocket("south");
    try {
      await createSession(liveSocket, "alias-alive");
      assert.equal(await probeTmuxAlive(liveSocket, 5_000), true, "live server ⇒ true");
    } finally {
      killServer(liveSocket);
    }
  });
});

// ---------------------------------------------------------------------------
// setSessionWorkspace + listSessions round-trip (S4 / tc-76m8.6)
//
// Proves the `@tmuxcc-workspace` identity option's SET (createUnique stamps it
// via setSessionWorkspace) and READ (listSessions surfaces it as
// `row.workspaceUri`) round-trip against real tmux — and that new sessions carry
// HUMAN-readable names (no sha8 suffix) in `tmux ls`.
// ---------------------------------------------------------------------------

describe("tmux-south @tmuxcc-workspace identity round-trip (S4/tc-76m8.6)", { skip: !TMUX_AVAILABLE }, () => {
  it("setSessionWorkspace stamps @tmuxcc-workspace; listSessions reads it back", async () => {
    const socketName = mintSocket("south");
    // A human-readable name (no sha8) — this is what `tmux ls` shows for new sessions.
    await createSession(socketName, "myproject");
    await setSessionWorkspace(socketName, "myproject", "file:///home/user/myproject");

    const rows = await listSessions(socketName);
    assert.notEqual(rows, null, "listSessions must not be a transient failure");
    const row = rows!.find((r) => r.name === "myproject");
    assert.ok(row, "the human-named session must be present");
    assert.equal(row!.workspaceUri, "file:///home/user/myproject", "workspaceUri reads back the option");
    assert.equal(row!.tmuxccMarked, true, "session is still tmuxcc-marked");
  });

  it("a session with no @tmuxcc-workspace option → workspaceUri is undefined (pre-S4 / legacy)", async () => {
    const socketName = mintSocket("south");
    await createSession(socketName, "legacy-sess");
    // Deliberately do NOT set @tmuxcc-workspace.
    const rows = await listSessions(socketName);
    const row = rows!.find((r) => r.name === "legacy-sess");
    assert.ok(row, "session present");
    assert.equal(row!.workspaceUri, undefined, "unset option surfaces as undefined, not empty string");
  });

  it("preserves a multi-root identity value containing '|' and ':' verbatim", async () => {
    const socketName = mintSocket("south");
    // workspaceIdentity joins multi-root folder URIs with '|'.
    const identity = "file:///ws/alpha|file:///ws/beta";
    await createSession(socketName, "multiroot");
    await setSessionWorkspace(socketName, "multiroot", identity);
    const rows = await listSessions(socketName);
    const row = rows!.find((r) => r.name === "multiroot");
    assert.equal(row!.workspaceUri, identity, "the '|'-joined identity round-trips verbatim");
  });

  it("two same-basename sessions carry DISTINCT identities (cross-workspace collision avoidance)", async () => {
    // Distinct sessions (createUnique would mint `myproject` + `myproject-2`), each
    // stamped with its OWN workspace identity — the S4 replacement for the sha8
    // suffix's disambiguation.
    const socketName = mintSocket("south");
    await createSession(socketName, "myproject");
    await setSessionWorkspace(socketName, "myproject", "file:///home/alice/myproject");
    await createSession(socketName, "myproject-2");
    await setSessionWorkspace(socketName, "myproject-2", "file:///home/bob/myproject");

    const rows = await listSessions(socketName);
    const a = rows!.find((r) => r.name === "myproject");
    const b = rows!.find((r) => r.name === "myproject-2");
    assert.ok(a && b, "both distinct sessions present");
    assert.equal(a!.workspaceUri, "file:///home/alice/myproject");
    assert.equal(b!.workspaceUri, "file:///home/bob/myproject");
    assert.notEqual(a!.workspaceUri, b!.workspaceUri, "same basename → distinct identities");
  });
});

// ---------------------------------------------------------------------------
// setGlobalScrollOnClear on externally-created session (tc-w3ir.5)
//
// Belt-and-suspenders: the claim seam now calls setGlobalScrollOnClear even
// when the session was created directly (not via createSession).  This test
// verifies that calling setGlobalScrollOnClear on a server that was NOT set up
// by createSession() correctly stamps scroll-on-clear off — the exact edge
// case covered by tc-w3ir.5.
// ---------------------------------------------------------------------------

describe("tmux-south setGlobalScrollOnClear on externally-created session (tc-w3ir.5)", { skip: !TMUX_AVAILABLE }, () => {
  it("sets scroll-on-clear off on a server bootstrapped without createSession", async () => {
    const socketName = mintSocket("south");
    try {
      // Create a session DIRECTLY via tmux CLI — simulates a user session that
      // was created outside of tmuxcc (the manually-created-then-attached edge).
      const ns = spawnSync(
        "tmux",
        ["-L", socketName, "new-session", "-d", "-s", "ext-sess"],
        { encoding: "utf8", timeout: 5_000 },
      );
      assert.equal(ns.status, 0, `direct new-session failed: ${ns.stderr}`);

      // Apply setGlobalScrollOnClear — mirrors what the attach/claim seam now does.
      await setGlobalScrollOnClear(socketName, false);

      // The server-global must now be off.
      const showAfter = spawnSync(
        "tmux",
        ["-L", socketName, "show-options", "-wg", "-v", "scroll-on-clear"],
        { encoding: "utf8", timeout: 3_000 },
      );
      assert.equal(showAfter.status, 0, "global scroll-on-clear must be readable after setGlobalScrollOnClear");
      assert.equal((showAfter.stdout ?? "").trim(), "off", "scroll-on-clear must be off after the claim-seam call");

      // The externally-created session's window also inherits the global.
      const showWindow = spawnSync(
        "tmux",
        ["-L", socketName, "show-options", "-A", "-w", "-t", "ext-sess"],
        { encoding: "utf8", timeout: 3_000 },
      );
      assert.equal(showWindow.status, 0, "window options must be readable");
      assert.match(
        showWindow.stdout ?? "",
        /scroll-on-clear\*?\s+off/,
        `externally-created session window must inherit scroll-on-clear off, got:\n${showWindow.stdout}`,
      );
    } finally {
      killServer(socketName);
    }
  });
});
