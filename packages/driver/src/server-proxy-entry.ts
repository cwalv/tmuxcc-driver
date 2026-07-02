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
import { monitorEventLoopDelay } from "node:perf_hooks";

import { createServerProxy, ServerProxyAlreadyRunningError } from "./server-proxy.js";
import type { ServerProxyOptions } from "./server-proxy.js";
import type { SpawnInfo } from "@tmuxcc/protocol";
import { PHASE_TIMING_ENABLED } from "./runtime/phase-timing.js";
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
  let persistThroughTmuxGone = false;
  let spawnInfo: SpawnInfo | undefined;
  let metricsAddr: string | undefined;

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
      case "--persist-through-tmux-gone":
        persistThroughTmuxGone = true;
        break;
      case "--metrics-addr": {
        // tc-44u4.4: empty/absent value is dropped (treated as not supplied);
        // a bare `--metrics-addr` with no operand leaves metricsAddr undefined
        // (OFF), not a silent unix-default — explicit intent only.
        const raw = argv[++i];
        if (raw !== undefined && raw.length > 0) metricsAddr = raw;
        break;
      }
      case "--spawn-info": {
        // tc-7aqb.2: parse the JSON provenance stamp from the spawner.
        // Malformed JSON or missing buildId is silently dropped — the driver
        // must remain functional regardless of what the spawner passes.
        const raw = argv[++i];
        if (raw !== undefined) {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              "buildId" in parsed &&
              typeof (parsed as { buildId: unknown }).buildId === "string"
            ) {
              spawnInfo = parsed as SpawnInfo;
            }
          } catch {
            // Malformed JSON — leave spawnInfo undefined.
          }
        }
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

  // tc-0eds: TMUXCC_PERSIST_THROUGH_TMUX_GONE env fallback (the e2e harness
  // path — the wdio config inherits the spawned server-proxy's env).  Either
  // the flag or a truthy env var enables it; absence keeps the production
  // default (self-exit on tmux-gone) unchanged.
  if (!persistThroughTmuxGone) {
    const raw = env.TMUXCC_PERSIST_THROUGH_TMUX_GONE;
    persistThroughTmuxGone = raw === "1" || raw === "true";
  }

  // tc-44u4.4: TMUXCC_METRICS_ADDR env fallback — the CLI flag wins (an
  // explicit `--metrics-addr` is more local intent than an inherited env var),
  // mirroring the `--idle-exit-ms` precedence above.  An empty env value is
  // treated as not supplied (OFF).
  if (metricsAddr === undefined) {
    const raw = env.TMUXCC_METRICS_ADDR;
    if (raw !== undefined && raw.length > 0) metricsAddr = raw;
  }

  return {
    socketName: socketName.length > 0 ? socketName : null,
    ...(runtimeDir !== undefined ? { runtimeDir } : {}),
    ...(idleExitMs !== undefined ? { idleExitMs } : {}),
    ...(persistThroughTmuxGone ? { persistThroughTmuxGone } : {}),
    ...(spawnInfo !== undefined ? { spawnInfo } : {}),
    ...(metricsAddr !== undefined ? { metricsAddr } : {}),
  };
}

