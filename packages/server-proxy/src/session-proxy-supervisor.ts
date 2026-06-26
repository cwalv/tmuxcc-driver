/**
 * SessionProxy supervisor — manages per-session session-proxy runtimes IN-PROCESS.
 *
 * # Responsibility
 *
 * The supervisor owns the lifecycle of per-session session-proxy runtimes:
 *   - Instantiating a session-proxy for a session (if one is not already running)
 *   - Waiting for the session-proxy to finish its bootstrap (start() resolves)
 *   - Reaping session-proxies on session removal or unexpected exit
 *   - Per-name atomicity: concurrent claim requests for the same session name
 *     are serialized so only one session-proxy is ever created
 *
 * # tc-2x3.3 collapse: in-process, single event loop
 *
 * Before tc-2x3 Stage 2 each session-proxy ran in its OWN child process
 * (`child_process.spawn(node, [session-proxy-entry.js, …])`).  The 1 + N + N
 * topology (server-proxy + N session-proxy processes + N tmux clients) cost
 * ~335-600 MB RSS at N=3.  Stage 2 collapses the N session-proxy processes into
 * the server-proxy's own event loop: each session-proxy is now created
 * IN-PROCESS via `createSessionProxy(...)` and serves clients over its own
 * per-session unix socket.  The per-session sockets and the client wire protocol
 * are BYTE-IDENTICAL — only WHERE the `createSessionProxy` + `net.createServer`
 * code runs changed (in-proc vs child proc).
 *
 * Consequences of the collapse:
 *   - No `--socket-name`/`--session-name`/`--socket-path` argv, no spawn, no
 *     READY-handshake — the session-proxy is just an object we `await .start()`.
 *   - No die-with-parent (tc-2c5): there is no child process to be reparented;
 *     the session-proxy lives and dies with the server-proxy by construction.
 *   - `sessionProxyPid()` reports the server-proxy's own pid — the session-proxy
 *     IS this process now (tc-k6v `server-proxy.info`).
 *   - The old SIGTERM graceful path (detach `-CC`, close + remove the unix
 *     socket) is preserved as `_teardownEntry`: `sessionProxy.stop()` then close
 *     the per-session server and unlink the socket file.
 *
 * # Data-plane endpoint convention
 *
 * Per SCHEMA.md: control + data plane are multiplexed on the same per-session
 * unix socket via the 0xCC magic byte (socket-transport.ts).  The endpoint
 * returned by the supervisor IS that multiplexed socket path; clients do not
 * need a separate data socket.
 *
 * # tc-2x3.6: GAP 1 — orphaned listening fd reclamation
 *
 * tc-2x3.4 fixed the socket-file clobber race (the fresh entry's socket file
 * was being unlinked by the old entry's deferred teardown) by calling
 * `server.unref()` instead of `server.close()` when refcount > 1.  `unref()`
 * prevents the old server from blocking process exit but leaves its listening
 * fd open until the process exits — an fd leak bounded in normal use (one reattach
 * cycle) but unbounded under a persistent GAP-2 busy-loop.
 *
 * The fix: call `_closeServerFdOnly(server, path)`.  Note the fresh
 * `_createSessionProxy` re-BINDS `path` (its `removeSocket` clears the stale
 * file, then it listens again), so at teardown time `path` holds the FRESH
 * socket — `server.close()`'s synchronous libuv unlink would clobber it.  So
 * `_closeServerFdOnly` renames the fresh socket aside, calls `server.close()`
 * (its unlink now hits the empty path → ENOENT no-op), then renames the fresh
 * socket back — reclaiming the old fd without touching the live socket.  Full
 * mechanism + the libuv-synchronous-unlink invariant it relies on are documented
 * at `_closeServerFdOnly` below.
 *
 * # tc-2x3.6: GAP 2 — repeated-trip circuit breaker
 *
 * A persistent parser/reducer bug trips → the session-proxy is torn down → the
 * extension calls `ensureSessionProxy` (lazy respawn) → the fresh session-proxy
 * immediately re-trips: a hot busy-loop that drives unbounded fd leaks (GAP 1)
 * and floods stderr.
 *
 * The fix: a per-session trip-timestamp log.  When `onFatalError` fires, the
 * supervisor appends the timestamp and checks whether the last
 * `CIRCUIT_BREAKER_TRIP_THRESHOLD` trips all fell within
 * `CIRCUIT_BREAKER_WINDOW_MS`.  If yes, the session is quarantined:
 *   - The sessionId is added to `_quarantinedSessions`.
 *   - A loud stderr message and an extra `session_boundary_quarantined_total`
 *     metric increment signal the event.
 *   - Subsequent calls to `ensureSessionProxy` for that sessionId reject
 *     immediately with a `SessionQuarantineError`.
 *   - `clearQuarantine(sessionId)` removes the quarantine so the extension can
 *     recover after a code fix or manual intervention.
 *
 * Design choices (documented here so reviewers can audit them):
 *   - N = 3 trips, window = 10 s: three rapid successive trips in ten seconds
 *     cannot be explained by transient tmux noise; they indicate a reproducible
 *     code path bug. Configured as module-level constants — easily tunable.
 *   - Quarantine is sticky (no auto-expiry): the supervisor does not know when
 *     the underlying bug is fixed. Auto-expiry would just restart the busy-loop
 *     after a cooldown. The correct recovery path is a new server-proxy binary
 *     (which re-creates the supervisor fresh) or an explicit clearQuarantine().
 *   - The supervisor decides quarantine (not the extension): quarantine is a
 *     structural invariant — the supervisor owns reattach policy end-to-end,
 *     and the extension already treats `ensureSessionProxy` as the only path
 *     into a live session-proxy. Surfacing quarantine as an error there is the
 *     minimum-footprint, legible design.
 *   - Trip log is bounded: we keep at most `CIRCUIT_BREAKER_TRIP_THRESHOLD`
 *     timestamps per session (older entries are trimmed); a quarantined session
 *     never appends again.
 *
 * @module session-proxy-supervisor
 */

