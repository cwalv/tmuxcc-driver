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
// Snapshot (daemon→client, sent once on connect)
// ---------------------------------------------------------------------------

/**
 * A session as represented in a Snapshot.
 */
export interface SnapshotSession {
  readonly sessionId: SessionId;
  readonly name: string;
  /** True if this is the currently active session. */
  readonly active: boolean;
}

/**
 * A window as represented in a Snapshot.
 */
export interface SnapshotWindow {
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
  readonly name: string;
  /** True if this is the currently active window in its session. */
  readonly active: boolean;
  /** Structured pane layout for this window. */
  readonly layout: WindowLayout;
}

/**
 * A pane as represented in a Snapshot.
 */
export interface SnapshotPane {
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
  /** Width in columns. */
  readonly cols: number;
  /** Height in rows. */
  readonly rows: number;
}

/**
 * Full-state snapshot, sent once by the daemon immediately after the
 * capabilities handshake.
 * direction: daemon→client
 *
 * Design: normalized (flat arrays) rather than deeply nested. The client
 * builds its own in-memory tree by joining on ids. This avoids deeply
 * nested JSON and makes incremental Delta application straightforward —
 * each collection is independently patchable.
 *
 * After receiving Snapshot, the client applies subsequent Delta messages
 * (ordered by seq) to maintain an up-to-date local model. The Snapshot
 * seq acts as the baseline; any Delta with a higher seq is applied on top.
 *
 * Focus state (active pane/window/session) is carried separately in the
 * `focus` field to avoid scattering active-flag logic across three lists.
 */
export interface SnapshotMessage extends MessageBase {
  readonly type: "snapshot";
  /** All sessions in the daemon's model. */
  readonly sessions: readonly SnapshotSession[];
  /** All windows across all sessions. */
  readonly windows: readonly SnapshotWindow[];
  /** All panes across all windows. */
  readonly panes: readonly SnapshotPane[];
  /**
   * Currently focused pane/window/session triple.
   * All three are null if no pane is focused (e.g. no sessions exist).
   */
  readonly focus: {
    readonly paneId: PaneId | null;
    readonly windowId: WindowId | null;
    readonly sessionId: SessionId | null;
  };
}

// ---------------------------------------------------------------------------
// Additional Deltas — window lifecycle (daemon→client)
// ---------------------------------------------------------------------------

/**
 * A new window was added to a session.
 * direction: daemon→client
 */
export interface WindowAddedMessage extends MessageBase {
  readonly type: "window.added";
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
  readonly name: string;
  /**
   * True if the new window immediately became the active window in its session.
   * Clients may use this to avoid a separate focus event.
   */
  readonly active: boolean;
}

/**
 * A window was closed (all its panes exited or it was explicitly destroyed).
 * direction: daemon→client
 */
export interface WindowClosedMessage extends MessageBase {
  readonly type: "window.closed";
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
}

/**
 * A window was renamed.
 * direction: daemon→client
 */
export interface WindowRenamedMessage extends MessageBase {
  readonly type: "window.renamed";
  readonly windowId: WindowId;
  readonly newName: string;
}

// ---------------------------------------------------------------------------
// Additional Deltas — session lifecycle (daemon→client)
// ---------------------------------------------------------------------------

/**
 * A new session was created.
 * direction: daemon→client
 *
 * Included for completeness — clients that track the full session set need
 * this to stay in sync without reconnecting.
 */
export interface SessionAddedMessage extends MessageBase {
  readonly type: "session.added";
  readonly sessionId: SessionId;
  readonly name: string;
  /**
   * True if this session immediately became the active session.
   */
  readonly active: boolean;
}

/**
 * A session was destroyed (detached and killed, or all windows closed).
 * direction: daemon→client
 */
export interface SessionClosedMessage extends MessageBase {
  readonly type: "session.closed";
  readonly sessionId: SessionId;
}

/**
 * The active session changed (user switched sessions).
 * direction: daemon→client
 */
export interface SessionChangedMessage extends MessageBase {
  readonly type: "session.changed";
  /** The session that is now active. */
  readonly newActiveSessionId: SessionId;
}

/**
 * A session was renamed.
 * direction: daemon→client
 */
export interface SessionRenamedMessage extends MessageBase {
  readonly type: "session.renamed";
  readonly sessionId: SessionId;
  readonly newName: string;
}

// ---------------------------------------------------------------------------
// Additional Deltas — pane mode (daemon→client)
// ---------------------------------------------------------------------------

/**
 * Model-level pane mode.
 *
 * "normal"  — the pane is in its default interactive mode.
 * "copy"    — the pane is in copy/scroll mode (user is browsing history).
 * "view"    — the pane output is being viewed in a pager-like mode.
 *
 * The type is open-ended (`string & {}`) so future modes can be added without
 * a breaking schema change. Clients MUST treat unknown modes as opaque strings
 * and not crash; they may render them as "unknown mode".
 *
 * Note: tmux-internal copy-mode sub-states (vi vs emacs keybindings, cursor
 * position, etc.) are NOT represented here. This is a model-level signal only.
 */
