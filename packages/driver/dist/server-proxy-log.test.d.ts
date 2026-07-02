/**
 * server-proxy-log.test.ts — unit tests for the append-only server-proxy log (tc-k6v).
 *
 * L1. openServerProxyLog creates the file (0600) and append() writes
 *     timestamp-prefixed chunks.
 * L2. append() after close() is a silent no-op (best-effort contract).
 * L3. openServerProxyLog returns null when the path is unwritable.
 * L4. installStderrMirror tees stderr writes into the log and the uninstall
 *     function restores the original write.
 * L5. installStderrMirror is EPIPE-resilient: once the launcher detaches the
 *     stderr pipe post-READY (tc-7xv.33), forwarding to the dead fd must NOT
 *     crash the broker — the log file is the durable sink (tc-9xf1 regression).
 *
 * @module server-proxy-log.test
 */
export {};
//# sourceMappingURL=server-proxy-log.test.d.ts.map