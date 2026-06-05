/**
 * Broker wire control-plane message schema (tc-j9c Stage 0 placeholder).
 *
 * The broker is a per-tmux-socket discovery and lifecycle service. Clients
 * talk to it first to learn what sessions exist and to obtain a daemon
 * endpoint for a specific session.
 *
 * This file defines the data shapes only. The broker process, its transport,
 * and its runtime are implemented in Stage 2 (tc-j9c.3).
 *
 * ---------------------------------------------------------------------------
 * WIRE CONTRACT INVARIANT
 * ---------------------------------------------------------------------------
 *
 * The broker wire speaks in terms of sessions (metadata) and endpoints.
 * It MUST NEVER carry:
 *   - Pane-level data (output bytes, resize events, input)
 *   - South-side tmux vocabulary (%output, %begin/%end, etc.)
 *   - Renderer/host vocabulary (Pseudoterminal, VS Code types, DOM)
 *
 * ---------------------------------------------------------------------------
 * DIRECTION MODEL
 * ---------------------------------------------------------------------------
 *
 * Broker → Client (broker push): session list snapshot + lifecycle deltas.
 * Client → Broker (client request): claim/create/destroy commands.
 * Both: capabilities handshake.
 *
 * ---------------------------------------------------------------------------
 * STATUS
 * ---------------------------------------------------------------------------
 *
 * This file compiles but is not yet wired in. Broker implementation is
 * Stage 2 work (bead tc-j9c.3). Types are defined now so that Stage 0's
 * file layout matches the target shape described in SCHEMA.md.
 */

import type { MessageBase, Capabilities } from "./envelope.js";
import type { SessionId } from "./ids.js";

// ---------------------------------------------------------------------------
// Broker → Client: capabilities handshake
// ---------------------------------------------------------------------------

/**
 * Broker's capabilities advertisement (sent once at handshake time).
 * direction: broker→client
 *
 * The handshake sequence is defined by bead tc-auj; this is just the shape.
 */
export interface BrokerCapabilitiesMessage extends MessageBase {
  readonly type: "broker.capabilities";
  readonly capabilities: Capabilities;
}

// ---------------------------------------------------------------------------
// Broker session info (shared across snapshot and deltas)
// ---------------------------------------------------------------------------

/**
 * A session as known to the broker.
 *
 * Counts are static at snapshot/delta time; the broker does not push
 * live count updates. Clients that need fresh counts may issue a new
 * session.claim or reconnect to get a fresh snapshot.
 */
export interface BrokerSessionInfo {
  readonly sessionId: SessionId;
  readonly name: string;
  /** Number of windows currently in this session (at snapshot/delta time). */
  readonly windowCount: number;
  /** Number of tmuxcc clients currently attached (at snapshot/delta time). */
  readonly attachedClientCount: number;
}

// ---------------------------------------------------------------------------
// Broker → Client: snapshot
// ---------------------------------------------------------------------------

/**
 * Full session-list snapshot, sent once by the broker immediately after the
 * capabilities handshake.
 * direction: broker→client
 *
 * Clients use this to populate their session picker without polling.
 */
export interface BrokerSnapshotMessage extends MessageBase {
  readonly type: "sessions.snapshot";
  /** All sessions known to this broker at snapshot time. */
  readonly sessions: readonly BrokerSessionInfo[];
}

// ---------------------------------------------------------------------------
// Broker → Client: session-set deltas (when "sessions-watch" is negotiated)
// ---------------------------------------------------------------------------

/**
 * A new session has become visible to the broker.
 * direction: broker→client
 *
 * Shape mirrors BrokerSessionInfo so clients can update their session model
 * without polling.
 */
export interface BrokerSessionAddedMessage extends MessageBase {
  readonly type: "sessions.added";
  readonly sessionId: SessionId;
  readonly name: string;
  /** Window count at add time (same as it would appear in a fresh snapshot). */
  readonly windowCount: number;
  /** Attached-client count at add time. */
  readonly attachedClientCount: number;
}

/**
 * A session has disappeared from the broker.
 * direction: broker→client
 *
 * The broker reaps the daemon (if any) bound to this session before
 * emitting sessions.removed. Clients holding a stale daemon endpoint
 * will see their daemon connection close with "session.unavailable".
 */
export interface BrokerSessionRemovedMessage extends MessageBase {
  readonly type: "sessions.removed";
  readonly sessionId: SessionId;
}

/**
 * A session was renamed.
 * direction: broker→client
 *
 * The broker emits this alongside the daemon wire's DaemonSessionRenamedMessage.
 * Ordering between the two events on a single client is not guaranteed; clients
 * should treat the later arrival as canonical.
 */
export interface BrokerSessionRenamedMessage extends MessageBase {
  readonly type: "sessions.renamed";
  readonly sessionId: SessionId;
  readonly newName: string;
}

// ---------------------------------------------------------------------------
// Client → Broker: commands
// ---------------------------------------------------------------------------

