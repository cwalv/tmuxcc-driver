/**
 * ServerProxy wire control-plane message schema (tc-j9c Stage 0 placeholder).
 *
 * The server-proxy is a per-tmux-socket discovery and lifecycle service. Clients
 * talk to it first to learn what sessions exist and to bind a connection to a
 * specific session.
 *
 * ---------------------------------------------------------------------------
 * WIRE CONTRACT INVARIANT
 * ---------------------------------------------------------------------------
 *
 * The server-proxy wire speaks in terms of sessions (metadata) and the
 * post-handshake `session.attach` binding. It MUST NEVER carry:
 *   - Pane-level data (output bytes, resize events, input)
 *   - South-side tmux vocabulary (%output, %begin/%end, etc.)
 *   - Renderer/host vocabulary (Pseudoterminal, VS Code types, DOM)
 *
 * ---------------------------------------------------------------------------
 * SINGLE-SOCKET WIRE COLLAPSE (D5, tc-4b6k.4)
 * ---------------------------------------------------------------------------
 *
 * There is ONE well-known broker socket. Every client connection lands on it
 * and runs the single `server-proxy.capabilities` handshake. After the
 * handshake a connection is in one of two modes:
 *
 *   - COMMAND connection: issues `command.request`s (claim / create / destroy /
 *     info / topology) and receives the session-set snapshot + deltas +
 *     `server-proxy.exiting`. The persistent extension keepalive is this
 *     connection.
 *   - DATA connection: sends a single {@link SessionAttachMessage}
 *     (`session.attach {sessionId}`) which BINDS the connection to that
 *     session's session-proxy. From that point the connection IS the
 *     session-proxy data+control stream (0xCC-muxed) — no second handshake,
 *     no per-session socket, no endpoint. One connection per (client, session)
 *     preserves per-session kernel backpressure isolation (tc-edf8).
 *
 * `session.claim` returns a `sessionId` (no endpoint) — the deployment topology
 * (where sockets live on disk) never leaks onto the wire.
 *
 * ---------------------------------------------------------------------------
 * DIRECTION MODEL
 * ---------------------------------------------------------------------------
 *
 * ServerProxy → Client (server-proxy push): session list snapshot + lifecycle deltas.
 * Client → ServerProxy (client request): claim/create/destroy commands; session.attach.
 * Both: capabilities handshake.
 */
import type { MessageBase, Capabilities, ClientIdentity, ClientFlags } from "./envelope.js";
import type { PaneId, SessionId } from "./ids.js";
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
    /**
     * Workspace identity carried on the session as the `@tmuxcc-workspace`
     * user-option (S4 / tc-76m8.6), or `undefined` when the session carries no
     * such option (folderless-window sessions, foreign sessions, and every
     * session created before S4).  Sourced from tmux's `#{@tmuxcc-workspace}`.
     * The extension matches this against the current workspace's
     * `session-name.workspaceIdentity` to reattach by identity rather than name.
     */
    readonly workspaceUri?: string;
}
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
    /**
     * Whether the broker can currently reach the `tmux` binary (tc-295a.35).
     *
     * `true`  — tmux is installed and runnable (the normal case).
     * `false` — the `tmux` executable is absent from the broker's PATH
     *           (`spawnSync` ENOENT).  The broker does NOT exit on this — it
     *           stays up, keeps polling, and flips this flag back to `true` in a
     *           later snapshot if tmux appears (preserving the
     *           tolerate-tmux-appearing-later behaviour, tc-295a.16 RCA).
     *
     * This is the canonical "is tmux available?" signal the extension reads from
     * the broker's snapshot to surface the actionable "tmuxcc requires tmux."
     * message — replacing the deleted `which tmux` pre-flight (E3.1 / plan A1g)
     * with driver-owned state instead of an extension-side shell-out.
     *
     * OPTIONAL on the wire for forward/backward compatibility: an older broker
     * that predates this field omits it; the extension treats `undefined` as
     * "available" (the safe default — no false "tmux missing" prompt against a
     * broker that simply doesn't report the flag).
     */
    readonly tmuxAvailable?: boolean;
}
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
    /**
     * Workspace identity (`@tmuxcc-workspace`), or `undefined` when unset (S4 /
     * tc-76m8.6).  Same field as {@link ServerProxySessionInfo.workspaceUri}.
     */
    readonly workspaceUri?: string;
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
export type ServerProxyExitReason = "idle" | "tmux-gone" | (string & Record<never, never>);
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
/**
 * Claim a named session and return its stable `sessionId` (D5, tc-4b6k.4).
 *
 * Semantics:
 *   - If `name` does not exist as a tmux session, create it (`tmux new-session
 *     -d -s <name>`), spawn a sessionProxy, and return its `sessionId`.
 *   - If `name` exists, ensure a session-proxy is running and return its
 *     `sessionId`.
 *
 * The response carries `{ sessionId, name, created }` — NO endpoint. The client
 * then opens (or reuses) a connection to the broker socket and sends
 * {@link SessionAttachMessage} `session.attach {sessionId}` to bind that
 * connection to the session's stream.
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
    /**
     * Optional workspace identity (S4 / tc-76m8.6).  When present, the broker sets
     * it on the freshly-minted session as the `@tmuxcc-workspace` user-option so
     * that a later reopen/arrival matches this workspace's session by identity
     * rather than by name.  The value is the canonical workspace URI
     * (`session-name.workspaceIdentity`).  Omitted for folderless windows (which
     * carry no workspace identity) and by older extensions.
     */
    readonly workspaceUri?: string;
}
/**
 * Destroy an existing session and reap its session-proxy.
 */
