/**
 * Wire protocol public surface — daemon↔client contract.
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
 * Handshake flow (tc-auj) uses the Capabilities / DaemonCapabilitiesMessage /
 * ClientCapabilitiesMessage types defined here; the sequence logic lives there.
 */

// Shared primitives — used by both planes
export type { PaneId, WindowId, SessionId } from "./ids.js";
export { paneId, windowId, sessionId } from "./ids.js";

// Layout types
export type {
  Rect,
  LayoutPane,
  LayoutHSplit,
  LayoutVSplit,
  LayoutNode,
  WindowLayout,
} from "./layout.js";

// Control-plane messages and unions
export { WIRE_PROTOCOL_VERSION } from "./control.js";
export type { Capabilities, WireFeature } from "./control.js";
export type {
  // Snapshot
  SnapshotSession,
  SnapshotWindow,
  SnapshotPane,
  SnapshotMessage,
  // Daemon → Client (pane deltas)
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  PaneMode,
  PaneModeChangedMessage,
  // Daemon → Client (window deltas)
  WindowAddedMessage,
  WindowClosedMessage,
  WindowRenamedMessage,
  // Daemon → Client (layout deltas)
  LayoutUpdatedMessage,
  // Daemon → Client (focus deltas)
  FocusChangedMessage,
  // Daemon → Client (session deltas)
  SessionAddedMessage,
  SessionClosedMessage,
  SessionChangedMessage,
  SessionRenamedMessage,
  // Daemon → Client (capabilities)
  DaemonCapabilitiesMessage,
  // Daemon → Client (command response + error)
  CommandOkPayload,
  CommandResponseMessage,
  WireErrorCode,
  ErrorMessage,
  // Daemon union
  DaemonMessage,
  // Client → Daemon (input + resize)
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  // Client → Daemon (commands)
  WireCommand,
  OpenWindowCommand,
  SplitPaneCommand,
  ClosePaneCommand,
  RenameWindowCommand,
  SelectPaneCommand,
  ResizePaneCommand,
  KillSessionCommand,
  CommandRequestMessage,
  // Client → Daemon (resync)
  ResyncRequestMessage,
  // Client union
  ClientMessage,
  // Either direction
  ControlMessage,
} from "./control.js";
export { isControlMessage, isDaemonMessage, isClientMessage } from "./control.js";

// Data-plane binary frame format (tc-2mq)
export { FRAME_MAGIC, encodeFrame, decodeFrame, FrameDecoder } from "./framing.js";
export type { DataFrame } from "./framing.js";

// Handshake sequence and negotiation (tc-666)
export type { NegotiatedSession, HandshakeErrorCode } from "./handshake.js";
export {
  HandshakeError,
  intersectFeatures,
  negotiateCapabilities,
  runDaemonHandshake,
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
