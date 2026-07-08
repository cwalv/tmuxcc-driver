/**
 * ServerProxy — the per-socket discovery and lifecycle service
 * (repo-root ARCHITECTURE.md §"Process model").
 *
 * # Public API
 *
 * ```ts
 * const serverProxy = createServerProxy({ socketName: "tmuxcc" });
 * await serverProxy.start();
 * // server-proxy is now accepting connections at serverProxy.endpoint()
 * await serverProxy.shutdown();
 * ```
 *
 * # Architecture
 *
 * The server-proxy owns:
 *   1. A unix socket server at `endpoint()` for incoming server-proxy-wire connections
 *   2. A thin tmux -CC watcher (south side) for %sessions-changed notifications
 *   3. A session table mapping session names → { sessionId, tmuxId, ... }
 *   4. A session-proxy supervisor that instantiates/reaps per-session
 *      session-proxies IN-PROCESS, one per claimed session (tc-2x3.3 collapse)
 *   5. A set of connected client transports (fan-out for delta messages)
 *   6. Its own exit policy (tc-3iv, ext-a-design-context.md §6.2):
 *      immediate self-exit when tmux is confirmed gone (watcher EOF + failed
 *      `tmux ls` probe), and an idle-grace self-exit at zero IPC clients for
 *      the full grace period (configurable via `TMUXCC_IDLE_EXIT_MS`, default
 *      5 minutes).  Both exit paths unlink the server-proxy socket file before
 *      reporting exit.
 *
 * # Wire protocol (ServerProxy wire)
 *
 * Each incoming connection:
 *   1. runServerHandshake with "server-proxy.capabilities"
 *   2. Send ServerProxySnapshotMessage (seq=2)
 *   3. Accept ServerProxyCommandRequestMessages and send ServerProxyCommandResponseMessages
 *   4. Fan-out session deltas when south-side state changes
 *
 * # Session ID stability
 *
 * Session IDs are server-proxy-assigned, stable for the lifetime of the server-proxy.
 * A new session ID is minted when a session first appears (from list-sessions
 * or from a session.create command). The same ID is reused for the session's
 * session-proxy and all delta messages.
 *
 * @module server-proxy
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  runServerHandshake,
  WIRE_PROTOCOL_VERSION,
  sessionId as mintSessionId,
  describeClientIdentity,
  CommandError,
  isCommandError,
  toCommandFailure,
} from "@tmuxcc/protocol";
import type {
  Transport,
  Capabilities,
  ClientIdentity,
  NegotiatedSession,
  ServerProxyCapabilitiesMessage,
  ServerProxySnapshotMessage,
  ServerProxySessionInfo,
  ServerProxySessionAddedMessage,
  ServerProxySessionRemovedMessage,
  ServerProxySessionRenamedMessage,
  ServerProxyExitingMessage,
  ServerProxyCommandRequestMessage,
  ServerProxyCommandResponseMessage,
  ServerProxyInfoPayload,
  ServerProxyInfoSession,
  SessionAttachMessage,
  MetricsHttpStatePayload,
  SpawnInfo,
  SessionTopologyPayload,
  ErrorMessage,
  MessageBase,
  PaneId,
  SessionId,
} from "@tmuxcc/protocol";

import { createSocketServer } from "./socket-transport.js";
import { serverProxySocketPath, removeSocket, restrictSocket, classifySocketOwner } from "./runtime-dir.js";
import { createServerProxyMetrics } from "./metrics.js";
import type { ServerProxyMetrics } from "./metrics.js";
import { mergeMetricsText } from "./metrics-exposition.js";
import { parseMetricsHttpBind, bindMetricsHttp } from "./metrics-http.js";
import type { MetricsHttpListener } from "./metrics-http.js";
import { listSessions, killSession, checkSessionPresence, createTmuxWatcher, probeTmuxLiveness, getTmuxServerPid, countTmuxccClientsBySession, listSessionTopology, setSessionWorkspace, listSessionForFreeze } from "./tmux-south.js";
import type { TmuxWatcher, TmuxAvailabilityOut } from "./tmux-south.js";
import { probeTmuxCapabilities, MINIMUM_TMUX_VERSION } from "./tmux-capabilities.js";
import type { TmuxCapabilityState, TmuxCapabilityMap } from "./tmux-capabilities.js";
import { createSessionProxySupervisor } from "./session-proxy-supervisor.js";
import type { SessionProxySupervisor, SessionProxyExitInfo } from "./session-proxy-supervisor.js";
import type { RuntimeDirOptions } from "./runtime-dir.js";
import { createSessionClaimer } from "./claim-session.js";
import type { SessionClaimer } from "./claim-session.js";
import { compileTemplate } from "./template/compile.js";
import { applyCompiledTemplate } from "./template/apply.js";
import { templateDiff } from "./template/diff.js";
import { buildFrozenTemplate } from "./template/freeze.js";
import type { SessionTemplate, TemplateApplyResult, WindowTemplate } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for createServerProxy. */
export interface ServerProxyOptions {
  /**
   * tmux socket name (passed as `-L <socketName>`).
   * Required — no default to prevent accidental attachment to user's tmux.
   */
  socketName: string;

  /**
   * Override the runtime directory for server-proxy + session-proxy sockets.
   * Default: $XDG_RUNTIME_DIR/tmuxcc or /tmp/tmuxcc-<uid>.
   */
  runtimeDir?: string;

  /**
   * Idle self-exit hysteresis (tc-3iv, §6.2): when the server-proxy has had
   * zero IPC clients for this long, it self-exits.  Default 5 minutes —
   * sized for human-scale close+reopen workflows (reload-window gaps are
   * sub-second).  Tests inject a short value instead of literally waiting
   * 5 minutes; the entry-point reads `TMUXCC_IDLE_EXIT_MS` from the
   * environment as a deployment-time knob.
   */
  idleExitMs?: number;

  /**
   * Absolute path of this server-proxy process's log file, when the entry point
   * has installed stderr→file mirroring (tc-k6v).  Reported verbatim in
   * `server-proxy.info` responses so debug clients can locate the log without
   * out-of-band knowledge.  Omit for in-process/programmatic server-proxies
   * (`server-proxy.info` then reports `logPath: null`).
   */
  logPath?: string;

  /**
   * Provenance stamp passed by the spawner at spawn time (tc-7aqb.2).
   *
   * Set by the extension via `--spawn-info '<json>'`; absent for programmatic
   * in-process server-proxies.  The driver holds it opaquely and echoes it via
   * `server-proxy.info` — it NEVER branches on its contents.
   */
  spawnInfo?: SpawnInfo;

  /**
   * tc-295a.41 (test-harness affordance): when true, the broker does NOT
   * self-exit with reason "tmux-gone".  By default (`false`/undefined — the
   * production behavior, unchanged) a watcher EOF + a `tmux ls` probe that finds
   * no tmux server triggers `_selfExit("tmux-gone")` and removes the socket.
   * A long-lived embedded broker shared across a whole integration-test run
   * (Layer A `runTest.ts`) instead wants to STAY UP through transient
   * empty-server windows — session-churning specs momentarily empty the tmux
   * server, and a self-exit there would wedge every later spec with a dropped
   * server-proxy socket.  With this flag set, a tmux-gone watcher EOF re-enters
   * watcher poll mode (waiting for a session to reappear) rather than exiting;
   * the idle self-exit and all other lifecycle behavior are unchanged.  The
   * production entry point never sets this.
   */
  persistThroughTmuxGone?: boolean;

  /**
   * tc-44u4.4: bind the `/metrics` (+ `/info`) HTTP exposition at startup.
   *
   * OFF BY DEFAULT (undefined ⇒ no listener bound).  Set by the entry point
   * from `--metrics-addr` / `TMUXCC_METRICS_ADDR` for monitored / always-on
   * deployments.  Accepts the same vocabulary as the wire toggle's `bind`:
   * `"unix"` / `"unix:/abs/path.sock"` (secure default — unix socket 0600) or
   * `"127.0.0.1:<port>"` (loopback TCP, single-user/trusted-host tradeoff —
   * never the implicit default).  An invalid/non-loopback spec fails startup.
   *
   * The runtime `server-proxy.set-metrics-http` toggle and SIGUSR2 can flip it
   * on/off later regardless of this start-time value.
   */
  metricsAddr?: string;

  /**
   * tc-i1pg: server-side handshake timeout.  A connection that connects but
   * never sends `client.capabilities` within this window is closed so that
   * `server.close()` is not blocked indefinitely during shutdown — specifically
   * the idle-exit and tmux-gone self-exit paths that no launcher SIGKILL covers.
   *
   * Default 10 s (well beyond any legitimate client startup latency).  Tests
   * inject a shorter value to keep suite time bounded.  The entry point reads
   * `TMUXCC_HANDSHAKE_TIMEOUT_MS` for deployment-time adjustment.
   */
  handshakeTimeoutMs?: number;

  /**
   * Test-harness affordance (tc-u4ny.2): when set, bypasses the live
   * {@link probeTmuxCapabilities} call in `start()` and uses this map instead.
   * The synthesised capability state reports version `"override"` and
   * `belowFloor: false`.  The production entry point never sets this.
   */
  capabilitiesOverride?: TmuxCapabilityMap;
}

/**
 * Why the server-proxy self-exited (tc-3iv, §6.2):
 *   - "tmux-gone": the thin `-CC` watcher EOFed AND the `tmux ls` probe
 *     confirmed the tmux server is gone.
 *   - "idle": zero IPC clients for the full hysteresis window.
 */
export type ServerProxySelfExitReason = "tmux-gone" | "idle";

/**
 * Thrown by `start()` when a LIVE broker already owns the server-proxy socket
 * (tc-kyq4.1).
 *
 * The unix-socket bind is the cross-process single-flight lock: of two brokers
 * racing to serve one socket name (e.g. two VS Code windows that both probed
 * the socket as unreachable within the spawn latency), exactly one wins the
 * `listen()` and the other gets EADDRINUSE on a still-live socket.  The loser
 * raises this instead of clobbering the winner's socket file — the spawn-side
 * root-cause fix for the tc-i0zk "broker alive but server-proxy.sock missing"
 * wedge, where an orphaned double-spawn loser's later idle-exit unlinked the
 * winner's socket.
 *
 * The entry point (`server-proxy-entry.ts`) maps this to a clean `exit(0)`: the
 * loser never bound or owned the socket, so there is nothing to unlink and the
 * winner is untouched.  The launcher re-probes and reuses the winner.
 */
export class ServerProxyAlreadyRunningError extends Error {
  /** Stable discriminator for cross-module `instanceof`-free checks. */
  readonly code = "server-proxy.already-running";
  constructor(readonly socketPath: string) {
    super(`server-proxy socket ${socketPath} is already owned by a live broker`);
    this.name = "ServerProxyAlreadyRunningError";
  }
}

/** The server-proxy handle returned by createServerProxy. */
export interface ServerProxyHandle {
  /**
   * Start the serverProxy: create the unix socket, begin accepting connections,
   * and start the tmux watcher.
   */
  start(): Promise<void>;

  /**
   * Gracefully shut down: stop accepting connections, disconnect all clients,
   * reap all session-proxies, and remove the server-proxy socket file.
   */
  shutdown(): Promise<void>;

  /**
   * The server-proxy's unix socket path. Only valid after start() resolves.
   */
  endpoint(): string;

  // ── tc-3iv self-exit lifecycle (§6.2) ──────────────────────────────────────

  /**
   * Number of currently open IPC connections to the server-proxy socket.
   *
   * "Client" means any open Unix-domain socket connection — counted at the
   * raw socket level, before (and regardless of) the wire handshake.  It does
   * NOT mean "has bound a terminal" or "has claimed a session"; a
   * connected-but-idle client keeps the server-proxy alive.
   */
  readonly connectedClientCount: number;

  /**
   * Register a callback invoked after the server-proxy has self-exited: shutdown is
   * complete and the server-proxy socket file is already unlinked when the callback
   * runs.  The entry point wires this to `process.exit(0)`.
   *
   * Self-exit triggers (§6.2):
   *   - The thin `-CC` watcher EOFs and the 1 s `tmux ls` probe fails
   *     (tmux genuinely gone) → immediate exit, reason "tmux-gone".
   *   - Zero IPC clients for the full `idleExitMs` window (default 5 min,
   *     configurable via `TMUXCC_IDLE_EXIT_MS`) → reason "idle".
   *
   * If the watcher EOFs but the probe succeeds (the watcher process itself
   * was killed while tmux lives), the server-proxy re-spawns the watcher and does
   * NOT exit.
   */
  onSelfExit(cb: (reason: ServerProxySelfExitReason) => void): void;

  // ── tc-44u4.4 metrics-HTTP exposition ──────────────────────────────────────

