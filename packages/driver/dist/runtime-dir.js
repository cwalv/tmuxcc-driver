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
/**
 * Resolve the base tmuxcc runtime directory and ensure it exists at mode 0700.
 */
export function resolveBaseRuntimeDir(opts = {}) {
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
export function serverProxySocketPath(socketName, opts = {}) {
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
export function serverProxyLogPath(socketName, opts = {}) {
    const base = resolveBaseRuntimeDir(opts);
    const dir = path.join(base, socketName);
    ensureDir(dir, 0o700);
    return path.join(dir, "server-proxy.log");
}
/**
 * Resolve the EDH-side instrument trace log path:
 * `<runtimeDir>/<socketName>/edh-trace.log` (tc-jlyi.9).
 *
 * Written by the VS Code extension host when TMUXCC_PHASE_TIMING=1; read by
 * the reaper's secondary *.log sweep so the file lands in
 * `test/e2e/trace/<cid>-detailed-edh-trace.log` alongside the broker log.
 * Does NOT create the file — the extension host opens it append-only on
 * first use. Fail-soft on the extension side.
 */
export function edhTraceLogPath(socketName, opts = {}) {
    const base = resolveBaseRuntimeDir(opts);
    const dir = path.join(base, socketName);
    ensureDir(dir, 0o700);
    return path.join(dir, "edh-trace.log");
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
export function metricsHttpSocketPath(socketName, opts = {}) {
    const base = resolveBaseRuntimeDir(opts);
    const dir = path.join(base, socketName);
    ensureDir(dir, 0o700);
    return path.join(dir, "metrics-http.sock");
}
/**
 * Create a directory if it does not exist, set its permissions.
 * Does NOT recurse — parent must exist.
 */
function ensureDir(dir, mode) {
    try {
        fs.mkdirSync(dir, { recursive: true, mode });
    }
    catch (err) {
        // Ignore EEXIST — directory already exists
        if (err.code !== "EEXIST")
            throw err;
    }
    // Always set mode in case the directory pre-existed with different perms
    try {
        fs.chmodSync(dir, mode);
    }
    catch {
        // Non-fatal — best effort
    }
}
/**
 * Remove a socket file if it exists. Ignores ENOENT.
 */
export function removeSocket(socketPath) {
    try {
        fs.unlinkSync(socketPath);
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
    }
}
/**
 * Set permissions on a socket file to 0600.
 * Called immediately after creating a net.Server socket.
 */
export function restrictSocket(socketPath) {
    try {
        fs.chmodSync(socketPath, 0o600);
    }
    catch {
        // Non-fatal — best effort on platforms where this is not supported
    }
}
/**
 * Three-valued classification of who, if anyone, owns the unix socket at
 * `sockPath` (tc-kyq4.1).
 *
 * Unlike {@link probeLiveSocket} (which collapses timeout into "not alive"),
 * this distinguishes a socket that is DEFINITIVELY ownerless (safe to remove +
 * rebind) from one we simply could not get a verdict on (a live owner may be
 * present but slow to accept — clobbering it is the dangerous action):
 *
 *   - `"alive"`:        a connection was accepted → a live broker owns it.
 *   - `"stale"`:        ENOENT (file gone) or ECONNREFUSED (file exists, no
 *                       listener) → no live owner; the file is a dead leftover.
 *   - `"inconclusive"`: connection timed out or failed with any other errno —
 *                       no terminal evidence of death.  Callers treat this
 *                       conservatively (back off, never clobber), mirroring the
 *                       watcher-EOF "inconclusive ≠ gone" principle (tc-hfxb.22):
 *                       a self-clobber is irreversible, so it is never taken on
 *                       non-terminal evidence.
 *
 * Used by the broker's single-flight socket bind (server-proxy.ts
 * `_bindSocketAsOwner`) to decide, on EADDRINUSE, whether it lost a
 * double-spawn race (back off) or is looking at a crash-leftover file (clean
 * up + retry).
 */
export function classifySocketOwner(sockPath, timeoutMs = 500) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (verdict) => {
            if (settled)
                return;
            settled = true;
            try {
                socket.destroy();
            }
            catch { /* ignore */ }
            resolve(verdict);
        };
        const timer = setTimeout(() => done("inconclusive"), timeoutMs);
        if (typeof timer.unref === "function")
            timer.unref();
        socket.once("connect", () => {
            clearTimeout(timer);
            done("alive");
        });
        socket.once("error", (err) => {
            clearTimeout(timer);
            const code = err.code;
            if (code === "ENOENT" || code === "ECONNREFUSED") {
                done("stale");
            }
            else {
                // EACCES / EPERM / unexpected — no terminal proof the owner is dead.
                done("inconclusive");
            }
        });
        socket.connect(sockPath);
    });
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
export function probeLiveSocket(sockPath, timeoutMs = 200) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (alive) => {
            if (settled)
                return;
            settled = true;
            try {
                socket.destroy();
            }
            catch { /* ignore */ }
            resolve(alive);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        // Unref the timer so this probe never holds the event loop open on its own.
        if (typeof timer.unref === "function")
            timer.unref();
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
export async function gcStaleRuntimeDirs(baseDir, currentSocketName, opts = {}) {
    const probeTimeoutMs = opts.probeTimeoutMs ?? 200;
    const minAgeMs = opts.minAgeMs ?? 60_000;
    let entries;
    try {
        entries = fs.readdirSync(baseDir);
    }
    catch {
        // Base dir does not exist yet or is unreadable — nothing to GC.
        return;
    }
    for (const entry of entries) {
        // Never touch the current broker's own directory.
        if (entry === currentSocketName)
            continue;
        const dirPath = path.join(baseDir, entry);
        // Skip non-directories (e.g. stray files).
        let stat;
        try {
            stat = fs.statSync(dirPath);
        }
        catch {
            continue;
        }
        if (!stat.isDirectory())
            continue;
        // Age guard: a freshly-created dir may belong to a sibling broker that is
        // mid-startup (socket not bound yet) — never sweep the young.
        if (Date.now() - stat.mtimeMs < minAgeMs)
            continue;
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
        }
        catch (err) {
            // ENOENT: another process already removed it (race) — fine.
            // Anything else: log to stderr but do NOT abort startup.
            if (err.code !== "ENOENT") {
                process.stderr.write(`tmuxcc: gc: failed to remove stale dir ${dirPath}: ${String(err)}\n`);
            }
        }
    }
}
//# sourceMappingURL=runtime-dir.js.map