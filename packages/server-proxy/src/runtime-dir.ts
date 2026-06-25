/**
 * Runtime directory helpers — path resolution for server-proxy and session-proxy sockets.
 *
 * Follows SCHEMA.md "Trust and security model":
 *   - Sockets live under $XDG_RUNTIME_DIR/tmuxcc/<socketName>/ (or
 *     /tmp/tmuxcc-<uid>/<socketName>/ as fallback) with directory mode 0700
 *     and socket mode 0600.
 *   - The sub-directory name is the tmux socket name (e.g. "tmuxcc"), making
 *     the server-proxy socket path well-known and discoverable by clients:
 *     `<runtimeDir>/<socketName>/server-proxy.sock`.
 *
 * @module runtime-dir
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** Options controlling runtime directory resolution. */
export interface RuntimeDirOptions {
  /**
   * Override the base runtime directory.
   * Default: $XDG_RUNTIME_DIR/tmuxcc or /tmp/tmuxcc-<uid>.
   */
  runtimeDir?: string;
}

/**
 * Resolve the base tmuxcc runtime directory and ensure it exists at mode 0700.
 */
export function resolveBaseRuntimeDir(opts: RuntimeDirOptions = {}): string {
  if (opts.runtimeDir) {
    ensureDir(opts.runtimeDir, 0o700);
    return opts.runtimeDir;
  }

  const xdg = process.env["XDG_RUNTIME_DIR"];
  const base = xdg
    ? path.join(xdg, "tmuxcc")
    : path.join(os.tmpdir(), `tmuxcc-${process.getuid?.() ?? "0"}`);

  ensureDir(base, 0o700);
  return base;
}

/**
 * Resolve the server-proxy socket path: `<runtimeDir>/<socketName>/server-proxy.sock`.
 * Creates the socket-name sub-directory at mode 0700.
 *
 * The `socketName` is the tmux socket name (e.g. `"tmuxcc"`).  Using the
 * socket name as the directory means the path is well-known and clients can
 * discover it without out-of-band communication.
 */
export function serverProxySocketPath(
  socketName: string,
  opts: RuntimeDirOptions = {},
): string {
  const base = resolveBaseRuntimeDir(opts);
  const dir = path.join(base, socketName);
  ensureDir(dir, 0o700);
  return path.join(dir, "server-proxy.sock");
}

/**
 * Resolve the server-proxy log file path: `<runtimeDir>/<socketName>/server-proxy.log`
 * (tc-k6v).  Creates the socket-name sub-directory at mode 0700 (same as
 * `serverProxySocketPath`) but does NOT create the file — the server-proxy entry point
 * opens it append-only; readers (the VS Code `tmuxcc.showServerProxyLogs` tail)
 * tolerate a missing file.
 *
 * Like the server-proxy socket, the path is well-known and derivable by clients
 * without out-of-band communication.
 */
export function serverProxyLogPath(
  socketName: string,
  opts: RuntimeDirOptions = {},
): string {
  const base = resolveBaseRuntimeDir(opts);
  const dir = path.join(base, socketName);
  ensureDir(dir, 0o700);
  return path.join(dir, "server-proxy.log");
}

/**
 * Resolve the metrics-HTTP unix socket path:
 * `<runtimeDir>/<socketName>/metrics-http.sock` (tc-44u4.4).
 *
 * The SECURE DEFAULT bind for the `/metrics` (+ `/info`) HTTP exposition.
 * Creates the socket-name sub-directory at mode 0700 (same as
 * `serverProxySocketPath`); the caller chmods the socket node itself to 0600
 * via `restrictSocket` after `listen()`.  Living under the same 0700
 * runtime-dir chain as the control socket, it inherits the existing per-user
 * isolation — no hand-rolled permission logic, and a TCP bind (which is NOT
 * per-user isolated) is never the default.
 */
export function metricsHttpSocketPath(
  socketName: string,
  opts: RuntimeDirOptions = {},
): string {
  const base = resolveBaseRuntimeDir(opts);
  const dir = path.join(base, socketName);
  ensureDir(dir, 0o700);
  return path.join(dir, "metrics-http.sock");
}

/**
 * Resolve a session-proxy socket path:
 * `<runtimeDir>/<socketName>/<sessionId>.sock`.
 * Re-uses the already-created socket-name sub-directory.
 */
export function sessionProxySocketPath(
  socketName: string,
  sessionId: string,
  opts: RuntimeDirOptions = {},
): string {
  const base = resolveBaseRuntimeDir(opts);
  const dir = path.join(base, socketName);
  ensureDir(dir, 0o700);
  return path.join(dir, `${sessionId}.sock`);
}

