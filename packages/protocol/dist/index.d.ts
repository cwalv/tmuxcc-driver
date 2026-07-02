/**
 * Wire protocol public surface — session-proxy↔client contract.
 *
 * The wire speaks in terms of panes, bytes, deltas, input, resize, and layout.
 * It NEVER leaks:
 *   - tmux south-side vocabulary (%output, %begin/%end, tmux command numbers,
 *     octal escapes, layout-string syntax)
 *   - renderer/host vocabulary (Pseudoterminal, VS Code types, DOM)
 *
 * Two planes:
 *   - Control plane (this module): structured messages, discriminated unions.
 *   - Data plane (tc-2mq): length-prefixed raw pane byte streams; imports
 *     PaneId from ids.ts to tag frames.
 *
 * Handshake flow (tc-auj) uses the Capabilities / SessionProxyCapabilitiesMessage /
 * ClientCapabilitiesMessage types defined here; the sequence logic lives there.
 *
 * File layout (tc-j9c Stage 0):
 *   envelope.ts        — MessageBase, Capabilities, WireFeature, WIRE_PROTOCOL_VERSION, isControlMessage
 *   server-proxy-control.ts  — ServerProxy wire control messages + ServerProxyCommand union
 *   session-proxy-control.ts  — SessionProxy wire control messages + WireCommand union
 */
export type { PaneId, WindowId, SessionId, ConnectionId } from "./ids.js";
export { paneId, windowId, sessionId, connectionId } from "./ids.js";
export type { Rect, LayoutPane, LayoutHSplit, LayoutVSplit, LayoutNode, WindowLayout, } from "./layout.js";
export { WIRE_PROTOCOL_VERSION } from "./envelope.js";
export type { Capabilities, WireFeature, MessageBase, ClientIdentity, ClientFlags } from "./envelope.js";
export { isControlMessage, describeClientIdentity } from "./envelope.js";
export type { ServerProxyCapabilitiesMessage, ServerProxySessionInfo, ServerProxySnapshotMessage, ServerProxySessionAddedMessage, ServerProxySessionRemovedMessage, ServerProxySessionRenamedMessage, ServerProxyExitReason, ServerProxyExitingMessage, ServerProxyCommand, SessionClaimCommand, SessionCreateCommand, SessionDestroyCommand, SessionAttachMessage, ServerProxyInfoCommand, ServerProxyInfoSession, ServerProxyInfoPayload, TmuxCapabilityMap, ServerProxySetMetricsHttpCommand, MetricsHttpStatePayload, SpawnInfo, SessionTopologyCommand, SessionTopologyWindow, SessionTopologyPane, SessionTopologyPayload, ServerProxyCommandRequestMessage, ServerProxyCommandOkPayload, ServerProxyCommandResponseMessage, ServerProxyErrorCode, ServerProxyMessage, } from "./server-proxy-control.js";
export { isServerProxyMessage } from "./server-proxy-control.js";
export type { SnapshotSession, SnapshotWindow, SnapshotPane, SnapshotMessage, Origin, PaneOpenedMessage, PaneClosedMessage, PaneResizedMessage, PaneMovedMessage, PaneMode, PaneModeChangedMessage, PaneLabelChangedMessage, PaneDeadChangedMessage, PaneTitleChangedMessage, PanePolicyChangedMessage, PaneNotifyMessage, PaneNotifyKind, PaneNotifyPayload, PaneNotifySource, PaneProgressState, WindowAddedMessage, WindowClosedMessage, WindowRenamedMessage, WindowSyncChangedMessage, WindowMonitorActivityChangedMessage, WindowMonitorSilenceChangedMessage, LayoutUpdatedMessage, FocusChangedMessage, SessionProxySessionRenamedMessage, ClientCountChangedMessage, PaneAttachFailedMessage, PaneHydrationBeginMessage, PaneHydrationEndMessage, SessionProxyCapabilitiesMessage, SessionProxyCommandOkPayload, SessionProxyCommandResponseMessage, SessionProxyInfoCommand, SessionProxyInfoPayload, WireErrorCode, ErrorMessage, SessionProxyMessage, InputMessage, ResizeRequestMessage, ClientCapabilitiesMessage, WireCommand, OpenWindowCommand, SplitPaneCommand, ClosePaneCommand, PaneCaptureCommand, RenameWindowCommand, RenameSessionCommand, SelectPaneCommand, ResizePaneCommand, ResizeManagedWindowCommand, KillSessionCommand, SetSynchronizePanesCommand, KillWindowCommand, SwapWindowCommand, SessionProxyCommandRequestMessage, ResyncRequestMessage, PaneAttachMessage, ClientFocusMessage, ClientMessage, ControlMessage, CommandOkPayload, CommandResponseMessage, CommandRequestMessage, } from "./session-proxy-control.js";
export { isSessionProxyMessage, isClientMessage } from "./session-proxy-control.js";
export { FRAME_MAGIC, MAX_FRAME, encodeFrame, decodeFrame, FrameDecoder } from "./framing.js";
export type { DataFrame } from "./framing.js";
export type { NegotiatedSession, HandshakeErrorCode } from "./handshake.js";
export { HandshakeError, intersectFeatures, negotiateCapabilities, runServerHandshake, runSessionProxyHandshake, runClientHandshake, } from "./handshake.js";
export type { Transport, InMemoryTransportPair, ControlHandler, DataHandler, CloseHandler, } from "./transport.js";
export { createInMemoryTransportPair } from "./transport.js";
//# sourceMappingURL=index.d.ts.map