/**
 * ServerProxy entry point — spawned as a child process by the VS Code extension
 * (or any other launcher) to start a server-proxy for a given tmux socket name.
 *
 * Arguments:
 *   --socket-name <name>    tmux socket name (= server-proxy socket directory name)
 *
 * Optional arguments:
 *   --runtime-dir <path>    override the base runtime directory
 *   --idle-exit-ms <n>      idle self-exit grace (default 5 min; injectable
 *                           so tests don't wait 5 real minutes).  Self-exit
 *                           requires zero IPC clients AND zero live
 *                           session-proxy children (tc-eqgp).
 *
 * Environment variables:
 *   TMUXCC_IDLE_EXIT_MS     idle self-exit grace (tc-eqgp).  Same shape as
 *                           --idle-exit-ms — must be a positive integer
 *                           number of milliseconds.  Used by deployments
 *                           (and the e2e harness, tc-nt3n) that want a
 *                           shorter grace without passing CLI flags.  When
 *                           both are supplied, --idle-exit-ms wins (the
 *                           caller passed it explicitly).
 *
 * Protocol:
 *   1. Parse arguments.
 *   2. Mirror stderr into the append-only server-proxy log file at
 *      `<runtime>/<socketName>/server-proxy.log` (tc-k6v) — launchers destroy the
 *      stderr pipe post-READY, so without the log the server-proxy's diagnostics
 *      (session-proxy crashes, self-exit reasons) would vanish.
 *   3. Create and start a serverProxy (createServerProxy from ./server-proxy.js).
 *   4. Write "READY\n" to stdout so the launcher knows we are listening.
 *   5. On SIGTERM: call serverProxy.shutdown() and exit cleanly.
 *   6. On server-proxy self-exit (tc-3iv, §6.2 — tmux gone, or idle past the
 *      hysteresis window): exit 0.  The server-proxy has already unlinked its
 *      socket file by the time the self-exit callback fires.
 *
 * This mirrors the session-proxy-entry.ts pattern: a thin entry script whose
 * only job is argument parsing → start → READY signal → exit handling.
 *
 * @module server-proxy-entry
 */
import type { SpawnInfo } from "@tmuxcc/protocol";
/**
 * Parsed entry-point configuration: the result of folding the CLI argv and
 * the relevant env vars into a single `ServerProxyOptions`-shaped object.
 *
 * `socketName` is `null` when the caller did not supply `--socket-name` —
 * the CLI driver treats that as a usage error; tests use the same shape to
 * assert the env-var path lands in `idleExitMs` correctly.
 */
export interface ParsedEntryConfig {
    socketName: string | null;
    runtimeDir?: string;
    idleExitMs?: number;
    /**
     * tc-0eds / tc-295a.41: keep the broker alive through a transient empty tmux
     * server (re-enter watcher poll mode instead of self-exiting "tmux-gone").
     * A test-harness affordance for a long-lived shared broker whose specs churn
     * sessions (the e2e harness kills every accumulated session per spec).
     * Production never sets it.  Set via `--persist-through-tmux-gone` or
     * `TMUXCC_PERSIST_THROUGH_TMUX_GONE=1`.
     */
    persistThroughTmuxGone?: boolean;
    /**
     * tc-7aqb.2: provenance stamp passed by the spawner at spawn time.
     *
     * Parsed from `--spawn-info '<json>'`.  Absent when the flag is omitted
     * (older launchers, programmatic in-process server-proxies).  The driver
     * holds it opaquely and echoes it via `server-proxy.info`.
     */
    spawnInfo?: SpawnInfo;
    /**
     * tc-44u4.4: bind the `/metrics` (+ `/info`) HTTP exposition at startup.
     *
     * Parsed from `--metrics-addr <unix | unix:/path | 127.0.0.1:PORT>` or the
     * `TMUXCC_METRICS_ADDR` env var (CLI wins, mirroring `--idle-exit-ms`).
     * Absent ⇒ OFF (no listener bound — the secure default).  The runtime
     * `server-proxy.set-metrics-http` toggle and SIGUSR2 can still enable it
     * later without a restart.
     */
    metricsAddr?: string;
}
/**
 * Parse a positive-integer-milliseconds value from a string.  Returns
 * `undefined` if the input is missing, non-numeric, or non-positive.
 *
 * Shared between the `--idle-exit-ms` CLI flag and the
 * `TMUXCC_IDLE_EXIT_MS` env var so the two paths accept exactly the same
 * shape (tc-eqgp).  Exported for unit tests.
 *
 * @internal
 */
export declare function _parseIdleExitMs(raw: string | undefined): number | undefined;
/**
 * Fold CLI argv (after the node + script slots) and env vars into a parsed
 * config.  Pure: no I/O, no process.exit; the caller decides what to do
 * when `socketName` is null.
 *
 * Exported so unit tests can drive the parser without spawning a child
 * process — see `_parseEntryConfig` callers in `server-proxy.test.ts`
 * (tc-eqgp env-precedence assertions).
 *
 * @param argv  argv slice — `process.argv.slice(2)` in production.
 * @param env   environment table — `process.env` in production.
 * @internal
 */
export declare function _parseEntryConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedEntryConfig;
//# sourceMappingURL=server-proxy-entry.d.ts.map