/**
 * Create a directory if it does not exist, set its permissions.
 * Does NOT recurse — parent must exist.
 */
function ensureDir(dir: string, mode: number): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode });
  } catch (err: unknown) {
    // Ignore EEXIST — directory already exists
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Always set mode in case the directory pre-existed with different perms
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // Non-fatal — best effort
  }
}

/**
 * Remove a socket file if it exists. Ignores ENOENT.
 */
export function removeSocket(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Set permissions on a socket file to 0600.
 * Called immediately after creating a net.Server socket.
 */
export function restrictSocket(socketPath: string): void {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    // Non-fatal — best effort on platforms where this is not supported
  }
}

// ---------------------------------------------------------------------------
// GC — stale runtime directory sweep (tc-s1sm)
// ---------------------------------------------------------------------------

/**
 * Probe whether a unix-domain socket at `sockPath` is accepting connections.
 *
 * Returns `true` if a connection can be established within `timeoutMs`
 * (default 200 ms), `false` for ECONNREFUSED / ENOENT / EACCES / timeout.
 * All other errors are treated as "not alive" (conservative).
 */
export function probeLiveSocket(sockPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(alive);
    };

    const timer = setTimeout(() => done(false), timeoutMs);
    // Unref the timer so this probe never holds the event loop open on its own.
    if (typeof timer.unref === "function") timer.unref();

    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });

    socket.connect(sockPath);
  });
}

/**
 * GC sweep: remove stale per-socket-name runtime directories from `baseDir`.
 *
 * A directory `<baseDir>/<entry>/` is stale when:
 *   - it contains `server-proxy.sock`, AND
 *   - that socket does NOT accept a connection (ECONNREFUSED / ENOENT / timeout).
 *
 * A directory without `server-proxy.sock` is also removed (orphan from a
 * crashed process that never created the socket).
 *
 * Safety rules:
 *   - `currentSocketName` is always skipped — never remove the dir this
 *     process is about to use.
 *   - A successful `connect()` means a live broker is present → skip.
 *   - Dirs younger than `minAgeMs` (dir mtime, default 60 s) are skipped: a
 *     sibling broker that is mid-startup (dir created, socket not yet bound)
 *     or briefly accept-stalled under load must not be swept.  Genuinely
 *     stale dirs are crash leftovers and are minutes-to-days old.
 *   - ENOENT during `rmSync` (race: another process just removed it) is
 *     silently ignored.
 *   - All other errors during removal are silently suppressed — GC is
 *     best-effort; a failed removal does not affect the broker's operation.
 *
 * @param baseDir          The tmuxcc base runtime dir (e.g. `$XDG_RUNTIME_DIR/tmuxcc`).
 * @param currentSocketName The socket name this broker is about to bind — never removed.
 * @param opts.probeTimeoutMs Per-socket connection probe timeout (default 200 ms).
 * @param opts.minAgeMs       Minimum dir age before it is eligible for removal
 *                            (default 60 000 ms; tests pass 0).
 */
export async function gcStaleRuntimeDirs(
  baseDir: string,
  currentSocketName: string,
  opts: { probeTimeoutMs?: number; minAgeMs?: number } = {},
): Promise<void> {
  const probeTimeoutMs = opts.probeTimeoutMs ?? 200;
  const minAgeMs = opts.minAgeMs ?? 60_000;
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    // Base dir does not exist yet or is unreadable — nothing to GC.
    return;
  }

  for (const entry of entries) {
    // Never touch the current broker's own directory.
    if (entry === currentSocketName) continue;

    const dirPath = path.join(baseDir, entry);

    // Skip non-directories (e.g. stray files).
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Age guard: a freshly-created dir may belong to a sibling broker that is
    // mid-startup (socket not bound yet) — never sweep the young.
    if (Date.now() - stat.mtimeMs < minAgeMs) continue;

    const sockPath = path.join(dirPath, "server-proxy.sock");

    // Check liveness only if the socket file exists.
    const sockExists = fs.existsSync(sockPath);
    if (sockExists) {
      const alive = await probeLiveSocket(sockPath, probeTimeoutMs);
      if (alive) {
        // Live broker — never touch.
        continue;
      }
    }

    // Stale or orphan — remove the whole directory tree.
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (err: unknown) {
      // ENOENT: another process already removed it (race) — fine.
      // Anything else: log to stderr but do NOT abort startup.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(
          `tmuxcc: gc: failed to remove stale dir ${dirPath}: ${String(err)}\n`,
        );
      }
    }
  }
}
