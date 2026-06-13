/**
 * ServerProxy wire control-plane message schema (tc-j9c Stage 0 placeholder).
 *
 * The server-proxy is a per-tmux-socket discovery and lifecycle service. Clients
 * talk to it first to learn what sessions exist and to obtain a session-proxy
 * endpoint for a specific session.
 *
 * This file defines the data shapes only. The server-proxy process, its transport,
 * and its runtime are implemented in Stage 2 (tc-j9c.3).
 *
 * ---------------------------------------------------------------------------
 * WIRE CONTRACT INVARIANT
 * ---------------------------------------------------------------------------
 *
 * The server-proxy wire speaks in terms of sessions (metadata) and endpoints.
 * It MUST NEVER carry:
 *   - Pane-level data (output bytes, resize events, input)
 *   - South-side tmux vocabulary (%output, %begin/%end, etc.)
 *   - Renderer/host vocabulary (Pseudoterminal, VS Code types, DOM)
 *
 * ---------------------------------------------------------------------------
 * DIRECTION MODEL
 * ---------------------------------------------------------------------------
 *
 * ServerProxy → Client (server-proxy push): session list snapshot + lifecycle deltas.
 * Client → ServerProxy (client request): claim/create/destroy commands.
 * Both: capabilities handshake.
 *
 * ---------------------------------------------------------------------------
 * STATUS
 * ---------------------------------------------------------------------------
 *
 * This file compiles but is not yet wired in. ServerProxy implementation is
 * Stage 2 work (bead tc-j9c.3). Types are defined now so that Stage 0's
 * file layout matches the target shape described in SCHEMA.md.
 */

import type { MessageBase, Capabilities } from "./envelope.js";
import type { PaneId, SessionId } from "./ids.js";

// ---------------------------------------------------------------------------
// ServerProxy → Client: capabilities handshake
// ---------------------------------------------------------------------------

/**
 * ServerProxy's capabilities advertisement (sent once at handshake time).
 * direction: server-proxy→client
 *
 * The handshake sequence is defined by bead tc-auj; this is just the shape.
 */
export interface ServerProxyCapabilitiesMessage extends MessageBase {
  readonly type: "server-proxy.capabilities";
  readonly capabilities: Capabilities;
}

// ---------------------------------------------------------------------------
// ServerProxy session info (shared across snapshot and deltas)
// ---------------------------------------------------------------------------

/**
 * A session as known to the server-proxy.
 *
 * Counts are static at snapshot/delta time; the server-proxy does not push
 * live count updates. Clients that need fresh counts may issue a new
 * session.claim or reconnect to get a fresh snapshot.
 *
 * tc-295a.4 (W1.3): enriched with tmuxccMarked, paneCount, lastActivity.
 * These fields are carried in snapshots and all session-added deltas so the
 * session picker (S1/W1.6) can render foreign-session rows without extra
 * round-trips.
 */
export interface ServerProxySessionInfo {
  readonly sessionId: SessionId;
  readonly name: string;
  /** Number of windows currently in this session (at snapshot/delta time). */
  readonly windowCount: number;
  /** Number of tmuxcc clients currently attached (at snapshot/delta time). */
  readonly attachedClientCount: number;
  /**
   * Whether this session carries the `@tmuxcc 1` user option (tc-295a.4 /
   * W1.3).  True for all sessions created/claimed by tmuxcc; false for
   * foreign sessions (e.g. user-created or managed by another tool).
   */
  readonly tmuxccMarked: boolean;
  /**
   * Total panes across all windows in this session at snapshot/delta time
   * (tc-295a.4 / W1.3).  Sourced from `tmux list-panes -a`.
   */
  readonly paneCount: number;
  /**
   * Unix epoch (seconds) of the most-recent activity in this session
   * (tc-295a.4 / W1.3).  Sourced from tmux's `#{session_activity}`.
   */
  readonly lastActivity: number;
}

