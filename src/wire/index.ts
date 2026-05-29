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
  // Daemon → Client
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  DaemonCapabilitiesMessage,
  DaemonMessage,
  // Client → Daemon
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  ClientMessage,
  // Either direction
  ControlMessage,
} from "./control.js";
export { isControlMessage, isDaemonMessage, isClientMessage } from "./control.js";
