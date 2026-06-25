/**
 * info.ts — typed driver-introspection round-trips (tc-44u4.3).
 *
 * One reusable home for "connect to the EXISTING driver socket, run the
 * handshake, send a `*.info` command, correlate the response".  Before this,
 * the round-trip lived ONLY in tmuxcc-vscode (server-proxy-debug.ts) and any
 * non-VSCode consumer (the tc-44u4 investigation, ad-hoc diagnostics) had to
 * hand-roll connectSocketTransport + runClientHandshake + correlationId
 * matching.
 *
 * Two surfaces:
 *
 *   - {@link fetchServerProxyInfo}(socketName) → {@link ServerProxyInfoPayload}
 *       server-proxy wire: handshake `server-proxy.capabilities`, then a
 *       `command.request { command: { kind: "server-proxy.info" } }`.
 *       Payload carries `metricsText` (Prometheus text, server-proxy-level)
 *       plus the session roster + tmux/server-proxy pids.
 *
 *   - {@link fetchSessionProxyInfo}(socketName, sessionId) →
 *       {@link SessionProxyInfoPayload}
 *       session-proxy wire: claim the session-proxy endpoint off the server-proxy,
 *       connect to it via {@link SessionProxyConnection}, then a
 *       `command.request { command: { kind: "session-proxy.info" } }`.
 *       Payload carries `metricsText` (Prometheus text, per-session-proxy) plus
 *       the storm-alarm window gauges.
 *
 * # Security (epic-level constraint, tc-44u4)
 *
 * These functions connect to the EXISTING 0600 unix sockets via the EXISTING
 * handshake.  No new listener, no weaker auth, no broadened access — this is a
 * pure client-side connect/send/correlate surface.  The sockets carry sensitive
 * data (keystrokes incl. typed passwords + captured screen content); callers
 * must treat the payloads (esp. `metricsText`) as the operator's to read, never
 * to forward off-host without intent.
 *
 * # Shape note for tc-44u4.4 (HTTP exposition)
 *
 * Both functions return the FULL structured payload incl. raw `metricsText`; no
 * bespoke metric re-parsing happens here (callers that want Prometheus scrape
 * output forward `metricsText` verbatim).  A future
 * `server-proxy.set-metrics-http` toggle (tc-44u4.4) is a NEW server-proxy
 * command — it slots in as a sibling round-trip here (a `setServerProxyMetricsHttp`
 * that sends `{ kind: "server-proxy.set-metrics-http", … }` through the same
 * {@link runServerProxyCommand} helper).  This module is shaped so that is an
 * additive change, NOT a rewrite.  tc-44u4.3 does NOT implement the toggle.
 *
 * @module info
 */
import type { Transport, ServerProxyCommand, ServerProxyCommandOkPayload, ServerProxyInfoPayload, SessionProxyInfoPayload } from "@tmuxcc/session-proxy";
/**
 * Send one server-proxy command over a handshook transport and await the
 * correlated `command.response`.
 *
 * Shared by {@link fetchServerProxyInfo} and the session-proxy endpoint claim so
 * correlationId minting, error propagation, and transport-close rejection stay
 * in one place — the same de-dup the ext's `sendServerProxyCommand` provided,
 * now reusable outside VS Code.
 *
 * @throws if the server-proxy replies `ok: false`, or the transport closes
 *         before a response arrives.
 */
export declare function runServerProxyCommand(transport: Transport, command: ServerProxyCommand, contextLabel: string): Promise<ServerProxyCommandOkPayload>;
/**
 * Connect to the server-proxy on `socketName`, send `server-proxy.info`, and
 * return the diagnostics payload.  The transport is closed before returning —
 * the server-proxy connection is request-scoped.
 *
 * @param socketName  The tmux/server-proxy socket name (server-proxy `-L` value;
 *                    also the runtime sub-dir name — they coincide by
 *                    construction, tc-5kv).
 *
 * @throws if:
 *   - the server-proxy socket does not exist / refuses connections (server-proxy
 *     not running) — callers may render that as "server-proxy not reachable",
 *     which is itself useful triage;
 *   - the handshake fails (version mismatch, timeout);
 *   - the server-proxy responds with an error (e.g. `protocol.unknown-message`
 *     from a pre-tc-k6v driver);
 *   - the response carries no `info` payload.
 */
export declare function fetchServerProxyInfo(socketName: string): Promise<ServerProxyInfoPayload>;
/**
 * Connect to the session-proxy backing the named session (via the server-proxy's
 * `session.claim`), send `session-proxy.info`, and return the per-session-proxy
 * diagnostics payload incl. `metricsText` (Prometheus text) and the storm-alarm
 * window gauges.
 *
 * Two request-scoped connections are made and torn down here: the server-proxy
 * socket (to resolve the session-proxy endpoint) and the session-proxy socket
 * itself.  Both are closed before returning.
 *
 * The endpoint is resolved via `session.claim`, the system's single
 * create-or-attach point (keyed by session NAME, not the numeric wire id — tmux
 * session numbers can be reshuffled).  For introspecting an EXISTING session
 * (the normal case) claim attaches with no side-effect; callers should pass the
 * `name` from a `server-proxy.info` session row, NOT a fabricated name, to avoid
 * minting an empty session.
 *
 * @param socketName   The tmux/server-proxy socket name (as for
 *                     {@link fetchServerProxyInfo}).
 * @param sessionName  The session NAME to introspect (the `name` field of a
 *                     `server-proxy.info` session row).
 *
 * @throws if the server-proxy/session-proxy is unreachable, either handshake
 *         fails, the claim is rejected, or the session-proxy responds with an
 *         error / no `info` payload (e.g. `protocol.unknown-message` from a
 *         pre-tc-x6l session-proxy).
 */
export declare function fetchSessionProxyInfo(socketName: string, sessionName: string): Promise<SessionProxyInfoPayload>;
//# sourceMappingURL=info.d.ts.map