// ---------------------------------------------------------------------------
// ServerProxy → Client: snapshot
// ---------------------------------------------------------------------------

/**
 * Full session-list snapshot, sent once by the server-proxy immediately after the
 * capabilities handshake.
 * direction: server-proxy→client
 *
 * Clients use this to populate their session picker without polling.
 *
 * BD-COMMENT tc-295a.4: sessions.snapshot shape changed — each ServerProxySessionInfo
 * entry now carries three new fields: tmuxccMarked (boolean), paneCount (number),
 * lastActivity (number).  TL: amend the JSON Schema for sessions.snapshot in the
 * protocol/ package at merge.
 */
export interface ServerProxySnapshotMessage extends MessageBase {
  readonly type: "sessions.snapshot";
  /** All sessions known to this server-proxy at snapshot time. */
  readonly sessions: readonly ServerProxySessionInfo[];
}

// ---------------------------------------------------------------------------
// ServerProxy → Client: session-set deltas (when "sessions-watch" is negotiated)
// ---------------------------------------------------------------------------

/**
 * A new session has become visible to the server-proxy.
 * direction: server-proxy→client
 *
 * Shape mirrors ServerProxySessionInfo so clients can update their session model
 * without polling.
 *
 * tc-295a.4 (W1.3): enriched with tmuxccMarked, paneCount, lastActivity
 * (same fields as ServerProxySessionInfo).
 *
 * BD-COMMENT tc-295a.4: sessions.added message shape changed — three new fields
 * added: tmuxccMarked (boolean), paneCount (number), lastActivity (number).
 * TL: amend the JSON Schema for sessions.added in the protocol/ package at merge.
 */
export interface ServerProxySessionAddedMessage extends MessageBase {
  readonly type: "sessions.added";
  readonly sessionId: SessionId;
  readonly name: string;
  /** Window count at add time (same as it would appear in a fresh snapshot). */
  readonly windowCount: number;
  /** Attached-client count at add time. */
  readonly attachedClientCount: number;
  /** Whether this session carries the `@tmuxcc 1` marker (tc-295a.4 / W1.3). */
  readonly tmuxccMarked: boolean;
  /** Total pane count at add time (tc-295a.4 / W1.3). */
  readonly paneCount: number;
  /** Unix epoch (seconds) of last activity at add time (tc-295a.4 / W1.3). */
  readonly lastActivity: number;
}

/**
 * A session has disappeared from the server-proxy.
 * direction: server-proxy→client
 *
 * The server-proxy reaps the sessionProxy (if any) bound to this session before
 * emitting sessions.removed. Clients holding a stale session-proxy endpoint
 * will see their session-proxy connection close with "session.unavailable".
 */
export interface ServerProxySessionRemovedMessage extends MessageBase {
  readonly type: "sessions.removed";
  readonly sessionId: SessionId;
}

/**
 * A session was renamed.
 * direction: server-proxy→client
 *
 * The server-proxy emits this alongside the session-proxy wire's SessionProxySessionRenamedMessage.
 * Ordering between the two events on a single client is not guaranteed; clients
 * should treat the later arrival as canonical.
 */
export interface ServerProxySessionRenamedMessage extends MessageBase {
  readonly type: "sessions.renamed";
  readonly sessionId: SessionId;
  readonly newName: string;
}

// ---------------------------------------------------------------------------
// ServerProxy → Client: designed self-exit announcement (tc-xnay / tc-ymxe)
// ---------------------------------------------------------------------------

