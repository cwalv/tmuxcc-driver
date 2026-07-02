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
 *   - Production names (`tmuxcc-vscode-<pid>-<ts>` from session-proxy-transport.ts,
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
/**
 * Idempotent, synchronous kill of a tmux server. Never throws.
 *
 * - "no server running" / "no current session" / ENOENT are all expected
 *   when the server is already dead or was never started; we swallow them.
 * - 4-second timeout to avoid blocking the process exit hook indefinitely.
 */
export declare function killTmuxServer(sock: string): void;
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
export declare function trackSocket(sock: string): void;
/**
 * Drop a socket from the tracked set. Optional — the process-level cleanup
 * is idempotent and will no-op on already-dead servers, so callers that
 * already issued a successful per-test kill can either forget or not.
 */
export declare function forgetSocket(sock: string): void;
/**
 * Test-only: snapshot of currently-tracked socket names.
 * Used by the self-test in cleanup-safety.test.ts.
 */
export declare function getTrackedSockets(): readonly string[];
/**
 * Test-only: run the cleanup pass synchronously. Exposed so the self-test
 * can verify the hook actually kills tracked servers without having to
 * actually exit the process.
 */
export declare function flushAllTracked(): void;
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
export declare function sweepOrphanedSockets(): void;
//# sourceMappingURL=test-tmux-cleanup.d.ts.map