export type PaneMode = "normal" | "copy" | "view" | (string & Record<never, never>);

/**
 * A pane entered or left a mode (e.g. entered copy mode, or returned to normal).
 * direction: daemon→client
 */
export interface PaneModeChangedMessage extends MessageBase {
  readonly type: "pane.mode-changed";
  readonly paneId: PaneId;
  readonly mode: PaneMode;
}

// ---------------------------------------------------------------------------
// Command request / response (client↔daemon, correlated)
// ---------------------------------------------------------------------------

/**
 * Open a new window in a session.
 * The daemon chooses the pane id(s); the created window/pane ids arrive via
 * CommandResponseMessage on success (payload.windowId, payload.paneId).
 */
export interface OpenWindowCommand {
  readonly kind: "open-window";
  readonly sessionId: SessionId;
  /** Optional name for the new window. If omitted the daemon picks one. */
  readonly name?: string;
}

/**
 * Split an existing pane into two.
 * The new pane's id arrives in CommandResponseMessage on success (payload.paneId).
 */
export interface SplitPaneCommand {
  readonly kind: "split-pane";
  readonly paneId: PaneId;
  /** "horizontal" = side-by-side; "vertical" = stacked top-to-bottom. */
  readonly direction: "horizontal" | "vertical";
}

/**
 * Close (kill) a pane. The daemon emits a pane.closed delta on success.
 */
export interface ClosePaneCommand {
  readonly kind: "close-pane";
  readonly paneId: PaneId;
}

/**
 * Rename a window. The daemon emits a window.renamed delta on success.
 */
export interface RenameWindowCommand {
  readonly kind: "rename-window";
  readonly windowId: WindowId;
  readonly name: string;
}

/**
 * Focus (select) a pane. The daemon emits a focus.changed delta on success.
 */
export interface SelectPaneCommand {
  readonly kind: "select-pane";
  readonly paneId: PaneId;
}

/**
 * Resize a pane. The daemon emits a pane.resized delta on success.
 * Distinct from ResizeRequestMessage (viewport-driven); this is an explicit
 * user-initiated resize command.
 */