/**
 * Reasons the server-proxy may DESIGN-exit (broadcast in `server-proxy.exiting`).
 *
 * Mirrors `ServerProxySelfExitReason` in @tmuxcc/server-proxy's runtime; defined
 * on the wire so clients can interpret an `exiting` announcement without
 * importing the runtime package.
 *
 *   "idle"      — zero IPC clients AND zero live session-proxy children for the
 *                 full hysteresis window (§6.2 / tc-eqgp).  Routine quiescence;
 *                 no user UX.
 *   "tmux-gone" — the tmux server vanished (watcher EOF + failed `tmux ls`
 *                 probe).  User's sessions are gone — informational, not an
 *                 error.
 *
 * Open union to keep the wire forward-compatible: a future designed reason
 * the extension does not yet recognise must NOT be classified as a crash —
 * the presence of an `exiting` message is the load-bearing signal, not the
 * reason string.
 */
export type ServerProxyExitReason =
  | "idle"
  | "tmux-gone"
  | (string & Record<never, never>);

/**
 * The server-proxy is about to perform a DESIGNED self-exit (tc-xnay / tc-ymxe).
 *
 * direction: server-proxy→client (broadcast immediately before `_selfExit`'s
 * shutdown() runs)
 *
 * # Why this message exists
 *
 * Before this message, every broker process death looked identical to the
 * extension: socket close on the keepalive (tc-eqgp) and/or a non-zero
 * child-exit watchdog signal.  Two failure modes resulted:
 *   1. tc-xnay — clean idle exits (exit code 0, designed) were surfaced as
 *      crash error notifications.
 *   2. tc-ymxe — externally-started brokers had no child-exit watchdog at
 *      all; SIGKILL silently degraded the extension.
 *
 * `server-proxy.exiting` makes the broker's intent EXPLICIT on the wire so the
 * extension's classification locus can distinguish designed quiescence from
 * unexpected death for BOTH self-spawned and externally-started brokers.
 *
 * # Delivery guarantees
 *
 * - Broadcast to every connected client immediately before `shutdown()` runs.
 * - Best-effort: a transport that has already closed (or whose buffer is
 *   full) silently drops the message — the keepalive then falls back to the
 *   "no announcement seen → unexpected death" classification, which is the
 *   safe default.
 * - One announcement per broker exit; the broker does NOT re-broadcast on
 *   shutdown-via-SIGTERM (the launcher knows SIGTERM was deliberate from its
 *   own `dispose()` flag).
 *
 * Additive addition — non-breaking per the versioning policy.  Older
 * extensions ignore unknown control messages (the keepalive's `onControl`
 * is a drain-only handler), so a new broker talking to an old extension
 * loses ONLY the classification refinement; lifecycle is unchanged.
 */
export interface ServerProxyExitingMessage extends MessageBase {
  readonly type: "server-proxy.exiting";
  /** Why the broker is exiting.  See {@link ServerProxyExitReason}. */
  readonly reason: ServerProxyExitReason;
}

// ---------------------------------------------------------------------------
// Client → ServerProxy: commands
// ---------------------------------------------------------------------------

/**
 * Claim or obtain the session-proxy endpoint for a named session.
 *
 * Semantics:
 *   - If a session-proxy for `name` already exists, return its endpoint.
 *   - If `name` does not exist as a tmux session, create it (`tmux new-session
 *     -d -s <name>`), spawn a sessionProxy, and return.
 *   - If `name` exists but no session-proxy is bound, spawn one and return.
 *
 * Per-name atomicity: concurrent claims for the same name are serialized.
 * Two racing clients receive identical responses without producing two session-proxies.
 *
 * The response payload's `created` flag reports whether THIS claim minted the
 * tmux session (`true`) or attached to a pre-existing one (`false`).  The
 * server-proxy is the system's single create-or-attach point, so this flag is the
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
 * Broker-minted unique session creation (tc-295a.5 / W1.4).
 *
 * Semantics:
 *   - The broker derives a unique name from `baseName` by checking its live
 *     `_byName` truth table (never the extension's in-process defaultRegistry).
 *   - If `baseName` is already taken, the broker appends `-2`, `-3`, … until
 *     a slot is free, then creates the session atomically (name-check and
 *     `tmux new-session` are serialized via the same `_claimLocks` mechanism
 *     used by `session.create`).
 *   - Always creates a new session — never silently attaches to an existing
 *     one.  The response always reports `created: true`.
 *
 * Use case: the extension's `startNew` path — the user asked for a FRESH
 * session, so the broker must not silently recycle a released base name that
 * still lives in tmux (the tc-d6dn root-cause bug).
 *
 * Wire-contract note: `baseName` may be empty or omitted; the broker falls
 * back to `"tmuxcc"` in that case.  `name` in the response is the final
 * uniquified name that was actually created.
 */