import * as net from "node:net";
import * as fs from "node:fs";
import { createSessionProxy } from "@tmuxcc/session-proxy";
import type { SessionProxy } from "@tmuxcc/session-proxy";
import { createSocketTransport } from "./socket-transport.js";
import type { SocketTransportMetrics } from "./socket-transport.js";
import { removeSocket, restrictSocket } from "./runtime-dir.js";
import { recordHostDeath } from "./death-instrument.js";

// ---------------------------------------------------------------------------
// Circuit breaker constants (tc-2x3.6 GAP 2)
// ---------------------------------------------------------------------------

/**
 * Number of boundary trips within `CIRCUIT_BREAKER_WINDOW_MS` that triggers
 * quarantine for a session.  Three rapid trips in ten seconds cannot be
 * explained by transient tmux noise; they indicate a reproducible code path bug.
 */
const CIRCUIT_BREAKER_TRIP_THRESHOLD = 3;

/**
 * Sliding window (milliseconds) over which boundary trips are counted.
 * Trips older than this are not counted toward the quarantine threshold.
 */
const CIRCUIT_BREAKER_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// Errors (tc-2x3.6 GAP 2)
// ---------------------------------------------------------------------------

/**
 * Thrown by `ensureSessionProxy` when the session has been quarantined by the
 * circuit breaker (>= CIRCUIT_BREAKER_TRIP_THRESHOLD boundary trips within
 * CIRCUIT_BREAKER_WINDOW_MS).
 *
 * The caller (typically the server-proxy's session.claim handler) should
 * surface this to the extension as a non-retriable error.  Recovery requires
 * either a fresh server-proxy process (new supervisor) or an explicit call to
 * `clearQuarantine(sessionId)`.
 */
export class SessionQuarantineError extends Error {
  readonly sessionId: string;
  readonly tripCount: number;
  readonly windowMs: number;