  /**
   * Enable (bind) or disable (unbind) the `/metrics` (+ `/info`) HTTP
   * exposition at runtime, returning the resulting listener state (tc-44u4.4).
   *
   * The PRIMARY no-restart enablement path — the wire
   * `server-proxy.set-metrics-http` command and the SIGUSR2 handler both route
   * here.  Idempotent: enabling when already bound at the SAME address is a
   * no-op; enabling at a DIFFERENT address rebinds; disabling when not bound
   * returns the unbound state.
   *
   * `bind` selects the address when `enabled` is true (`undefined` ⇒ the
   * secure unix-socket default).  Rejects with code `"metrics.bind-invalid"`
   * on a non-loopback TCP host or unparseable spec, and propagates a bind
   * failure (`EADDRINUSE`, permission) — callers map these to a wire error.
   */
  setMetricsHttp(enabled: boolean, bind?: string): Promise<MetricsHttpStatePayload>;

  /**
   * Toggle the metrics-HTTP exposition: bind the secure unix-socket default if
   * currently unbound, unbind if currently bound (tc-44u4.4).
   *
   * The SIGUSR2 fallback semantics — a no-client/no-tooling diagnostic switch
   * (`kill -USR2 <serverProxyPid>`).  When enabling, it always uses the secure
   * unix-socket default (never TCP — a signal carries no address).  Returns
   * the resulting state.
   */
  toggleMetricsHttp(): Promise<MetricsHttpStatePayload>;

  /** Current metrics-HTTP listener state (tc-44u4.4). */
  metricsHttpState(): MetricsHttpStatePayload;

  // Window-option verbs (synchronize-panes / monitor-activity / monitor-silence)
  // are NOT on the broker surface: they are session-scoped commands served by
  // the session-proxy's ordered input-path pipeline (`set-synchronize-panes` /
  // `set-monitor-activity` / `set-monitor-silence` WireCommands), where the
  // `%window-option-changed` round-trip already closes the loop (D6 / S6).
}

// ---------------------------------------------------------------------------
// Internal session model
// ---------------------------------------------------------------------------

interface SessionEntry {
  sessionId: SessionId;
  /** tmux session id (e.g. "$1") */
  tmuxId: string;
  name: string;
  windowCount: number;
  /** Count of tmuxcc clients attached (tracked per sessionProxy, 0 until a session-proxy is spawned) */
  attachedClientCount: number;
  /**
   * Whether the session carries the `@tmuxcc 1` user option (tc-295a.4 / W1.3).
   * True for all sessions created/claimed by tmuxcc; false for foreign sessions.
   */
  tmuxccMarked: boolean;
  /**
   * Total panes across all windows in this session (tc-295a.4 / W1.3).
   * Sourced from `list-panes -a` via `listSessions`.
   */
  paneCount: number;
  /**
   * Unix epoch (seconds) of most-recent session activity (tc-295a.4 / W1.3).
   * Sourced from tmux's `#{session_activity}` format variable.
   */
  lastActivity: number;
  /**
   * Workspace identity carried on the session as the `@tmuxcc-workspace`
   * user-option (S4 / tc-76m8.6), or `undefined` when unset.  Sourced from
   * tmux's `#{@tmuxcc-workspace}` via `listSessions`; set at creation by
   * `session.createUnique` when the extension supplies a workspace URI.
   */
  workspaceUri?: string;
  /**
   * Applied session-template identity carried on the session as the
   * `@tmuxcc-template` user-option (tc-gjdx.3), or `undefined` when unset.
   * Sourced from tmux's `#{@tmuxcc-template}` via `listSessions`; set at
   * apply-at-create by the template applicator.  Surfaced on the session row
   * (snapshot / sessions.added) like `tmuxccMarked` / `workspaceUri`.
   */
  template?: string;
}

// ---------------------------------------------------------------------------
// Per-client connection state
// ---------------------------------------------------------------------------

interface ClientState {
  transport: Transport;
  /** Next outbound seq number for this client, starting at 1 */
  nextSeq: number;
  /**
   * Durable client identity this connection presented on `client.capabilities`
   * (D2, tc-4b6k.1), or `undefined` if it advertised none. Captured from the
   * handshake result; logged on connect and surfaced in the `server-proxy.info`
   * payload (`info.clients[]`). Carried and logged only — no behavior yet.
   */
  identity: ClientIdentity | undefined;
  /**
   * The full session negotiated by this connection's `server-proxy.capabilities`
   * handshake (D5, tc-4b6k.4). On a `session.attach` the broker hands this to
   * `sessionProxy.addClient({ preNegotiated })` so the session-proxy adopts it
   * instead of running a second handshake — the single broker handshake already
   * negotiated version + identity for this connection.
   */
  session: NegotiatedSession;
}

// ---------------------------------------------------------------------------
// ServerProxy capabilities
// ---------------------------------------------------------------------------

const SERVER_PROXY_CAPABILITIES: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: [
    "sessions-watch",
    "session-claim",
    "session-create",
    "session-unique-create", // tc-295a.5 / W1.4: broker-minted unique names
    "session-destroy",
    "server-proxy-info", // tc-k6v
    "server-proxy-metrics-http", // tc-44u4.4
    "tmux-caps", // tc-4b6k.12: server-proxy.info carries TmuxCapabilityMap
  ],
};

// ---------------------------------------------------------------------------
// Self-exit policy constants (tc-3iv, §6.2)
// ---------------------------------------------------------------------------

/** Default idle (zero IPC clients) self-exit hysteresis: 5 minutes. */
const DEFAULT_IDLE_EXIT_MS = 5 * 60_000;

/**
 * Default server-side handshake timeout (tc-i1pg): close connections that
 * don't complete the wire handshake within this window so `server.close()`
 * is not blocked indefinitely during idle-exit / tmux-gone self-exit paths.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Timeout for the `tmux ls` liveness probe after a watcher EOF. */
const TMUX_PROBE_TIMEOUT_MS = 1_000;

/**
 * Watcher respawn backoff (probe-succeeded path).  A watcher that lived at
 * least WATCHER_HEALTHY_MS is respawned immediately (one-off signal/OOM kill);
 * short-lived watchers escalate 250 ms → 8 s so a persistently-failing spawn
 * (e.g. broken PTY bridge) cannot turn into a process-spawn storm.
 */
const WATCHER_HEALTHY_MS = 10_000;
const WATCHER_RESPAWN_BACKOFF_INIT_MS = 250;
const WATCHER_RESPAWN_BACKOFF_MAX_MS = 8_000;

// ---------------------------------------------------------------------------
// ServerProxyImpl
// ---------------------------------------------------------------------------

class ServerProxyImpl implements ServerProxyHandle {
  private readonly _opts: ServerProxyOptions;
  /**
   * The socket-name-derived identifier used as the runtime sub-directory.
   * Equals `opts.socketName` so that server-proxy socket paths are well-known and
   * discoverable: `<runtime>/<socketName>/server-proxy.sock`.
   * One server-proxy per tmux socket name — no UUID needed for isolation.
   */
  private readonly _socketDirName: string;
  private readonly _runtimeDirOpts: RuntimeDirOptions;

  /** Active client connections */
  private _clients = new Map<Transport, ClientState>();
  /**
   * tc-13hq (Option 1): every accepted transport, tracked from the moment
   * _handleConnection fires — BEFORE the wire handshake runs.  In
   * _shutdownOnce this set is iterated and every transport is closed, so
   * server.close() cannot block on a pre-handshake (un-handshaken) socket.
   *
   * Lifecycle:
   *   - added in _handleConnection at accept time (before any await)
   *   - removed via the onClose handler (fires synchronously on transport.close())
   *   - cleared in _shutdownOnce after explicitly closing each entry
   *
   * Relationship to _clients: _clients ⊆ _acceptedSockets.  Closing all
   * _acceptedSockets in _shutdownOnce subsumes the _clients close loop; both
   * loops are kept for belt-and-suspenders clarity.
   */
  private _acceptedSockets = new Set<Transport>();
  /** Session table: sessionId → SessionEntry */
  private _sessions = new Map<SessionId, SessionEntry>();
  /** Name index: session name → SessionEntry (for fast lookups) */
  private _byName = new Map<string, SessionEntry>();

  // Assigned in the constructor (after `_metrics`) so the supervisor's
  // per-session transports can report backpressure onto the server-proxy
  // registry (tc-edf8).
  private readonly _supervisor: SessionProxySupervisor;
  private _watcher: TmuxWatcher | null = null;
  private _server: { close(): Promise<void> } | null = null;
  private _socketPath: string = "";
  /**
   * Inode of the socket file this broker bound, or null when it never bound /
   * has released ownership (tc-kyq4.1).  The exit-time unlink only ever removes
   * the file matching this inode, so a broker can never unlink a socket it does
   * not own (a double-spawn loser that never bound, or a replacement broker's
   * fresh socket rebound at the same well-known path after this one exits).
   */
  private _boundSocketIno: number | null = null;
  private _started = false;

  // ── tc-k6v server-proxy.info state ────────────────────────────────────────────────
  /** Date.now() when start() completed; drives `server-proxy.info` uptimeMs. */
  private _startedAtMs = 0;
  /**
   * Whether sessions already existed on the tmux socket when this server-proxy
   * started (ext-a §6.2 "adopted server").  Reported in `server-proxy.info`.
   */
  private _adoptedExistingServer = false;

  // ── tc-295a.35 tmux-availability state ─────────────────────────────────────
  /**
   * Whether the `tmux` binary is currently reachable (tc-295a.35).
   *
   * Canonical driver-owned state: `_refreshSessions` flips it false when
   * `listSessions` reports a binary-missing ENOENT and true again when tmux
   * runs.  Reported in every `sessions.snapshot` so the extension can surface
   * the actionable "tmuxcc requires tmux." message — the replacement for the
   * deleted `which tmux` pre-flight (E3.1 / plan A1g), WITHOUT the broker
   * exiting on tmux-absence (it stays up and tolerates tmux appearing later;
   * tc-295a.16 RCA).
   *
   * Starts `true` (optimistic): the first `_refreshSessions` in `start()`
   * corrects it before the first client snapshot is built.
   */
  private _tmuxAvailable = true;

  // ── tc-4b6k.12 tmux capability state ───────────────────────────────────────
  /**
   * tmux version and capability map, probed once via `tmux -V` during
   * `start()` (tc-4b6k.12 D9).
   *
   * Canonical driver-owned state: probed once, never re-probed (the installed
   * tmux binary does not change under a running server-proxy). Exposed through
   * `server-proxy.info` responses so diagnostics and the extension can read
   * the effective capability set. Used internally to gate version-sensitive
   * operations (e.g. `scroll-on-clear`).
   *
   * `null` means the probe failed: either `tmux -V` errored, or the output
   * was not parseable. In the `null` case we fall back to best-effort (same
   * as before this capability system existed).
   */
  private _tmuxCapabilityState: TmuxCapabilityState | null = null;

  // ── tc-3iv self-exit state ──────────────────────────────────────────────────
  /** Idle hysteresis window (ms) before self-exit at zero IPC clients. */
  private readonly _idleExitMs: number;
  /** tc-i1pg: server-side handshake timeout (ms). */
  private readonly _handshakeTimeoutMs: number;
  /** tc-295a.41: suppress the "tmux-gone" self-exit (test-harness affordance). */
  private readonly _persistThroughTmuxGone: boolean;
  /** Raw IPC connection count, maintained by the socket server (§6.2 "client"). */
  private _ipcClientCount = 0;
  /** Pending idle self-exit timer; armed whenever the client count is zero. */
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once a self-exit has been initiated; suppresses re-entry. */
  private _selfExited = false;
  /**
   * The in-flight `shutdown()` promise, or null when not shutting down.
   *
   * `shutdown()` `await`s `_server.close()` and only nulls `_server`
   * AFTERWARDS, so a concurrent caller entering during that await still sees a
   * non-null `_server` and races a second `net.Server.close()` — the second
   * throws `ERR_SERVER_NOT_RUNNING`.  This happens for real: a `tmux-gone`
   * `_selfExit` runs shutdown while the entry-point / a test's `finally`
   * independently calls it.  Sharing ONE in-flight promise makes shutdown
   * re-entrancy-safe.
   */
  private _shutdownPromise: Promise<void> | null = null;
  /** True while a watcher-EOF tmux probe is in flight. */
  private _probeInFlight = false;
  private _selfExitHandlers: Array<(reason: ServerProxySelfExitReason) => void> = [];
  /** When the current watcher was spawned (drives respawn backoff). */
  private _watcherSpawnedAt = 0;
  /** Backoff for the next respawn after a short-lived watcher. 0 = immediate. */
  private _watcherRespawnDelayMs = 0;
  /** Pending watcher respawn timer (probe-succeeded path). */
  private _respawnTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Session claim/activate manager (tc-4b6k.8).
   *
   * Owns the per-name claim-lock table (tc-3y8.2) and executes the claim/
   * activate path with phase-typed states.  Wired in the constructor via
   * `createSessionClaimer`; lives for the server-proxy's lifetime.
   */
  private _claimer!: SessionClaimer;