function parseArgs(): {
  socketName: string;
  runtimeDir?: string;
  idleExitMs?: number;
  persistThroughTmuxGone?: boolean;
  spawnInfo?: SpawnInfo;
  metricsAddr?: string;
} {
  const cfg = _parseEntryConfig(process.argv.slice(2), process.env);

  if (cfg.socketName === null) {
    process.stderr.write(
      "Usage: server-proxy-entry --socket-name <name> [--runtime-dir <path>] " +
        "[--idle-exit-ms <n>] [--persist-through-tmux-gone] [--spawn-info '<json>'] " +
        "[--metrics-addr <unix | unix:/path | 127.0.0.1:PORT>]\n",
    );
    process.exit(1);
  }

  return {
    socketName: cfg.socketName,
    ...(cfg.runtimeDir !== undefined ? { runtimeDir: cfg.runtimeDir } : {}),
    ...(cfg.idleExitMs !== undefined ? { idleExitMs: cfg.idleExitMs } : {}),
    ...(cfg.persistThroughTmuxGone !== undefined
      ? { persistThroughTmuxGone: cfg.persistThroughTmuxGone }
      : {}),
    ...(cfg.spawnInfo !== undefined ? { spawnInfo: cfg.spawnInfo } : {}),
    ...(cfg.metricsAddr !== undefined ? { metricsAddr: cfg.metricsAddr } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { socketName, runtimeDir, idleExitMs, persistThroughTmuxGone, spawnInfo, metricsAddr } = parseArgs();

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

  // tc-jlyi.3: when TMUXCC_PHASE_TIMING=1, emit the Node.js event-loop lag
  // (p99 over each 5 s window) to stderr so it reaches the detailed
  // server-proxy.log via installStderrMirror (above).  Inert when phase
  // timing is disabled (default) — the interval is never installed.
  //
  // CHANGED FROM: nothing (nodejs_eventloop_lag_seconds was prom-client HTTP
  // only, never in the detailed log).
  // CHANGED TO: [tc-is5w] metrics line every 5 s when TMUXCC_PHASE_TIMING=1,
  // so the high-N repro captures the event-loop health alongside phase lines.
  if (PHASE_TIMING_ENABLED) {
    const lagHistogram = monitorEventLoopDelay({ resolution: 20 });
    lagHistogram.enable();
    const lagTimer = setInterval(() => {
      const p99s = lagHistogram.percentile(99) / 1e9; // nanoseconds → seconds
      process.stderr.write(
        `[tc-is5w] metrics nodejs_eventloop_lag_seconds_p99=${p99s.toFixed(6)}\n`,
      );
      lagHistogram.reset();
    }, 5_000);
    lagTimer.unref(); // do not keep the process alive solely for this timer
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
    ...(persistThroughTmuxGone !== undefined ? { persistThroughTmuxGone } : {}),
    ...(log !== null ? { logPath: log.path } : {}),
    ...(spawnInfo !== undefined ? { spawnInfo } : {}),
    ...(metricsAddr !== undefined ? { metricsAddr } : {}),
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

  try {
    await serverProxy.start();
  } catch (err: unknown) {
    // tc-kyq4.1: a live broker already owns this socket — we raced a sibling
    // spawn (another VS Code window) and LOST the bind.  Exit CLEANLY (0): we
    // never bound or owned the socket, so there is nothing to unlink and the
    // winner's socket is untouched.  The launcher re-probes and reuses the
    // winner.  This is a designed outcome, not a crash — exit 0 (the watchdog
    // must not surface it as a "server-proxy process crashed" notification).
    if (
      err instanceof ServerProxyAlreadyRunningError ||
      (err as { code?: unknown } | null)?.code === "server-proxy.already-running"
    ) {
      process.stderr.write(
        `serverProxy: socket ${socketName} already owned by a live broker — ` +
          `exiting cleanly (double-spawn loser, pid=${process.pid})\n`,
      );
      process.exit(0);
    }
    throw err;
  }

  // Signal readiness to the launcher
  process.stdout.write("READY\n");

  // Handle SIGTERM gracefully
  process.once("SIGTERM", () => {
    process.stderr.write("serverProxy: SIGTERM received, shutting down\n");
    void serverProxy.shutdown().finally(() => {
      process.exit(0);
    });
  });

  // tc-44u4.4: SIGUSR2 toggles the /metrics (+ /info) HTTP exposition — the
  // no-client / no-tooling fallback enable path (`kill -USR2 <serverProxyPid>`).
  // The canonical Unix diagnostic-toggle (mirrors Node's own SIGUSR1→inspector;
  // SIGUSR2 is free here — only SIGTERM is otherwise handled, and Node reserves
  // SIGUSR1 for the inspector).  Toggling ON always uses the SECURE unix-socket
  // default (a signal carries no bind address — never TCP); toggling again
  // unbinds.  Best-effort: a bind failure is logged, not fatal.
  process.on("SIGUSR2", () => {
    void serverProxy
      .toggleMetricsHttp()
      .then((state) => {
        process.stderr.write(
          state.enabled
            ? `serverProxy: SIGUSR2 — metrics HTTP enabled at ${state.address}\n`
            : "serverProxy: SIGUSR2 — metrics HTTP disabled\n",
        );
      })
      .catch((err: unknown) => {
        process.stderr.write(`serverProxy: SIGUSR2 metrics-http toggle failed: ${String(err)}\n`);
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
