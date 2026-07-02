/**
 * SessionProxy wire control-plane message schema for the tmuxcc wire protocol.
 *
 * These are the STRUCTURED messages that flow between session-proxy and client
 * on the session-proxy wire (one connection = one tmux session).
 * They are transport-agnostic: no WebSocket frames, no pipe framing, no
 * length-prefixed byte streams (that is tc-2mq's job).
 *
 * INVARIANT (enforced by design):
 *   - No tmux south-side vocabulary: no %output, no %begin/%end, no tmux
 *     command numbers, no octal escapes, no layout-string syntax.
 *   - No renderer/host vocabulary: no Pseudoterminal, no VS Code types, no DOM.
 *   The wire is the session-proxy's projection of its model, not a passthrough of
 *   tmux's control-mode syntax and not a renderer API.
 *
 * ---------------------------------------------------------------------------
 * DIRECTION MODEL
 * ---------------------------------------------------------------------------
 *
 * SessionProxy → Client (server push): the session-proxy is the source of truth and pushes
 *   state changes to the client. These are read-only events from the client's
 *   perspective.
 *
 * Client → SessionProxy (client request): the client sends input or resize requests
 *   to the session-proxy.
 *
 * Both: the handshake messages (capabilities exchange) flow in both directions;
 *   their sequencing is defined by tc-auj; here we only define the data shapes.
 *
 * ---------------------------------------------------------------------------
 * VERSIONING
 * ---------------------------------------------------------------------------
 *
 * See envelope.ts for WIRE_PROTOCOL_VERSION.
 *
 * v2 → v3 (tc-j9c.1/tc-j9c.2): SessionProxy wire becomes single-session.
 *   - Plural `sessions[]` snapshot replaced by singular `session`.
 *   - `sessionId` stripped from every delta (PaneOpenedMessage, PaneClosedMessage,
 *     LayoutUpdatedMessage, FocusChangedMessage, WindowAddedMessage, WindowClosedMessage).
 *   - `active` stripped from SnapshotSession (always true — bound session).
 *   - `sessionId` stripped from SnapshotWindow, SnapshotPane, and focus.
 *   - SessionAddedMessage, SessionChangedMessage removed from session-proxy wire
 *     (moved to server-proxy wire).
 *   - SessionRenamedMessage renamed SessionProxySessionRenamedMessage; sessionId dropped.
 *   - SessionClosedMessage removed; session destruction surfaces as ErrorMessage
 *     with code "session.unavailable".
 *   - CommandRequestMessage renamed SessionProxyCommandRequestMessage;
 *     CommandResponseMessage renamed SessionProxyCommandResponseMessage;
 *     CommandOkPayload renamed SessionProxyCommandOkPayload.
 *   - `sessionId` dropped from OpenWindowCommand.
 *   - "session.closed" removed from WireErrorCode; "session.unavailable" remains.
 */
// ---------------------------------------------------------------------------
// Type guards — runtime narrowing without external schema libraries.
// ---------------------------------------------------------------------------
/** Narrows a ControlMessage to a specific session-proxy→client message type. */
export function isSessionProxyMessage(msg) {
    const t = msg.type;
    return (
    // Capabilities
    t === "session-proxy.capabilities" ||
        // Snapshot
        t === "snapshot" ||
        // Pane deltas
        t === "pane.opened" ||
        t === "pane.closed" ||
        t === "pane.resized" ||
        t === "pane.mode-changed" ||
        t === "pane.dead-changed" ||
        // Pane re-home (window-membership change) delta (tc-4gor)
        t === "pane.moved" ||
        // Durable pane name delta (tc-1a8z)
        t === "pane.label-changed" ||
        // Live shell title delta (tc-2mn8)
        t === "pane.title-changed" ||
        // Window deltas
        t === "window.added" ||
        t === "window.closed" ||
        t === "window.renamed" ||
        // Sync-panes delta (tc-7xv.12)
        t === "window.sync.changed" ||
        // Monitor deltas (tc-7xv.15)
        t === "window.monitor.activity.changed" ||
        t === "window.monitor.silence.changed" ||
        // Layout deltas
        t === "layout.updated" ||
        // Focus deltas
        t === "focus.changed" ||
        // Session delta
        t === "session.renamed" ||
        // Client-count delta (tc-44wu0)
        t === "client-count.changed" ||
        // Per-pane attach + hydration protocol (tc-295a.8 / tc-295a.9)
        t === "pane.attach.failed" ||
        t === "pane.hydration.begin" ||
        t === "pane.hydration.end" ||
        // Command responses
        t === "command.response" ||
        // Unsolicited errors
        t === "error");
}
/** Narrows a ControlMessage to a specific client→session-proxy message type. */
export function isClientMessage(msg) {
    const t = msg.type;
    return (t === "input" ||
        t === "resize.request" ||
        t === "client.capabilities" ||
        t === "command.request" ||
        t === "resync.request" ||
        // Per-pane attach (tc-295a.8)
        t === "pane.attach" ||
        // Client-focus activity signal (tc-76m8.3)
        t === "client.focus");
}
//# sourceMappingURL=session-proxy-control.js.map