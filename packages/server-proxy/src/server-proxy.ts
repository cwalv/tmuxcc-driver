/**
 * ServerProxy — the per-socket discovery and lifecycle service (SCHEMA.md Stage 2).
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
 *   4. A session-proxy supervisor that spawns/reaps per-session session-proxy child processes
 *   5. A set of connected client transports (fan-out for delta messages)
 *   6. Its own exit policy (tc-3iv, tc-eqgp, ext-a-design-context.md §6.2):
 *      immediate self-exit when tmux is confirmed gone (watcher EOF + failed
 *      `tmux ls` probe), and an idle-grace self-exit at zero IPC clients AND
 *      zero live session-proxy children.  Live children are activity
 *      (they hold the data plane the IPC count is blind to — tc-eqgp); the
 *      grace period is configurable via `TMUXCC_IDLE_EXIT_MS` (default 5
 *      minutes).  Both exit paths unlink the server-proxy socket file before
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
import {
  runServerHandshake,
  WIRE_PROTOCOL_VERSION,
  sessionId as mintSessionId,
} from "@tmuxcc/session-proxy";
import type {
  Transport,
  Capabilities,
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
  ErrorMessage,
  MessageBase,
  PaneId,
  SessionId,
} from "@tmuxcc/session-proxy";

import { createSocketServer, createSocketTransport } from "./socket-transport.js";
import { serverProxySocketPath, sessionProxySocketPath, removeSocket, restrictSocket } from "./runtime-dir.js";
import { createServerProxyMetrics } from "./metrics.js";
import type { ServerProxyMetrics } from "./metrics.js";
import { listSessions, createSession, killSession, createTmuxWatcher, probeTmuxAlive, setWindowSynchronizePanes, setWindowMonitorActivity, setWindowMonitorSilence, setSessionMarker, getTmuxServerPid, countTmuxccClientsBySession } from "./tmux-south.js";
import type { TmuxWatcher, TmuxAvailabilityOut } from "./tmux-south.js";
import { createSessionProxySupervisor } from "./session-proxy-supervisor.js";
import type { SessionProxySupervisor, SessionProxyExitInfo } from "./session-proxy-supervisor.js";
import type { RuntimeDirOptions } from "./runtime-dir.js";

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
   * Idle self-exit hysteresis (tc-3iv, tc-eqgp, §6.2): when the server-proxy
   * has had zero IPC clients AND zero live session-proxy children for this
   * long, it self-exits.  Default 5 minutes — sized for human-scale
   * close+reopen workflows (reload-window gaps are sub-second).  Tests inject
   * a short value instead of literally waiting 5 minutes; the
   * entry-point reads `TMUXCC_IDLE_EXIT_MS` from the environment as a
   * deployment-time knob.
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
}

/**
 * Why the server-proxy self-exited (tc-3iv, §6.2):
 *   - "tmux-gone": the thin `-CC` watcher EOFed AND the `tmux ls` probe
 *     confirmed the tmux server is gone.
 *   - "idle": zero IPC clients for the full hysteresis window.
 */