export interface SessionDestroyCommand {
    readonly kind: "session.destroy";
    readonly sessionId: SessionId;
}
/**
 * Bind THIS connection to a session's stream (D5, tc-4b6k.4).
 *
 * Sent by a client ONCE after the `server-proxy.capabilities` handshake, on a
 * connection it wants to become a DATA connection. It is a top-level
 * client→server-proxy message (NOT a `command.request`): it transitions the
 * connection rather than returning a correlated response.
 *
 * Semantics:
 *   - The broker looks up `sessionId`, ensures the session-proxy is running
 *     (`ensureSessionProxy` — idempotent with `session.claim`'s single-flight),
 *     detaches the connection from the command-plane (it stops receiving
 *     session-set deltas), and hands the transport to the session-proxy's
 *     `addClient`. The session-proxy's snapshot + deltas continue the SAME
 *     per-connection seq counter (no reset), so the client mirror sees one
 *     monotonic stream across the handoff.
 *   - There is NO second handshake and NO per-session socket: the single
 *     `server-proxy.capabilities` handshake already negotiated version +
 *     identity for this connection.
 *   - Success is signalled by the session snapshot arriving; an unknown
 *     `sessionId` closes the connection (the client observes the disconnect).
 *
 * `flags` carries the D4/D8 tmux-parity client flags (ignore-size / read-only) —
 * RESERVED carriage only in this bead; the driver does not act on them yet
 * (owner-only size authority is tc-4b6k.3).
 *
 * `primaryPaneId` is the targeted-attach hint (formerly the `pane.attach`
 * command, tc-7xv.36): the pane the client is binding its host pty to. The
 * session-proxy hydrates it first and fails loud (`pane.attach.failed`) if it
 * has vanished. Omit for a session-wide attach (first-pane-wins).
 */
