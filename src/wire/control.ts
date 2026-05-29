/**
 * Control-plane message schema for the tmuxcc wire protocol.
 *
 * These are the STRUCTURED messages that flow between daemon and client.
 * They are transport-agnostic: no WebSocket frames, no pipe framing, no
 * length-prefixed byte streams (that is tc-2mq's job).
 *
 * INVARIANT (enforced by design):
 *   - No tmux south-side vocabulary: no %output, no %begin/%end, no tmux
 *     command numbers, no octal escapes, no layout-string syntax.
 *   - No renderer/host vocabulary: no Pseudoterminal, no VS Code types, no DOM.
 *   The wire is the daemon's projection of its model, not a passthrough of
 *   tmux's control-mode syntax and not a renderer API.
 *
 * ---------------------------------------------------------------------------
 * DIRECTION MODEL
 * ---------------------------------------------------------------------------
 *
 * Daemon → Client (server push): the daemon is the source of truth and pushes
 *   state changes to the client. These are read-only events from the client's
 *   perspective. Types prefixed with no direction marker but tagged
 *   direction: "daemon→client" in their JSDoc.
 *
 * Client → Daemon (client request): the client sends input or resize requests
 *   to the daemon. Types tagged direction: "client→daemon".
 *
 * Both: the handshake messages (capabilities exchange) flow in both directions;
 *   their sequencing is defined by tc-auj; here we only define the data shapes.
 *
 * ---------------------------------------------------------------------------
 * VERSIONING
 * ---------------------------------------------------------------------------
 *
 * The protocol version is a single monotonically-increasing integer:
 *   WIRE_PROTOCOL_VERSION = 1
 *
 * It appears in the handshake-adjacent CapabilitiesMessage (both sides
 * advertise their supported version). Increment this constant for any
 * breaking change to this schema. Additive changes (new optional fields,
 * new message kinds) are non-breaking and do not require a bump.
 *
 * The version is NOT repeated in every message envelope to keep messages
 * compact. Version negotiation happens once at handshake time (tc-auj).
 */

import type { PaneId, WindowId, SessionId } from "./ids.js";
import type { WindowLayout } from "./layout.js";

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/**
 * Monotonically-increasing integer identifying this schema revision.
 * Increment on any breaking schema change. Non-breaking additions do not
 * require a bump. Version negotiation flow is defined by bead tc-auj.
 */
