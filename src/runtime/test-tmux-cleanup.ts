/**
 * tc-bpn — Shared real-tmux test cleanup safety net.
 *
 * # Why this exists
 *
 * Tests that spawn real tmux servers (with `-L <socket>`) currently rely on
 * per-test `finally`/`after()` blocks to kill the server. That cleanup only
 * runs when control reaches it — if the test body throws synchronously, or
 * the node:test runner times out and aborts the body, the kill never runs
 * and the tmux server is orphaned. Observed in practice: ~233 orphan
 * `tmuxcc-tmuxcc-*` servers accumulated over weeks of subagent test runs;
 * tmux itself eventually crashed.
 *
 * # What this module provides
 *
 * - `trackSocket(sock)` — register a socket name. Once tracked, the socket
 *   will be killed by the process-exit hook even if every per-test teardown
 *   is skipped.
 * - `forgetSocket(sock)` — unregister (after a successful explicit kill).
 *   Calling kill again on an already-dead server is harmless, so forgetting
 *   is only an optimisation — never required for correctness.
 * - `killTmuxServer(sock)` — synchronous, idempotent kill. Swallows
 *   "no server" errors. Always safe to call.
 * - `sweepOrphanedSockets()` — scan `/tmp/tmux-<uid>/` for stale
 *   `tmuxcc-test-*` sockets whose owner PID is no longer alive and kill
 *   them. Called automatically at first `trackSocket()` call.
 *
 * On first call to `trackSocket`, the module:
 *
 *   0. Calls `sweepOrphanedSockets()` — reaps any sockets left by
 *      SIGKILL-ed prior runs BEFORE minting a new server.
 *   1. `process.on('exit', ...)` — runs at the very end of the process life,
 *      including when node:test aborts after a timeout. Synchronous only,
 *      which is why we use `execFileSync(kill-server)`.
 *   2. `process.on('SIGINT' | 'SIGTERM' | 'SIGHUP', ...)` — Ctrl-C the
 *      runner mid-suite and we still clean up.
 *   3. A top-level `after()` hook in node:test that flushes the set.
 *      `after()` runs even after a thrown / timed-out test, so this is the
 *      primary cleanup path under normal test runs; the process-exit hook
 *      is the belt-and-suspenders backstop.
 *
 * # Socket name convention: `tmuxcc-test-<pid>-<suffix>`
 *
 * Every test-owned socket MUST use the shape `tmuxcc-test-<pid>-<suffix>`
 * where `<pid>` is `process.pid` of the test-runner process that mints it.
 *
 * This keeps the test surface unambiguous in `/tmp/tmux-<uid>/`:
 *
 *   - Anything starting with `tmuxcc-test-` is a test artifact.
 *   - Production names (`tmuxcc-vscode-<pid>-<ts>` from daemon-transport.ts,
 *     the bare `tmuxcc` socket from `isolatedSocket: true`, the user's own
 *     `-L default`) are all strictly out of scope and will never be touched.
 *
 * The `<pid>` segment enables the boot sweep to check PID liveness:
 *
 *   - If the owning process is still alive, the socket is in active use —
 *     skip it (multiple concurrent test agents is the routine case).
 *   - If the owning process is dead, the socket is a SIGKILL orphan — kill
 *     and unlink it.
 *
 * `trackSocket` will throw at runtime if a caller passes a name that does
 * not match `/^tmuxcc-test-\d+-/`, so a bad rename is caught immediately.
 *
 * # Safety against blast radius
 *
 * The cleanup only ever runs `tmux -L <tracked-socket> kill-server` against
 * names this module itself handed out. Every socket name is checked against
 * the `tmuxcc-test-` prefix before kill — a blanket `pkill -f tmux` would
 * risk killing the user's own tmux server (e.g. `gc-chost.*`) and is NOT
 * used here.
 *
 * @module runtime/test-tmux-cleanup
 */

import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import { after } from "node:test";

// ---------------------------------------------------------------------------
// Tracked socket registry
// ---------------------------------------------------------------------------

