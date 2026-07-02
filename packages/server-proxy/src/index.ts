/**
 * @tmuxcc/server-proxy — public API.
 *
 * Primary entry point: `createServerProxy({ socketName, runtimeDir? })`.
 * Returns a ServerProxyHandle with `start()`, `shutdown()`, `endpoint()`.
 *
 * The server-proxy is a per-tmux-socket discovery and lifecycle service:
 *   - Maintains the list of sessions on a tmux socket
 *   - Instantiates per-session session-proxies IN-PROCESS on demand (tc-2x3.3)
 *   - Hands clients session-proxy socket paths via the server-proxy wire
 *
 * See SCHEMA.md "ServerProxy wire" for the full wire protocol spec.
 *
 * Lifecycle (ext-a-design-context.md §6.2/§6.3): auto-spawn is the
 * launcher's job, but the server-proxy self-manages exit (tc-3iv) — immediate
 * self-exit when tmux is confirmed gone (watcher EOF + failed probe),
 * 5-minute hysteresis self-exit at zero IPC clients.  Both paths unlink the
 * server-proxy socket file before `onSelfExit` listeners run.
 *
 * tc-2x3 Stage 2 (tc-2x3.3): the per-session session-proxies were collapsed
 * from N child processes into the server-proxy's own event loop — one
 * `createSessionProxy(...)` per claimed session, each on its own per-session
 * unix socket, all in this single process.  There are therefore no child
 * processes to orphan and no die-with-parent watchdog (tc-2c5 deleted);
 * recovery from server-proxy death is unchanged: a fresh server-proxy
 * re-attaches `-CC` to the surviving tmux sessions (tmux is the persistence layer).
 */

export { createServerProxy, ServerProxyAlreadyRunningError } from "./server-proxy.js";
export type { ServerProxyHandle, ServerProxyOptions, ServerProxySelfExitReason } from "./server-proxy.js";

// Socket transport utilities (useful for clients / tests)
export { createSocketTransport, connectSocketTransport, createSocketServer } from "./socket-transport.js";

// Runtime directory helpers (useful for clients that need to compute socket paths)
export { serverProxySocketPath, serverProxyLogPath, edhTraceLogPath, resolveBaseRuntimeDir, gcStaleRuntimeDirs, probeLiveSocket, classifySocketOwner } from "./runtime-dir.js";

// tmux-liveness probe (`tmux -L <socketName> ls`, hard-timeout).  The broker
// uses `probeTmuxAlive` for watcher-EOF disambiguation; the extension's
// broker-exit classifier reuses the SAME spawn via the three-way
// `probeTmuxLiveness` so it can tell "ran and found no server" (gone) apart
// from "could not run the probe" (inconclusive — host load) and avoid
// presuming gone on a spawn-timeout (tc-vw10).  One canonical tmux-liveness
// implementation, no second shell-out in the extension.
export { probeTmuxAlive, probeTmuxLiveness, type TmuxLiveness } from "./tmux-south.js";
