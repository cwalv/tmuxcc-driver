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
 * @module session-proxy-supervisor
 */

import * as net from "node:net";
import { createSessionProxy } from "@tmuxcc/session-proxy";
import type { SessionProxy } from "@tmuxcc/session-proxy";
import { createSocketTransport } from "./socket-transport.js";
import { removeSocket, restrictSocket } from "./runtime-dir.js";

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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SessionProxySupervisorImpl implements SessionProxySupervisor {
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

  onCrash(handler: SessionProxyCrashHandler): void {
    this._crashHandler = handler;
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
    });

    // Create the per-session unix socket server.
    const server = net.createServer((socket) => {
      const transport = createSocketTransport(socket);
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
    sessionProxy.host.onExit(() => {
      if (entry.tornDown) return; // intentional reap already owns teardown
      entry.tornDown = true;

      // Give connected clients a moment to receive session.unavailable (the
      // SessionProxy's host.onExit broadcastErrorAndClose runs synchronously
      // before our handler in registration order, but the close-and-unlink
      // matches the pre-collapse 500ms grace from session-proxy-entry.ts).
      // Ownership guard (tc-2x3.4 DEFECT 1): same close-vs-unref logic as
      // _doSocketTeardown — see that method's comment for the full explanation.
      // ensureSessionProxy may have rebound the path during the 500ms grace window.
      setTimeout(() => {
        const refCount = this._socketPathRefCount.get(sessionProxySockPath) ?? 0;
        if (refCount <= 1) {
          this._socketPathRefCount.delete(sessionProxySockPath);
          server.close();
        } else {
          this._socketPathRefCount.set(sessionProxySockPath, refCount - 1);
          server.unref();
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
      // When a fresh entry has since claimed the path, call server.unref()
      // instead: this prevents the old server from blocking process exit but
      // does NOT unlink the socket file.  The old server's listening fd is
      // orphaned (the socket path was already unlinked when the fresh
      // _createSessionProxy called removeSocket), so it cannot accept new
      // connections regardless.  The ref-count claim for this entry is
      // released without triggering a file unlink.
      const refCount = this._socketPathRefCount.get(entry.socketPath) ?? 0;
      if (refCount <= 1) {
        // No fresh claimant — close normally (auto-unlinks the path).
        this._socketPathRefCount.delete(entry.socketPath);
        entry.server.close();
      } else {
        // A fresh entry owns the path — abandon the old server without unlinking.
        this._socketPathRefCount.set(entry.socketPath, refCount - 1);
        entry.server.unref();
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

export function createSessionProxySupervisor(): SessionProxySupervisor {
  return new SessionProxySupervisorImpl();
}