const tracked = new Set<string>();

// Idempotent install guards — ensure we register the global hooks at most once
// per process. Both the after() hook and process exit handlers are global to
// the whole test process, not per-test.
let hooksInstalled = false;

/**
 * Prefix every test socket name must start with. Enforced for safety.
 *
 * Every test-owned socket MUST have the shape `tmuxcc-test-<pid>-<suffix>`
 * so that the boot sweep can identify orphans by their owner PID.
 */
const SOCKET_PREFIX = "tmuxcc-test-";

/**
 * Full validation regex: name must start with `tmuxcc-test-` followed by
 * at least one digit (the owner PID) then a `-`.
 */
const SOCKET_REGEX = /^tmuxcc-test-\d+-/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Idempotent, synchronous kill of a tmux server. Never throws.
 *
 * - "no server running" / "no current session" / ENOENT are all expected
 *   when the server is already dead or was never started; we swallow them.
 * - 4-second timeout to avoid blocking the process exit hook indefinitely.
 */
export function killTmuxServer(sock: string): void {
  if (!sock.startsWith(SOCKET_PREFIX)) {
    // Refuse to issue a kill against an out-of-prefix socket. This guards
    // against a caller accidentally passing the user's real socket.
    return;
  }
  try {
    execFileSync("tmux", ["-L", sock, "kill-server"], {
      timeout: 4000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Already dead, never existed, or tmux binary missing — all benign here.
  }
}

/**
 * Register a socket name for global cleanup.
 *
 * MUST be called by every test helper that mints a `tmuxcc-test-<pid>-*`
 * socket name BEFORE the server is started. Idempotent — re-registering the
 * same name is harmless.
 *
 * Throws if the name does not match `/^tmuxcc-test-\d+-/`, enforcing the
 * `tmuxcc-test-<pid>-<suffix>` convention. This keeps the cleanup blast
 * radius bounded to test-owned servers and enables the PID-liveness sweep.
 */
export function trackSocket(sock: string): void {
  if (!SOCKET_REGEX.test(sock)) {
    throw new Error(
      `trackSocket: socket name must match /^tmuxcc-test-\\d+-/ ` +
      `(shape "tmuxcc-test-<pid>-<suffix>"); got "${sock}". ` +
      `Use tmuxcc-test-\${process.pid}-<suffix> when minting socket names.`,
    );
  }
  tracked.add(sock);
  installHooksOnce();
}

/**
 * Drop a socket from the tracked set. Optional — the process-level cleanup
 * is idempotent and will no-op on already-dead servers, so callers that
 * already issued a successful per-test kill can either forget or not.
 */
export function forgetSocket(sock: string): void {
  tracked.delete(sock);
}

/**
 * Test-only: snapshot of currently-tracked socket names.
 * Used by the self-test in cleanup-safety.test.ts.
 */
export function getTrackedSockets(): readonly string[] {
  return [...tracked];
}

/**
 * Test-only: run the cleanup pass synchronously. Exposed so the self-test
 * can verify the hook actually kills tracked servers without having to
 * actually exit the process.
 */
export function flushAllTracked(): void {
  // Snapshot first so we can iterate even as kill mutates the set.
  const snapshot = [...tracked];
  for (const sock of snapshot) {
    killTmuxServer(sock);
    tracked.delete(sock);
  }
}

// ---------------------------------------------------------------------------
// Boot sweep — reap orphaned sockets from SIGKILL-ed prior runs
// ---------------------------------------------------------------------------

/**
 * Scan `/tmp/tmux-<uid>/` for stale `tmuxcc-test-*` sockets whose owner
 * PID is no longer alive and kill + unlink them.
 *
 * Algorithm:
 *   1. Read the tmux socket directory for this UID.
 *   2. For each entry matching `tmuxcc-test-<pid>-*`:
 *      - If pid === process.pid: skip (our own run).
 *      - If isPidAlive(pid):     skip (another live test agent).
 *      - Otherwise: kill the tmux server and unlink the socket file.
 *
 * PID liveness is checked with `process.kill(pid, 0)`:
 *   - Throws ESRCH  → dead PID   → reap.
 *   - Throws EPERM  → live PID, no permission to signal → leave it alone.
 *   - Returns void  → live PID, signalable              → leave it alone.
 *
 * PID-reuse trade-off: if a SIGKILLed agent's PID was recycled by an
 * unrelated live process, we leave the orphan in place. Worst case: one
 * leaked socket per PID-reuse event, far better than unbounded accumulation.
 * Reboots clear `/tmp` anyway. No TTL fallback.
 *
 * Called automatically by `installHooksOnce()` so it runs exactly once per
 * process, BEFORE the first new server is minted.
 */
export function sweepOrphanedSockets(): void {
  const uid = process.getuid?.();
  const tmuxDir = uid !== undefined ? `/tmp/tmux-${uid}` : `/tmp/tmux-${process.env["USER"] ?? "unknown"}`;

  let entries: string[];
  try {
    entries = readdirSync(tmuxDir);
  } catch {
    // Directory doesn't exist yet (first test run on this machine) — nothing
    // to sweep.
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(SOCKET_PREFIX)) continue;

    // Extract the PID segment: tmuxcc-test-<pid>-<rest>
    const afterPrefix = entry.slice(SOCKET_PREFIX.length); // "<pid>-<rest>"
    const dashIdx = afterPrefix.indexOf("-");
    if (dashIdx === -1) continue; // malformed — skip

    const pidStr = afterPrefix.slice(0, dashIdx);
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) continue; // malformed — skip

    // Skip our own sockets.
    if (pid === process.pid) continue;

    // Check liveness.
    if (isPidAlive(pid)) continue;

    // PID is dead — reap the orphan.
    killTmuxServer(entry);
    try {
      unlinkSync(`${tmuxDir}/${entry}`);
    } catch {
      // Already gone (race with another sweeper) — harmless.
    }
  }
}

