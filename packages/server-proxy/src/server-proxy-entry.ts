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

import { fileURLToPath } from "node:url";

import { createServerProxy } from "./server-proxy.js";
import type { ServerProxyOptions } from "./server-proxy.js";
import { serverProxyLogPath, resolveBaseRuntimeDir, gcStaleRuntimeDirs } from "./runtime-dir.js";
import { openServerProxyLog, installStderrMirror } from "./server-proxy-log.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

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
export function _parseIdleExitMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

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
export function _parseEntryConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ParsedEntryConfig {
  let socketName = "";
  let runtimeDir: string | undefined;
  let idleExitMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--socket-name":
        socketName = argv[++i] ?? "";
        break;
      case "--runtime-dir":
        runtimeDir = argv[++i] ?? undefined;
        break;
      case "--idle-exit-ms": {
        idleExitMs = _parseIdleExitMs(argv[++i]);
        break;
      }
    }
  }

  // tc-eqgp: TMUXCC_IDLE_EXIT_MS env fallback (the e2e harness path).  The
  // CLI flag wins when both are present: an explicit `--idle-exit-ms` on the
  // command line is more local intent than an inherited env var.
  if (idleExitMs === undefined) {
    idleExitMs = _parseIdleExitMs(env.TMUXCC_IDLE_EXIT_MS);
  }

  return {
    socketName: socketName.length > 0 ? socketName : null,
    ...(runtimeDir !== undefined ? { runtimeDir } : {}),
    ...(idleExitMs !== undefined ? { idleExitMs } : {}),
  };
}

function parseArgs(): { socketName: string; runtimeDir?: string; idleExitMs?: number } {
  const cfg = _parseEntryConfig(process.argv.slice(2), process.env);

  if (cfg.socketName === null) {
    process.stderr.write(
      "Usage: server-proxy-entry --socket-name <name> [--runtime-dir <path>] [--idle-exit-ms <n>]\n",
    );
    process.exit(1);
  }

  return {
    socketName: cfg.socketName,
    ...(cfg.runtimeDir !== undefined ? { runtimeDir: cfg.runtimeDir } : {}),
    ...(cfg.idleExitMs !== undefined ? { idleExitMs: cfg.idleExitMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { socketName, runtimeDir, idleExitMs } = parseArgs();

  // tc-k6v: mirror stderr into the append-only server-proxy log file.  Best-effort:
  // a failed open (unwritable runtime dir) leaves the server-proxy running without
  // a log — `server-proxy.info` then reports `logPath: null`.
  const log = openServerProxyLog(
    serverProxyLogPath(socketName, runtimeDir !== undefined ? { runtimeDir } : {}),
  );
  if (log !== null) {
    installStderrMirror(log);
    process.stderr.write(`serverProxy: starting pid=${process.pid} socket=${socketName} log=${log.path}\n`);
  }

  // tc-s1sm: GC stale sibling runtime dirs before binding our own socket.
  // Runs before start() so we cannot race a LIVE broker: any dir whose
  // server-proxy.sock accepts a connection is skipped; only dirs with a
  // dead/absent socket are removed.  Our own dir (socketName) is never
  // touched.  Errors are non-fatal — GC failure must not block startup.
  const baseRtDir = resolveBaseRuntimeDir(runtimeDir !== undefined ? { runtimeDir } : {});
  try {
    await gcStaleRuntimeDirs(baseRtDir, socketName);
  } catch (err: unknown) {
    process.stderr.write(`serverProxy: gc sweep error (non-fatal): ${String(err)}\n`);
  }

  const serverProxyOpts: ServerProxyOptions = {
    socketName,
    ...(runtimeDir !== undefined ? { runtimeDir } : {}),
    ...(idleExitMs !== undefined ? { idleExitMs } : {}),
    ...(log !== null ? { logPath: log.path } : {}),
  };
  const serverProxy = createServerProxy(serverProxyOpts);

  // tc-3iv (§6.2): the server-proxy self-manages exit — immediately when tmux is
  // confirmed gone, after the idle hysteresis at zero IPC clients.  By the
  // time this callback fires, shutdown() has completed and the server-proxy socket
  // file is unlinked, so a clean exit(0) is all that's left.
  serverProxy.onSelfExit((reason) => {
    process.stderr.write(`server-proxy self-exit: ${reason}\n`);
    process.exit(0);
  });

  await serverProxy.start();

  // Signal readiness to the launcher
  process.stdout.write("READY\n");

  // Handle SIGTERM gracefully
  process.once("SIGTERM", () => {
    process.stderr.write("serverProxy: SIGTERM received, shutting down\n");
    void serverProxy.shutdown().finally(() => {
      process.exit(0);
    });
  });
}

// Run only when this module is the process entry point.  Tests that import
// the module to exercise `_parseEntryConfig` / `_parseIdleExitMs` must not
// spawn a real server-proxy as a side effect of import.
//
// Detection mirrors the standard Node pattern: compare the resolved URL of
// this module against the script the user actually launched.  The session-
// proxy supervisor and the extension launcher both invoke this script via
// `node <path>` (or `node --import tsx <path>` in dev), so
// `process.argv[1]` is the absolute path of either the .js or .ts entry —
// `fileURLToPath(import.meta.url)` will match.
{
  const argvEntry = process.argv[1];
  if (argvEntry !== undefined && fileURLToPath(import.meta.url) === argvEntry) {
    main().catch((err: unknown) => {
      process.stderr.write(`server-proxy-entry fatal: ${String(err)}\n`);
      process.exit(1);
    });
  }
}