export interface ResizePaneCommand {
  readonly kind: "resize-pane";
  readonly paneId: PaneId;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Discriminated union of all model-level commands a client may issue.
 * Narrow with `cmd.kind` to get the specific shape.
 *
 * All commands are model-level — no raw tmux command strings are exposed.
 * The daemon translates each command kind to the appropriate tmux operation
 * internally (south-side boundary). The E4 daemon runtime implements the
 * actual tmux side; this is the wire shape only.
 */
export type WireCommand =
  | OpenWindowCommand
  | SplitPaneCommand
  | ClosePaneCommand
  | RenameWindowCommand
  | SelectPaneCommand
  | ResizePaneCommand;

/**
 * Client issues a model-level command to the daemon.
 * direction: client→daemon
 *
 * `correlationId` is a client-generated opaque string (e.g. a UUID or
 * monotonic counter string) that the daemon echoes back in
 * `CommandResponseMessage`. Clients use it to match responses to outstanding
 * requests. The daemon does NOT assign correlation ids.
 */
export interface CommandRequestMessage extends MessageBase {
  readonly type: "command.request";
  /** Client-generated opaque string, echoed in the matching response. */
  readonly correlationId: string;
  /** The model operation to perform. */
  readonly command: WireCommand;
}

/**
 * Successful command result payload. Fields are optional because not every
 * command produces a new entity. The daemon includes ids for newly created
 * entities (open-window → windowId + paneId, split-pane → paneId).
 */
export interface CommandOkPayload {
  readonly windowId?: WindowId;
  readonly paneId?: PaneId;
}

/**
 * The daemon's response to a CommandRequestMessage.
 * direction: daemon→client
 *
 * Error handling: command-specific failures (unknown pane, invalid size,
 * permission denied) arrive HERE as `result.ok = false`. The separate
 * `ErrorMessage` (type: "error") is for UNSOLICITED / protocol-level errors
 * (malformed message, unknown message type, session in bad state) where there
 * is no in-flight command to correlate. If a failure is attributable to a
 * specific command request, the error comes in CommandResponseMessage, not
 * ErrorMessage. This keeps the contract simple: command.request always gets
 * exactly one command.response.
 */
export interface CommandResponseMessage extends MessageBase {
  readonly type: "command.response";
  /** Echoed from the matching CommandRequestMessage. */
  readonly correlationId: string;
  /** Discriminated result: success or failure. */
  readonly result:
    | { readonly ok: true; readonly payload?: CommandOkPayload }
    | { readonly ok: false; readonly code: string; readonly message: string };
}

// ---------------------------------------------------------------------------
// Error — unsolicited / protocol-level errors (daemon→client)
// ---------------------------------------------------------------------------

/**
 * Daemon-level error codes.
 *
 * "protocol.unknown-message"   — the daemon received a message type it does not
 *                                recognise; the message was dropped.
 * "protocol.malformed"         — the daemon could not parse the message
 *                                (e.g. missing required field, wrong type).
 * "protocol.version-mismatch"  — protocol version negotiation failed.
 * "session.unavailable"        — the tmux session the connection was bound to
 *                                has gone away unexpectedly.
 * "internal"                   — unexpected daemon-side error not attributable
 *                                to a specific command.
 *
 * The type is open-ended for forward compatibility.
 */
export type WireErrorCode =
  | "protocol.unknown-message"
  | "protocol.malformed"
  | "protocol.version-mismatch"
  | "session.unavailable"
  | "internal"
  | (string & Record<never, never>);

/**
 * Unsolicited error pushed by the daemon.
 * direction: daemon→client
 *
 * ONLY for errors that are NOT attributable to a specific outstanding
 * CommandRequestMessage. If the error IS attributable to a command, the daemon
 * sends a CommandResponseMessage with `result.ok = false` instead.
 *
 * `correlationId` is OPTIONAL: if present, it ties the error to an earlier
 * command request that the daemon is now aborting without a normal response
 * (e.g. the session died mid-execution). If absent, the error is fully
 * unsolicited (e.g. protocol parse failure on an unrelated frame).
 *
 * Clients SHOULD display or log the `message` and MAY use `code` to trigger
 * specific recovery logic. After "protocol.version-mismatch" or
 * "session.unavailable", the client should consider the connection dead.
 */
export interface ErrorMessage extends MessageBase {
  readonly type: "error";
  readonly code: WireErrorCode;
  /** Human-readable error description (English, for logging/debugging). */
  readonly message: string;
  /** If set, ties this error to a prior CommandRequestMessage. */
  readonly correlationId?: string;
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
 *
 * Grouped by family:
 *   Capabilities:  DaemonCapabilitiesMessage
 *   Snapshot:      SnapshotMessage
 *   Pane deltas:   PaneOpenedMessage | PaneClosedMessage | PaneResizedMessage | PaneModeChangedMessage
 *   Window deltas: WindowAddedMessage | WindowClosedMessage | WindowRenamedMessage
 *   Layout deltas: LayoutUpdatedMessage
 *   Focus deltas:  FocusChangedMessage
 *   Session delta: SessionAddedMessage | SessionClosedMessage | SessionChangedMessage | SessionRenamedMessage
 *   Commands:      CommandResponseMessage
 *   Errors:        ErrorMessage
 */
export type DaemonMessage =
  // Capabilities
  | DaemonCapabilitiesMessage
  // Snapshot
  | SnapshotMessage
  // Pane deltas
  | PaneOpenedMessage
  | PaneClosedMessage
  | PaneResizedMessage
  | PaneModeChangedMessage
  // Window deltas
  | WindowAddedMessage
  | WindowClosedMessage
  | WindowRenamedMessage
  // Layout deltas
  | LayoutUpdatedMessage
  // Focus deltas
  | FocusChangedMessage
  // Session deltas
  | SessionAddedMessage
  | SessionClosedMessage
  | SessionChangedMessage
  | SessionRenamedMessage
  // Command responses
  | CommandResponseMessage
  // Unsolicited errors
  | ErrorMessage;

/**
 * All messages the client sends to the daemon.
 * Narrow with `msg.type` to get the specific shape.
 */
export type ClientMessage =
  | InputMessage
  | ResizeRequestMessage
  | ClientCapabilitiesMessage
  | CommandRequestMessage;

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
    // Capabilities
    t === "daemon.capabilities" ||
    // Snapshot
    t === "snapshot" ||
    // Pane deltas
    t === "pane.opened" ||
    t === "pane.closed" ||
    t === "pane.resized" ||
    t === "pane.mode-changed" ||
    // Window deltas
    t === "window.added" ||
    t === "window.closed" ||
    t === "window.renamed" ||
    // Layout deltas
    t === "layout.updated" ||
    // Focus deltas
    t === "focus.changed" ||
    // Session deltas
    t === "session.added" ||
    t === "session.closed" ||
    t === "session.changed" ||
    t === "session.renamed" ||
    // Command responses
    t === "command.response" ||
    // Unsolicited errors
    t === "error"
  );
}

/** Narrows a ControlMessage to a specific client→daemon message type. */
export function isClientMessage(msg: ControlMessage): msg is ClientMessage {
  const t = msg.type;
  return (
    t === "input" ||
    t === "resize.request" ||
    t === "client.capabilities" ||
    t === "command.request"
  );
}