/**
 * Check whether a process with the given PID is currently alive.
 *
 * Uses `process.kill(pid, 0)` which does NOT send a signal; it only checks
 * whether the process exists and we have permission to signal it:
 *   - Returns true (no throw): process is alive.
 *   - Throws ESRCH: process does not exist → dead.
 *   - Throws EPERM: process exists but we can't signal it → treat as alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;   // No such process — dead.
    if (code === "EPERM") return true;    // Alive but unpermissioned.
    // Any other error: treat as alive to be conservative.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Hook installation (once per process)
// ---------------------------------------------------------------------------

function installHooksOnce(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // 0. Boot sweep — run BEFORE minting any new server so orphaned sockets
  //    from SIGKILL-ed prior runs are reaped upfront.
  sweepOrphanedSockets();

  // 1. process.on('exit', ...) — last-ditch synchronous cleanup. Fires even
  //    when the test runner aborts due to a timed-out test.
  process.on("exit", () => {
    // Iterate over a snapshot since we mutate while iterating.
    for (const sock of [...tracked]) {
      killTmuxServer(sock);
    }
  });

  // 2. Signal handlers — Ctrl-C the runner mid-suite. We re-emit the signal
  //    after cleanup so the process still exits with the conventional code.
  //    Use `once` so a second Ctrl-C escalates normally.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      for (const sock of [...tracked]) {
        killTmuxServer(sock);
      }
      // Re-raise so default handling (exit) still happens.
      process.kill(process.pid, sig);
    });
  }

  // 3. Top-level node:test after() — runs after every describe() in the
  //    file completes (pass or fail). This is the primary cleanup path
  //    under normal runs; the exit hook above is the backstop.
  //
  //    NOTE: after() at module top level binds to the *root* suite, which
  //    runs once after all describe()/it() in this file's process have
  //    completed. Because the helper module is shared across test files,
  //    each file that imports it gets the same hook registered exactly once
  //    (the second import is a no-op via the ESM module cache).
  after(() => {
    for (const sock of [...tracked]) {
      killTmuxServer(sock);
    }
    tracked.clear();
  });
}