/**
 * Claim or obtain the daemon endpoint for a named session.
 *
 * Semantics:
 *   - If a daemon for `name` already exists, return its endpoint.
 *   - If `name` does not exist as a tmux session, create it (`tmux new-session
 *     -d -s <name>`), spawn a daemon, and return.
 *   - If `name` exists but no daemon is bound, spawn one and return.
 *
 * Per-name atomicity: concurrent claims for the same name are serialized.
 * Two racing clients receive identical responses without producing two daemons.
 */
export interface SessionClaimCommand {
  readonly kind: "session.claim";
  readonly name: string;
}

/**
 * Create a brand-new session with the given name.
 * Fails if a session with that name already exists.
 */
export interface SessionCreateCommand {
  readonly kind: "session.create";
  readonly name: string;
}

/**
 * Destroy an existing session and reap its daemon.
 */
export interface SessionDestroyCommand {
  readonly kind: "session.destroy";
  readonly sessionId: SessionId;
}

/**
 * Discriminated union of all broker commands a client may issue.
 * Narrow with `cmd.kind`.
 */
export type BrokerCommand =
  | SessionClaimCommand
  | SessionCreateCommand
  | SessionDestroyCommand;

/**
 * Client issues a broker-level command.
 * direction: client→broker
 *
 * `correlationId` is a client-generated opaque string echoed back in
 * BrokerCommandResponseMessage. The broker does NOT assign correlation ids.
 */
export interface BrokerCommandRequestMessage extends MessageBase {
  readonly type: "command.request";
  /** Client-generated opaque string, echoed in the matching response. */
  readonly correlationId: string;
  /** The broker operation to perform. */
  readonly command: BrokerCommand;
}

/**
 * Successful broker command result payload.
 *
 * Per-kind payloads:
 *   session.claim / session.create → { sessionId, endpoint }
 *   session.destroy                → { ok: true }
 */
export interface BrokerCommandOkPayload {
  readonly sessionId?: SessionId;
  /**
   * Opaque connection string (unix socket path under the v3 trust model).
   * Clients pass it to `createDaemonTransport(endpoint)`.
   */
  readonly endpoint?: string;
}

/**
 * The broker's response to a BrokerCommandRequestMessage.
 * direction: broker→client
 *
 * Command-specific failures arrive HERE as `result.ok = false`.
 * The separate `ErrorMessage` (type: "error") is for unsolicited /
 * protocol-level errors where there is no in-flight command to correlate.
 */
export interface BrokerCommandResponseMessage extends MessageBase {
  readonly type: "command.response";
  /** Echoed from the matching BrokerCommandRequestMessage. */
  readonly correlationId: string;
  /** Discriminated result: success or failure. */
  readonly result:
    | { readonly ok: true; readonly payload?: BrokerCommandOkPayload }
    | { readonly ok: false; readonly code: string; readonly message: string };
}

// ---------------------------------------------------------------------------
// Broker wire error codes
// ---------------------------------------------------------------------------

/**
 * Broker-wire error codes.
 *
 * "protocol.unknown-message"  — unknown message type received; message dropped.
 * "protocol.malformed"        — parse failure.
 * "protocol.version-mismatch" — handshake version mismatch.
 * "session.not-found"         — session.claim or session.destroy named an unknown session.
 * "session.name-taken"        — session.create requested a name already in use.
 * "tmux.unavailable"          — underlying tmux server is gone or refusing commands.
 * "internal"                  — unexpected broker-side error.
 *
 * The type is open-ended for forward compatibility.
 */
export type BrokerErrorCode =
  | "protocol.unknown-message"
  | "protocol.malformed"
  | "protocol.version-mismatch"
  | "session.not-found"
  | "session.name-taken"
  | "tmux.unavailable"
  | "internal"
  | (string & Record<never, never>);

// ---------------------------------------------------------------------------
// Union types — broker wire discriminated unions
// ---------------------------------------------------------------------------

/**
 * All messages the broker pushes to the client.
 * Narrow with `msg.type`.
 */
export type BrokerMessage =
  | BrokerCapabilitiesMessage
  | BrokerSnapshotMessage
  | BrokerSessionAddedMessage
  | BrokerSessionRemovedMessage
  | BrokerSessionRenamedMessage
  | BrokerCommandResponseMessage;
// Note: ErrorMessage (type: "error") is shared with the daemon wire and
// is re-exported from daemon-control.ts. Broker wire uses the same shape.

/**
 * Narrows a MessageBase to a broker→client message type.
 *
 * NOTE: `command.response` is ambiguous between broker and daemon wires
 * (both use `type: "command.response"`). In practice the caller knows which
 * wire they are on from the transport, and `command.kind` discriminates
 * further. This guard checks only the broker-specific message types plus
 * the shared `command.response` discriminant.
 */
export function isBrokerMessage(msg: MessageBase): msg is BrokerMessage {
  const t = msg.type;
  return (
    t === "broker.capabilities" ||
    t === "sessions.snapshot" ||
    t === "sessions.added" ||
    t === "sessions.removed" ||
    t === "sessions.renamed" ||
    t === "command.response"
  );
}
