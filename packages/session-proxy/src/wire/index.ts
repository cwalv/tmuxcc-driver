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

// Shared primitives — used by both planes
export type { PaneId, WindowId, SessionId, ConnectionId } from "./ids.js";
export { paneId, windowId, sessionId, connectionId } from "./ids.js";

// Layout types
export type {
  Rect,
  LayoutPane,
  LayoutHSplit,
  LayoutVSplit,
  LayoutNode,
  WindowLayout,
} from "./layout.js";

// Shared envelope types — protocol version, capabilities, base types
export { WIRE_PROTOCOL_VERSION } from "./envelope.js";
export type { Capabilities, WireFeature, MessageBase } from "./envelope.js";
export { isControlMessage } from "./envelope.js";

// ServerProxy wire control messages (placeholder — not yet wired, Stage 2)
export type {
  ServerProxyCapabilitiesMessage,
  ServerProxySessionInfo,
  ServerProxySnapshotMessage,
  ServerProxySessionAddedMessage,
  ServerProxySessionRemovedMessage,
  ServerProxySessionRenamedMessage,
  // tc-xnay / tc-ymxe: designed self-exit announcement
  ServerProxyExitReason,
  ServerProxyExitingMessage,
  ServerProxyCommand,
  SessionClaimCommand,
  SessionCreateCommand,
  SessionDestroyCommand,
  // tc-7xv.36: targeted-pane attach
  PaneAttachCommand,
  // tc-k6v: server-proxy diagnostics snapshot
  ServerProxyInfoCommand,
  ServerProxyInfoSession,
  ServerProxyInfoPayload,
  // tc-7aqb.2: spawn-info provenance stamp
  SpawnInfo,
  // tc-i9aq.2: one-shot session topology query
  SessionTopologyCommand,
  SessionTopologyWindow,
  SessionTopologyPane,
  SessionTopologyPayload,
  ServerProxyCommandRequestMessage,
  ServerProxyCommandOkPayload,
  ServerProxyCommandResponseMessage,
  ServerProxyErrorCode,
  ServerProxyMessage,
} from "./server-proxy-control.js";
export { isServerProxyMessage } from "./server-proxy-control.js";

// SessionProxy wire control-plane messages and unions
export type {
  // Snapshot
  SnapshotSession,
  SnapshotWindow,
  SnapshotPane,
  SnapshotMessage,
  // Causality tag for creation deltas (tc-ozk.2)
  Origin,
  // SessionProxy → Client (pane deltas)
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  PaneMovedMessage,
  PaneMode,
  PaneModeChangedMessage,
  // SessionProxy → Client (window deltas)
  WindowAddedMessage,
  WindowClosedMessage,
  WindowRenamedMessage,
  // SessionProxy → Client (sync-panes delta — tc-7xv.12)
  WindowSyncChangedMessage,
  // SessionProxy → Client (layout deltas)
  LayoutUpdatedMessage,
  // SessionProxy → Client (focus deltas)
  FocusChangedMessage,
  // SessionProxy → Client (session delta — only rename on session-proxy wire)
  SessionProxySessionRenamedMessage,
  // SessionProxy → Client (client-count delta — tc-44wu0)
  ClientCountChangedMessage,
  // SessionProxy → Client (per-pane attach + hydration protocol — tc-295a.8 / tc-295a.9)
  PaneAttachFailedMessage,
  PaneHydrationBeginMessage,
  PaneHydrationEndMessage,
  // SessionProxy → Client (capabilities)
  SessionProxyCapabilitiesMessage,
  // SessionProxy → Client (command response + error)
  SessionProxyCommandOkPayload,
  SessionProxyCommandResponseMessage,
  // SessionProxy diagnostics (session-proxy.info — tc-x6l)
  SessionProxyInfoCommand,
  SessionProxyInfoPayload,
  WireErrorCode,
  ErrorMessage,
  // SessionProxy union
  SessionProxyMessage,
  // Client → SessionProxy (input + resize)
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  // Client → SessionProxy (commands)
  WireCommand,
  OpenWindowCommand,
  SplitPaneCommand,
  ClosePaneCommand,
  RenameWindowCommand,
  // tc-6gnc.9: rename the bound tmux session
  RenameSessionCommand,
  SelectPaneCommand,
  ResizePaneCommand,
  // tc-zna.3: managed-window resize transaction
  ResizeManagedWindowCommand,
  KillSessionCommand,
  SetSynchronizePanesCommand,
  KillWindowCommand,
  SwapWindowCommand,
  SessionProxyCommandRequestMessage,
  // Client → SessionProxy (resync)
  ResyncRequestMessage,
  // Client → SessionProxy (per-pane attach — tc-295a.8)
  PaneAttachMessage,
  // Client union
  ClientMessage,
  // Either direction (session-proxy wire)
  ControlMessage,
  // Backward-compat aliases (deprecated)
  CommandOkPayload,
  CommandResponseMessage,
  CommandRequestMessage,
} from "./session-proxy-control.js";
export { isSessionProxyMessage, isClientMessage } from "./session-proxy-control.js";

// Data-plane binary frame format (tc-2mq)
export { FRAME_MAGIC, MAX_FRAME, encodeFrame, decodeFrame, FrameDecoder } from "./framing.js";
export type { DataFrame } from "./framing.js";

// Handshake sequence and negotiation (tc-666)
export type { NegotiatedSession, HandshakeErrorCode } from "./handshake.js";
export {
  HandshakeError,
  intersectFeatures,
  negotiateCapabilities,
  runServerHandshake,
  runSessionProxyHandshake,
  runClientHandshake,
} from "./handshake.js";

// Transport seam — in-process pair + interface types (tc-em3)
export type {
  Transport,
  InMemoryTransportPair,
  ControlHandler,
  DataHandler,
  CloseHandler,
} from "./transport.js";
export { createInMemoryTransportPair } from "./transport.js";
