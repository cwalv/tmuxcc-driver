/**
 * ServerProxy wire control-plane message schema (tc-j9c Stage 0 placeholder).
 *
 * The server-proxy is a per-tmux-socket discovery and lifecycle service. Clients
 * talk to it first to learn what sessions exist and to bind a connection to a
 * specific session.
 *
 * ---------------------------------------------------------------------------
 * WIRE CONTRACT INVARIANT
 * ---------------------------------------------------------------------------
 *
 * The server-proxy wire speaks in terms of sessions (metadata) and the
 * post-handshake `session.attach` binding. It MUST NEVER carry:
 *   - Pane-level data (output bytes, resize events, input)
 *   - South-side tmux vocabulary (%output, %begin/%end, etc.)
 *   - Renderer/host vocabulary (Pseudoterminal, VS Code types, DOM)
 *
 * ---------------------------------------------------------------------------
 * SINGLE-SOCKET WIRE COLLAPSE (D5, tc-4b6k.4)
 * ---------------------------------------------------------------------------
 *
 * There is ONE well-known broker socket. Every client connection lands on it
 * and runs the single `server-proxy.capabilities` handshake. After the
 * handshake a connection is in one of two modes:
 *
 *   - COMMAND connection: issues `command.request`s (claim / create / destroy /
 *     info / topology) and receives the session-set snapshot + deltas +
 *     `server-proxy.exiting`. The persistent extension keepalive is this
 *     connection.
 *   - DATA connection: sends a single {@link SessionAttachMessage}
 *     (`session.attach {sessionId}`) which BINDS the connection to that
 *     session's session-proxy. From that point the connection IS the
 *     session-proxy data+control stream (0xCC-muxed) — no second handshake,
 *     no per-session socket, no endpoint. One connection per (client, session)
 *     preserves per-session kernel backpressure isolation (tc-edf8).
 *
 * `session.claim` returns a `sessionId` (no endpoint) — the deployment topology
 * (where sockets live on disk) never leaks onto the wire.
 *
 * ---------------------------------------------------------------------------
 * DIRECTION MODEL
 * ---------------------------------------------------------------------------
 *
 * ServerProxy → Client (server-proxy push): session list snapshot + lifecycle deltas.
 * Client → ServerProxy (client request): claim/create/destroy commands; session.attach.
 * Both: capabilities handshake.
 */
// Note: ErrorMessage (type: "error") is shared with the session-proxy wire and
// is re-exported from session-proxy-control.ts. ServerProxy wire uses the same shape.
/**
 * Narrows a MessageBase to a server-proxy→client message type.
 *
 * NOTE: `command.response` is ambiguous between server-proxy and session-proxy wires
 * (both use `type: "command.response"`). In practice the caller knows which
 * wire they are on from the transport, and `command.kind` discriminates
 * further. This guard checks only the server-proxy-specific message types plus
 * the shared `command.response` discriminant.
 */
export function isServerProxyMessage(msg) {
    const t = msg.type;
    return (t === "server-proxy.capabilities" ||
        t === "sessions.snapshot" ||
        t === "sessions.added" ||
        t === "sessions.removed" ||
        t === "sessions.renamed" ||
        t === "server-proxy.exiting" ||
        t === "command.response");
}
//# sourceMappingURL=server-proxy-control.js.map