export interface SessionAttachMessage extends MessageBase {
    readonly type: "session.attach";
    /** Session to bind this connection to (server-proxy-minted SessionId). */
    readonly sessionId: SessionId;
    /**
     * tmux-parity per-client attach flags (D4/D8). RESERVED — carried but not
     * acted on in tc-4b6k.4; owner-size / observer behavior is tc-4b6k.3.
     */
    readonly flags?: ClientFlags;
    /**
     * Targeted-pane hint (tc-7xv.36): the pane the client binds its host pty to.
     * The session-proxy hydrates it first and surfaces `pane.attach.failed` if it
     * has vanished. Omit for a session-wide (first-pane-wins) attach.
     */
    readonly primaryPaneId?: PaneId;
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
 * Runtime toggle of the server-proxy's `/metrics` (+ `/info`) HTTP exposition
 * (tc-44u4.4).
 *
 * The PRIMARY enablement path: flip the Prometheus scrape surface on or off
 * WITHOUT restarting the server-proxy (a restart loses every live session).
 * Proven viable during a wedge — in the tc-44u4 incident the event loop stayed
 * healthy (`nodejs_eventloop_lag` ~4 ms) and the control plane answered
 * `server-proxy.info`, so this toggle fires even when a session is wedged.
 *
 * The command inherits the control socket's existing 0600 + handshake posture
 * (no separate, weaker auth).
 *
 * `bind` selects where the HTTP listener binds when `enabled` is true:
 *   - `"unix"` (or omitted) — a unix-domain HTTP socket at
 *     `<runtime>/<socketName>/metrics-http.sock`, mode 0600 under the existing
 *     0700 runtime-dir chain.  The REQUIRED secure default: it inherits the
 *     per-user isolation of the control socket.
 *   - `"unix:/abs/path.sock"` — a unix-domain HTTP socket at an explicit path
 *     (restricted to 0600 best-effort).
 *   - `"127.0.0.1:<port>"` — a loopback TCP listener.  NOT per-user isolated
 *     (any local process can connect) — a documented single-user / trusted-host
 *     tradeoff, never the default.  A non-loopback host is rejected.
 *
 * When `enabled` is false the listener is unbound (and its unix socket file
 * removed); `bind` is ignored.
 *
 * Additive — older server-proxies respond with `protocol.unknown-message`.
 */
export interface ServerProxySetMetricsHttpCommand {
    readonly kind: "server-proxy.set-metrics-http";
    /** Bind a listener (true) or unbind the current one (false). */
    readonly enabled: boolean;
    /**
     * Bind address when `enabled` is true.  Omit for the secure unix-socket
     * default.  Ignored when `enabled` is false.
     */
    readonly bind?: string;
}
/**
 * Result payload for a `server-proxy.set-metrics-http` response (tc-44u4.4).
 *
 * Reports the listener state AFTER the toggle was applied so a client (the
 * tc-44u4.3 introspection lib) can confirm and surface the live address.
 */
export interface MetricsHttpStatePayload {
    /** Whether a metrics-HTTP listener is bound after the toggle. */
    readonly enabled: boolean;
    /**
     * The bound address when `enabled` is true: an absolute unix socket path or
     * a `host:port` string.  `null` when no listener is bound.
     */
    readonly address: string | null;
}
/**
 * One window row in a `session.topology` response (tc-i9aq.2).
 *
 * Wire-contract note: carries only session-level window METADATA — no pane
 * content, no south-side vocabulary — so the server-proxy-wire invariant is
 * preserved.
 */
export interface SessionTopologyWindow {
    /** tmux window id string, e.g. "@1". */
    readonly windowId: string;
    /** tmux window display name. */
    readonly name: string;
    /** True when this window is the active window in its session. */
    readonly active: boolean;
}
/**
 * One pane row in a `session.topology` response (tc-i9aq.2).
 *
 * `@tmuxcc-*` user-option fields are included so the extension can render
 * unbound nodes with their durable intent/policy without a separate query.
 * The `detach` field carries the RESOLVED (first-wins pane→window→session)
 * value from tmux's own format-walk, matching the session-proxy requery.
 */
export interface SessionTopologyPane {
    /** tmux pane id string, e.g. "%1". */
    readonly paneId: string;
    /** tmux window id this pane belongs to, e.g. "@1". */
    readonly windowId: string;
    /**
     * Durable binding intent (`@tmuxcc-bound`): true when the pane carries the
     * option set to "1" (tc-i9aq.1 / cold-start.md §4.A).
     */
    readonly bound: boolean;
    /**
     * RESOLVED detach-on-close policy (`@tmuxcc-detach`): the effective
     * first-wins pane→window→session value.  `undefined` ⇒ no scope set it.
     */
    readonly detach: "detach" | "kill" | undefined;
    /**
     * Durable icon policy (`@tmuxcc-icon`).  `undefined` ⇒ no policy.
     */
    readonly icon: string | undefined;
}
/**
 * Payload of a successful `session.topology` response (tc-i9aq.2).
 */
export interface SessionTopologyPayload {
    /** All windows in the named session at query time. */
    readonly windows: readonly SessionTopologyWindow[];
    /** All panes across all windows in the named session at query time. */
    readonly panes: readonly SessionTopologyPane[];
}
/**
 * One-shot topology query for a discovered-but-unclaimed session (tc-i9aq.2).
 *
 * Runs `tmux list-windows` + `tmux list-panes` for the named session without
 * claiming it or spawning a session-proxy.  The response carries the full
 * window/pane topology including `@tmuxcc-*` fields so the extension can
 * render unbound nodes with their durable intent.
 *
 * Wire-contract note: read-only; nothing is mutated.  The server-proxy-wire
 * invariant (no pane CONTENT or south-side vocabulary) is preserved — only
 * pane identity and durable metadata are carried.
 *
 * Additive addition — non-breaking per the versioning policy.  Older
 * server-proxies respond with `protocol.unknown-message`; the extension
 * falls back to the empty-leaf rendering (pre-tc-i9aq.2 behaviour).
 */
export interface SessionTopologyCommand {
    readonly kind: "session.topology";
    /** Session to query, identified by the server-proxy-minted SessionId. */
    readonly sessionId: SessionId;
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
 * tmux version→capability map held as canonical driver-owned state (tc-4b6k.12 D9).
 *
 * Each field is `true` iff the probed tmux version supports the feature.
 * Version floors are sourced from the tmux CHANGES file (github/tmux/tmux).
 */
export interface TmuxCapabilityMap {
    /**
     * `window-size` option (smallest / largest / manual / default-size).
     * CHANGES FROM 2.8 TO 2.9.
     */
    readonly windowSize: boolean;
    /**
     * `no-output` control-mode client flag via `refresh-client -F`/`-f`.
     * CHANGES FROM 2.9 TO 3.0.
     */
    readonly noOutputFlag: boolean;
    /**
     * `window-size latest` mode — size based on the most-recently-used client.
     * CHANGES FROM 3.0a TO 3.1.
     */
    readonly windowSizeLatest: boolean;
    /**
     * `ignore-size` client flag, separated from `read-only`.
     * CHANGES FROM 3.1c TO 3.2.
     */
    readonly ignoreSizeFlag: boolean;
    /**
     * `read-only` flag via the unified `-f` mechanism for any client type.
     * The original `-r` flag predates 3.2, but the unified `-f` mechanism
     * that applies to control-mode clients was introduced in 3.2.
     * CHANGES FROM 3.1c TO 3.2.
     */
    readonly readOnlyFlag: boolean;
    /**
     * `pause-after` client flag for pacing control-mode output.
     * CHANGES FROM 3.1c TO 3.2.
     */
    readonly pauseAfterFlag: boolean;
    /**
     * `active-pane` client flag for per-client independent active pane.
     * CHANGES FROM 3.1c TO 3.2.
     */
    readonly activePaneFlag: boolean;
    /**
     * `scroll-on-clear` window option.
     * CHANGES FROM 3.2a TO 3.3.
     */
    readonly scrollOnClear: boolean;
    /**
     * `no-detach-on-destroy` client option.
     * CHANGES FROM 3.5a TO 3.6.
     */
    readonly noDetachOnDestroy: boolean;
}
/**
 * Provenance stamp written by the spawner at spawn time and echoed
 * read-only by the driver via `server-proxy.info` (tc-7aqb.2).
 *
 * Ownership: the spawner (the extension) is the sole writer — the driver
 * parses and holds it opaquely, never branching on its contents.
 * The struct is intentionally extensible without touching the driver CLI.
 */
export interface SpawnInfo {
    /**
     * A string that identifies the extension build that spawned this driver.
     *
     * In production (compiled dist): the package.json semver (e.g. "1.2.3").
     * In development (tsx source): semver + "+dev." + dist-bundle mtime in
     * milliseconds (e.g. "0.0.0+dev.1718886000000"), changing on every rebuild.
     *
     * The driver treats this as an opaque string — only the extension defines
     * and reads the schema.
     */
    readonly buildId: string;
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
     * Connected server-proxy-wire clients and the durable identity each presented
     * at handshake (D2, tc-4b6k.1). One entry per live control connection;
     * `identity` is absent for a connection that advertised none. Additive
     * optional field — carried for observability only, no behavior depends on it.
     */
    readonly clients?: ReadonlyArray<{
        readonly identity?: ClientIdentity;
    }>;
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
    /**
     * Provenance stamp passed by the spawner at spawn time (tc-7aqb.2).
     *
     * Present when the driver was started with `--spawn-info '<json>'`; absent
     * (`undefined`) when spawned without that flag (older launchers, programmatic
     * in-process server-proxies, tests that don't pass it).  Additive/non-breaking:
     * clients that don't know about this field simply ignore it.
     */
    readonly spawnInfo?: SpawnInfo;
    /**
     * tmux version and capability state probed once at startup (tc-4b6k.12 D9).
     *
     * `null` when `tmux -V` failed or returned an unparseable version string.
     * The `sessions.snapshot` `tmuxAvailable` flag is authoritative for
     * binary-presence; this field adds version and feature detail when the
     * binary is present and parseable.
     *
     * `belowFloor` true means the detected version is below the driver's
     * minimum supported floor and the driver has emitted an actionable error
     * message.
     */
    readonly tmuxCapabilities: {
        readonly version: string;
        readonly capabilities: TmuxCapabilityMap;
        readonly belowFloor: boolean;
    } | null;
}
/**
 * Discriminated union of all server-proxy commands a client may issue.
 * Narrow with `cmd.kind`.
 */
export type ServerProxyCommand = SessionClaimCommand | SessionCreateCommand | SessionCreateUniqueCommand | SessionDestroyCommand | ServerProxyInfoCommand | ServerProxySetMetricsHttpCommand | SessionTopologyCommand;
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
 *   session.claim / session.create / session.createUnique → { sessionId, name, created }
 *   session.destroy                → { ok: true }
 *   server-proxy.info              → { info }
 *
 * D5 (tc-4b6k.4): there is NO `endpoint` field — the client binds a connection
 * to a session with {@link SessionAttachMessage}, not by dialing a per-session
 * socket path.
 */
export interface ServerProxyCommandOkPayload {
    readonly sessionId?: SessionId;
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
    /**
     * Session topology for a `session.topology` response (tc-i9aq.2).
     * Absent on all other command kinds.
     */
    readonly topology?: SessionTopologyPayload;
    /**
     * Post-toggle metrics-HTTP listener state for a
     * `server-proxy.set-metrics-http` response (tc-44u4.4).
     * Absent on all other command kinds.
     */
    readonly metricsHttp?: MetricsHttpStatePayload;
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
    readonly result: {
        readonly ok: true;
        readonly payload?: ServerProxyCommandOkPayload;
    } | {
        readonly ok: false;
        readonly code: string;
        readonly message: string;
    };
}
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
export type ServerProxyErrorCode = "protocol.unknown-message" | "protocol.malformed" | "protocol.version-mismatch" | "session.not-found" | "session.name-taken" | "tmux.unavailable" | "internal" | (string & Record<never, never>);
/**
 * All messages the server-proxy pushes to the client.
 * Narrow with `msg.type`.
 */
export type ServerProxyMessage = ServerProxyCapabilitiesMessage | ServerProxySnapshotMessage | ServerProxySessionAddedMessage | ServerProxySessionRemovedMessage | ServerProxySessionRenamedMessage | ServerProxyExitingMessage | ServerProxyCommandResponseMessage;
/**
 * Narrows a MessageBase to a server-proxy→client message type.
 *
 * NOTE: `command.response` is ambiguous between server-proxy and session-proxy wires
 * (both use `type: "command.response"`). In practice the caller knows which
 * wire they are on from the transport, and `command.kind` discriminates
 * further. This guard checks only the server-proxy-specific message types plus
 * the shared `command.response` discriminant.
 */
export declare function isServerProxyMessage(msg: MessageBase): msg is ServerProxyMessage;
//# sourceMappingURL=server-proxy-control.d.ts.map