export interface SessionCreateUniqueCommand {
  readonly kind: "session.createUnique";
  /** Base session name.  The broker appends `-2`, `-3`, … as needed. */
  readonly baseName: string;
}

/**
 * Destroy an existing session and reap its session-proxy.
 */
export interface SessionDestroyCommand {
  readonly kind: "session.destroy";
  readonly sessionId: SessionId;
}

/**
 * Attach a new client to a specific pane within a session (tc-7xv.36).
 *
 * Semantics:
 *   - Same session-proxy endpoint as `session.claim` is returned — the server-proxy does NOT
 *     spawn per-pane session-proxies, and the data plane is unchanged.
 *   - `paneId` is an opaque hint that the server-proxy echoes back in the response
 *     payload.  The client uses it to drive its render-level decision of
 *     "which pane should the host pty bind to" (vs. the default first-pane-wins).
 *   - The server-proxy does NOT validate that the pane exists.  Pane-level state is
 *     a session-proxy concern (see WIRE CONTRACT INVARIANT above) — the server-proxy only
 *     knows about sessions.  If the pane has disappeared by the time the
 *     client connects to the sessionProxy, the snapshot will simply not contain it
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
 * Why this lives on the server-proxy wire and not the session-proxy wire:
 *   - The same session-proxy process can serve multiple clients with disjoint host-
 *     pane targets — declaring the intent at attach time keeps the server-proxy as
 *     the single discovery entry-point for both session-wide and per-pane
 *     attaches.
 *   - The server-proxy does not pump pane bytes — `paneId` is an identifier, not
 *     pane-level data — so the wire contract invariant is preserved.
 *
 * Additive addition — non-breaking per the versioning policy.  Older server-proxies
 * will respond with `protocol.unknown-message`; clients fall back to
 * `session.claim` in that case.
 */
export interface PaneAttachCommand {
  readonly kind: "pane.attach";
  /** Session containing the target pane (server-proxy-minted SessionId). */
  readonly sessionId: SessionId;
  /** Target pane on the session-proxy side; echoed back in the response payload. */
  readonly paneId: PaneId;
}

/**
 * Read-only server-proxy diagnostics snapshot (tc-k6v).
 *
 * Issued by debug surfaces (the VS Code `tmuxcc.showServerProxyInfo` command) to
 * render a triage panel without shelling out to pgrep/ls.  The server-proxy answers
 * from its in-memory state plus cheap synchronous tmux queries; nothing is
 * mutated.
 *
 * Wire-contract note: the per-session entries carry session-level METADATA
 * only (names, counts, pids) — no pane content, no south-side vocabulary —
 * so the server-proxy-wire invariant is preserved.
 *
 * Additive addition — non-breaking per the versioning policy.  Older server-proxies
 * respond with `protocol.unknown-message`; clients surface "server-proxy does not
 * support server-proxy.info" in that case.
 */
export interface ServerProxyInfoCommand {
  readonly kind: "server-proxy.info";
}

/**
 * One session row in a `server-proxy.info` response (tc-k6v).
 */