export type ServerProxySelfExitReason = "tmux-gone" | "idle";

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
   *   - Zero IPC clients AND zero live session-proxy children for the full
   *     `idleExitMs` window (default 5 min, configurable via
   *     `TMUXCC_IDLE_EXIT_MS`) → reason "idle".  Live children count as
   *     activity (tc-eqgp) because their data plane (EDH ↔ session-proxy
   *     over per-session sockets) is invisible to the IPC count.
   *
   * If the watcher EOFs but the probe succeeds (the watcher process itself
   * was killed while tmux lives), the server-proxy re-spawns the watcher and does
   * NOT exit.
   */
  onSelfExit(cb: (reason: ServerProxySelfExitReason) => void): void;

  /**
   * Toggle `synchronize-panes` for a tmux window (tc-7xv.12).
   *
   * `windowId` is the session-proxy wire WindowId (e.g. `"w3"` for tmux window `@3`).
   * `on` controls the desired state.
   *
   * Issues `tmux set-option -wt @<N> synchronize-panes on|off` synchronously.
   * The session-proxy connected to the session will detect the change via the
   * `%window-option-changed` notification and push a `window.sync.changed`
   * delta to all connected clients.
   *
   * Throws if tmux is unavailable or the window does not exist.
   */
  setSynchronizePanes(windowId: string, on: boolean): void;

  // ── tc-7xv.15 ──────────────────────────────────────────────────────────────

  /**
   * Set `monitor-activity` for a tmux window (tc-7xv.15).
   *
   * `windowId` is the session-proxy wire WindowId (e.g. `"w3"` for tmux window `@3`).
   * `on` controls the desired state.
   *
   * Issues `tmux set-option -wt @<N> monitor-activity on|off` synchronously.
   *
   * Throws if tmux is unavailable or the window does not exist.
   */
  setMonitorActivity(windowId: string, on: boolean): void;

  /**
   * Set `monitor-silence` for a tmux window (tc-7xv.15).
   *
   * `windowId` is the session-proxy wire WindowId (e.g. `"w3"` for tmux window `@3`).
   * `seconds` is the silence threshold (1..N), or 0/null to disable.
   *
   * Issues `tmux set-option -wt @<N> monitor-silence <seconds>` synchronously.
   * Pass `seconds = null` to disable (sends `monitor-silence 0`).
   *
   * Throws if tmux is unavailable or the window does not exist.
   */
  setMonitorSilence(windowId: string, seconds: number | null): void;

  // ── end tc-7xv.15 ─────────────────────────────────────────────────────────
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
}

// ---------------------------------------------------------------------------
// Per-client connection state
// ---------------------------------------------------------------------------

interface ClientState {
  transport: Transport;
  /** Next outbound seq number for this client, starting at 1 */
  nextSeq: number;
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
    "pane-attach", // tc-7xv.36
    "server-proxy-info", // tc-k6v
  ],
};

// ---------------------------------------------------------------------------
// Self-exit policy constants (tc-3iv, §6.2)
// ---------------------------------------------------------------------------