  // ── tc-4b6k.6 session-refresh coalescing (D6) ──────────────────────────────
  /**
   * The in-flight `_doRefreshSessions()` promise, or null when idle.  The south
   * side is now async (tmux-south.ts), so a reconcile no longer runs
   * atomically; this serializes reconciles so concurrent callers never
   * interleave their reads/mutations of the session table.
   */
  private _refreshInFlight: Promise<void> | null = null;
  /**
   * A single coalesced follow-up reconcile that begins after the in-flight one
   * completes.  Callers arriving while a reconcile is running share this ONE
   * follow-up, so a firehose of `%sessions-changed` cannot pile up unbounded,
   * yet a caller that mutated state (or the event that woke them) is always
   * reflected by the reconcile their `await` resolves on.
   */
  private _refreshPending: Promise<void> | null = null;

  // ── tc-x6l server-proxy metrics ───────────────────────────────────────────────
  private readonly _metrics: ServerProxyMetrics = createServerProxyMetrics();

  // ── tc-44u4.4 metrics-HTTP exposition ──────────────────────────────────────
  /**
   * The live metrics-HTTP listener, or null when the exposition is OFF (the
   * default).  Bound via `setMetricsHttp(true, …)` (startup flag / wire toggle)
   * or `toggleMetricsHttp()` (SIGUSR2); unbound by the off paths and by
   * shutdown.
   */
  private _metricsHttp: MetricsHttpListener | null = null;
  /**
   * Serialises concurrent metrics-HTTP toggles so a wire command, a SIGUSR2,
   * and the startup bind cannot race `bind`/`close` on the listener.  Each
   * toggle chains off the previous one.
   */
  private _metricsHttpOp: Promise<void> = Promise.resolve();

  constructor(opts: ServerProxyOptions) {
    this._opts = opts;
    this._socketDirName = opts.socketName;
    this._runtimeDirOpts = opts.runtimeDir !== undefined ? { runtimeDir: opts.runtimeDir } : {};
    this._idleExitMs = opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
    this._handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this._persistThroughTmuxGone = opts.persistThroughTmuxGone ?? false;
    // D5 (tc-4b6k.4): the supervisor no longer owns any socket — every data
    // connection lands on the broker's single socket server, which already
    // reports its drain path onto `_metrics` (the tc-edf8 firehose
    // backpressure path is preserved on the broker's `createSocketServer`).
    this._supervisor = createSessionProxySupervisor();

    // tc-4b6k.8: wire the claim/activate manager.  All context callbacks are
    // closures over `this` — safe to build here because they are never invoked
    // until start() runs and beyond (never during construction).
    this._claimer = createSessionClaimer({
      socketName: opts.socketName,
      getCapabilities: () => this._tmuxCapabilityState?.capabilities,
      refreshSessions: () => this._refreshSessions(),
      lookupByName: (name) => this._byName.get(name),
      registerSession: (tmuxId, name) => this._registerNewSession(tmuxId, name),
      ensureSessionProxy: async (sessionId, name) => {
        await this._supervisor.ensureSessionProxy(sessionId, name, this._opts.socketName);
      },
      onClaimComplete: (_timing) => {
        // tc-is5w: histogram observation wires here when the per-phase
        // sessionproxy_claim_to_snapshot_seconds instrument is implemented.
      },
    });
  }

  endpoint(): string {
    if (!this._started) throw new Error("ServerProxy not started");
    return this._socketPath;
  }

  get connectedClientCount(): number {
    return this._ipcClientCount;
  }

  onSelfExit(cb: (reason: ServerProxySelfExitReason) => void): void {
    this._selfExitHandlers.push(cb);
  }

  // ---------------------------------------------------------------------------
  // tc-44u4.4: metrics-HTTP exposition (/metrics + /info)
  // ---------------------------------------------------------------------------

  metricsHttpState(): MetricsHttpStatePayload {
    return this._metricsHttp !== null
      ? { enabled: true, address: this._metricsHttp.address }
      : { enabled: false, address: null };
  }