  constructor(sessionId: string, tripCount: number, windowMs: number) {
    super(
      `Session "${sessionId}" quarantined after ${tripCount} boundary trips within ${windowMs}ms. ` +
        `The session pipeline is repeatedly crashing — a code bug is likely. ` +
        `Call clearQuarantine("${sessionId}") to allow reattach after the underlying bug is fixed.`,
    );
    this.name = "SessionQuarantineError";
    this.sessionId = sessionId;
    this.tripCount = tripCount;
    this.windowMs = windowMs;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A running in-process session-proxy entry. */
interface SessionProxyEntry {
  /** The unix socket path the session-proxy is listening on. */
  socketPath: string;
  /** Stable server-proxy-assigned session id. */
  sessionId: string;
  /** The in-process session-proxy runtime. */
  sessionProxy: SessionProxy;
  /** The per-session unix socket server. */
  server: net.Server;
  /**
   * Set once this entry has begun teardown (intentional reap OR host-exit).
   * Guards the host.onExit crash handler against firing during an intentional
   * reap, and guards double-teardown.
   */
  tornDown: boolean;
}

/**
 * Exit details passed to the crash handler.  `code`/`signal` are retained for
 * wire/log compatibility with the pre-collapse shape; for an in-process
 * session-proxy that exits because its bound tmux died, both are null (there is
 * no child process exit code — the cause is a tmux host exit, surfaced via
 * `host.onExit`).
 */
export interface SessionProxyExitInfo {
  /** Session name the session-proxy was bound to (for logging). */
  sessionName: string;
  /** Exit code — always null for an in-process session-proxy (no child process). */
  code: number | null;
  /** Terminating signal — always null for an in-process session-proxy. */
  signal: NodeJS.Signals | null;
}

/**
 * Called when a session-proxy exits UNEXPECTEDLY (ext-a §6.3 "Crash while the
 * server-proxy lives").  Intentional reaps (reapSessionProxy / reapAll) set the
 * entry's `tornDown` flag before tearing down and therefore never reach this
 * handler.  By the time the handler runs, the supervisor has already reaped the
 * sessionId → session-proxy registry entry, so the next ensureSessionProxy() for
 * the session creates a fresh session-proxy.
 *
 * tc-2x3.3: the canonical unexpected-exit trigger is now the bound tmux session
 * dying (`host.onExit`) — there is no separate process to crash.  Per-session
 * error boundaries (a session pipeline throwing should be survivable, with a
 * trip counter / fault injection) are tc-2x3.4, NOT here.
 */
export type SessionProxyCrashHandler = (sessionId: string, info: SessionProxyExitInfo) => void;

// ---------------------------------------------------------------------------
// SessionProxySupervisor
// ---------------------------------------------------------------------------

export interface SessionProxySupervisor {
  /**
   * Ensure a session-proxy is running for the given session and return its socket path.
   *
   * If a session-proxy for `sessionId` is already running, returns its socket path
   * immediately. If not, creates one IN-PROCESS and waits for it to finish
   * bootstrapping (the per-session socket is listening and `sessionProxy.start()`
   * has resolved).
   *
   * Per-name atomicity: concurrent calls for the same `sessionId` share the
   * same in-flight creation promise — only one session-proxy is ever created.
   */
  ensureSessionProxy(
    sessionId: string,
    sessionName: string,
    socketName: string,
    sessionProxySocketPath: string,
  ): Promise<string>;

  /**
   * PID of the process serving the session-proxy for `sessionId`, or `null`
   * when no session-proxy is running (never claimed, reaped, or crashed) or its
   * creation is still in-flight (tc-k6v `server-proxy.info`).  Read-only; never
   * blocks on creation.
   *
   * tc-2x3.3: the session-proxy now runs IN-PROCESS, so a live entry reports
   * the server-proxy's own pid (`process.pid`) — the session-proxy IS this
   * process.
   */
  sessionProxyPid(sessionId: string): number | null;

  /**
   * Whether a session-proxy for `sessionId` is live — a ready entry OR an
   * in-flight creation (tc-hfxb.18.4).  Unlike {@link sessionProxyPid} (which
   * returns null for an in-flight creation), this is true for the WHOLE window
   * from `ensureSessionProxy` being called through ready, until the entry is
   * reaped or its creation rejects.
   *
   * A live session-proxy holds a live `tmux -CC` connection to its session, so
   * the session provably exists in the tmux server — it CANNOT have "left".  The
   * reconciliation removal path uses this to reject spurious `sessions.removed`
   * broadcasts: a transient `list-sessions` that momentarily omits a live
   * session (an empty or partial list during cold-boot `-CC` churn) must not
   * remove it.  The genuine-gone path is unaffected: when a tmux session is
   * truly killed its `-CC` client EOFs, the session-proxy exits, and the
   * supervisor reaps this entry FIRST — so by the time reconciliation runs,
   * `hasSessionProxy` is already false and removal proceeds correctly.
   */
  hasSessionProxy(sessionId: string): boolean;

  /**
   * Collect the Prometheus text exposition of every READY session-proxy's
   * metrics registry, paired with its session id (tc-44u4.4).
   *
   * Used by the `/metrics` HTTP surface (and the same merge path) to namespace
   * each session's `topology_*` / `correlator_*` / `flow_*` families under a
   * `session="<id>"` label.  In-flight creations (Promise entries) are skipped
   * — they have no live registry yet.  Returns one entry per ready session, in
   * registry order; an empty array when no session-proxies are running.
   */
  sessionMetricsTexts(): Promise<Array<{ sessionId: string; text: string }>>;

  /**
   * Number of live session-proxies — both ready entries and in-flight
   * creations.  Used by the idle-exit policy (tc-eqgp): the server-proxy must
   * never idle-exit while it has live session-proxies, because those represent
   * active VS Code terminals whose data path (EDH ↔ session-proxy over
   * per-session sockets) is invisible to the server-proxy's own IPC client
   * count.  An in-flight creation counts too — a claim is in progress and
   * tearing the server-proxy down out from under it would cascade-kill that
   * nascent terminal too.
   */
  aliveCount(): number;

  /**
   * Register a callback fired whenever the alive count changes (creation
   * registered, ready entry recorded, entry reaped, or unexpected exit).  The
   * handler receives the new count.  Used by the server-proxy to re-check the
   * idle policy when the last session-proxy goes away (tc-eqgp).
   */
  onAliveCountChange(handler: (count: number) => void): void;

  /**
   * Tear down the session-proxy for a session (if running). Called on session removal.
   */
  reapSessionProxy(sessionId: string): void;

  /**
   * Tear down all running session-proxies. Called on server-proxy shutdown.
   */
  reapAll(): void;

  /**
   * Register a handler called when a session-proxy exits unexpectedly.
   */
  onCrash(handler: SessionProxyCrashHandler): void;

  /**
   * Clear the circuit-breaker quarantine for `sessionId` so that a subsequent
   * `ensureSessionProxy` call can reattach the session.
   *
   * This does NOT create a new session-proxy — it only removes the quarantine
   * flag.  The next `ensureSessionProxy` call will trigger a fresh creation.
   *
   * Also clears the trip-timestamp log for the session so the window restarts
   * from zero.
   *
   * Idempotent: calling on a non-quarantined session is a no-op.
   */
  clearQuarantine(sessionId: string): void;

  /**
   * Return the set of currently quarantined session IDs (a snapshot — the
   * returned Set is a copy).  Useful for diagnostics / server-proxy.info.
   */
  quarantinedSessions(): ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// GAP 1 helper: close a net.Server's fd without triggering the socket-file unlink
// (tc-2x3.6)
// ---------------------------------------------------------------------------

/**
 * Close a `net.Server`'s listening file descriptor WITHOUT unlinking the socket
 * file at `socketPath` — used when a fresh entry has already rebound that path
 * and we must not clobber it (tc-2x3.6 GAP 1).
 *
 * # The problem
 *
 * `server.close()` calls `handle.close()` which, at the libuv level, calls
 * `unlink(socketPath)` synchronously.  When a fresh entry has already rebound
 * the same path (refcount > 1), this would delete the FRESH server's live socket
 * file — the clobber that tc-2x3.4 fixed by switching to `server.unref()`.
 *
 * `server.unref()` prevents the old server from blocking process exit but leaves
 * its fd open — an fd leak bounded in normal use but unbounded under a GAP-2
 * persistent-trip busy-loop (tc-2x3.6 GAP 1).
 *
 * # The fix: rename-protect
 *
 * At the point this function is called:
 *   - `socketPath` → fresh server's inode (the live socket clients connect to).
 *   - Old server's fd → orphaned inode (no directory entry; cannot accept connections).
 *
 * Strategy:
 *   1. `fs.renameSync(socketPath, tempPath)` — move the fresh socket aside so
 *      `socketPath` is empty.  This is synchronous and takes no event-loop turn.
 *   2. `server.close()` — libuv calls `unlink(socketPath)`.  The path is now
 *      empty (ENOENT), so the unlink is a silent no-op.  The fd is closed.
 *   3. `fs.renameSync(tempPath, socketPath)` — restore the fresh socket.
 *
 * The rename window (step 1 → step 3) is synchronous: no event loop turn fires
 * in that window, so no client connection attempt can observe the absent path.
 *
 * # Fallback
 *
 * If the rename fails for any reason (e.g. the fresh socket was already deleted),
 * we fall back to `server.unref()` — the tc-2x3.4 behavior (fd held open until
 * process exit, not a correctness bug).  The fallback is logged to stderr so
 * the operator knows GAP 1 reclamation did not fire.
 */
function _closeServerFdOnly(server: net.Server, socketPath: string): void {
  // Belt-and-suspenders: prevent the server from blocking process exit regardless
  // of whether the close succeeds.  This matches the tc-2x3.4 safety floor.
  server.unref();

  const tempPath = socketPath + ".__tc2x36__";
  try {
    // Step 1: protect the fresh socket by renaming it aside (synchronous).
    // If the rename throws (e.g. ENOENT — fresh socket already gone), jump to fallback.
    fs.renameSync(socketPath, tempPath);
  } catch {
    // Fresh socket is already gone (nothing to protect); fall back to unref-only
    // so we don't call close() and risk any side effects.
    return;
  }

  try {
    // Step 2: close the old server — libuv tries unlink(socketPath) → ENOENT (no-op).
    // Fd is reclaimed.
    server.close();
  } finally {
    // Step 3: restore the fresh socket regardless of whether close() threw.
    try {
      fs.renameSync(tempPath, socketPath);
    } catch {
      // If restoration fails, the fresh socket may be lost.  Log loudly — this is
      // a correctness issue and should never happen in normal operation.
      process.stderr.write(
        `[session-proxy-supervisor] CRITICAL: failed to restore fresh socket ` +
          `at "${socketPath}" after fd reclamation (tc-2x3.6 GAP 1). ` +
          `The session may be unreachable to new client connections.\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SessionProxySupervisorImpl implements SessionProxySupervisor {
  private readonly _opts: SessionProxySupervisorOptions;

  constructor(opts: SessionProxySupervisorOptions = {}) {
    this._opts = opts;
  }

  /**
   * Map from sessionId to running session-proxy entry (or in-progress creation
   * promise).  The value is the entry OR a Promise for the in-flight creation,
   * allowing per-name serialization.
   */
  private _sessionProxies = new Map<string, SessionProxyEntry | Promise<SessionProxyEntry>>();
  /**
   * Reference count per socket path: how many live or in-flight entries currently
   * claim ownership of that path.  Used by the ownership guard in
   * `_doSocketTeardown` to decide whether to unlink the socket file.
   *
   * Why a reference count?
   *
   * `stop()` can take up to ~3 s.  During that window `ensureSessionProxy` may
   * have already called `_createSessionProxy` for the same path, incrementing the
   * count to 2.  When the old entry's `.finally` fires, it decrements back to 1;
   * since the count is > 0, the unlink is skipped.  When the new entry eventually
   * tears down, it decrements to 0 and the unlink runs safely.
   *
   * Lifecycle:
   *   - Incremented at the START of `_createSessionProxy` (before server.listen),
   *     even before `start()` resolves, so the guard sees the new claim during the
   *     in-flight phase.
   *   - Decremented inside `_doSocketTeardown`'s `.finally` callback at unlink
   *     time.  If the count reaches 0, the path has no living owners → unlink.
   *   - Also decremented (and the path removed) in the creation-failure path so
   *     a failing creation does not leak a permanent claim.
   */
  private _socketPathRefCount = new Map<string, number>();
  private _crashHandler: SessionProxyCrashHandler | null = null;
  private _aliveCountHandlers: Array<(count: number) => void> = [];

  // ---------------------------------------------------------------------------
  // tc-2x3.6 GAP 2: circuit breaker state
  // ---------------------------------------------------------------------------

  /**
   * Per-session boundary-trip timestamps (ms since epoch).  Only the most
   * recent `CIRCUIT_BREAKER_TRIP_THRESHOLD` entries are kept per session
   * (older entries are trimmed on each new trip).  A quarantined session is
   * removed from this map (it no longer needs trip tracking).
   */
  private _boundaryTripLog = new Map<string, number[]>();

  /**
   * Sessions that have been quarantined by the circuit breaker.  Once in this
   * set, `ensureSessionProxy` will immediately throw `SessionQuarantineError`.
   * Cleared by `clearQuarantine(sessionId)`.
   */
  private _quarantinedSessions = new Set<string>();

  onCrash(handler: SessionProxyCrashHandler): void {
    this._crashHandler = handler;
  }

  clearQuarantine(sessionId: string): void {
    this._quarantinedSessions.delete(sessionId);
    this._boundaryTripLog.delete(sessionId);
  }

  quarantinedSessions(): ReadonlySet<string> {
    return new Set(this._quarantinedSessions);
  }

  aliveCount(): number {
    // Every map entry — ready entry or in-flight creation promise — represents
    // a live (or imminently-live) session-proxy whose existence the idle policy
    // must respect.  reapSessionProxy() / the crash handler delete the entry
    // synchronously with the teardown/exit, so the size is the alive count.
    return this._sessionProxies.size;
  }

  onAliveCountChange(handler: (count: number) => void): void {
    this._aliveCountHandlers.push(handler);
  }

  private _fireAliveCount(): void {
    const count = this._sessionProxies.size;
    for (const h of this._aliveCountHandlers.slice()) {
      try {
        h(count);
      } catch {
        // Listener errors must not break the supervisor.
      }
    }
  }

  async ensureSessionProxy(
    sessionId: string,
    sessionName: string,
    socketName: string,
    sessionProxySockPath: string,
  ): Promise<string> {
    // tc-2x3.6 GAP 2: circuit-breaker quarantine check.
    // A quarantined session has tripped the boundary >= CIRCUIT_BREAKER_TRIP_THRESHOLD
    // times within CIRCUIT_BREAKER_WINDOW_MS.  Reject immediately — do NOT create
    // a fresh session-proxy, which would just re-trip and continue the busy-loop.
    if (this._quarantinedSessions.has(sessionId)) {
      throw new SessionQuarantineError(
        sessionId,
        CIRCUIT_BREAKER_TRIP_THRESHOLD,
        CIRCUIT_BREAKER_WINDOW_MS,
      );
    }

    // Fast path: session-proxy already running
    const existing = this._sessionProxies.get(sessionId);
    if (existing !== undefined) {
      if (existing instanceof Promise) {
        // In-flight creation — wait for it
        const entry = await existing;
        return entry.socketPath;
      }
      return existing.socketPath;
    }

    // Slow path: create a new session-proxy in-process
    const createPromise = this._createSessionProxy(
      sessionId,
      sessionName,
      socketName,
      sessionProxySockPath,
    );

    // Register the promise immediately so concurrent callers share it.
    // tc-eqgp: count an in-flight creation as a live session-proxy for
    // idle-exit purposes — a claim is in progress and the server-proxy must
    // stay up until that nascent terminal is wired.
    this._sessionProxies.set(sessionId, createPromise);
    this._fireAliveCount();

    let entry: SessionProxyEntry;
    try {
      entry = await createPromise;
    } catch (err) {
      // Creation failed — remove the stale promise
      this._sessionProxies.delete(sessionId);
      this._fireAliveCount();
      throw err;
    }

    // Replace promise with resolved entry (no count change — promise → entry
    // is still one alive session-proxy).  But: an intentional reap may have run
    // while the creation was in-flight (reapSessionProxy deletes the promise
    // and chains teardown after it settles).  Only register the entry if THIS
    // promise is still the registered value; otherwise the reap already owns
    // teardown and we must not resurrect a reaped session.
    if (this._sessionProxies.get(sessionId) === createPromise) {
      this._sessionProxies.set(sessionId, entry);
    }
    return entry.socketPath;
  }

  sessionProxyPid(sessionId: string): number | null {
    const entry = this._sessionProxies.get(sessionId);
    if (entry === undefined || entry instanceof Promise) return null;
    // tc-2x3.3: in-process — the session-proxy IS the server-proxy process.
    return process.pid;
  }

  hasSessionProxy(sessionId: string): boolean {
    // tc-hfxb.18.4: ready entry OR in-flight creation promise — both register in
    // `_sessionProxies` (the in-flight promise is set synchronously by
    // `ensureSessionProxy` before its first await), so this is true for the
    // entire claim/create window.
    return this._sessionProxies.has(sessionId);
  }

  async sessionMetricsTexts(): Promise<Array<{ sessionId: string; text: string }>> {
    // tc-44u4.4: gather every READY session-proxy's prom-client exposition.
    // In-flight creations (Promise entries) have no live registry yet — skip.
    const out: Array<{ sessionId: string; text: string }> = [];
    const ready: Array<{ sessionId: string; promise: Promise<string> }> = [];
    for (const [sessionId, entry] of this._sessionProxies) {
      if (entry instanceof Promise) continue;
      ready.push({ sessionId, promise: entry.sessionProxy.metrics.metrics() });
    }
    for (const r of ready) {
      out.push({ sessionId: r.sessionId, text: await r.promise });
    }
    return out;
  }

  reapSessionProxy(sessionId: string): void {
    const entry = this._sessionProxies.get(sessionId);
    if (!entry) return;

    this._sessionProxies.delete(sessionId);
    this._fireAliveCount();

    if (entry instanceof Promise) {
      // In-flight creation — tear down after it resolves.  ensureSessionProxy's
      // registration is guarded on the promise still being the registered
      // value, so deleting it here means the resolved entry will not be
      // re-registered; we own its teardown.
      void entry.then((e) => this._teardownEntry(e)).catch(() => {});
    } else {
      this._teardownEntry(entry);
    }
  }

  reapAll(): void {
    for (const sessionId of [...this._sessionProxies.keys()]) {
      this.reapSessionProxy(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create and start a session-proxy IN-PROCESS, listening on its per-session
   * unix socket.  This is the in-process equivalent of the old
   * session-proxy-entry.ts main(): remove the stale socket, create the
   * SessionProxy, bind the unix socket server, restrict to 0600, start the
   * SessionProxy (spawns `tmux -CC attach` via node-pty), and wire the
   * host-exit teardown.
   *
   * Mirrors the pre-collapse readiness contract: the returned promise resolves
   * ONLY after the socket is listening AND `sessionProxy.start()` has resolved,
   * so `session.claim` does not return an endpoint until clients can actually
   * connect and get a snapshot (the old "READY\n" handshake guaranteed the same).
   */
  private async _createSessionProxy(
    sessionId: string,
    sessionName: string,
    socketName: string,
    sessionProxySockPath: string,
  ): Promise<SessionProxyEntry> {
    // Remove stale socket file if present.
    removeSocket(sessionProxySockPath);

    // Increment the socket-path reference count BEFORE binding the server.
    // The ownership guard in _doSocketTeardown reads this count at unlink time;
    // incrementing early ensures the guard sees the new claim even while this
    // creation is still in-flight (awaiting start()).  The old entry's .finally
    // will decrement its own claim; if the count is still > 0 afterward, the
    // fresh entry owns the path and the unlink is skipped.
    this._socketPathRefCount.set(
      sessionProxySockPath,
      (this._socketPathRefCount.get(sessionProxySockPath) ?? 0) + 1,
    );

    // tc-2x3.4: per-session error boundary — late-binding entry reference.
    //
    // `entry` is declared below (after `server` is created), but `onFatalError`
    // closes over it.  We use a nullable reference patched after the entry is
    // built — same late-bind pattern as `pipelineRef`/`serverRef` in
    // runtime/session-proxy.ts — so the closure never sees a TDZ violation.
    // `onFatalError` only fires AFTER `sessionProxy.start()` resolves (the
    // pipeline is live only then), which is always after `entryRef` is patched.
    let entryRef: SessionProxyEntry | null = null;

    // Create the session-proxy (not yet started).
    //
    // tc-2x3.4: per-session error boundary.  The pipeline's `onFatalError`
    // callback fires if the tokenizer / parser / reducer / _dispatchEvent
    // stack throws an unhandled exception.  The pipeline stops itself before
    // calling this hook; we tear down only THIS session's entry (unlink socket,
    // reap registry), increment the boundary-trip counter on the session's own
    // metrics registry, and fire `_fireAliveCount()` so the idle-exit policy
    // re-evaluates.  Siblings are unaffected.
    //
    // This is NOT a crash (tmux is still alive) and NOT an intentional reap
    // (the user didn't ask for shutdown) — so we do NOT fire `_crashHandler`.
    // We set `tornDown = true` on the entry before teardown to prevent the
    // host.onExit handler from double-tearing-down if tmux also exits right after.
    //
    // Lazy respawn (§6.2 ext-a): nothing is re-created until the extension
    // calls `ensureSessionProxy` for this session again.
    //
    // tc-2x3.6 GAP 2: circuit breaker.  On each trip, the supervisor logs the
    // timestamp and checks whether the last CIRCUIT_BREAKER_TRIP_THRESHOLD trips
    // all fell within CIRCUIT_BREAKER_WINDOW_MS.  If so, the session is quarantined
    // and ensureSessionProxy will reject immediately on the next call.
    let boundaryTripInFlight = false;
    const onFatalError = (err: unknown): void => {
      const entry = entryRef;
      if (entry === null) {
        // Entry not yet patched — this would mean the pipeline fired before
        // start() completed, which is structurally impossible. Defensive no-op.
        return;
      }

      // Guard double-trip: the pipeline stops itself before calling this hook,
      // but defensive against any re-entrant path.
      if (boundaryTripInFlight) return;
      boundaryTripInFlight = true;

      // ABA guard: only tear down if THIS entry is still the registered one.
      // A concurrent reap or fresh ensureSessionProxy may have already replaced it.
      const current = this._sessionProxies.get(sessionId);
      if (current !== entry) {
        // Entry was already replaced — the boundary trip is stale; skip.
        return;
      }

      // Increment the boundary-trip counter on THIS session's metrics registry
      // so the trip is visible via session-proxy.info. Loud-log with session
      // attribution so the bug stays visible even without a metrics reader.
      entry.sessionProxy.metrics.incBoundaryTrip();
      process.stderr.write(
        `[session-proxy-supervisor] BOUNDARY TRIP: session "${sessionName}" (id: ${sessionId}) ` +
          `pipeline threw an unhandled exception — tearing down this session's PTY client + per-session ` +
          `socket; sibling sessions are unaffected (tc-2x3.4).\n` +
          `  Error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );

      // tc-2x3.6 GAP 2: circuit-breaker trip log update.
      // Record the timestamp and check whether the last N trips fell within the window.
      const now = Date.now();
      const tripLog = this._boundaryTripLog.get(sessionId) ?? [];
      tripLog.push(now);
      // Keep only the most recent CIRCUIT_BREAKER_TRIP_THRESHOLD entries — older
      // entries cannot trigger quarantine (they're outside the window) and we
      // don't want unbounded growth.
      while (tripLog.length > CIRCUIT_BREAKER_TRIP_THRESHOLD) {
        tripLog.shift();
      }
      this._boundaryTripLog.set(sessionId, tripLog);

      // Check whether the oldest of the last N trips is within the window.
      const shouldQuarantine =
        tripLog.length >= CIRCUIT_BREAKER_TRIP_THRESHOLD &&
        now - tripLog[0]! <= CIRCUIT_BREAKER_WINDOW_MS;

      if (shouldQuarantine) {
        // Enter quarantine: mark the session so the next ensureSessionProxy
        // call rejects immediately.  Remove the trip log — the quarantine state
        // is the durable signal now.
        this._quarantinedSessions.add(sessionId);
        this._boundaryTripLog.delete(sessionId);
        // tc-m2y8: count the quarantine event on THIS session's metrics
        // registry (companion to incBoundaryTrip), alongside the loud-log
        // below — an expected-zero tripwire surfaced via session-proxy.info.
        entry.sessionProxy.metrics.incBoundaryQuarantine();
        process.stderr.write(
          `[session-proxy-supervisor] CIRCUIT BREAKER OPEN: session "${sessionName}" ` +
            `(id: ${sessionId}) has tripped the error boundary ` +
            `${CIRCUIT_BREAKER_TRIP_THRESHOLD} times in ${CIRCUIT_BREAKER_WINDOW_MS}ms — ` +
            `session QUARANTINED; ensureSessionProxy will reject until clearQuarantine() is called. ` +
            `Fix the underlying parser/reducer bug before re-enabling this session (tc-2x3.6).\n`,
        );
      }

      // Mark tornDown so the host.onExit handler (wired below, after start)
      // does not double-tear-down if tmux also exits right after the boundary trip.
      entry.tornDown = true;

      // Remove from registry so the next ensureSessionProxy creates a fresh
      // session-proxy (lazy respawn — §6.2 ext-a).
      if (this._sessionProxies.get(sessionId) === entry) {
        this._sessionProxies.delete(sessionId);
        this._fireAliveCount();
      }

      // Tear down: stop the session-proxy (detach `-CC` client, ≤3 s then
      // SIGKILL the tmux child), close the per-session socket server, unlink
      // the socket file — with the ownership guard that prevents clobbering a
      // fresh entry that may have taken over this socket path during stop()'s
      // ≤3 s window (tc-2x3.4 DEFECT 1).
      this._doSocketTeardown(entry);
    };

    const sessionProxy = createSessionProxy({
      host: {
        socketName,
        sessionName,
        attach: true, // server-proxy creates the session; session-proxy attaches
      },
      onFatalError,
      // Forward the supervisor-level onTopologyNotify if provided (tc-2x3.6):
      // used for supervisor-level observability and for fault-injection in tests.
      ...(this._opts.onTopologyNotify !== undefined
        ? { onTopologyNotify: this._opts.onTopologyNotify }
        : {}),
    });

    // Create the per-session unix socket server.
    const server = net.createServer((socket) => {
      // tc-edf8: thread the broker's backpressure metrics hook into each
      // per-session client transport so its drain path is observable.
      const transport = createSocketTransport(socket, this._opts.socketTransportMetrics);
      // tc-295a.21: catch per-connection rejections (e.g. raw/unhandshaked
      // connections).  Without this catch, a HandshakeError from a malformed
      // connection becomes an unhandled promise rejection → Node ≥ 22 exits.
      // In the collapsed topology that would take the ENTIRE server-proxy and
      // ALL its sessions down (previously it killed one session-proxy process).
      // Per-connection catch: log fail-loud, close that socket, continue.
      sessionProxy.addClient(transport).catch((err: unknown) => {
        process.stderr.write(
          `[session-proxy] client connection rejected (handshake failed): ${String(err)}\n`,
        );
        try { transport.close(); } catch { /* already closed by addClient's catch */ }
      });
    });

    // Pre-build the entry so the host-exit handler (wired below, after start)
    // can reference its `tornDown` flag and identity.
    const entry: SessionProxyEntry = {
      sessionId,
      socketPath: sessionProxySockPath,
      sessionProxy,
      server,
      tornDown: false,
    };

    // tc-2x3.4: patch the late-binding boundary reference so `onFatalError`
    // can find the entry if the pipeline throws.
    entryRef = entry;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(sessionProxySockPath, () => {
          server.off("error", reject);
          resolve();
        });
      });

      // Restrict socket permissions to 0600.
      restrictSocket(sessionProxySockPath);

      // Start the session-proxy (spawns tmux -CC attach via node-pty).
      await sessionProxy.start();
    } catch (err) {
      // Creation failed before readiness — clean up the half-built entry so we
      // leave no listening socket or running tmux behind, then rethrow so
      // ensureSessionProxy removes the registry slot and the claim fails.
      // Release the socket-path ref-count claim added at the top of this method.
      // The caller explicitly unlinks via removeSocket below; no auto-unlink here.
      this._releaseSocketPath(sessionProxySockPath);
      try { sessionProxy.kill(); } catch { /* not started */ }
      await new Promise<void>((res) => { server.close(() => res()); });
      removeSocket(sessionProxySockPath);
      throw err;
    }

    // Wire host-exit teardown (tmux crashed or the bound session ended).
    //
    // tc-ukq (ext-a §6.3 "Crash while the server-proxy lives"): on an
    // unexpected exit the registry entry is reaped HERE, and the crash handler
    // fires so the server-proxy refreshes sessions (the tmux session may be
    // gone → sessions.removed, or alive → fresh session-proxy on next claim).
    // Respawn is LAZY (§6.2): nothing is created until the next claim.
    //
    // The host.onExit handler also drives the SessionProxy's own
    // broadcastErrorAndClose (session.unavailable) before this runs — see
    // createSessionProxy's start().  Here we just close the per-session socket
    // server and unlink the socket file, then fire the crash handler.
    const onHostDeath = (): void => {
      if (entry.tornDown) return; // intentional reap already owns teardown
      entry.tornDown = true;

      // Give connected clients a moment to receive session.unavailable (the
      // SessionProxy's host.onExit broadcastErrorAndClose runs synchronously
      // before our handler in registration order, but the close-and-unlink
      // matches the pre-collapse 500ms grace from session-proxy-entry.ts).
      // Ownership guard (tc-2x3.4 DEFECT 1): same close-vs-fd-only logic as
      // _doSocketTeardown — see that method's comment for the full explanation.
      // ensureSessionProxy may have rebound the path during the 500ms grace window.
      // tc-2x3.6 GAP 1: use _closeServerFdOnly (not server.unref()) when a fresh
      // entry owns the path, so the old fd is reclaimed without unlinking the
      // fresh socket file.
      setTimeout(() => {
        const refCount = this._socketPathRefCount.get(sessionProxySockPath) ?? 0;
        if (refCount <= 1) {
          this._socketPathRefCount.delete(sessionProxySockPath);
          server.close();
        } else {
          this._socketPathRefCount.set(sessionProxySockPath, refCount - 1);
          _closeServerFdOnly(server, sessionProxySockPath);
        }
      }, 500);

      // Reap the registry entry + fire the crash handler, but only if THIS
      // entry is still the registered one (ABA guard: a reap + fresh
      // ensureSessionProxy under the same sessionId must not have its healthy
      // replacement reaped by this late exit).
      const current = this._sessionProxies.get(sessionId);
      if (current === entry) {
        this._sessionProxies.delete(sessionId);
        this._fireAliveCount();
        this._crashHandler?.(sessionId, { sessionName, code: null, signal: null });
      }
    };

    // tc-jlyi.17: dev-gated instrument — record WHICH path drove the death
    // (onExit here vs onError below) + host memory/liveness at the instant,
    // BEFORE the idempotent onHostDeath teardown. `entry.tornDown` is read at
    // this instant: false => unexpected (mid-flood) death = the io-torture
    // anomaly; true => the death follows an intentional reap = orderly teardown.
    // Inert unless TMUXCC_DEATH_INSTRUMENT is set.
    sessionProxy.host.onExit((code, signal) => {
      recordHostDeath({
        path: "onExit",
        code,
        signal,
        sessionId,
        sessionName,
        socketName,
        tornDown: entry.tornDown,
      });
      onHostDeath();
    });

    // tc-crnt.14: a host ERROR (a pty read-socket fault routed out of node-pty
    // by tmux-host's `'error'` listener — see tmux-host.ts) is a session-fatal
    // event just like an exit: the -CC client's pty is unusable.  WITHOUT this
    // handler the TmuxHost's `_emitError` would find zero registered handlers
    // and re-emit the error as a process `uncaughtException` — which in the
    // tc-2x3.3 collapsed topology takes the WHOLE server-proxy (and every
    // session it serves) down.  That was the intermittent
    // "server-proxy process crashed (exit code signal)" (tc-crnt.14).  Routing
    // the host error through the SAME per-session teardown as onExit reaps only
    // THIS session; siblings and the broker survive (lazy respawn on next
    // claim, §6.2).  `onHostDeath` is idempotent (tornDown guard), so a host
    // error followed by the pty's exit event is handled exactly once.
    sessionProxy.host.onError((err) => {
      // tc-jlyi.17: the onError path is the (c)-product discriminator — a pty
      // read-socket fault IN THE PRODUCT under the flood (tc-crnt.14 class).
      recordHostDeath({
        path: "onError",
        error: err,
        sessionId,
        sessionName,
        socketName,
        tornDown: entry.tornDown,
      });
      onHostDeath();
    });

    return entry;
  }

  /**
   * Intentional teardown of an entry (reap): mirror the pre-collapse SIGTERM
   * graceful path in-process — stop the session-proxy (detach the `-CC` client,
   * up to 3 s then SIGKILL the tmux child), then close the per-session socket
   * server and unlink the socket file.
   */
  private _teardownEntry(entry: SessionProxyEntry): void {
    if (entry.tornDown) return;
    entry.tornDown = true;
    this._doSocketTeardown(entry);
  }

  /**
   * Shared deferred socket teardown: stop the session-proxy, close the server,
   * then unlink the socket file — BUT only if no currently-live or in-flight
   * entry owns that socket path (ownership guard, tc-2x3.4 DEFECT 1).
   *
   * # Ownership guard
   *
   * `stop()` can take up to ~3 s (detach `-CC`, then SIGKILL fallback).  During
   * that window the extension may call `ensureSessionProxy` again for the same
   * session, which calls `_createSessionProxy` → `removeSocket(path)` → binds a
   * NEW server on the same path.  Without the guard, the old entry's deferred
   * `.finally` would fire `removeSocket(path)` AFTER the fresh server has
   * already claimed it, unlinking the LIVE socket of the newly-reattached
   * session and making it unreachable to any new client connections.
   *
   * Guard mechanism: `_socketPathRefCount` tracks how many entries (live OR
   * in-flight) claim a given path.  `_createSessionProxy` increments the count
   * immediately (even before `start()` resolves), and `_releaseSocketPath`
   * decrements it at unlink time, performing the unlink only when the count
   * reaches 0 (no remaining claimants).
   *
   * This is the SINGLE place both the boundary path (onFatalError) and the reap
   * path (_teardownEntry) perform the deferred unlink, so the guard is applied
   * consistently to both.
   *
   * # tc-2x3.6 GAP 1: fd reclamation
   *
   * When a fresh entry has claimed the path (ref count > 1), the old server's
   * listening fd must be closed to reclaim the OS file descriptor.  The previous
   * approach (`server.unref()`) prevented the server from blocking process exit
   * but left the fd open until the process exited — an fd leak bounded under
   * normal use but unbounded under a GAP-2 persistent-trip busy-loop.
   *
   * The new approach: `_closeServerFdOnly(server)` closes the underlying libuv
   * Pipe handle WITHOUT triggering the post-close `fs.unlink` callback that
   * `server.close()` installs.  The socket FILE was already unlinked by the fresh
   * `_createSessionProxy`'s `removeSocket(path)` call, so there is nothing on
   * the filesystem to protect — the old fd is an orphaned inode with no directory
   * entry and can safely be closed by releasing the libuv handle directly.
   */
  private _doSocketTeardown(entry: SessionProxyEntry): void {
    // Fire-and-forget: stop() resolves when tmux exits (≤3 s, then SIGKILL).
    void entry.sessionProxy.stop().finally(() => {
      // Ownership guard (tc-2x3.4 DEFECT 1): check BEFORE calling server.close().
      //
      // Node.js net.Server.close() on a unix socket AUTOMATICALLY UNLINKS the
      // socket file path that was passed to server.listen() — regardless of
      // whether a fresh server has since bound to the same path.  If a fresh
      // entry has claimed this path (ref count > 1), calling close() would
      // clobber the live socket of the reattached session.
      //
      // When the path is still exclusively owned by THIS entry (ref count === 1),
      // call server.close() normally — it closes the server AND unlinks the path
      // as a side effect, which is exactly what we want.
      //
      // When a fresh entry has since claimed the path:
      //   - The old server's socket FILE was already unlinked by removeSocket()
      //     in the fresh _createSessionProxy.  The old fd is an orphaned inode
      //     with no directory entry — it cannot accept new connections.
      //   - We MUST close the fd (tc-2x3.6 GAP 1 fix): call _closeServerFdOnly()
      //     which closes the libuv handle directly WITHOUT triggering the fs.unlink
      //     that server.close() would run.  This reclaims the fd without clobbering
      //     the fresh server's socket file.
      //   - The ref-count claim for this entry is released.
      const refCount = this._socketPathRefCount.get(entry.socketPath) ?? 0;
      if (refCount <= 1) {
        // No fresh claimant — close normally (auto-unlinks the path).
        this._socketPathRefCount.delete(entry.socketPath);
        entry.server.close();
      } else {
        // A fresh entry owns the path — close the fd without unlinking.
        this._socketPathRefCount.set(entry.socketPath, refCount - 1);
        _closeServerFdOnly(entry.server, entry.socketPath);
      }
    });
  }

  /**
   * Decrement the socket-path reference count for `socketPath` without
   * performing any socket file operation.  Used only in the creation-failure
   * path (the catch block in `_createSessionProxy`) where the caller handles
   * the unlink explicitly via `removeSocket`.
   *
   * The teardown path uses the inline close-vs-unref logic in `_doSocketTeardown`
   * and the host.onExit handler directly, so this method is NOT called there.
   */
  private _releaseSocketPath(socketPath: string): void {
    const current = this._socketPathRefCount.get(socketPath) ?? 0;
    if (current <= 1) {
      this._socketPathRefCount.delete(socketPath);
    } else {
      this._socketPathRefCount.set(socketPath, current - 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for `createSessionProxySupervisor`.
 */
export interface SessionProxySupervisorOptions {
  /**
   * Optional topology-notification observer forwarded into each created
   * session-proxy's `onTopologyNotify` option.
   *
   * Intended uses:
   *   - Supervisor-level topology observability (e.g. aggregate metrics).
   *   - Fault injection in tests: throwing from this callback exercises the
   *     per-session error boundary and the circuit-breaker trip path end-to-end,
   *     without test seams in the supervisor's production logic.
   *
   * The callback receives the notification kind string (e.g. "window-add",
   * "layout-change") — same as `SessionProxyOptions.onTopologyNotify`.
   * Exceptions thrown here propagate into the pipeline's error boundary
   * (onFatalError), which is the correct fault-injection path for circuit-
   * breaker tests.
   */
  onTopologyNotify?: (kind: string) => void;

  /**
   * Optional backpressure metrics hook (tc-edf8) passed to each per-session
   * client transport. The broker supplies its `ServerProxyMetrics` so the
   * per-session data/control sockets — the firehose path that actually
   * backpressures (the `find /` wedge) — report drain-queue depth and
   * time-in-queue onto the server-proxy registry, aggregate across sessions.
   */
  socketTransportMetrics?: SocketTransportMetrics;
}

export function createSessionProxySupervisor(
  opts: SessionProxySupervisorOptions = {},
): SessionProxySupervisor {
  return new SessionProxySupervisorImpl(opts);
}
