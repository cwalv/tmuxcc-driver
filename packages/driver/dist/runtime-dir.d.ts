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
export declare function resolveBaseRuntimeDir(opts?: RuntimeDirOptions): string;
/**
 * Resolve the server-proxy socket path: `<runtimeDir>/<socketName>/server-proxy.sock`.
 * Creates the socket-name sub-directory at mode 0700.
 *
 * The `socketName` is the tmux socket name (e.g. `"tmuxcc"`).  Using the
 * socket name as the directory means the path is well-known and clients can
 * discover it without out-of-band communication.
 */
export declare function serverProxySocketPath(socketName: string, opts?: RuntimeDirOptions): string;
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
export declare function serverProxyLogPath(socketName: string, opts?: RuntimeDirOptions): string;
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
export declare function edhTraceLogPath(socketName: string, opts?: RuntimeDirOptions): string;
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
export declare function metricsHttpSocketPath(socketName: string, opts?: RuntimeDirOptions): string;
/**
 * Remove a socket file if it exists. Ignores ENOENT.
 */
export declare function removeSocket(socketPath: string): void;
/**
 * Set permissions on a socket file to 0600.
 * Called immediately after creating a net.Server socket.
 */
export declare function restrictSocket(socketPath: string): void;
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
export declare function classifySocketOwner(sockPath: string, timeoutMs?: number): Promise<"alive" | "stale" | "inconclusive">;
/**
 * Probe whether a unix-domain socket at `sockPath` is accepting connections.
 *
 * Returns `true` if a connection can be established within `timeoutMs`
 * (default 200 ms), `false` for ECONNREFUSED / ENOENT / EACCES / timeout.
 * All other errors are treated as "not alive" (conservative).
 */
export declare function probeLiveSocket(sockPath: string, timeoutMs?: number): Promise<boolean>;
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
export declare function gcStaleRuntimeDirs(baseDir: string, currentSocketName: string, opts?: {
    probeTimeoutMs?: number;
    minAgeMs?: number;
}): Promise<void>;
//# sourceMappingURL=runtime-dir.d.ts.map