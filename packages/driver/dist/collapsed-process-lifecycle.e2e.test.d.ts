/**
 * collapsed-process-lifecycle.e2e.test.ts — tc-2x3.5
 *
 * # What this proves
 *
 * tc-2x3.3 collapsed the N session-proxy child processes INTO the server-proxy's
 * own event loop.  There is now ONE backend process (the server-proxy) that holds
 * ALL sessions in-process.  The old "daemon-crash-respawn" e2e tested a process
 * TREE (server-proxy + N session-proxy children) and exercised the READY-handshake
 * and die-with-parent machinery — both now deleted.
 *
 * This test is the collapsed-process EQUIVALENT:
 *
 *   Kill -9 the server-proxy process
 *   → tmux sessions SURVIVE (tmux server outlives the server-proxy)
 *   → relaunch a fresh server-proxy
 *   → it rediscovers the still-alive sessions and reattaches all bindings.
 *
 * # "Bindings restored" concrete definition
 *
 * After relaunch:
 *   1. The server-proxy's `sessions.snapshot` lists the session(s) that were
 *      alive in tmux (rediscovered via `_refreshSessions()` on start).
 *   2. `server-proxy.info` reports `adoptedExistingServer: true` — this flag
 *      is set when sessions are already present at start() time, proving the
 *      reattach path ran.
 *   3. `session.claim` on the still-alive session name succeeds and returns a
 *      live session-proxy endpoint (the in-process `ensureSessionProxy()` ran
 *      `_createSessionProxy()` → spawned a fresh `-CC attach` to the session).
 *   4. The returned endpoint is a live unix socket (probeLiveSocket → true).
 *
 * # Determinism
 *
 * Every wait uses `waitFor()` (poll every 50 ms, hard timeout), not
 * `setTimeout(fixed)`.  The kill/relaunch timing is deterministic because:
 *   - We wait for the server-proxy's unix socket to be unreachable (SIGKILL +
 *     socket-file removal race — the entry point does NOT clean up on SIGKILL,
 *     so we probe via connect() attempt that ECONNREFUSED/ENOENT = dead) before
 *     relaunching.  Actually: the entry script does NOT unlink the socket on
 *     SIGKILL, so we probe by trying to connect() — ECONNREFUSED/ENOENT.
 *     We poll until the socket file disappears OR a connect() fails
 *     (the latter happens first when the process is SIGKILLed because the
 *     OS closes all listening fds before unlinking any file).
 *   - The fresh launch is ready when "READY\n" arrives on its stdout.
 *   - All session assertions are gated on snapshot contents.
 *
 * # Requires real tmux
 *
 * Real tmux 3.4 is on PATH in this repo.  The suite skips cleanly when absent.
 *
 * @module collapsed-process-lifecycle.e2e.test
 */
export {};
//# sourceMappingURL=collapsed-process-lifecycle.e2e.test.d.ts.map