  setMetricsHttp(enabled: boolean, bind?: string): Promise<MetricsHttpStatePayload> {
    // Chain off the previous op so concurrent toggles (wire + SIGUSR2 + start)
    // serialise — bind/close on the listener must never interleave.
    const run = this._metricsHttpOp.then(() => this._applyMetricsHttp(enabled, bind));
    // Keep the chain alive even if THIS op throws (so a failed bind doesn't
    // wedge every later toggle); the returned promise still rejects.
    this._metricsHttpOp = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  toggleMetricsHttp(): Promise<MetricsHttpStatePayload> {
    // SIGUSR2 semantics: flip state.  When enabling, always use the secure
    // unix-socket default (a signal carries no bind address — never TCP).
    const enable = this._metricsHttp === null;
    return this.setMetricsHttp(enable);
  }

  /**
   * Apply one metrics-HTTP toggle.  Runs serialised via `_metricsHttpOp`.
   *
   * Enabling: parse+bind the listener (the merged-exposition provider closes
   * over `this`).  An already-bound listener at the SAME address is a no-op; a
   * DIFFERENT address rebinds (close old, bind new).  Disabling: close the
   * listener (managed unix socket file removed by `close()`).
   */
  private async _applyMetricsHttp(enabled: boolean, bind?: string): Promise<MetricsHttpStatePayload> {
    if (!enabled) {
      if (this._metricsHttp !== null) {
        const l = this._metricsHttp;
        this._metricsHttp = null;
        await l.close();
      }
      return { enabled: false, address: null };
    }

    const target = parseMetricsHttpBind(bind, this._opts.socketName, this._runtimeDirOpts);
    const targetAddress = target.kind === "unix" ? target.path : `${target.host}:${target.port}`;

    if (this._metricsHttp !== null) {
      if (this._metricsHttp.address === targetAddress) {
        // Already bound at the requested address — idempotent no-op.
        return { enabled: true, address: this._metricsHttp.address };
      }
      // Rebind at a new address.
      const old = this._metricsHttp;
      this._metricsHttp = null;
      await old.close();
    }

    const listener = await bindMetricsHttp(target, {
      metricsText: () => this._mergedMetricsText(),
      infoJson: () => this._buildInfoAsync(),
    });
    this._metricsHttp = listener;
    return { enabled: true, address: listener.address };
  }

  /**
   * Render the merged Prometheus exposition: the server-proxy registry plus
   * every live session-proxy registry, namespaced by a `session="<id>"` label
   * (tc-44u4.4).  Backs `GET /metrics`.
   */
  private async _mergedMetricsText(): Promise<string> {
    // Refresh the session table so the server-proxy's own session gauge is
    // current before we render (matches the `server-proxy.info` discipline).
    this._metrics.setSessionsActive(this._sessions.size);
    const serverText = await this._metrics.metricsText();
    const sessionTexts = await this._supervisor.sessionMetricsTexts();
    return mergeMetricsText(serverText, sessionTexts);
  }

  async start(): Promise<void> {
    if (this._started) throw new Error("ServerProxy already started");
    this._selfExited = false;
    // tc-hfxb.20: clear any prior shutdown's settled promise so THIS instance's
    // shutdown runs (the guard keeps the promise set after completion to make a
    // late repeat call a no-op; a fresh start must re-enable shutdown).
    this._shutdownPromise = null;

    this._socketPath = serverProxySocketPath(this._socketDirName, this._runtimeDirOpts);

    // tc-kyq4.1: the unix-socket bind is the CROSS-PROCESS single-flight lock.
    // `_bindSocketAsOwner` listens WITHOUT pre-removing the socket file; on
    // EADDRINUSE it classifies the occupant and either backs off (a live /
    // inconclusive owner — this broker is a double-spawn loser, raising
    // ServerProxyAlreadyRunningError) or removes a DEFINITIVELY-stale leftover
    // and retries.  This replaces the old unconditional `removeSocket()` +
    // `listen()`, which let a second broker clobber a live broker's socket and
    // stranded an orphaned loser whose later idle self-exit unlinked the
    // winner's socket — the tc-i0zk "alive but server-proxy.sock missing" wedge.
    this._server = await this._bindSocketAsOwner();

    // Restrict socket permissions to 0600
    restrictSocket(this._socketPath);

    // Record the bound socket's inode so the exit-time unlink only ever removes
    // the file WE own (see `_removeOwnedSocket`).
    this._boundSocketIno = this._statSocketIno(this._socketPath);

    // Initial session load — await so `_adoptedExistingServer` (below) and the
    // first client's snapshot see the reconciled table.
    await this._refreshSessions();

    // tc-4b6k.12 D9: probe tmux version and derive the capability map once.
    // Runs after _refreshSessions so _tmuxAvailable is already up to date; if
    // tmux is absent the probe also returns null (consistent with _tmuxAvailable
    // false). Must complete before the first client connection so the initial
    // snapshot and _buildInfo() see the correct capability state.
    // tc-u4ny.2: capabilitiesOverride bypasses the live probe for test seams.
    this._tmuxCapabilityState = this._opts.capabilitiesOverride
      ? { version: "override", capabilities: this._opts.capabilitiesOverride, belowFloor: false }
      : probeTmuxCapabilities();
    if (this._tmuxCapabilityState?.belowFloor) {
      // Actionable floor-gate message. The server-proxy stays up (same as the
      // _tmuxAvailable path) so the extension can surface it to the user.
      process.stderr.write(
        `serverProxy: tmuxcc requires tmux ${MINIMUM_TMUX_VERSION} or later` +
        ` (detected ${this._tmuxCapabilityState.version})\n`,
      );
    }

    // tc-k6v: sessions present at start ⇒ the tmux server pre-existed this
    // server-proxy — it was "adopted", not minted by a later session.claim (§6.2).
    this._adoptedExistingServer = this._sessions.size > 0;

    // Start tmux watcher for %sessions-changed notifications
    this._watcher = this._spawnWatcher();

    // Wire supervisor crash handler (tc-ukq, ext-a §6.3 "Crash while the
    // server-proxy lives")
    this._supervisor.onCrash((sessionId, info) => {
      this._onSessionProxyCrash(sessionId as SessionId, info);
    });

    this._started = true;
    this._startedAtMs = Date.now();

    // Arm the idle-exit hysteresis: the server-proxy starts with zero clients, and
    // a launcher that crashes before connecting must not leak a server-proxy.
    this._startIdleTimer();

    // tc-44u4.4: startup metrics-HTTP bind (OFF unless --metrics-addr /
    // TMUXCC_METRICS_ADDR was supplied).  A bad spec or a bind failure here is
    // a startup error — the deployment asked for an always-on scrape surface
    // and silently swallowing the failure would hide a misconfiguration.
    if (this._opts.metricsAddr !== undefined) {
      await this.setMetricsHttp(true, this._opts.metricsAddr);
    }
  }

  /**
   * Bind the broker's unix socket, using the bind itself as a cross-process
   * single-flight lock (tc-kyq4.1).
   *
   * The kernel makes unix-socket bind atomic: of two brokers racing `listen()`
   * on the same path, exactly one succeeds and the other gets EADDRINUSE.  We
   * therefore listen WITHOUT pre-removing the file:
   *   - `listen()` succeeds              → we are the sole owner; return.
   *   - EADDRINUSE, occupant `"alive"` /
   *     `"inconclusive"`                 → a live broker already owns the socket
   *                                        (or we cannot prove otherwise); we are
   *                                        the double-spawn loser — raise
   *                                        ServerProxyAlreadyRunningError WITHOUT
   *                                        touching the file.
   *   - EADDRINUSE, occupant `"stale"`   → a dead broker's leftover file; remove
   *                                        it and retry the bind (bounded).
   *
   * The bounded retry converges under contention: if a sibling binds the
   * just-cleared stale path before our retry, the next `listen()` EADDRINUSEs
   * and the now-`"alive"` classification routes us to the loser path.  Exhausting
   * the retries also yields the loser path (we never clobber on ambiguity).
   */
  private async _bindSocketAsOwner(): Promise<{ close(): Promise<void> }> {
    const MAX_BIND_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        // Connection counting happens at the raw socket level (see
        // SocketServerOptions.onConnectionCountChange).
        return await createSocketServer(
          this._socketPath,
          (transport) => {
            void this._handleConnection(transport);
          },
          {
            onConnectionCountChange: (count) => {
              this._onConnectionCountChange(count);
            },
            // tc-edf8: report the broker IPC socket's backpressure (drain) depth
            // and per-send time-in-queue onto the server-proxy registry.
            metrics: this._metrics,
          },
        );
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        const owner = await classifySocketOwner(this._socketPath);
        if (owner !== "stale" || attempt >= MAX_BIND_ATTEMPTS) {
          // A live/inconclusive owner, or stale-cleanup retries exhausted —
          // back off as the double-spawn loser WITHOUT clobbering the socket.
          throw new ServerProxyAlreadyRunningError(this._socketPath);
        }
        // Definitively stale leftover (dead owner) — clear it and retry the bind.
        removeSocket(this._socketPath);
      }
    }
  }

  /**
   * Inode of the socket file at `p`, or null if it is absent / cannot be
   * stat'd (tc-kyq4.1).  `stat.ino` is a JS number for the file sizes/inodes
   * we deal with; `Number(...)` normalises the BigInt-on-some-platforms case.
   */
  private _statSocketIno(p: string): number | null {
    try {
      return Number(fs.statSync(p).ino);
    } catch {
      return null;
    }
  }

  /**
   * Remove the broker socket file ONLY IF it is still the inode this broker
   * bound (tc-kyq4.1).
   *
   * Guards the exit-time unlink so a broker can never unlink a socket it does
   * not own:
   *   - never bound (a double-spawn loser) → owns nothing → remove nothing;
   *   - file already gone                  → no-op;
   *   - path now points at a DIFFERENT inode (a replacement broker rebound the
   *     well-known path after we exited) → leave the replacement's socket intact;
   *   - inode matches ours                 → unlink it (the required cleanup so
   *     the next launcher probe doesn't connect-then-reset on our dead socket).
   */
  private _removeOwnedSocket(): void {
    if (this._boundSocketIno === null) return; // never bound — own nothing
    const currentIno = this._statSocketIno(this._socketPath);
    if (currentIno === null || currentIno !== this._boundSocketIno) {
      // Already gone, or a replacement broker owns the path now — not ours.
      this._boundSocketIno = null;
      return;
    }
    removeSocket(this._socketPath);
    this._boundSocketIno = null;
  }

  shutdown(): Promise<void> {
    // tc-hfxb.20: re-entrancy guard.  Concurrent callers (a `tmux-gone`
    // `_selfExit` + an entry-point / test `finally`) share ONE in-flight
    // shutdown so they cannot both race `net.Server.close()`.
    if (this._shutdownPromise !== null) return this._shutdownPromise;
    const p = this._shutdownOnce();
    this._shutdownPromise = p;
    // Leave `_shutdownPromise` set after completion so a late repeat call is a
    // no-op (matches the pre-tc-hfxb.20 idempotent contract — a second
    // shutdown found `_server` already null and skipped its close).
    return p;
  }

  private async _shutdownOnce(): Promise<void> {
    this._clearIdleTimer();
    if (this._respawnTimer !== null) {
      clearTimeout(this._respawnTimer);
      this._respawnTimer = null;
    }

    this._watcher?.stop();
    this._watcher = null;

    // tc-44u4.4: unbind the metrics-HTTP listener (removes its managed unix
    // socket file) so a shut-down server-proxy leaves no stale scrape surface.
    if (this._metricsHttp !== null) {
      const l = this._metricsHttp;
      this._metricsHttp = null;
      try { await l.close(); } catch { /* best-effort */ }
    }

    // Disconnect all clients
    for (const [transport] of this._clients) {
      try { transport.close(); } catch { /* ignore */ }
    }
    this._clients.clear();

    // tc-13hq (Option 1): close all accepted sockets — pre-handshake connections
    // not in _clients AND any session-proxy-owned transports removed from _clients
    // by _handleAttach.  Each transport.close() fires its onClose handler
    // synchronously (SocketTransport), so _acceptedSockets.delete() runs during
    // iteration — safe in JS (deleted items are skipped by the iterator).
    // This ensures server.close() below sees NO open connections and resolves
    // immediately, regardless of handshake state.
    for (const transport of this._acceptedSockets) {
      try { transport.close(); } catch { /* ignore */ }
    }
    this._acceptedSockets.clear();

    // Reap all session-proxies
    this._supervisor.reapAll();

    // Stop the server
    await this._server?.close();
    this._server = null;

    // Remove the socket file — but only if it is still the one WE bound
    // (tc-kyq4.1 ownership guard), so a delayed shutdown never unlinks a
    // replacement broker's freshly-rebound socket at the same well-known path.
    this._removeOwnedSocket();

    // tc-3si.6: stop the prom-client default-metrics sampler timer so a
    // shut-down server-proxy doesn't leak a setInterval handle keeping the
    // event loop alive.
    this._metrics.stop();

    this._started = false;
  }

  // ---------------------------------------------------------------------------
  // Self-exit policy (tc-3iv, §6.2)
  // ---------------------------------------------------------------------------

  private _spawnWatcher(): TmuxWatcher {
    this._watcherSpawnedAt = Date.now();
    return createTmuxWatcher(
      this._opts.socketName,
      () => {
        // Event-driven reconcile: fire-and-forget (coalesced in _refreshSessions).
        void this._refreshSessions();
      },
      () => {
        this._onWatcherEof();
      },
    );
  }

  /**
   * The thin `-CC` watcher EOFed.  Disambiguate via a three-valued `tmux ls`
   * probe (1 s timeout, `probeTmuxLiveness`) and act ONLY on conclusive
   * evidence (tc-hfxb.22):
   *
   *   - `"alive"` (probe exited 0) → the watcher process itself died
   *     (signal/OOM) while tmux lives → re-spawn the watcher and keep serving.
   *   - `"inconclusive"` (spawn failure / probe timeout — under host load the
   *     `tmux ls` spawn can lose its budget; the probe comment is explicit that
   *     a timeout "is INCONCLUSIVE, never gone") → treat as NOT-gone → re-spawn
   *     and retry, NEVER self-exit.  A self-exit is irreversible, so we refuse
   *     to take it on non-terminal evidence; the respawned watcher + its forced
   *     refresh re-confirm, and a genuine death will re-EOF and eventually probe
   *     `"gone"`.
   *   - `"gone"` (probe exited non-zero — POSITIVE "no server running") → the
   *     terminal path: a `--persist-through-tmux-gone` broker re-enters poll
   *     mode (test-harness affordance) and a normal broker self-exits.
   *
   * PRINCIPLE (tc-hfxb.22): every consumer of a death EOF — both this broker
   * self-exit and the per-session reap (`_refreshSessions` removes only on a
   * conclusive `checkSessionPresence === "absent"`, tc-hfxb.18.4/.19) — acts
   * only on CONCLUSIVE/terminal evidence and is conservative on ambiguity.  So
   * the racing EOFs of the watcher `-CC` and the per-session `-CC` clients are
   * HARMLESS: each kicks its own confirmed check, they converge on the same
   * terminal truth, and no actor takes a destructive action on a racy signal.
   * Previously this path used `probeTmuxAlive`, which collapsed "inconclusive"
   * into presume-gone — the one consumer that acted destructively on a guess.
   */
  private _onWatcherEof(): void {
    if (!this._started || this._selfExited || this._probeInFlight) return;
    this._probeInFlight = true;

    void probeTmuxLiveness(this._opts.socketName, TMUX_PROBE_TIMEOUT_MS).then((liveness) => {
      this._probeInFlight = false;
      // The server-proxy may have been shut down (or self-exited) during the probe.
      if (!this._started || this._selfExited) return;

      // tc-m2y8: count each acted-on watcher EOF by its probe verdict. Placed
      // after the shutdown-during-probe guard so a teardown mid-probe is not
      // counted; the verdict distribution (alive | inconclusive | gone) is the
      // promoted-from-log signal for watcher health.
      this._metrics.incWatcherEof(liveness);

      if (liveness === "gone") {
        // POSITIVE evidence the tmux server is gone — the only terminal case.
        if (this._persistThroughTmuxGone) {
          // tc-295a.41 (test-harness affordance): the tmux server is gone, but a
          // long-lived embedded broker must NOT exit — re-enter watcher poll mode
          // so it adopts the next session/server that appears.  The watcher's own
          // pre-attach poll handles "no server yet" (listSessions → null/empty →
          // schedulePoll), and each poll tick re-drives a full refresh.
          this._scheduleWatcherRespawn(WATCHER_RESPAWN_BACKOFF_INIT_MS);
        } else {
          void this._selfExit("tmux-gone");
        }
        return;
      }

      // `"alive"` (watcher died but tmux lives) OR `"inconclusive"` (the probe
      // could not get a verdict — spawn failure / timeout).  Both are NOT-gone:
      // re-spawn the watcher with backoff if it keeps dying young (see
      // WATCHER_HEALTHY_MS) and keep serving.  On `"inconclusive"` this is the
      // conservative retry — never a self-exit on a guess; the respawn's forced
      // refresh re-confirms, and a genuine death re-EOFs to eventually probe
      // `"gone"`.
      const aliveMs = Date.now() - this._watcherSpawnedAt;
      if (aliveMs >= WATCHER_HEALTHY_MS) {
        this._watcherRespawnDelayMs = 0;
      } else {
        this._watcherRespawnDelayMs = Math.min(
          Math.max(this._watcherRespawnDelayMs * 2, WATCHER_RESPAWN_BACKOFF_INIT_MS),
          WATCHER_RESPAWN_BACKOFF_MAX_MS,
        );
      }
      this._scheduleWatcherRespawn(this._watcherRespawnDelayMs);
    });
  }

  private _scheduleWatcherRespawn(delayMs: number): void {
    if (this._respawnTimer !== null) return; // already scheduled
    const timer = setTimeout(() => {
      this._respawnTimer = null;
      if (!this._started || this._selfExited) return;
      // tc-m2y8: count the respawn at the point the timer fires and we actually
      // spawn a replacement watcher (not at schedule time — a broker that shuts
      // down inside the backoff window never respawns and must not be counted).
      this._metrics.incWatcherRespawn();
      // Replace the (inert, already-EOFed) watcher and force a refresh:
      // sessions may have changed during the watcher gap.
      this._watcher?.stop();
      this._watcher = this._spawnWatcher();
      void this._refreshSessions();
    }, delayMs);
    timer.unref();
    this._respawnTimer = timer;
  }

  /** Socket-level connection count changed (raw connections, pre-handshake). */
  private _onConnectionCountChange(count: number): void {
    // tc-x6l: track active connections and new accepts.
    const prev = this._ipcClientCount;
    this._ipcClientCount = count;
    if (count > prev) {
      // New connection(s) accepted.
      this._metrics.incConnectionAccepted();
      this._metrics.incConnectionActive();
    } else if (count < prev) {
      // Connection(s) closed.
      this._metrics.decConnectionActive();
    }
    if (!this._started || this._selfExited) return;
    if (count === 0) {
      // Last client gone — restart the hysteresis window.
      this._startIdleTimer();
    } else {
      this._clearIdleTimer();
    }
  }

  private _startIdleTimer(): void {
    this._clearIdleTimer();
    const timer = setTimeout(() => {
      this._idleTimer = null;
      if (
        this._started &&
        !this._selfExited &&
        this._ipcClientCount === 0
      ) {
        void this._selfExit("idle");
      }
    }, this._idleExitMs);
    // The listening server keeps the event loop alive while the server-proxy runs;
    // unref so a pending hysteresis window never holds the loop on its own.
    timer.unref();
    this._idleTimer = timer;
  }

  private _clearIdleTimer(): void {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /**
   * Self-exit: run a full shutdown (which unlinks the server-proxy socket file —
   * required so the next launcher's probe doesn't get connect-then-reset),
   * then notify onSelfExit listeners.  The entry point maps that notification
   * to `process.exit(0)`.
   *
   * # Exit-reason wire contract (tc-xnay / tc-ymxe)
   *
   * Before shutdown runs we broadcast a `server-proxy.exiting` control message
   * to every connected client carrying the reason.  This is the on-wire
   * signal the extension's classification locus uses to distinguish a
   * DESIGNED quiescence from an unexpected death — for self-spawned AND
   * externally-started brokers alike.  Without it, the next event the
   * extension sees is the socket close (and possibly a child-exit notification
   * for self-spawned brokers), and the two failure modes look identical.
   *
   * Best-effort: sendControl is fire-and-forget; transports that have already
   * closed silently drop the message and the extension falls back to the
   * "no announcement seen → unexpected death" classification (safe default).
   */
  private async _selfExit(reason: ServerProxySelfExitReason): Promise<void> {
    if (this._selfExited || !this._started) return;
    this._selfExited = true;

    // tc-m2y8: count the designed self-exit by reason before shutdown runs.
    // Promotes the previously on-wire-only / logged reason into a counter that
    // survives in metricsText (read via a sibling broker / a late server-proxy.info).
    this._metrics.incSelfExit(reason);

    // tc-xnay / tc-ymxe: announce designed exit BEFORE shutdown closes
    // transports.  Mirrors `_broadcastToAll` shape; inlined here so the
    // shutdown path doesn't have to know about the announcement seq.
    this._broadcastExiting(reason);

    try {
      await this.shutdown();
    } catch {
      // Best-effort: even if shutdown failed midway, OUR socket file MUST be
      // gone before we report self-exit, or the next spawn stalls.  The
      // ownership guard (tc-kyq4.1) still applies — if shutdown already removed
      // it this is a no-op, and we never unlink a replacement's socket.
      this._removeOwnedSocket();
    }

    for (const cb of this._selfExitHandlers.slice()) {
      try {
        cb(reason);
      } catch {
        // Listener errors must not break the exit path
      }
    }
  }

  /**
   * Broadcast `server-proxy.exiting` to every connected client (tc-xnay /
   * tc-ymxe).  Called from `_selfExit` immediately before `shutdown()` runs.
   *
   * Best-effort per-client send; a transport that has already closed (or
   * whose write fails) is silently skipped — the connection-count change
   * listener will reap it during shutdown's transport.close() loop.
   */
  private _broadcastExiting(reason: ServerProxySelfExitReason): void {
    for (const [transport, state] of this._clients) {
      const msg: ServerProxyExitingMessage = {
        type: "server-proxy.exiting",
        seq: state.nextSeq,
        reason,
      };
      state.nextSeq++;
      try {
        transport.sendControl(msg as unknown as Parameters<typeof transport.sendControl>[0]);
      } catch {
        // Transport already closed — nothing to do; shutdown will clean up.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SessionProxy crash handling (tc-ukq, ext-a §6.3 "Crash while the server-proxy lives")
  // ---------------------------------------------------------------------------

  /**
   * A session session-proxy exited unexpectedly (not via reapSessionProxy) while the
   * server-proxy lives — parser fault, OOM, stray SIGKILL.
   *
   * By the time this runs the supervisor has already reaped its
   * sessionId → session-proxy registry entry, so the next `session.claim` for this
   * session spawns a fresh session-proxy against the still-alive tmux session.
   * Respawn is LAZY (§6.2): a crashed session-proxy with no interested client stays
   * gone — nothing is spawned here.
   *
   * Client notification is session-scoped by construction: clients attached
   * to THAT session held connections to the dead session-proxy's socket, which the
   * kernel closed when the process died.  Per protocol/PROTOCOL.md §5
   * (request/response correlation — ErrorMessage semantics):
   * after a session-proxy connection dies the client must consider it dead and
   * reconnect through the server-proxy — the connection close IS the wire-level
   * signal.  No server-proxy-wide message is sent; sibling sessions' session-proxies and
   * clients are untouched.
   *
   * The same supervisor exit event also fires when the session-proxy exited because
   * its bound tmux SESSION died (session-proxy-side `-CC` EOF / `%sessions-changed`
   * handling) before the server-proxy's own watcher refresh ran.  Disambiguate
   * against tmux: `_refreshSessions()` keeps the session entry when the
   * session is alive (session-proxy crash → no server-proxy-wire delta; the session stays
   * listed and claimable), or removes it and broadcasts `sessions.removed`
   * when it is gone (the SCHEMA-specified signal for genuine session
   * disappearance).
   *
   * tc-hfxb.19: when this session was the LAST one, killing it also kills the
   * whole tmux server.  `_refreshSessions`'s removal gate (tc-hfxb.18.4) handles
   * that correctly because `checkSessionPresence` now classifies a "no server
   * running" result as `"absent"` (a server that is DOWN has no sessions — see
   * `tmux-south.ts`), so the dead session is removed even though the server is
   * unreachable.  No special-case path is needed here.
   */
  private _onSessionProxyCrash(sessionId: SessionId, info: SessionProxyExitInfo): void {
    process.stderr.write(
      `serverProxy: session-proxy for session '${info.sessionName}' (${sessionId}) exited ` +
      `unexpectedly (bound tmux host died); fresh session-proxy on next session.claim\n`,
    );
    if (!this._started || this._selfExited) return;
    // Fire-and-forget: the crash handler is a synchronous supervisor callback.
    void this._refreshSessions();
  }

  // ---------------------------------------------------------------------------
  // Session state management
  // ---------------------------------------------------------------------------

  /**
   * Reconcile the session table against tmux.  Coalesced + serialized (D6):
   * at most one reconcile runs at a time, and callers arriving while one is in
   * flight share a SINGLE queued follow-up that begins after it — so a caller
   * that mutated state (or the `%sessions-changed` that woke them) is always
   * reflected by the reconcile their `await` resolves on, without a firehose of
   * events piling up unbounded reconciles.
   *
   * The body (`_doRefreshSessions`) is now async: its south-side shell-outs no
   * longer block the shared event loop, so a reconcile never stalls the
   * in-process session-proxies' delta pipelines (the whole point of the change).
   * Serialization matters because the body is no longer atomic — without it two
   * concurrent reconciles could interleave their reads/mutations of the session
   * table across their `await` points.
   */
  private _refreshSessions(): Promise<void> {
    if (this._refreshInFlight !== null) {
      if (this._refreshPending === null) {
        this._refreshPending = this._refreshInFlight.then(() => {
          this._refreshPending = null;
          return this._startRefresh();
        });
      }
      return this._refreshPending;
    }
    return this._startRefresh();
  }

  /** Begin one reconcile and track it as the in-flight run. */
  private _startRefresh(): Promise<void> {
    const p = this._doRefreshSessions()
      .catch((err: unknown) => {
        // A reconcile must never reject its coalescing chain (that would wedge
        // `_refreshPending`).  The synchronous predecessor could not throw;
        // preserve that contract by logging and swallowing.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`serverProxy: session refresh failed: ${msg}\n`);
      })
      .finally(() => {
        if (this._refreshInFlight === p) this._refreshInFlight = null;
      });
    this._refreshInFlight = p;
    return p;
  }

  private async _doRefreshSessions(): Promise<void> {
    // tc-x6l: sessions gauge is updated at the end of each refresh.
    // tc-zcqr: listSessions returns null on transient failure (timeout, spawn
    // error, unexpected non-zero exit) — distinguish from "no sessions"
    // (status 0 with empty stdout / "no server running" stderr).  On a
    // transient failure, leave _sessions/_byName intact; clearing on a flake
    // is exactly what produced the "Session not found after creation" race.
    // tc-295a.35: classify tmux-binary availability from the SAME shell-out
    // (no extra spawn).  `listSessions` sets `availability.binaryMissing` true
    // iff the spawn failed with ENOENT (tmux not on PATH).  We track it as
    // canonical state and re-broadcast a fresh snapshot to connected clients
    // when it flips, so the extension can surface / clear the actionable
    // "tmuxcc requires tmux." message without the broker ever exiting on
    // tmux-absence (tolerate-tmux-appearing-later, tc-295a.16 RCA).
    const availability: TmuxAvailabilityOut = { binaryMissing: false };
    const rows = await listSessions(this._opts.socketName, availability);
    const nowAvailable = !availability.binaryMissing;
    if (nowAvailable !== this._tmuxAvailable) {
      this._tmuxAvailable = nowAvailable;
      // Only push if we already have live clients AND start() has finished:
      // start()'s initial refresh runs BEFORE the socket server accepts
      // connections, so the first client gets the corrected flag in its
      // post-handshake snapshot anyway; a flip AFTER that is the case that
      // needs an unsolicited re-broadcast.
      if (this._started) this._broadcastSnapshot();
    }
    if (rows === null) {
      // Transient failure — do not mutate the session table.  The watcher /
      // next claim will re-drive a refresh.
      return;
    }
    // tc-3y8.7: subtract tmuxcc-owned control-mode clients from the raw
    // session_attached count so that attachedClientCount reflects only
    // real (external) clients.
    const tmuxccCounts = await countTmuxccClientsBySession(this._opts.socketName);

    // Build a set of current tmux ids
    const currentTmuxIds = new Set(rows.map((r) => r.tmuxId));

    // Detect removals.  A tracked session whose tmuxId is absent from this list
    // is removed ONLY IF its absence is CONFIRMED by a trustworthy direct check.
    //
    // tc-hfxb.18.4: `list-sessions` is NOT trustworthy for absence on its own.
    // During cold-boot `-CC` churn it transiently omits a live session — empty
    // ("no server running" / "error connecting" both coerce to `[]`) OR partial
    // (a successful list that just hasn't caught up).  Treating that omission as
    // a removal broadcasts a spurious `sessions.removed`, which disposed the
    // extension's SessionManager mid-(re)connect and produced the `openSession
    // did not produce a new terminal` flake (RCA tc-hfxb.18.3/.18.4).  "removed"
    // must mean was-present-then-CONFIRMED-absent, never transiently-omitted.
    //
    // The authoritative confirm is `has-session -t <id>` (checkSessionPresence),
    // which — unlike `list-sessions` — distinguishes genuine absence on a
    // reachable server ("absent") from a transiently-unreachable server
    // ("inconclusive").  We remove ONLY on "absent".  A live/in-flight
    // session-proxy is a free fast-path "definitely present" short-circuit that
    // avoids the shell-out in the common case (it holds a live `-CC` connection,
    // so the session provably exists).  Genuine teardown still removes promptly:
    // a really-killed session fails `has-session` with "can't find session" →
    // "absent" → removed; explicit `session.destroy` removes directly, not here.
    for (const [sid, entry] of this._sessions) {
      if (currentTmuxIds.has(entry.tmuxId)) continue;
      // Fast path: a live/in-flight session-proxy proves the session exists.
      if (this._supervisor.hasSessionProxy(sid)) continue;
      // Authoritative: only a positive "absent" from a reachable server removes.
      if ((await checkSessionPresence(this._opts.socketName, entry.tmuxId)) !== "absent") continue;
      this._sessions.delete(sid);
      this._byName.delete(entry.name);
      this._supervisor.reapSessionProxy(sid);
      this._broadcastRemoved(sid);
    }

    // Build a set of existing tmux ids in our table for addition/rename detection
    const knownTmuxIds = new Map<string, SessionEntry>();
    for (const entry of this._sessions.values()) {
      knownTmuxIds.set(entry.tmuxId, entry);
    }

    // Detect additions and renames
    for (const row of rows) {
      const ownCount = tmuxccCounts.get(row.tmuxId) ?? 0;
      const externalCount = Math.max(0, row.attachedCount - ownCount);
      const existing = knownTmuxIds.get(row.tmuxId);
      if (!existing) {
        // New session
        const sessionId = mintSessionId(`s${row.tmuxId.replace("$", "")}`);
        const entry: SessionEntry = {
          sessionId,
          tmuxId: row.tmuxId,
          name: row.name,
          windowCount: row.windowCount,
          attachedClientCount: externalCount,
          // tc-295a.4 (W1.3): enriched fields from the extended listSessions format.
          tmuxccMarked: row.tmuxccMarked,
          paneCount: row.paneCount,
          lastActivity: row.lastActivity,
          // S4 (tc-76m8.6): workspace identity option, when set on the session.
          ...(row.workspaceUri !== undefined ? { workspaceUri: row.workspaceUri } : {}),
          // tc-gjdx.3: applied-template awareness option, when set.
          ...(row.template !== undefined ? { template: row.template } : {}),
        };
        this._sessions.set(sessionId, entry);
        this._byName.set(row.name, entry);
        this._broadcastAdded(entry);
      } else if (existing.name !== row.name) {
        // Session was renamed
        this._byName.delete(existing.name);
        existing.name = row.name;
        existing.windowCount = row.windowCount;
        // tc-295a.4 (W1.3): keep enriched fields current on rename.
        existing.tmuxccMarked = row.tmuxccMarked;
        existing.paneCount = row.paneCount;
        existing.lastActivity = row.lastActivity;
        // S4 (tc-76m8.6): keep the workspace identity current (set or clear).
        if (row.workspaceUri !== undefined) existing.workspaceUri = row.workspaceUri;
        else delete existing.workspaceUri;
        // tc-gjdx.3: keep the applied-template awareness current (set or clear).
        if (row.template !== undefined) existing.template = row.template;
        else delete existing.template;
        this._byName.set(row.name, existing);
        this._broadcastRenamed(existing.sessionId, row.name);
      } else {
        // Update counts
        existing.windowCount = row.windowCount;
        existing.attachedClientCount = externalCount;
        // tc-295a.4 (W1.3): keep enriched fields current on every refresh.
        existing.tmuxccMarked = row.tmuxccMarked;
        existing.paneCount = row.paneCount;
        existing.lastActivity = row.lastActivity;
        // S4 (tc-76m8.6): keep the workspace identity current (set or clear).
        if (row.workspaceUri !== undefined) existing.workspaceUri = row.workspaceUri;
        else delete existing.workspaceUri;
        // tc-gjdx.3: keep the applied-template awareness current (set or clear).
        if (row.template !== undefined) existing.template = row.template;
        else delete existing.template;
      }
    }

    // tc-x6l: update the sessions-active gauge after each refresh.
    this._metrics.setSessionsActive(this._sessions.size);
  }

  // ---------------------------------------------------------------------------
  // Connection handler
  // ---------------------------------------------------------------------------

  private async _handleConnection(transport: Transport): Promise<void> {
    // tc-13hq (Option 1): track every accepted transport from accept, before the
    // handshake.  _shutdownOnce closes all _acceptedSockets so server.close()
    // is never blocked by a pre-handshake connection.  The onClose handler
    // removes the entry when the transport closes for any reason (timeout,
    // handshake failure, normal close, or _shutdownOnce's explicit destroy).
    this._acceptedSockets.add(transport);
    transport.onClose(() => { this._acceptedSockets.delete(transport); });

    // tc-i1pg: bounded handshake timeout — defense-in-depth resource guard.
    // A connection that connects but never sends client.capabilities is closed
    // after handshakeTimeoutMs (default 10 s) so zombie pre-handshake sockets
    // cannot accumulate indefinitely during normal uptime.  This is no longer
    // the PRIMARY drain-fix (tc-13hq Option 1 above handles that structurally)
    // but remains valuable for fd/memory hygiene.  Fires loud stderr per the
    // expected-zero convention (a stale half-open connection is unexpected in
    // production).
    const handshakeTimer = setTimeout(() => {
      process.stderr.write(
        `serverProxy: handshake timeout after ${this._handshakeTimeoutMs} ms — ` +
        `closing pre-handshake connection (tc-i1pg)\n`,
      );
      try { transport.close(); } catch { /* ignore */ }
    }, this._handshakeTimeoutMs);

    // Run server-proxy-wire handshake
    let session: Awaited<ReturnType<typeof runServerHandshake>>;
    try {
      session = await runServerHandshake(transport, SERVER_PROXY_CAPABILITIES, "server-proxy.capabilities");
    } catch {
      clearTimeout(handshakeTimer);
      try { transport.close(); } catch { /* ignore */ }
      return;
    }
    clearTimeout(handshakeTimer);

    // tc-9r2y: reject a late handshake that completed after shutdown began.
    // _shutdownOnce clears _clients and reaps all session-proxies before
    // server.close() — a connection registered here would spawn a fresh
    // session-proxy that nothing can reap (S2/S3 two-live-full-CC state).
    // _shutdownPromise is set synchronously by shutdown() before _shutdownOnce
    // runs any async work, so it is a reliable "shutdown has begun" sentinel.
    if (this._shutdownPromise !== null) {
      try { transport.close(); } catch { /* ignore */ }
      return;
    }

    // features not yet used in v3 alpha; the client's durable identity (D2,
    // tc-4b6k.1) IS captured — stored on the connection, logged, and surfaced
    // in server-proxy.info. Carried and logged only; no behavior depends on it.

    // nextSeq starts at 2: the handshake itself sent seq=1 (server-proxy.capabilities).
    // The snapshot is the second server-side message and therefore seq=2.
    const state: ClientState = { transport, nextSeq: 2, identity: session.clientIdentity, session };
    this._clients.set(transport, state);

    process.stderr.write(
      `serverProxy: client connected identity=` +
        `${describeClientIdentity(session.clientIdentity)}\n`,
    );

    transport.onClose(() => {
      this._clients.delete(transport);
    });

    // Send snapshot at seq=2 per protocol/PROTOCOL.md §3 handshake sequence (§3.2):
    //   server-proxy.capabilities (seq=1) → client.capabilities (seq=1) → sessions.snapshot (seq=2)
    const snapshot = this._buildSnapshot(state.nextSeq);
    state.nextSeq++;
    transport.sendControl(snapshot as unknown as Parameters<typeof transport.sendControl>[0]);

    // Handle incoming client→server-proxy messages.
    transport.onControl((msg: MessageBase) => {
      if (msg.type === "command.request") {
        void this._handleCommand(state, msg as unknown as ServerProxyCommandRequestMessage);
      } else if (msg.type === "session.attach") {
        // D5 (tc-4b6k.4): bind this connection to a session's stream. The
        // handler transitions the connection out of the command plane and hands
        // the transport to the session-proxy — after this the broker's onControl
        // is replaced by the session-proxy's (see _handleAttach).
        void this._handleAttach(state, msg as unknown as SessionAttachMessage);
      }
      // Other message types: dropped (protocol.unknown-message is best-effort).
    });
  }

  // ---------------------------------------------------------------------------
  // session.attach — single-socket connection→session binding (D5, tc-4b6k.4)
  // ---------------------------------------------------------------------------

  /**
   * Bind a connection to a session's stream in response to `session.attach`.
   *
   * The seq contract is the load-bearing invariant here: this connection's seq
   * counter has already advanced past the handshake (seq=1) and the
   * sessions.snapshot (seq=2), plus any session-set deltas broadcast before the
   * attach arrived. We SYNCHRONOUSLY (before any await) capture the connection's
   * live `nextSeq` and remove it from `_clients` so the broker never touches its
   * seq again, then hand `startSeq` to the session-proxy so its snapshot + deltas
   * continue the SAME monotonic per-connection counter. The client mirror sees
   * one unbroken stream across the handoff.
   *
   * The single broker `server-proxy.capabilities` handshake already negotiated
   * version + identity for this connection, so the session-proxy skips its own
   * handshake (`preNegotiated: state.session`) — no second handshake, the S1
   * ceremony this bead deletes.
   */
  private async _handleAttach(state: ClientState, msg: SessionAttachMessage): Promise<void> {
    const { transport } = state;

    // Capture the continued seq + detach from the command plane BEFORE the first
    // await, so no broker broadcast (added/removed/renamed/exiting) can advance
    // this connection's seq after the handoff point.
    const startSeq = state.nextSeq;
    this._clients.delete(transport);

    // tc-9r2y: a session.attach that arrives after shutdown began must not spawn
    // a fresh session-proxy — the supervisor was already reaped by _shutdownOnce
    // and nothing would reap the new proxy (S2/S3 two-live-full-CC state).
    if (this._shutdownPromise !== null) {
      try { transport.close(); } catch { /* ignore */ }
      return;
    }

    // Refresh the session table so the attach decision is made against CURRENT
    // tmux truth, not a stale table (tc-62k9).  AWAITED: `_refreshSessions` is
    // coalesced+serialized precisely so an awaiting caller's resolve reflects
    // its reconcile — un-awaited (the previous shape) the lookup below read the
    // OLD table, so a session created just before the attach could be
    // spuriously refused and a just-died one mis-admitted.  session.attach is
    // the system's ATTACH-ONLY decision point (it can never create), so this
    // read is what the client-side phantom-immunity contract stands on.
    await this._refreshSessions();
    // tc-9r2y (re-check): shutdown may have BEGUN during the awaited refresh —
    // the supervisor is reaped by then, so spawning a fresh session-proxy below
    // would leak one (the same two-live-full-CC hazard the pre-await check
    // guards).
    if (this._shutdownPromise !== null) {
      try { transport.close(); } catch { /* ignore */ }
      return;
    }
    const entry = this._sessions.get(msg.sessionId);
    if (entry === undefined) {
      // Unknown session — surface a fail-loud error then close the connection;
      // the client observes the disconnect (its data connection never resolves).
      try {
        const err: ErrorMessage = {
          type: "error",
          seq: startSeq,
          code: "session.not-found",
          message: `Session '${msg.sessionId}' not found`,
        };
        transport.sendControl(err as unknown as Parameters<typeof transport.sendControl>[0]);
      } catch { /* transport may already be closed */ }
      try { transport.close(); } catch { /* ignore */ }
      return;
    }

    try {
      // Ensure the session-proxy is running (idempotent with session.claim's
      // single-flight), then hand this transport to it with the continued seq.
      const sessionProxy = await this._supervisor.ensureSessionProxy(
        entry.sessionId,
        entry.name,
        this._opts.socketName,
      );
      await sessionProxy.addClient(transport, {
        startSeq,
        preNegotiated: state.session,
        ...(msg.primaryPaneId !== undefined ? { primaryPaneId: msg.primaryPaneId } : {}),
        // D4 (tc-4b6k.3): forward tmux-parity client flags from session.attach.
        ...(msg.flags !== undefined ? { flags: msg.flags } : {}),
      });
    } catch (err: unknown) {
      // ensureSessionProxy (quarantine / start failure) or addClient rejected.
      // Fail-loud on stderr and close the connection so the client sees the
      // disconnect (previously the per-session net.createServer callback owned
      // this catch, tc-295a.21).
      process.stderr.write(
        `serverProxy: session.attach for '${msg.sessionId}' failed: ${String(err)}\n`,
      );
      try { transport.close(); } catch { /* already closed */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  private _buildSnapshot(seq: number): ServerProxySnapshotMessage {
    const sessions: ServerProxySessionInfo[] = [];
    for (const entry of this._sessions.values()) {
      sessions.push({
        sessionId: entry.sessionId,
        name: entry.name,
        windowCount: entry.windowCount,
        attachedClientCount: entry.attachedClientCount,
        // tc-295a.4 (W1.3): enriched fields carried in snapshot.
        tmuxccMarked: entry.tmuxccMarked,
        paneCount: entry.paneCount,
        lastActivity: entry.lastActivity,
        // S4 (tc-76m8.6): workspace identity option, when set.
        ...(entry.workspaceUri !== undefined ? { workspaceUri: entry.workspaceUri } : {}),
        // tc-gjdx.3: applied-template awareness option, when set.
        ...(entry.template !== undefined ? { template: entry.template } : {}),
      });
    }
    // tc-295a.35: canonical tmux-availability flag carried in every snapshot.
    return { type: "sessions.snapshot", seq, sessions, tmuxAvailable: this._tmuxAvailable };
  }

  /**
   * Re-broadcast a full `sessions.snapshot` to every connected client
   * (tc-295a.35).
   *
   * Used when `_tmuxAvailable` flips AFTER clients have connected — the
   * post-handshake snapshot they received is now stale on that one field, so
   * we push a fresh full snapshot.  A snapshot (not a bespoke delta) keeps the
   * extension's SocketStore consumer on its existing FULL-REPLACE path: the
   * session table is re-asserted identically and `tmuxAvailable` updates
   * atomically with it.
   */
  private _broadcastSnapshot(): void {
    for (const [transport, state] of this._clients) {
      const snapshot = this._buildSnapshot(state.nextSeq);
      state.nextSeq++;
      try {
        transport.sendControl(snapshot as unknown as Parameters<typeof transport.sendControl>[0]);
      } catch {
        this._clients.delete(transport);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // server-proxy.info (tc-k6v)
  // ---------------------------------------------------------------------------

  /**
   * Build the read-only diagnostics snapshot for a `server-proxy.info` command.
   *
   * Refreshes the session table first so counts are current, then augments
   * each session row with the session-proxy PID (from the supervisor).  Pane
   * counts are now sourced from the SessionEntry (populated by `listSessions`
   * via a companion `list-panes -a` call) — no extra shell-out here.
   */
  private async _buildInfo(): Promise<ServerProxyInfoPayload> {
    await this._refreshSessions();

    const sessions: ServerProxyInfoSession[] = [];
    for (const entry of this._sessions.values()) {
      sessions.push({
        sessionId: entry.sessionId,
        name: entry.name,
        sessionProxyPid: this._supervisor.sessionProxyPid(entry.sessionId),
        windowCount: entry.windowCount,
        paneCount: entry.paneCount,
        attachedClientCount: entry.attachedClientCount,
      });
    }

    // tc-x6l: update the sessions-active gauge before building the info payload.
    this._metrics.setSessionsActive(this._sessions.size);

    const tmuxServerPid = await getTmuxServerPid(this._opts.socketName);

    return {
      socketName: this._opts.socketName,
      serverProxySocketPath: this._socketPath,
      serverProxyPid: process.pid,
      uptimeMs: Math.max(0, Date.now() - this._startedAtMs),
      tmuxServerPid,
      adoptedExistingServer: this._adoptedExistingServer,
      connectedClientCount: this._ipcClientCount,
      // D2 (tc-4b6k.1): the durable identity each connected wire client
      // presented at handshake. Observability only — no behavior depends on it.
      clients: Array.from(this._clients.values(), (c) =>
        c.identity !== undefined ? { identity: c.identity } : {},
      ),
      logPath: this._opts.logPath ?? null,
      sessions,
      // tc-x6l: metricsText deferred to async; populated in _buildInfoAsync.
      metricsText: null,
      // tc-7aqb.2: echo the spawn-info provenance stamp opaquely.
      ...(this._opts.spawnInfo !== undefined ? { spawnInfo: this._opts.spawnInfo } : {}),
      // tc-4b6k.12 D9: canonical tmux capability state probed once at startup.
      tmuxCapabilities: this._tmuxCapabilityState,
    };
  }

  /**
   * Async variant of _buildInfo that populates `metricsText` from prom-client.
   * Used by the command handler so the server-proxy.info response carries live metrics.
   */
  private async _buildInfoAsync(): Promise<ServerProxyInfoPayload> {
    const info = await this._buildInfo();
    const metricsText = await this._metrics.metricsText();
    return { ...info, metricsText };
  }

  // ---------------------------------------------------------------------------
  // Command dispatch
  // ---------------------------------------------------------------------------

  private async _handleCommand(
    state: ClientState,
    req: ServerProxyCommandRequestMessage,
  ): Promise<void> {
    const { correlationId, command } = req;

    // tc-9r2y: refuse commands during shutdown — the supervisor and session
    // table are being torn down; commands that spawn session-proxies
    // (session.claim, session.create) would mint resources with no reaper.
    if (this._shutdownPromise !== null) {
      this._sendResponse(state, {
        correlationId,
        result: { ok: false, code: "server-proxy.shutting-down", message: "Server proxy is shutting down" },
      });
      return;
    }

    // tc-x6l: increment command counter before dispatch.
    this._metrics.incCommand(command.kind);

    // tc-bn7d: time the full application-leg RPC round-trip (the whole handler
    // await chain) and attribute it to the command kind. Observed in the
    // `finally` so every exit path — success, unknown-command, and the error
    // catch — records exactly one sample. This is the application-leg companion
    // to the tmux-leg `command_round_trip_seconds`: a slow `ensureSessionProxy`
    // / tmux spawn shows here while the tmux leg stays ~1 ms (tc-jlyi).
    const rpcStartMs = Date.now();

    try {
      let payload: { sessionId?: SessionId; created?: boolean; ok?: true; info?: ServerProxyInfoPayload; topology?: SessionTopologyPayload; name?: string; metricsHttp?: MetricsHttpStatePayload; applyTemplate?: TemplateApplyResult; frozenTemplate?: SessionTemplate };

      switch (command.kind) {
        case "session.claim":
          payload = await this._claimer.claim(command.name);
          break;
        case "session.create":
          // tc-gjdx.2: forward env so the claim path can pass -e flags to new-session.
          payload = await this._createSession(command.name, command.env);
          break;
        case "session.createUnique":
          // tc-gjdx.2: forward env similarly for unique-create.
          payload = await this._createUniqueSession(command.baseName, command.workspaceUri, command.env);
          break;
        case "session.destroy":
          payload = await this._destroySession(command.sessionId);
          break;
        case "server-proxy.info":
          // tc-k6v + tc-x6l: read-only diagnostics snapshot with metrics.
          payload = { info: await this._buildInfoAsync() };
          break;
        case "server-proxy.set-metrics-http":
          // tc-44u4.4: runtime toggle of the /metrics (+ /info) HTTP surface —
          // the PRIMARY no-restart enablement path.  Inherits the control
          // socket's 0600 + handshake posture.  A bad bind spec / bind failure
          // surfaces as result.ok=false via the catch below (code
          // "metrics.bind-invalid" or the underlying bind errno).
          payload = {
            metricsHttp: await this.setMetricsHttp(command.enabled, command.bind),
          };
          break;
        case "session.topology":
          // tc-i9aq.2: one-shot topology query for a discovered-but-unclaimed
          // session.  Read-only — no claim, no session-proxy spawn.
          // tc-4b6k.2 (D3): resolve per-client binding intent for the REQUESTING
          // connection's identity so the picker's bind affordance is per-client.
          payload = { topology: await this._querySessionTopology(command.sessionId, state.identity?.id) };
          break;
        case "session.applyTemplate":
          // tc-gjdx.4: apply-to-live merge-diff + preview.  Diffs the template
          // against the live session's windows (merge key: window name) and
          // creates only the missing ones.  dryRun returns the would-create set
          // WITHOUT creating; a real apply creates exactly that set and returns
          // the did-create set.  Both paths share templateDiff so they can't
          // drift (preview-equals-apply AC).
          payload = { applyTemplate: await this._applyTemplateLive(command.sessionId, command.template, command.dryRun ?? false) };
          break;
        case "session.freezeTemplate":
          // tc-gjdx.5: freeze a live session into a schema-valid template.
          payload = {
            frozenTemplate: await this._freezeTemplate(command.sessionId, command.name),
          };
          break;
        default: {
          const _exhaustive: never = command;
          void _exhaustive;
          this._sendResponse(state, {
            correlationId,
            result: {
              ok: false,
              code: "protocol.unknown-message",
              message: `Unknown command kind`,
            },
          });
          return;
        }
      }

      // tc-gjdx.3: apply-at-create.  A template carried on a CREATING claim verb
      // (session.claim / session.create / session.createUnique) is applied by
      // the driver EXACTLY ONCE, iff THIS command minted the session
      // (created:true — the tc-3y8.2 exactly-once contract; the broker serialises
      // per name, so exactly one claimant observes it).  NEVER on bind / adopt /
      // reattach / reconnect (those never mint, so never see created:true).
      //
      // Runs BEFORE the response so the client learns the outcome: on success the
      // ok payload is unchanged (sessionId/created/name); on failure the thrown
      // TemplateValidationError / TemplateApplyError (both code "template.invalid")
      // is mapped by the catch below to a loud result.ok=false naming the failed
      // verb + created-so-far — with NO rollback (the partial session persists).
      if (
        payload.created === true &&
        payload.sessionId !== undefined &&
        (command.kind === "session.claim" ||
          command.kind === "session.create" ||
          command.kind === "session.createUnique") &&
        command.template !== undefined
      ) {
        const sessionName =
          command.kind === "session.createUnique"
            ? (payload.name as string)
            : command.name;
        await this._applyTemplateAtCreate(payload.sessionId, sessionName, command.template);
      }

      this._sendResponse(state, {
        correlationId,
        result: { ok: true, payload },
      });
    } catch (err: unknown) {
      const result = isCommandError(err)
        ? toCommandFailure(err)
        : { ok: false as const, code: "internal", message: err instanceof Error ? err.message : String(err) };
      this._sendResponse(state, { correlationId, result });
    } finally {
      // tc-bn7d: one observation per command, across every exit path.
      this._metrics.observeRpcRoundTrip((Date.now() - rpcStartMs) / 1000, command.kind);
    }
  }

  private _sendResponse(
    state: ClientState,
    partial: Omit<ServerProxyCommandResponseMessage, "type" | "seq">,
  ): void {
    const msg: ServerProxyCommandResponseMessage = {
      type: "command.response",
      seq: state.nextSeq,
      ...partial,
    };
    state.nextSeq++;
    try {
      state.transport.sendControl(msg as unknown as Parameters<typeof state.transport.sendControl>[0]);
    } catch {
      // Transport may have closed
    }
  }

  // ---------------------------------------------------------------------------
  // tc-i9aq.2: one-shot topology query
  // ---------------------------------------------------------------------------

  /**
   * Resolve a `session.topology` command.
   *
   * Looks up the session name from the registry by `sessionId`, then runs a
   * one-shot `list-windows` + `list-panes` via `listSessionTopology`.  Returns
   * an empty topology `{ windows: [], panes: [] }` when the session is not
   * found in the registry or the tmux calls fail — the caller renders the
   * session as a leaf in that case (same as pre-tc-i9aq.2).
   *
   * Read-only: no claim, no session-proxy spawn, no mutation.
   */
  private async _querySessionTopology(
    sessionId: SessionId,
    clientId: string | undefined,
  ): Promise<SessionTopologyPayload> {
    const entry = this._sessions.get(sessionId);
    if (entry === undefined) {
      // Session not in registry; caller falls back to leaf rendering.
      return { windows: [], panes: [] };
    }
    // tc-4b6k.2 (D3): read the requesting client's own per-client binding slot.
    const result = await listSessionTopology(this._opts.socketName, entry.name, clientId);
    if (result === null) {
      // tmux call failed; fall back to leaf rendering.
      return { windows: [], panes: [] };
    }
    return {
      windows: result.windows.map((w) => ({
        windowId: w.windowId,
        name: w.name,
        active: w.active,
      })),
      panes: result.panes.map((p) => ({
        paneId: p.paneId,
        windowId: p.windowId,
        bound: p.bound,
        detach: p.detach,
        icon: p.icon,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // tc-gjdx.5: session freeze
  // ---------------------------------------------------------------------------

  /**
   * Freeze a live session into a schema-valid {@link SessionTemplate}.
   *
   * Looks up the session name, runs the two tmux queries via
   * {@link listSessionForFreeze}, and converts the raw data to a template via
   * {@link buildFrozenTemplate}.
   *
   * Fails loud (throws) when the session is not in the registry or the tmux
   * queries fail — surfaced as `result.ok=false` by the surrounding catch in
   * `_handleCommand`.
   */
  private async _freezeTemplate(sessionId: SessionId, name?: string): Promise<SessionTemplate> {
    const entry = this._sessions.get(sessionId);
    if (entry === undefined) {
      throw new CommandError("session.not-found", `session ${sessionId} not found`);
    }

    const data = await listSessionForFreeze(this._opts.socketName, entry.name);
    if (data === null) {
      throw new Error(`freeze: tmux queries failed for session ${entry.name}`);
    }

    return buildFrozenTemplate(data, name);
  }

  // ---------------------------------------------------------------------------
  // Command implementations
  // ---------------------------------------------------------------------------

  /**
   * Register a just-created tmux session in the server-proxy session table
   * (tc-4b6k.8 — extracted from the claim path into a named method).
   *
   * Called by the `ClaimSessionContext.registerSession` callback in response
   * to a successful `createSession` where no concurrent refresh already added
   * the entry.  Mints a stable sessionId, adds to both maps, broadcasts
   * `sessions.added`, and updates the sessions-active gauge.
   *
   * Callers have already verified (via `_byName.get(name) === undefined`) that
   * the entry is absent; this is the side-effecting publish step.
   */
  private _registerNewSession(tmuxId: string, name: string): SessionEntry {
    const sessionId = mintSessionId(`s${tmuxId.replace("$", "")}`);
    const entry: SessionEntry = {
      sessionId,
      tmuxId,
      name,
      windowCount: 1,
      attachedClientCount: 0,
      // tc-295a.4 (W1.3): newly-created sessions are always marked
      // (createSession calls setSessionMarker internally), have 1 pane
      // (tmux new-session creates a default window with one pane), and
      // have current-epoch activity.  These are overwritten on the first
      // _refreshSessions tick; the values here prevent a brief 0-gap.
      tmuxccMarked: true,
      paneCount: 1,
      lastActivity: Math.floor(Date.now() / 1_000),
    };
    this._sessions.set(sessionId, entry);
    this._byName.set(name, entry);
    this._broadcastAdded(entry);
    this._metrics.setSessionsActive(this._sessions.size);
    return entry;
  }

  private async _createSession(
    name: string,
    env?: Record<string, string>,
  ): Promise<{ sessionId: SessionId; created: boolean }> {
    await this._refreshSessions();

    // tc-3y8.2: an in-flight claim counts as "name in use" — joining it via
    // _claimer.claim would resolve with created=false, contradicting the
    // session.create contract (a successful create always mints, so its
    // response always reports created=true; otherwise it fails name-taken).
    if (this._byName.has(name) || this._claimer.isInFlight(name)) {
      throw new CommandError("session.name-taken", `Session name '${name}' is already in use`);
    }

    // Use claim semantics — create then spawn session-proxy.
    // tc-gjdx.2: env is forwarded to the claimer, which passes it to
    // createSession for the -e NAME=value new-session flags.
    const result = await this._claimer.claim(name, env);

    // tc-3y8.2: enforce mint-or-fail.  The checks above close the in-process
    // races, but another tmux client (outside this serverProxy) can still mint the
    // name between our refresh and the underlying `new-session`.  The claim
    // path resolves that race by attaching (`created: false`); for
    // session.create that outcome IS name-taken.  The session and session-proxy stay
    // up — they belong to whoever created the session, exactly as if a
    // session.claim had been issued.
    if (!result.created) {
      throw new CommandError("session.name-taken", `Session name '${name}' is already in use`);
    }

    return result;
  }

  /**
   * Broker-minted unique session creation (tc-295a.5 / W1.4).
   *
   * Derives a unique name from `baseName` by consulting the broker's live
   * `_byName` truth table (NOT the extension's in-process `defaultRegistry`
   * whose release-on-gone recycles base names — tc-d6dn root cause #1).
   *
   * Uniquification algorithm:
   *   1. Refresh the live session table from tmux.
   *   2. If `baseName` is not in `_byName` AND not in-flight (`_claimer.isInFlight`),
   *      use it.
   *   3. Otherwise try `baseName-2`, `baseName-3`, … until a free slot is found.
   *   4. Claim the chosen name via `_claimer.claim` (which creates the tmux
   *      session and spawns the session-proxy atomically with the per-name lock).
   *
   * Atomicity guarantee: two concurrent `createUnique({baseName})` calls
   * cannot collide because:
   *   - `_claimer.isInFlight` is checked synchronously before `_claimer.claim`
   *     yields (single-threaded JS event loop).
   *   - `_claimer` uses a per-name mutex internally — a second caller who picks
   *     the same uniquified name will join the in-flight claim and observe
   *     `created: false`, which this method treats as a collision and re-tries
   *     with the next suffix.
   *
   * Returns `{ sessionId, name, created: true }` — `created` is always `true`
   * because this command never silently attaches.
   *
   * S4 (tc-76m8.6): when `workspaceUri` is supplied (a folder/file window's
   * workspace identity), stamp it on the freshly-minted session as the
   * `@tmuxcc-workspace` user-option so a later reopen matches this workspace's
   * session by identity rather than by its human name.  Set once at birth,
   * mirroring the `@tmuxcc 1` marker; the failure is non-fatal (the option
   * simply lands on the next refresh's read is a no-op — a session that briefly
   * lacks it falls back to legacy name-matching).
   */
  private async _createUniqueSession(
    baseName: string,
    workspaceUri?: string,
    env?: Record<string, string>,
  ): Promise<{ sessionId: SessionId; created: boolean; name: string }> {
    // Normalise: empty / whitespace-only baseName → "tmuxcc".
    const base = (baseName ?? "").trim() || "tmuxcc";

    // eslint-disable-next-line no-constant-condition
    for (let attempt = 0; ; attempt++) {
      // Refresh on the first pass; subsequent passes skip the refresh because
      // the session we just tried to claim is now in _byName.
      if (attempt === 0) {
        await this._refreshSessions();
      }

      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;

      // Skip names already live in tmux or in-flight.
      if (this._byName.has(candidate) || this._claimer.isInFlight(candidate)) {
        continue;
      }

      // Attempt to claim the candidate.  If another concurrent caller beats
      // us (race between the check above and _claimer.claim below), the claim
      // resolves with created=false — that means the name was taken; loop.
      // tc-gjdx.2: env is forwarded so new-session receives the -e flags.
      const result = await this._claimer.claim(candidate, env);
      if (result.created) {
        // S4: stamp the workspace identity on the just-minted session so reopen
        // matches by option, not by the (human, non-unique) name.  Also mirror
        // it onto the in-memory entry so a snapshot requested before the next
        // refresh already carries the identity.
        if (workspaceUri !== undefined && workspaceUri.length > 0) {
          await setSessionWorkspace(this._opts.socketName, candidate, workspaceUri);
          const entry = this._sessions.get(result.sessionId);
          if (entry !== undefined) entry.workspaceUri = workspaceUri;
        }
        return { sessionId: result.sessionId, created: true, name: candidate };
      }
      // Name was taken by a concurrent caller — try the next suffix.
    }
  }

  /**
   * Apply a session template at CREATE time (tc-gjdx.3).
   *
   * Called by `_handleCommand` gated on `created:true` for the creating claim
   * verbs — the tc-3y8.2 exactly-once contract, so this runs at most once per
   * session creation.  The flow:
   *   1. COMPILE the concrete template to an ordered transaction (pure).  A
   *      structurally-valid-but-semantically-broken template fails HERE
   *      (TemplateValidationError, code "template.invalid") before any tmux
   *      command runs.
   *   2. Fetch the live session-proxy (idempotent with the claim path's
   *      `ensureSessionProxy` single-flight — it is already live for a
   *      just-minted session) and run the transaction through its slotted,
   *      correlated `send` path.  A verb tmux refuses mid-transaction throws
   *      TemplateApplyError (fail-loud, no rollback).
   *   3. Reconcile the broker's session table so the `@tmuxcc-template`
   *      awareness option + the new window count surface on the next snapshot.
   *
   * Both error types carry code "template.invalid"; the command handler's catch
   * maps them to a loud `result.ok=false` response naming the failed verb and
   * the created-so-far state.
   */
  private async _applyTemplateAtCreate(
    sessionId: SessionId,
    sessionName: string,
    template: SessionTemplate,
  ): Promise<void> {
    const plan = compileTemplate(template);
    const sessionProxy = await this._supervisor.ensureSessionProxy(
      sessionId,
      sessionName,
      this._opts.socketName,
    );
    await applyCompiledTemplate((cmd) => sessionProxy.send(cmd), plan, sessionName);
    await this._refreshSessions();
    // tc-gjdx.8: push the updated @tmuxcc-template to connected clients.
    // _broadcastAdded was called with template=undefined (template not yet
    // applied at registration time); _refreshSessions updates entry.template
    // in the internal table but sends no delta.  A full snapshot broadcast
    // here ensures every client's SocketStore learns the templateName before
    // the session.createUnique response arrives on the keepalive.
    this._broadcastSnapshot();
  }

  // ---------------------------------------------------------------------------
  // tc-gjdx.4: apply-to-live merge-diff + preview
  // ---------------------------------------------------------------------------

  /**
   * Apply a session template to a LIVE session (tc-gjdx.4).
   *
   * Computes the safe-direction merge-diff — the subset of `template.windows`
   * whose names are absent in the live session — and either returns the
   * would-create set (`dryRun: true`) or creates exactly that set and returns
   * the did-create set (`dryRun: false`).  A re-apply of a satisfied template
   * is a no-op (empty diff).
   *
   * Shared diff function: both dryRun and real apply call {@link templateDiff},
   * so they are guaranteed to agree on the would-create / did-create set (the
   * preview-equals-apply AC).
   *
   * Partial-failure semantics (tc-gjdx.3): the apply path uses the SAME
   * applicator machinery as apply-at-create, with `killInitialWindow: false`
   * (the session already has real user windows).  A mid-transaction tmux
   * refusal throws {@link TemplateApplyError} (code "template.invalid"); the
   * caller's catch maps it to a loud `result.ok=false` with no rollback.
   */
  private async _applyTemplateLive(
    sessionId: SessionId,
    template: SessionTemplate,
    dryRun: boolean,
  ): Promise<TemplateApplyResult> {
    const entry = this._sessions.get(sessionId);
    if (entry === undefined) {
      throw new CommandError("session.not-found", `Session '${sessionId}' not found`);
    }

    // Query the live window names to compute the diff.  Fall back to an empty
    // set on topology failure (listSessionTopology returns null when the session
    // is unreachable) so the diff treats all template windows as missing — the
    // applicator will then fail loud on the first creating verb.
    const topology = await listSessionTopology(this._opts.socketName, entry.name);
    const liveWindowNames = new Set(
      (topology?.windows ?? []).map((w) => w.name),
    );

    // The would-create set: template windows absent from the live session.
    // Shared between dryRun and real apply — they cannot drift.
    const missingWindows: readonly WindowTemplate[] = templateDiff(template, liveWindowNames);

    if (dryRun) {
      return { dryRun: true, windows: missingWindows };
    }

    if (missingWindows.length === 0) {
      // The template is already satisfied — re-apply is a no-op (empty diff).
      return { dryRun: false, windows: [] };
    }

    // Build a sub-template from the missing windows and apply it via the SAME
    // tc-gjdx.3 applicator machinery.  killInitialWindow: false — the session
    // already has real user windows; never kill any of them.
    const subTemplate: SessionTemplate = {
      ...(template.name !== undefined ? { name: template.name } : {}),
      windows: missingWindows,
    };
    const plan = compileTemplate(subTemplate);
    const sessionProxy = await this._supervisor.ensureSessionProxy(
      sessionId,
      entry.name,
      this._opts.socketName,
    );
    await applyCompiledTemplate(
      (cmd) => sessionProxy.send(cmd),
      plan,
      entry.name,
      { killInitialWindow: false },
    );
    await this._refreshSessions();

    return { dryRun: false, windows: missingWindows };
  }

  private async _destroySession(
    sessionId: SessionId,
  ): Promise<{ ok: true }> {
    const entry = this._sessions.get(sessionId);
    if (!entry) {
      throw new CommandError("session.not-found", `Session '${sessionId}' not found`);
    }

    // Reap session-proxy first
    this._supervisor.reapSessionProxy(sessionId);

    // Kill the tmux session
    try {
      await killSession(this._opts.socketName, entry.tmuxId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CommandError("tmux.unavailable", `tmux.unavailable: ${msg}`);
    }

    // Update local state
    this._sessions.delete(sessionId);
    this._byName.delete(entry.name);
    this._broadcastRemoved(sessionId);

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Delta broadcast
  // ---------------------------------------------------------------------------

  private _broadcastAdded(entry: SessionEntry): void {
    const delta: Omit<ServerProxySessionAddedMessage, "seq"> = {
      type: "sessions.added",
      sessionId: entry.sessionId,
      name: entry.name,
      windowCount: entry.windowCount,
      attachedClientCount: entry.attachedClientCount,
      // tc-295a.4 (W1.3): enriched fields carried in sessions.added delta.
      tmuxccMarked: entry.tmuxccMarked,
      paneCount: entry.paneCount,
      lastActivity: entry.lastActivity,
      // S4 (tc-76m8.6): workspace identity option, when set.
      ...(entry.workspaceUri !== undefined ? { workspaceUri: entry.workspaceUri } : {}),
      // tc-gjdx.3: applied-template awareness option, when set (usually unset at
      // registration — apply-at-create runs after; surfaces on the next snapshot).
      ...(entry.template !== undefined ? { template: entry.template } : {}),
    };
    this._broadcastToAll(delta);
  }

  private _broadcastRemoved(sessionId: SessionId): void {
    const delta: Omit<ServerProxySessionRemovedMessage, "seq"> = {
      type: "sessions.removed",
      sessionId,
    };
    this._broadcastToAll(delta);
  }

  private _broadcastRenamed(sessionId: SessionId, newName: string): void {
    const delta: Omit<ServerProxySessionRenamedMessage, "seq"> = {
      type: "sessions.renamed",
      sessionId,
      newName,
    };
    this._broadcastToAll(delta);
  }

  private _broadcastToAll(msgWithoutSeq: Omit<MessageBase, "seq">): void {
    for (const [transport, state] of this._clients) {
      const stamped = { ...msgWithoutSeq, seq: state.nextSeq };
      state.nextSeq++;
      try {
        transport.sendControl(stamped as unknown as Parameters<typeof transport.sendControl>[0]);
      } catch {
        this._clients.delete(transport);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a server-proxy for the given tmux socket.
 *
 * ```ts
 * const serverProxy = createServerProxy({ socketName: "tmuxcc" });
 * await serverProxy.start();
 * console.log("server-proxy at", serverProxy.endpoint());
 * // ... use the server-proxy ...
 * await serverProxy.shutdown();
 * ```
 *
 * Lifecycle (tc-3iv, §6.2): the server-proxy does not manage its own auto-spawn —
 * that is the launcher's job — but it DOES self-manage exit:
 *   - watcher EOF + failed 1 s `tmux ls` probe → immediate self-exit
 *     (tmux genuinely gone; mirrors tmux's own `exit-empty on` semantics)
 *   - watcher EOF + successful probe → re-spawn the watcher, keep serving
 *   - zero IPC clients for `idleExitMs` (default 5 min) → self-exit
 * Register `onSelfExit` to observe; both paths complete shutdown() — which
 * unlinks the server-proxy socket file — before listeners run.  There is no
 * auto-restart layer: server-proxy crashes are bugs to fix, not UX to smooth over.
 * tc-2x3.3: session-proxies now run IN-PROCESS, so a server-proxy crash takes
 * them with it by construction — there are no orphan processes to reap and no
 * die-with-parent watchdog.  Recovery is launcher → fresh server-proxy → fresh
 * in-process session-proxies on next session.claim → fresh `-CC attach` to the
 * surviving tmux sessions.
 */
export function createServerProxy(opts: ServerProxyOptions): ServerProxyHandle {
  return new ServerProxyImpl(opts);
}
