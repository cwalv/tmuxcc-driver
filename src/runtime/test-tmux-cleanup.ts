/**
 * tc-blk — Shared real-tmux test cleanup safety net.
 *
 * # Why this exists
 *
 * Tests that spawn real tmux servers (with `-L <socket>`) currently rely on
 * per-test `finally`/`after()` blocks to kill the server. That cleanup only
 * runs when control reaches it — if the test body throws synchronously, or
 * the node:test runner times out and aborts the body, the kill never runs
 * and the tmux server is orphaned. Observed in practice: ~16 orphan
 * `tmuxcc-e2e-*` / `tmuxcc-vsce2e-*` servers accumulated over a session.
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
 *
 * On first call to `trackSocket`, the module installs (exactly once):
 *
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
 * # Safety against blast radius
 *
 * The cleanup only ever runs `tmux -L <tracked-socket> kill-server` against
 * names this module itself handed out. Every socket name is checked to
 * start with the `tmuxcc-` prefix before kill — a blanket `pkill -f tmux`
 * would risk killing the user's own tmux server (e.g. `gc-chost.*`) and is
 * NOT used here. Callers MUST mint socket names that begin with `tmuxcc-`;
 * `trackSocket` will throw if they don't.
 *
 * @module runtime/test-tmux-cleanup
 */

import { execFileSync } from "node:child_process";
import { after } from "node:test";

// ---------------------------------------------------------------------------
// Tracked socket registry
// ---------------------------------------------------------------------------

const tracked = new Set<string>();

// Idempotent install guards — ensure we register the global hooks at most once
// per process. Both the after() hook and process exit handlers are global to
// the whole test process, not per-test.
let hooksInstalled = false;

/** Prefix every test socket name must start with. Enforced for safety. */
const SOCKET_PREFIX = "tmuxcc-";

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
 * MUST be called by every test helper that mints a `tmuxcc-*` socket name
 * BEFORE the server is started. Idempotent — re-registering the same name
 * is harmless.
 *
 * Throws if the name does not start with the `tmuxcc-` prefix, to keep the
 * cleanup blast radius bounded to test-owned servers.
 */
export function trackSocket(sock: string): void {
  if (!sock.startsWith(SOCKET_PREFIX)) {
    throw new Error(
      `trackSocket: socket name must start with "${SOCKET_PREFIX}"; got "${sock}". ` +
      `Refusing to track an out-of-prefix socket to avoid killing the user's tmux.`,
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
// Hook installation (once per process)
// ---------------------------------------------------------------------------

function installHooksOnce(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

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
