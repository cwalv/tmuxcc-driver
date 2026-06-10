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
import type { PaneId, SessionId } from "./ids.js";

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
 *
 * The response payload's `created` flag reports whether THIS claim minted the
 * tmux session (`true`) or attached to a pre-existing one (`false`).  The
 * broker is the system's single create-or-attach point, so this flag is the
 * authority clients use for create-time-only behaviour (e.g. profile apply,
 * tc-3y8.2).  Claims that join an in-flight claim for the same name receive
 * `created: false` — exactly one claimant observes `created: true` per
 * session creation.
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
 * Attach a new client to a specific pane within a session (tc-7xv.36).
 *
 * Semantics:
 *   - Same daemon endpoint as `session.claim` is returned — the broker does NOT
 *     spawn per-pane daemons, and the data plane is unchanged.
 *   - `paneId` is an opaque hint that the broker echoes back in the response
 *     payload.  The client uses it to drive its render-level decision of
 *     "which pane should the host pty bind to" (vs. the default first-pane-wins).
 *   - The broker does NOT validate that the pane exists.  Pane-level state is
 *     a daemon concern (see WIRE CONTRACT INVARIANT above) — the broker only
 *     knows about sessions.  If the pane has disappeared by the time the
 *     client connects to the daemon, the snapshot will simply not contain it
 *     and the client must surface that to the user.
 *
 * Use cases (tc-7xv.36):
 *   - `tmuxcc.detached.bindNew`: user picked a detached pane in the side view;
 *     bind a new VS Code terminal to that specific pane rather than to the
 *     first one reported by the snapshot.
 *   - `tmuxcc.dead.restart`: the dead pane's binding metadata identifies which
 *     session to attach; the new host pane will be created in that session by
 *     a subsequent split/open-window command — `pane.attach` carries the
 *     original paneId only to disambiguate the attach intent (the client may
 *     then issue a follow-up `split-pane` to materialise a fresh pane).
 *
 * Why this lives on the broker wire and not the daemon wire:
 *   - The same daemon process can serve multiple clients with disjoint host-
 *     pane targets — declaring the intent at attach time keeps the broker as
 *     the single discovery entry-point for both session-wide and per-pane
 *     attaches.
 *   - The broker does not pump pane bytes — `paneId` is an identifier, not
 *     pane-level data — so the wire contract invariant is preserved.
 *
 * Additive addition — non-breaking per the versioning policy.  Older brokers
 * will respond with `protocol.unknown-message`; clients fall back to
 * `session.claim` in that case.
 */
export interface PaneAttachCommand {
  readonly kind: "pane.attach";
  /** Session containing the target pane (broker-minted SessionId). */
  readonly sessionId: SessionId;
  /** Target pane on the daemon side; echoed back in the response payload. */
  readonly paneId: PaneId;
}

/**
 * Read-only broker diagnostics snapshot (tc-k6v).
 *
 * Issued by debug surfaces (the VS Code `tmuxcc.showBrokerInfo` command) to
 * render a triage panel without shelling out to pgrep/ls.  The broker answers
 * from its in-memory state plus cheap synchronous tmux queries; nothing is
 * mutated.
 *
 * Wire-contract note: the per-session entries carry session-level METADATA
 * only (names, counts, pids) — no pane content, no south-side vocabulary —
 * so the broker-wire invariant is preserved.
 *
 * Additive addition — non-breaking per the versioning policy.  Older brokers
 * respond with `protocol.unknown-message`; clients surface "broker does not
 * support broker.info" in that case.
 */
export interface BrokerInfoCommand {
  readonly kind: "broker.info";
}

/**
 * One session row in a `broker.info` response (tc-k6v).
 */