/** Default idle (zero IPC clients) self-exit hysteresis: 5 minutes. */
const DEFAULT_IDLE_EXIT_MS = 5 * 60_000;

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
  /** Session table: sessionId → SessionEntry */
  private _sessions = new Map<SessionId, SessionEntry>();
  /** Name index: session name → SessionEntry (for fast lookups) */
  private _byName = new Map<string, SessionEntry>();

  private _supervisor: SessionProxySupervisor = createSessionProxySupervisor();
  private _watcher: TmuxWatcher | null = null;
  private _server: { close(): Promise<void> } | null = null;
  private _socketPath: string = "";
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

  // ── tc-3iv self-exit state ──────────────────────────────────────────────────
  /** Idle hysteresis window (ms) before self-exit at zero IPC clients. */
  private readonly _idleExitMs: number;
  /** tc-295a.41: suppress the "tmux-gone" self-exit (test-harness affordance). */
  private readonly _persistThroughTmuxGone: boolean;
  /** Raw IPC connection count, maintained by the socket server (§6.2 "client"). */
  private _ipcClientCount = 0;
  /** Pending idle self-exit timer; armed whenever the client count is zero. */
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once a self-exit has been initiated; suppresses re-entry. */
  private _selfExited = false;
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
   * Per-name claim locks: maps session name → in-flight claim promise.
   * Concurrent claims for the same name share this promise.
   *
   * tc-3y8.2: only the claim that INITIATED the shared promise reports the
   * promise's `created` value; joiners are remapped to `created: false` in
   * `_claimSession` so exactly one claimant observes `created: true` per
   * session creation (the authority for create-time-only profile apply).
   */
  private _claimLocks = new Map<string, Promise<{ sessionId: SessionId; endpoint: string; created: boolean; name?: string }>>();

  // ── tc-x6l server-proxy metrics ───────────────────────────────────────────────
  private readonly _metrics: ServerProxyMetrics = createServerProxyMetrics();

  constructor(opts: ServerProxyOptions) {
    this._opts = opts;
    this._socketDirName = opts.socketName;
    this._runtimeDirOpts = opts.runtimeDir !== undefined ? { runtimeDir: opts.runtimeDir } : {};
    this._idleExitMs = opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
    this._persistThroughTmuxGone = opts.persistThroughTmuxGone ?? false;
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

  /**
   * Map a wire WindowId string ("w3") → tmux numeric id (3).
   * Convention mirrors input-path.ts defaultWindowIdToTmux.
   * Throws with code "internal" on malformed input.
   */
  private _parseWindowId(windowId: string, caller: string): number {
    if (!windowId.startsWith("w")) {
      throw Object.assign(
        new Error(`${caller}: invalid windowId "${windowId}" — must start with "w"`),
        { code: "internal" },
      );
    }
    const windowNum = parseInt(windowId.slice(1), 10);
    if (Number.isNaN(windowNum)) {
      throw Object.assign(
        new Error(`${caller}: cannot parse numeric window id from "${windowId}"`),
        { code: "internal" },
      );
    }
    return windowNum;
  }

  setSynchronizePanes(windowId: string, on: boolean): void {
    const windowNum = this._parseWindowId(windowId, "setSynchronizePanes");
    try {
      setWindowSynchronizePanes(this._opts.socketName, windowNum, on);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`tmux.unavailable: ${msg}`), { code: "tmux.unavailable" });
    }
  }

  // ── tc-7xv.15 ──────────────────────────────────────────────────────────────

  setMonitorActivity(windowId: string, on: boolean): void {
    const windowNum = this._parseWindowId(windowId, "setMonitorActivity");
    try {
      setWindowMonitorActivity(this._opts.socketName, windowNum, on);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`tmux.unavailable: ${msg}`), { code: "tmux.unavailable" });
    }
  }

  setMonitorSilence(windowId: string, seconds: number | null): void {
    const windowNum = this._parseWindowId(windowId, "setMonitorSilence");
    const secondsVal = seconds !== null && seconds > 0 ? seconds : 0;
    try {
      setWindowMonitorSilence(this._opts.socketName, windowNum, secondsVal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`tmux.unavailable: ${msg}`), { code: "tmux.unavailable" });
    }
  }

  // ── end tc-7xv.15 ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._started) throw new Error("ServerProxy already started");
    this._selfExited = false;

    this._socketPath = serverProxySocketPath(this._socketDirName, this._runtimeDirOpts);

    // Remove stale socket file if present
    removeSocket(this._socketPath);

    // Start the unix socket server.  Connection counting happens at the raw
    // socket level (see SocketServerOptions.onConnectionCountChange).
    this._server = await createSocketServer(
      this._socketPath,
      (transport) => {
        void this._handleConnection(transport);
      },
      {
        onConnectionCountChange: (count) => {
          this._onConnectionCountChange(count);
        },
      },
    );

    // Restrict socket permissions to 0600
    restrictSocket(this._socketPath);

    // Initial session load
    this._refreshSessions();

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

    // tc-eqgp: re-evaluate the idle policy whenever the live-child count
    // changes.  Two cases matter:
    //   - first child appears: cancel any pending idle exit (children are
    //     activity even though they don't connect to the server-proxy's IPC
    //     socket — they are the data plane the IPC count is blind to).
    //   - last child goes away (reap/crash): if there are also zero IPC
    //     clients, arm the idle timer.
    this._supervisor.onAliveCountChange((count) => {
      this._onAliveChildCountChange(count);
    });

    this._started = true;
    this._startedAtMs = Date.now();

    // Arm the idle-exit hysteresis: the server-proxy starts with zero clients, and
    // a launcher that crashes before connecting must not leak a server-proxy.
    this._startIdleTimer();
  }

  async shutdown(): Promise<void> {
    this._clearIdleTimer();
    if (this._respawnTimer !== null) {
      clearTimeout(this._respawnTimer);
      this._respawnTimer = null;
    }

    this._watcher?.stop();
    this._watcher = null;

    // Disconnect all clients
    for (const [transport] of this._clients) {
      try { transport.close(); } catch { /* ignore */ }
    }
    this._clients.clear();

    // Reap all session-proxies
    this._supervisor.reapAll();

    // Stop the server
    await this._server?.close();
    this._server = null;

    // Remove socket file
    removeSocket(this._socketPath);

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
        this._refreshSessions();
      },
      () => {
        this._onWatcherEof();
      },
    );
  }

  /**
   * The thin `-CC` watcher EOFed.  Disambiguate via a `tmux ls` probe (1 s
   * timeout): probe fails → tmux genuinely gone → self-exit immediately;
   * probe succeeds → the watcher process itself died (signal/OOM) while tmux
   * lives → re-spawn the watcher and keep serving.
   */
  private _onWatcherEof(): void {
    if (!this._started || this._selfExited || this._probeInFlight) return;
    this._probeInFlight = true;

    void probeTmuxAlive(this._opts.socketName, TMUX_PROBE_TIMEOUT_MS).then((alive) => {
      this._probeInFlight = false;
      // The server-proxy may have been shut down (or self-exited) during the probe.
      if (!this._started || this._selfExited) return;

      if (alive) {
        // Watcher died but tmux lives — re-spawn, with backoff if the watcher
        // keeps dying young (see WATCHER_HEALTHY_MS).
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
      } else if (this._persistThroughTmuxGone) {
        // tc-295a.41 (test-harness affordance): the tmux server is gone, but a
        // long-lived embedded broker must NOT exit — re-enter watcher poll mode
        // so it adopts the next session/server that appears.  The watcher's own
        // pre-attach poll handles "no server yet" (listSessions → null/empty →
        // schedulePoll), and each poll tick re-drives a full refresh.
        this._scheduleWatcherRespawn(WATCHER_RESPAWN_BACKOFF_INIT_MS);
      } else {
        void this._selfExit("tmux-gone");
      }
    });
  }

  private _scheduleWatcherRespawn(delayMs: number): void {
    if (this._respawnTimer !== null) return; // already scheduled
    const timer = setTimeout(() => {
      this._respawnTimer = null;
      if (!this._started || this._selfExited) return;
      // Replace the (inert, already-EOFed) watcher and force a refresh:
      // sessions may have changed during the watcher gap.
      this._watcher?.stop();
      this._watcher = this._spawnWatcher();
      this._refreshSessions();
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
      // Last client gone — restart the hysteresis window (which itself no-ops
      // when live session-proxy children are still around — tc-eqgp).
      this._startIdleTimer();
    } else {
      this._clearIdleTimer();
    }
  }

  /**
   * tc-eqgp: live-child count changed.  When children appear, cancel any
   * pending idle exit; when the last child departs, arm the idle timer iff
   * there are also zero IPC clients (otherwise the connected-client path
   * already keeps us alive).
   */
  private _onAliveChildCountChange(count: number): void {
    if (!this._started || this._selfExited) return;
    if (count > 0) {
      this._clearIdleTimer();
    } else if (this._ipcClientCount === 0) {
      this._startIdleTimer();
    }
  }

  private _startIdleTimer(): void {
    this._clearIdleTimer();
    // tc-eqgp (b): live session-proxy children represent active VS Code
    // terminals whose data path (EDH ↔ session-proxy over per-session sockets)
    // is invisible to the IPC client count.  Treat them as activity — refuse
    // to arm the idle timer while any child is alive.  When the last child
    // departs the supervisor notifies us via `onAliveCountChange`, which
    // re-enters this method.
    if (this._supervisor.aliveCount() > 0) return;
    const timer = setTimeout(() => {
      this._idleTimer = null;
      if (
        this._started &&
        !this._selfExited &&
        this._ipcClientCount === 0 &&
        this._supervisor.aliveCount() === 0
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

    // tc-xnay / tc-ymxe: announce designed exit BEFORE shutdown closes
    // transports.  Mirrors `_broadcastToAll` shape; inlined here so the
    // shutdown path doesn't have to know about the announcement seq.
    this._broadcastExiting(reason);

    try {
      await this.shutdown();
    } catch {
      // Best-effort: even if shutdown failed midway, the socket file MUST be
      // gone before we report self-exit, or the next spawn stalls.
      removeSocket(this._socketPath);
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
   * kernel closed when the process died.  Per SCHEMA.md ("SessionProxy errors"):
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
   */
  private _onSessionProxyCrash(sessionId: SessionId, info: SessionProxyExitInfo): void {
    process.stderr.write(
      `serverProxy: session-proxy for session '${info.sessionName}' (${sessionId}) exited ` +
      `unexpectedly (code=${info.code}, signal=${info.signal}); ` +
      `fresh session-proxy on next session.claim\n`,
    );
    if (!this._started || this._selfExited) return;
    this._refreshSessions();
  }

  // ---------------------------------------------------------------------------
  // Session state management
  // ---------------------------------------------------------------------------

  private _refreshSessions(): void {
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
    const rows = listSessions(this._opts.socketName, availability);
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
    const tmuxccCounts = countTmuxccClientsBySession(this._opts.socketName);

    // Build a set of current tmux ids
    const currentTmuxIds = new Set(rows.map((r) => r.tmuxId));

    // Detect removals: any session in our table whose tmuxId is no longer present
    for (const [sid, entry] of this._sessions) {
      if (!currentTmuxIds.has(entry.tmuxId)) {
        this._sessions.delete(sid);
        this._byName.delete(entry.name);
        this._supervisor.reapSessionProxy(sid);
        this._broadcastRemoved(sid);
      }
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
      }
    }

    // tc-x6l: update the sessions-active gauge after each refresh.
    this._metrics.setSessionsActive(this._sessions.size);
  }

  // ---------------------------------------------------------------------------
  // Connection handler
  // ---------------------------------------------------------------------------

  private async _handleConnection(transport: Transport): Promise<void> {
    // Run server-proxy-wire handshake
    let session: Awaited<ReturnType<typeof runServerHandshake>>;
    try {
      session = await runServerHandshake(transport, SERVER_PROXY_CAPABILITIES, "server-proxy.capabilities");
    } catch (err) {
      try { transport.close(); } catch { /* ignore */ }
      return;
    }
    void session; // features not yet used in v3 alpha

    // nextSeq starts at 2: the handshake itself sent seq=1 (server-proxy.capabilities).
    // The snapshot is the second server-side message and therefore seq=2.
    const state: ClientState = { transport, nextSeq: 2 };
    this._clients.set(transport, state);

    transport.onClose(() => {
      this._clients.delete(transport);
    });

    // Send snapshot at seq=2 per SCHEMA.md handshake sequence:
    //   server-proxy.capabilities (seq=1) → client.capabilities (seq=1) → sessions.snapshot (seq=2)
    const snapshot = this._buildSnapshot(state.nextSeq);
    state.nextSeq++;
    transport.sendControl(snapshot as unknown as Parameters<typeof transport.sendControl>[0]);

    // Handle incoming commands
    transport.onControl((msg: MessageBase) => {
      if (msg.type === "command.request") {
        void this._handleCommand(state, msg as unknown as ServerProxyCommandRequestMessage);
      }
      // Other message types: emit protocol.unknown-message error
    });
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
  private _buildInfo(): ServerProxyInfoPayload {
    this._refreshSessions();

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

    return {
      socketName: this._opts.socketName,
      serverProxySocketPath: this._socketPath,
      serverProxyPid: process.pid,
      uptimeMs: Math.max(0, Date.now() - this._startedAtMs),
      tmuxServerPid: getTmuxServerPid(this._opts.socketName),
      adoptedExistingServer: this._adoptedExistingServer,
      connectedClientCount: this._ipcClientCount,
      logPath: this._opts.logPath ?? null,
      sessions,
      // tc-x6l: metricsText deferred to async; populated in _buildInfoAsync.
      metricsText: null,
    };
  }

  /**
   * Async variant of _buildInfo that populates `metricsText` from prom-client.
   * Used by the command handler so the server-proxy.info response carries live metrics.
   */
  private async _buildInfoAsync(): Promise<ServerProxyInfoPayload> {
    const info = this._buildInfo();
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

    // tc-x6l: increment command counter before dispatch.
    this._metrics.incCommand(command.kind);

    try {
      let payload: { sessionId?: SessionId; endpoint?: string; paneId?: PaneId; created?: boolean; ok?: true; info?: ServerProxyInfoPayload; name?: string };

      switch (command.kind) {
        case "session.claim":
          payload = await this._claimSession(command.name);
          break;
        case "session.create":
          payload = await this._createSession(command.name);
          break;
        case "session.createUnique":
          payload = await this._createUniqueSession(command.baseName);
          break;
        case "session.destroy":
          payload = await this._destroySession(command.sessionId);
          break;
        case "server-proxy.info":
          // tc-k6v + tc-x6l: read-only diagnostics snapshot with metrics.
          payload = { info: await this._buildInfoAsync() };
          break;
        case "pane.attach":
          // tc-7xv.36: attach intent for a specific pane.  The server-proxy doesn't
          // own pane-level state — it just ensures the session-proxy is running for
          // the named session and echoes the paneId back so the client has a
          // round-tripped acknowledgement of its targeted attach.
          payload = await this._attachPane(command.sessionId, command.paneId);
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

      this._sendResponse(state, {
        correlationId,
        result: { ok: true, payload },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = errorCode(err);
      this._sendResponse(state, {
        correlationId,
        result: { ok: false, code, message: msg },
      });
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
  // Command implementations
  // ---------------------------------------------------------------------------

  /**
   * Claim or obtain the session-proxy endpoint for a named session.
   * Per-name serialization via _claimLocks.
   *
   * tc-3y8.2: the returned `created` flag reports whether THIS claim minted
   * the tmux session.  Joining an in-flight claim returns `created: false`
   * regardless of the shared promise's outcome — the joiner did not initiate
   * the creating claim, so exactly one claimant per session creation sees
   * `created: true`.
   */
  private _claimSession(name: string): Promise<{ sessionId: SessionId; endpoint: string; created: boolean }> {
    const inFlight = this._claimLocks.get(name);
    if (inFlight) {
      // Joined claim: by the time this resolves the session exists; this
      // caller did not create it.
      return inFlight.then((r) => ({ ...r, created: false }));
    }

    const promise = this._doClaimSession(name).finally(() => {
      // Only remove the lock if it's still THIS promise (not a newer one)
      if (this._claimLocks.get(name) === promise) {
        this._claimLocks.delete(name);
      }
    });

    this._claimLocks.set(name, promise);
    return promise;
  }

  private async _doClaimSession(
    name: string,
  ): Promise<{ sessionId: SessionId; endpoint: string; created: boolean; name?: string }> {
    // Refresh session list from tmux
    this._refreshSessions();

    let entry = this._byName.get(name);

    // tc-3y8.2: whether THIS claim minted the tmux session (vs attaching to a
    // pre-existing one).  Reported to the client as the authority for
    // create-time-only behaviour (profile apply).
    let created = false;

    if (!entry) {
      // Session doesn't exist — create it.
      //
      // tc-zcqr: `createSession` returns the new tmux session id directly via
      // `new-session -P -F '#{session_id}'`.  We inject the new entry into
      // _sessions/_byName synchronously rather than relying on a follow-up
      // `tmux list-sessions` to learn the id — that round-trip can fail
      // transiently (the watcher's -CC attach + supervisor's session-proxy spawn
      // contend for the tmux server's response budget in this window) and
      // silently produced "Session 'X' not found after creation".
      try {
        const { tmuxId } = createSession(this._opts.socketName, name);
        created = true;
        entry = this._byName.get(name);
        if (!entry) {
          // No race winner ahead of us — inject the just-created session
          // authoritatively from the createSession return value.  Broadcast
          // sessions.added so connected clients see it immediately (this is
          // the same broadcast _refreshSessions would emit on the next tick).
          const sessionId = mintSessionId(`s${tmuxId.replace("$", "")}`);
          entry = {
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
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes("duplicate")) {
          // Race: another process created it between our check and create —
          // we attached to that process's session; `created` stays false.
          this._refreshSessions();
          entry = this._byName.get(name);
          if (!entry) {
            throw Object.assign(new Error(`session.create race: ${msg}`), { code: "internal" });
          }
        } else {
          throw Object.assign(new Error(`tmux.unavailable: ${msg}`), { code: "tmux.unavailable" });
        }
      }
    }

    // tc-w61: mark-on-attach — ensure the Phase 2 @tmuxcc 1 marker is set on
    // the session before starting the session-proxy.  For sessions created by
    // createSession() above, the marker was already set inside createSession();
    // this call is effectively a no-op in that case (idempotent).  For
    // pre-existing sessions that tmuxcc is claiming for the first time (e.g. a
    // session the user manually created then attached via tmuxcc.attachToSession),
    // this stamps them as tmuxcc-managed so they will appear in listTmuxccSessions
    // on subsequent invocations.
    setSessionMarker(this._opts.socketName, entry.name);

    // Ensure session-proxy is running
    const sessionProxySockPath = sessionProxySocketPath(
      this._socketDirName,
      entry.sessionId,
      this._runtimeDirOpts,
    );

    const endpoint = await this._supervisor.ensureSessionProxy(
      entry.sessionId,
      entry.name,
      this._opts.socketName,
      sessionProxySockPath,
    );

    return { sessionId: entry.sessionId, endpoint, created };
  }

  private async _createSession(
    name: string,
  ): Promise<{ sessionId: SessionId; endpoint: string; created: boolean }> {
    this._refreshSessions();

    // tc-3y8.2: an in-flight claim counts as "name in use" — joining it via
    // _claimSession would resolve with created=false, contradicting the
    // session.create contract (a successful create always mints, so its
    // response always reports created=true; otherwise it fails name-taken).
    if (this._byName.has(name) || this._claimLocks.has(name)) {
      throw Object.assign(
        new Error(`Session name '${name}' is already in use`),
        { code: "session.name-taken" },
      );
    }

    // Use claim semantics — create then spawn session-proxy.
    const result = await this._claimSession(name);

    // tc-3y8.2: enforce mint-or-fail.  The checks above close the in-process
    // races, but another tmux client (outside this serverProxy) can still mint the
    // name between our refresh and the underlying `new-session`.  The claim
    // path resolves that race by attaching (`created: false`); for
    // session.create that outcome IS name-taken.  The session and session-proxy stay
    // up — they belong to whoever created the session, exactly as if a
    // session.claim had been issued.
    if (!result.created) {
      throw Object.assign(
        new Error(`Session name '${name}' is already in use`),
        { code: "session.name-taken" },
      );
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
   *   2. If `baseName` is not in `_byName` AND not in `_claimLocks`, use it.
   *   3. Otherwise try `baseName-2`, `baseName-3`, … until a free slot is found.
   *   4. Claim the chosen name via `_claimSession` (which creates the tmux
   *      session and spawns the session-proxy atomically with the per-name lock).
   *
   * Atomicity guarantee: two concurrent `createUnique({baseName})` calls
   * cannot collide because:
   *   - `_claimLocks` is checked and set synchronously before `_claimSession`
   *     yields (single-threaded JS event loop).
   *   - `_doClaimSession` uses `_claimLocks` as a per-name mutex — a second
   *     caller who picks the same uniquified name will join the in-flight claim
   *     and observe `created: false`, which this method treats as a collision
   *     and re-tries with the next suffix.
   *
   * Returns `{ sessionId, name, endpoint, created: true }` — `created` is
   * always `true` because this command never silently attaches.
   */
  private async _createUniqueSession(
    baseName: string,
  ): Promise<{ sessionId: SessionId; endpoint: string; created: boolean; name: string }> {
    // Normalise: empty / whitespace-only baseName → "tmuxcc".
    const base = (baseName ?? "").trim() || "tmuxcc";

    // eslint-disable-next-line no-constant-condition
    for (let attempt = 0; ; attempt++) {
      // Refresh on the first pass; subsequent passes skip the refresh because
      // the session we just tried to claim is now in _byName.
      if (attempt === 0) {
        this._refreshSessions();
      }

      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;

      // Skip names already live in tmux or in-flight.
      if (this._byName.has(candidate) || this._claimLocks.has(candidate)) {
        continue;
      }

      // Attempt to claim the candidate.  If another concurrent caller beats
      // us (race between the check above and _claimSession below), the claim
      // resolves with created=false — that means the name was taken; loop.
      const result = await this._claimSession(candidate);
      if (result.created) {
        return { sessionId: result.sessionId, endpoint: result.endpoint, created: true, name: candidate };
      }
      // Name was taken by a concurrent caller — try the next suffix.
    }
  }

  /**
   * Handle `pane.attach` (tc-7xv.36).
   *
   * The server-proxy doesn't track panes — it only knows about sessions.  This
   * handler:
   *   1. Verifies the named session exists in the server-proxy's session table
   *      (after a refresh from tmux).
   *   2. Ensures the per-session session-proxy is running and returns its endpoint
   *      (same path used by `session.claim`).
   *   3. Echoes the supplied `paneId` back to the client as an acknowledgement
   *      of the targeted-attach intent — the client uses it to drive its host-
   *      pty binding decision.
   *
   * Pane existence is NOT validated here.  If the pane has disappeared by the
   * time the client connects to the sessionProxy, the session-proxy's snapshot simply will
   * not contain it; the client is expected to detect the missing pane and
   * surface a UI signal.  Validating in the server-proxy would require the server-proxy
   * to inspect session-proxy-side state, which crosses the wire-contract invariant
   * (the server-proxy speaks in sessions, not panes).
   */
  private async _attachPane(
    sessionId: SessionId,
    paneId: PaneId,
  ): Promise<{ sessionId: SessionId; endpoint: string; paneId: PaneId }> {
    // Refresh the session table from tmux so a recently-disappeared session
    // is detected promptly.
    this._refreshSessions();

    const entry = this._sessions.get(sessionId);
    if (!entry) {
      throw Object.assign(
        new Error(`Session '${sessionId}' not found`),
        { code: "session.not-found" },
      );
    }

    // Ensure the session-proxy is up.  Reuse the same per-name claim semantics so
    // concurrent pane.attach + session.claim requests share one spawn.
    const { endpoint } = await this._claimSession(entry.name);

    return { sessionId: entry.sessionId, endpoint, paneId };
  }

  private async _destroySession(
    sessionId: SessionId,
  ): Promise<{ ok: true }> {
    const entry = this._sessions.get(sessionId);
    if (!entry) {
      throw Object.assign(
        new Error(`Session '${sessionId}' not found`),
        { code: "session.not-found" },
      );
    }

    // Reap session-proxy first
    this._supervisor.reapSessionProxy(sessionId);

    // Kill the tmux session
    try {
      killSession(this._opts.socketName, entry.tmuxId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`tmux.unavailable: ${msg}`), { code: "tmux.unavailable" });
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
// Error code helper
// ---------------------------------------------------------------------------

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return "internal";
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
 * Nor are there orphaned session-proxies to reap after a server-proxy crash: session-proxies are
 * non-detached children that enforce die-with-parent themselves (tc-2c5 —
 * getppid watchdog installed in session-proxy-entry.ts).  Recovery is launcher →
 * fresh server-proxy → fresh session-proxies on next session.claim → fresh `-CC attach`
 * to the surviving tmux sessions.
 */
export function createServerProxy(opts: ServerProxyOptions): ServerProxyHandle {
  return new ServerProxyImpl(opts);
}
