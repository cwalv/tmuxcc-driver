/**
 * server-proxy-log.ts — append-only server-proxy log file (tc-k6v).
 *
 * # Why
 *
 * The server-proxy is spawned detached by its launcher, which destroys the
 * stdout/stderr pipes once "READY\n" has been read (tmuxcc-vscode
 * server-proxy-launcher.ts, tc-7xv.33).  From that point on the server-proxy's stderr
 * diagnostics — session-proxy crash notices, self-exit reasons, fatal errors —
 * go nowhere.  The 2026-06-08 server-proxy debug took minutes precisely because
 * there was nothing to tail.
 *
 * # What
 *
 * `openServerProxyLog(logPath)` opens an append-only (0600) log file and returns
 * a small appender handle.  `installStderrMirror(log)` then tees every
 * `process.stderr.write` into it, prefixing each write with an ISO-8601
 * timestamp.  ServerProxy stderr writes are line-oriented (one `write` per line),
 * so per-write timestamping yields per-line timestamps in practice.
 *
 * Deliberately simple per the bead: append-only, no rotation, best-effort
 * (a failed open or a failed append never takes the server-proxy down — logging
 * is a diagnostic aid, not a dependency).
 *
 * The well-known path is `<runtime>/<socketName>/server-proxy.log` — resolve it
 * with `serverProxyLogPath()` from runtime-dir.ts.  Clients (the VS Code
 * `tmuxcc.showServerProxyLogs` command) derive the same path independently and
 * tail the file; `server-proxy.info` also reports it as `logPath`.
 *
 * @module server-proxy-log
 */
/** Appender handle returned by `openServerProxyLog`. */
export interface ServerProxyLog {
    /** The absolute log file path. */
    readonly path: string;
    /** Append a chunk (timestamped). Best-effort: errors are swallowed. */
    append(chunk: string | Uint8Array): void;
    /** Close the underlying file descriptor. Idempotent. */
    close(): void;
}
/**
 * Open `logPath` for appending (created 0600 if absent).
 *
 * Returns `null` when the file cannot be opened (unwritable directory,
 * permission failure) — callers run without a log in that case.
 */
export declare function openServerProxyLog(logPath: string): ServerProxyLog | null;
/**
 * Tee `process.stderr.write` into `log` (the original stderr still receives
 * every write — launchers that capture stderr pre-READY keep working).
 *
 * Returns an uninstall function that restores the original `write`.
 *
 * # EPIPE resilience (tc-9xf1)
 *
 * The launcher (server-proxy-launcher.ts `spawnServerProxy`, tc-7xv.33) DESTROYS
 * the broker's stdout/stderr pipes once it has read "READY\n", so the broker can
 * outlive the extension host without EPIPE-ing on the next write.  The log file
 * is the intended durable sink from that point on (see this module's header).
 *
 * After tc-2x3.3 collapsed the per-session session-proxy INTO the server-proxy
 * process, the session-proxy's own routine diagnostics (e.g. the flow-control
 * `[flow-control] DRAIN CLAMPED` warning, boundary-trip / crash notices) now run
 * in THIS process and fire post-READY — i.e. AFTER the original stderr fd was
 * destroyed.  Forwarding those writes to the detached fd raises EPIPE (or EBADF):
 *   - SYNCHRONOUSLY (origWrite throws), and/or
 *   - ASYNCHRONOUSLY (an 'error' event on process.stderr from the deferred
 *     write-queue flush — `afterWriteDispatched`).
 * With no handler, the async EPIPE becomes an uncaughtException that takes the
 * collapsed broker — and every session it serves — down.  That is the tc-9xf1
 * regression: the spawned broker self-destructed the moment tmux output flowed.
 *
 * Fix: the forward to the (possibly detached) original stderr must FAIL-SOFT —
 * the log file already captured the line, so a dead pipe must never crash the
 * broker.  We (1) swallow synchronous write errors and (2) install a benign,
 * idempotent `process.stderr.on('error')` handler that drops EPIPE/EBADF (the
 * expected detached-pipe codes) while re-throwing anything unexpected.
 */
export declare function installStderrMirror(log: ServerProxyLog): () => void;
//# sourceMappingURL=server-proxy-log.d.ts.map