export interface ServerProxyInfoSession {
  readonly sessionId: SessionId;
  readonly name: string;
  /**
   * PID of the per-session session-proxy child, or `null` when no session-proxy is
   * currently running for this session (not yet claimed, or crashed and
   * awaiting lazy respawn on the next claim).
   */
  readonly sessionProxyPid: number | null;
  /** Number of windows in the session (from `tmux list-sessions`). */
  readonly windowCount: number;
  /** Number of panes across all windows (from `tmux list-panes -a`). */
  readonly paneCount: number;
  /**
   * Raw tmux `session_attached` count.  NOTE: this includes tmuxcc's own
   * `-CC` clients (the per-session session-proxy and possibly the server-proxy's thin
   * watcher), so it overstates "real" attached clients — open bead tc-3y8.7
   * owns fixing the semantics.  Display surfaces should label it as raw.
   */
  readonly attachedClientCount: number;
}

/**
 * Payload of a successful `server-proxy.info` response (tc-k6v).
 */
export interface ServerProxyInfoPayload {
  /**
   * The tmux socket name this server-proxy serves (`-L <socketName>`).  Also the
   * server-proxy's runtime sub-directory name — server-proxy socket name and tmux socket
   * name are the same value by construction (tc-5kv).
   */
  readonly socketName: string;
  /** Absolute path of the server-proxy's unix socket. */
  readonly serverProxySocketPath: string;
  /** The server-proxy process's PID. */
  readonly serverProxyPid: number;
  /** Milliseconds since the server-proxy's `start()` completed. */
  readonly uptimeMs: number;
  /**
   * PID of the tmux server on `socketName`, or `null` when the server is not
   * running (or has no sessions to report through).
   */
  readonly tmuxServerPid: number | null;
  /**
   * Whether the server-proxy attached to a PRE-EXISTING tmux server at start
   * (ext-a §6.2 "adopted server"): true iff sessions already existed on the
   * socket when the server-proxy started.  False when the server-proxy started against
   * an empty socket (server minted later by the first session.claim).
   */
  readonly adoptedExistingServer: boolean;
  /**
   * Number of currently open IPC connections to the server-proxy socket (raw
   * socket-level count, pre-handshake — same value that drives the tc-3iv
   * idle-exit hysteresis).  Includes the connection carrying this very
   * `server-proxy.info` request.
   */
  readonly connectedClientCount: number;
  /**
   * Absolute path of the server-proxy's append-only log file
   * (`<runtime>/<socketName>/server-proxy.log`), or `null` when the server-proxy was
   * started without log redirection (programmatic/in-process server-proxies).
   */
  readonly logPath: string | null;
  /** Per-session diagnostics rows. */
  readonly sessions: readonly ServerProxyInfoSession[];
  /**
   * Prometheus text exposition of all server-proxy-level metrics (tc-x6l).
   *
   * Contains counter and histogram data for the server-proxy itself
   * (commands issued, clients connected, etc.).  Per-session metrics are NOT
   * included — they live in each session-proxy process; fetch them by
   * connecting to the session-proxy socket and issuing `session-proxy.info`.
   *
   * `null` when metrics are unavailable (should never happen in practice).
   */
  readonly metricsText: string | null;
}

/**
 * Discriminated union of all server-proxy commands a client may issue.
 * Narrow with `cmd.kind`.
 */
export type ServerProxyCommand =
  | SessionClaimCommand
  | SessionCreateCommand
  | SessionCreateUniqueCommand
  | SessionDestroyCommand
  | PaneAttachCommand
  | ServerProxyInfoCommand;

/**
 * Client issues a server-proxy-level command.
 * direction: client→server-proxy
 *
 * `correlationId` is a client-generated opaque string echoed back in
 * ServerProxyCommandResponseMessage. The server-proxy does NOT assign correlation ids.
 */
export interface ServerProxyCommandRequestMessage extends MessageBase {
  readonly type: "command.request";
  /** Client-generated opaque string, echoed in the matching response. */
  readonly correlationId: string;
  /** The server-proxy operation to perform. */
  readonly command: ServerProxyCommand;
}

/**
 * Successful server-proxy command result payload.
 *
 * Per-kind payloads:
 *   session.claim / session.create / session.createUnique → { sessionId, name, endpoint, created }
 *   session.destroy                → { ok: true }
 *   pane.attach                    → { sessionId, endpoint, paneId }
 *   server-proxy.info              → { info }
 */