export interface BrokerInfoSession {
  readonly sessionId: SessionId;
  readonly name: string;
  /**
   * PID of the per-session daemon child, or `null` when no daemon is
   * currently running for this session (not yet claimed, or crashed and
   * awaiting lazy respawn on the next claim).
   */
  readonly daemonPid: number | null;
  /** Number of windows in the session (from `tmux list-sessions`). */
  readonly windowCount: number;
  /** Number of panes across all windows (from `tmux list-panes -a`). */
  readonly paneCount: number;
  /**
   * Raw tmux `session_attached` count.  NOTE: this includes tmuxcc's own
   * `-CC` clients (the per-session daemon and possibly the broker's thin
   * watcher), so it overstates "real" attached clients — open bead tc-3y8.7
   * owns fixing the semantics.  Display surfaces should label it as raw.
   */
  readonly attachedClientCount: number;
}

/**
 * Payload of a successful `broker.info` response (tc-k6v).
 */
export interface BrokerInfoPayload {
  /**
   * The tmux socket name this broker serves (`-L <socketName>`).  Also the
   * broker's runtime sub-directory name — broker socket name and tmux socket
   * name are the same value by construction (tc-5kv).
   */
  readonly socketName: string;
  /** Absolute path of the broker's unix socket. */
  readonly brokerSocketPath: string;
  /** The broker process's PID. */
  readonly brokerPid: number;
  /** Milliseconds since the broker's `start()` completed. */
  readonly uptimeMs: number;
  /**
   * PID of the tmux server on `socketName`, or `null` when the server is not
   * running (or has no sessions to report through).
   */
  readonly tmuxServerPid: number | null;
  /**
   * Whether the broker attached to a PRE-EXISTING tmux server at start
   * (ext-a §6.2 "adopted server"): true iff sessions already existed on the
   * socket when the broker started.  False when the broker started against
   * an empty socket (server minted later by the first session.claim).
   */
  readonly adoptedExistingServer: boolean;
  /**
   * Number of currently open IPC connections to the broker socket (raw
   * socket-level count, pre-handshake — same value that drives the tc-3iv
   * idle-exit hysteresis).  Includes the connection carrying this very
   * `broker.info` request.
   */
  readonly connectedClientCount: number;
  /**
   * Absolute path of the broker's append-only log file
   * (`<runtime>/<socketName>/broker.log`), or `null` when the broker was
   * started without log redirection (programmatic/in-process brokers).
   */
  readonly logPath: string | null;
  /** Per-session diagnostics rows. */
  readonly sessions: readonly BrokerInfoSession[];
}

/**
 * Discriminated union of all broker commands a client may issue.
 * Narrow with `cmd.kind`.
 */
export type BrokerCommand =
  | SessionClaimCommand
  | SessionCreateCommand
  | SessionDestroyCommand
  | PaneAttachCommand
  | BrokerInfoCommand;

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
 *   session.claim / session.create → { sessionId, endpoint, created }
 *   session.destroy                → { ok: true }
 *   pane.attach                    → { sessionId, endpoint, paneId }
 *   broker.info                    → { info }
 */
export interface BrokerCommandOkPayload {
  readonly sessionId?: SessionId;
  /**
   * Opaque connection string (unix socket path under the v3 trust model).
   * Clients pass it to `createDaemonTransport(endpoint)`.
   */
  readonly endpoint?: string;
  /**
   * Echoed target paneId for a `pane.attach` response (tc-7xv.36).
   *
   * Carried solely so the client has the broker's confirmation that the
   * attach intent referenced this pane.  The broker does not validate
   * existence — see `PaneAttachCommand` notes.
   */
  readonly paneId?: PaneId;
  /**
   * Whether this `session.claim` / `session.create` minted the tmux session
   * (tc-3y8.2).
   *
   * `true`  — the session did not exist; this command created it.
   * `false` — the command attached to a pre-existing session (or joined an
   *           in-flight claim that another client initiated).
   *
   * Clients use this as the authority for create-time-only behaviour —
   * notably the profile applicator, which runs exactly once per session,
   * at creation.  Absent on `session.destroy` / `pane.attach` responses;
   * treat absent as `false`.
   */
  readonly created?: boolean;
  /**
   * Diagnostics snapshot for a `broker.info` response (tc-k6v).
   * Absent on all other command kinds.
   */
  readonly info?: BrokerInfoPayload;
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
 * "session.not-found"         — session.claim, session.destroy, or pane.attach
 *                               named an unknown session.
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