export const WIRE_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Capabilities (data shape only — handshake flow is tc-auj's job)
// ---------------------------------------------------------------------------

/**
 * Feature flags and version info exchanged during handshake.
 * direction: both (daemon→client and client→daemon advertise their own).
 *
 * The handshake *sequence* (who sends first, fallback logic) is defined by
 * bead tc-auj; this type is only the data shape.
 */
export interface Capabilities {
  /** Wire protocol version this endpoint implements. */
  readonly protocolVersion: typeof WIRE_PROTOCOL_VERSION;
  /**
   * Feature flags this endpoint supports.
   * Both sides advertise; the intersection is the effective feature set.
   */
  readonly features: readonly WireFeature[];
}

/**
 * Named feature flags. Extensible: unknown strings are ignored by older
 * implementations (forward-compatible).
 */
export type WireFeature =
  | "pane-lifecycle" // pane open/close/resize events
  | "layout-updates" // structured window layout pushes
  | "focus-events" // active-pane focus notifications
  | "input-forwarding" // client→daemon key/text input
  | (string & Record<never, never>); // open-ended for future features

// ---------------------------------------------------------------------------
// Shared envelope fields
// ---------------------------------------------------------------------------

/**
 * Every control-plane message carries a `type` discriminant and a
 * monotonically-increasing sequence number.  The sequence number lets the
 * client detect drops and order events; it is per-connection, starting at 1.
 *
 * Extend with additional envelope fields here if needed — e.g. a correlation
 * ID for request/response pairing in future revisions.
 */
interface MessageBase {
  /** Discriminant for TypeScript narrowing. */
  readonly type: string;
  /**
   * Per-connection sequence number, starting at 1, incremented by the
   * SENDER for each message. Daemon-push messages use the daemon's counter;
   * client-request messages use the client's counter.
   */
  readonly seq: number;
}

// ---------------------------------------------------------------------------
// Daemon → Client messages (server push)
// ---------------------------------------------------------------------------

/**
 * A new pane has been created.
 * direction: daemon→client
 *
 * Sent when a pane opens (new window, split, or any other tmux operation
 * that produces a new pane). The daemon maps the tmux-internal id to a
 * wire PaneId before sending; `%N` never appears here.
 */
export interface PaneOpenedMessage extends MessageBase {
  readonly type: "pane.opened";
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
  /** Initial size of the pane in terminal cells. */
  readonly cols: number;
  readonly rows: number;
  /**
   * True if this pane is the active (focused) pane at the moment of opening.
   * Clients MAY use this to avoid a separate focus event on startup.
   */
  readonly active: boolean;
}

/**
 * A pane has been closed (exited or killed).
 * direction: daemon→client
 */
export interface PaneClosedMessage extends MessageBase {
  readonly type: "pane.closed";
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
}

/**
 * A pane's dimensions have changed (user resized the terminal or layout changed).
 * direction: daemon→client
 *
 * Distinct from ResizeRequestMessage (client→daemon): this is the daemon
 * confirming the new size after the resize has taken effect.
 */
export interface PaneResizedMessage extends MessageBase {
  readonly type: "pane.resized";
  readonly paneId: PaneId;
  readonly cols: number;
  readonly rows: number;
}

/**
 * The layout of a window has changed.
 * direction: daemon→client
 *
 * Sent whenever panes are added, removed, or resized within a window,
 * giving clients the full current geometry as a structured tree.
 * See layout.ts for the WindowLayout / LayoutNode types.
 *
 * Clients should apply the layout atomically: update all pane rects before
 * re-rendering to avoid flickering.
 */
export interface LayoutUpdatedMessage extends MessageBase {
  readonly type: "layout.updated";
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
  readonly layout: WindowLayout;
}

/**
 * The active (focused) pane has changed.
 * direction: daemon→client
 *
 * Sent when the user navigates between panes or when tmux changes focus for
 * any reason. If no pane is active (e.g., no windows open), `paneId` is null.
 */
export interface FocusChangedMessage extends MessageBase {
  readonly type: "focus.changed";
  readonly paneId: PaneId | null;
  readonly windowId: WindowId | null;
  readonly sessionId: SessionId | null;
}

/**
 * The daemon's capabilities advertisement (sent once at handshake time).
 * direction: daemon→client
 *
 * The handshake sequence is defined by bead tc-auj; this is just the shape.
 */
export interface DaemonCapabilitiesMessage extends MessageBase {
  readonly type: "daemon.capabilities";
  readonly capabilities: Capabilities;
}

// ---------------------------------------------------------------------------
// Client → Daemon messages (client requests)
// ---------------------------------------------------------------------------

/**
 * Client sends text/key input destined for a pane.
 * direction: client→daemon
 *
 * Input is represented as a UTF-8 string. The daemon forwards this to the
 * pane's pty without tmux-level interpretation (NOT tmux send-keys syntax;
 * the daemon writes bytes directly). Special keys (e.g. escape sequences)
 * should be pre-encoded by the client as their byte sequences before sending.
 *
 * Rationale for string vs Uint8Array: the control plane is structured text
 * (JSON-serializable). Raw byte streams go through the data plane (tc-2mq).
 * Input here is typically short key-sequences or pasted text — UTF-8 strings
 * cover this well and remain JSON-serializable.
 */
export interface InputMessage extends MessageBase {
  readonly type: "input";
  readonly paneId: PaneId;
  /** UTF-8 text to write to the pane's stdin. */
  readonly data: string;
}

/**
 * Client requests that a pane be resized.
 * direction: client→daemon
 *
 * The client sends this when the host viewport changes (e.g. VS Code pane
 * resized). The daemon applies the resize to tmux and then emits a
 * PaneResizedMessage (daemon→client) confirming the new dimensions.
 */
export interface ResizeRequestMessage extends MessageBase {
  readonly type: "resize.request";
  readonly paneId: PaneId;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Client's capabilities advertisement (sent once at handshake time).
 * direction: client→daemon
 *
 * The handshake sequence is defined by bead tc-auj; this is just the shape.
 */
export interface ClientCapabilitiesMessage extends MessageBase {
  readonly type: "client.capabilities";
  readonly capabilities: Capabilities;
}

// ---------------------------------------------------------------------------
// Union types — the top-level discriminated unions
// ---------------------------------------------------------------------------

/**
 * All messages the daemon pushes to the client.
 * Narrow with `msg.type` to get the specific shape.
 */
export type DaemonMessage =
  | PaneOpenedMessage
  | PaneClosedMessage
  | PaneResizedMessage
  | LayoutUpdatedMessage
  | FocusChangedMessage
  | DaemonCapabilitiesMessage;

/**
 * All messages the client sends to the daemon.
 * Narrow with `msg.type` to get the specific shape.
 */
export type ClientMessage = InputMessage | ResizeRequestMessage | ClientCapabilitiesMessage;

/**
 * Any control-plane message (either direction).
 * Useful for generic transport code that doesn't care about direction.
 */
export type ControlMessage = DaemonMessage | ClientMessage;

// ---------------------------------------------------------------------------
// Type guards — runtime narrowing without external schema libraries.
// ---------------------------------------------------------------------------

/**
 * Checks whether a value looks like a ControlMessage at runtime (has a
 * string `type` and a numeric `seq`). Does NOT do deep field validation —
 * use a validator library (e.g. zod) if you need full schema validation.
 */
export function isControlMessage(value: unknown): value is ControlMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as Record<string, unknown>)["type"] === "string" &&
    "seq" in value &&
    typeof (value as Record<string, unknown>)["seq"] === "number"
  );
}

/** Narrows a ControlMessage to a specific daemon→client message type. */
export function isDaemonMessage(msg: ControlMessage): msg is DaemonMessage {
  const t = msg.type;
  return (
    t === "pane.opened" ||
    t === "pane.closed" ||
    t === "pane.resized" ||
    t === "layout.updated" ||
    t === "focus.changed" ||
    t === "daemon.capabilities"
  );
}

/** Narrows a ControlMessage to a specific client→daemon message type. */
export function isClientMessage(msg: ControlMessage): msg is ClientMessage {
  const t = msg.type;
  return t === "input" || t === "resize.request" || t === "client.capabilities";
}