export interface ServerProxyCommandOkPayload {
  readonly sessionId?: SessionId;
  /**
   * Opaque connection string (unix socket path under the v3 trust model).
   * Clients pass it to `createSessionProxyTransport(endpoint)`.
   */
  readonly endpoint?: string;
  /**
   * Echoed target paneId for a `pane.attach` response (tc-7xv.36).
   *
   * Carried solely so the client has the server-proxy's confirmation that the
   * attach intent referenced this pane.  The server-proxy does not validate
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
   * The final uniquified session name minted by `session.createUnique` (tc-295a.5 / W1.4).
   *
   * Present only on `session.createUnique` responses — absent on all other
   * command kinds.  The broker derives this from the supplied `baseName` by
   * appending `-2`, `-3`, … until a name not already in its live `_byName`
   * table is found, then creates the session atomically.
   */
  readonly name?: string;
  /**
   * Diagnostics snapshot for a `server-proxy.info` response (tc-k6v).
   * Absent on all other command kinds.
   */
  readonly info?: ServerProxyInfoPayload;
}

/**
 * The server-proxy's response to a ServerProxyCommandRequestMessage.
 * direction: server-proxy→client
 *
 * Command-specific failures arrive HERE as `result.ok = false`.
 * The separate `ErrorMessage` (type: "error") is for unsolicited /
 * protocol-level errors where there is no in-flight command to correlate.
 */
export interface ServerProxyCommandResponseMessage extends MessageBase {
  readonly type: "command.response";
  /** Echoed from the matching ServerProxyCommandRequestMessage. */
  readonly correlationId: string;
  /** Discriminated result: success or failure. */
  readonly result:
    | { readonly ok: true; readonly payload?: ServerProxyCommandOkPayload }
    | { readonly ok: false; readonly code: string; readonly message: string };
}

// ---------------------------------------------------------------------------
// ServerProxy wire error codes
// ---------------------------------------------------------------------------

/**
 * ServerProxy-wire error codes.
 *
 * "protocol.unknown-message"  — unknown message type received; message dropped.
 * "protocol.malformed"        — parse failure.
 * "protocol.version-mismatch" — handshake version mismatch.
 * "session.not-found"         — session.claim, session.destroy, or pane.attach
 *                               named an unknown session.
 * "session.name-taken"        — session.create requested a name already in use.
 * "tmux.unavailable"          — underlying tmux server is gone or refusing commands.
 * "internal"                  — unexpected server-proxy-side error.
 *
 * The type is open-ended for forward compatibility.
 */
export type ServerProxyErrorCode =
  | "protocol.unknown-message"
  | "protocol.malformed"
  | "protocol.version-mismatch"
  | "session.not-found"
  | "session.name-taken"
  | "tmux.unavailable"
  | "internal"
  | (string & Record<never, never>);

// ---------------------------------------------------------------------------
// Union types — server-proxy wire discriminated unions
// ---------------------------------------------------------------------------

/**
 * All messages the server-proxy pushes to the client.
 * Narrow with `msg.type`.
 */
export type ServerProxyMessage =
  | ServerProxyCapabilitiesMessage
  | ServerProxySnapshotMessage
  | ServerProxySessionAddedMessage
  | ServerProxySessionRemovedMessage
  | ServerProxySessionRenamedMessage
  | ServerProxyExitingMessage
  | ServerProxyCommandResponseMessage;
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
export function isServerProxyMessage(msg: MessageBase): msg is ServerProxyMessage {
  const t = msg.type;
  return (
    t === "server-proxy.capabilities" ||
    t === "sessions.snapshot" ||
    t === "sessions.added" ||
    t === "sessions.removed" ||
    t === "sessions.renamed" ||
    t === "server-proxy.exiting" ||
    t === "command.response"
  );
}
