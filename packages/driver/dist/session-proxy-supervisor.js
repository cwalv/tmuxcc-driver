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
 * IN-PROCESS via `createSessionProxy(...)`.  Stage 2 kept the per-session unix
 * socket (each session-proxy bound its own `net.createServer`); tc-4b6k.4 (D5,
 * below) then removed even that, folding every connection onto the ONE broker
 * socket — so the supervisor no longer touches sockets at all.
 *
 * Consequences of the collapse:
 *   - No `--socket-name`/`--session-name`/`--socket-path` argv, no spawn, no
 *     READY-handshake — the session-proxy is just an object we `await .start()`.
 *   - No die-with-parent (tc-2c5): there is no child process to be reparented;
 *     the session-proxy lives and dies with the server-proxy by construction.
 *   - `sessionProxyPid()` reports the server-proxy's own pid — the session-proxy
 *     IS this process now (tc-k6v `server-proxy.info`).
 *   - The old SIGTERM graceful path (detach `-CC`) is preserved as
 *     `_teardownEntry`: `sessionProxy.stop()` closes tmux stdin and waits for
 *     the `-CC` client to exit (≤3 s, then SIGKILL).
 *
 * # tc-4b6k.4 (D5): single-socket wire collapse — no per-session socket
 *
 * Before this bead each session-proxy owned its OWN `net.Server` on a per-session
 * unix socket, and the supervisor carried a whole layer of socket-lifecycle
 * machinery to guard the races that per-session socket rebinding across respawns
 * created (`_socketPathRefCount`, the `_closeServerFdOnly` rename-aside dance,
 * ABA guards on the socket path — the tc-2x3.4 / tc-2x3.6 GAP-1 generations).
 *
 * D5 deletes all of it: there is ONE well-known broker socket. The broker
 * accepts every connection, runs the single handshake, and — on a
 * `session.attach {sessionId}` — hands the transport to `sessionProxy.addClient`.
 * The supervisor no longer creates, binds, restricts, renames, refcounts, or
 * unlinks any socket. `ensureSessionProxy` returns the live `SessionProxy`
 * object; the broker owns the transport handoff. Session lifecycle no longer
 * implies socket lifecycle, so the GAP-1 class ceases to exist rather than being
 * guarded.
 *
 * The genuinely-deep parts of the supervisor survive unchanged: per-name
 * single-flight ensure, the GAP-2 circuit breaker, the registry ABA guard on
 * host death / boundary trip, and lazy respawn.
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
import { createSessionProxy } from "./runtime/session-proxy.js";
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
    sessionId;
    tripCount;
    windowMs;
    constructor(sessionId, tripCount, windowMs) {
        super(`Session "${sessionId}" quarantined after ${tripCount} boundary trips within ${windowMs}ms. ` +
            `The session pipeline is repeatedly crashing — a code bug is likely. ` +
            `Call clearQuarantine("${sessionId}") to allow reattach after the underlying bug is fixed.`);
        this.name = "SessionQuarantineError";
        this.sessionId = sessionId;
        this.tripCount = tripCount;
        this.windowMs = windowMs;
    }
}
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
class SessionProxySupervisorImpl {
    _opts;
    constructor(opts = {}) {
        this._opts = opts;
    }
    /**
     * Map from sessionId to running session-proxy entry (or in-progress creation
     * promise).  The value is the entry OR a Promise for the in-flight creation,
     * allowing per-name serialization.
     */
    _sessionProxies = new Map();
    _crashHandler = null;
    _aliveCountHandlers = [];
    // ---------------------------------------------------------------------------
    // tc-2x3.6 GAP 2: circuit breaker state
    // ---------------------------------------------------------------------------
    /**
     * Per-session boundary-trip timestamps (ms since epoch).  Only the most
     * recent `CIRCUIT_BREAKER_TRIP_THRESHOLD` entries are kept per session
     * (older entries are trimmed on each new trip).  A quarantined session is
     * removed from this map (it no longer needs trip tracking).
     */
    _boundaryTripLog = new Map();
    /**
     * Sessions that have been quarantined by the circuit breaker.  Once in this
     * set, `ensureSessionProxy` will immediately throw `SessionQuarantineError`.
     * Cleared by `clearQuarantine(sessionId)`.
     */
    _quarantinedSessions = new Set();
    onCrash(handler) {
        this._crashHandler = handler;
    }
    clearQuarantine(sessionId) {
        this._quarantinedSessions.delete(sessionId);
        this._boundaryTripLog.delete(sessionId);
    }
    quarantinedSessions() {
        return new Set(this._quarantinedSessions);
    }
    aliveCount() {
        // Every map entry — ready entry or in-flight creation promise — represents
        // a live (or imminently-live) session-proxy whose existence the idle policy
        // must respect.  reapSessionProxy() / the crash handler delete the entry
        // synchronously with the teardown/exit, so the size is the alive count.
        return this._sessionProxies.size;
    }
    onAliveCountChange(handler) {
        this._aliveCountHandlers.push(handler);
    }
    _fireAliveCount() {
        const count = this._sessionProxies.size;
        for (const h of this._aliveCountHandlers.slice()) {
            try {
                h(count);
            }
            catch {
                // Listener errors must not break the supervisor.
            }
        }
    }
    async ensureSessionProxy(sessionId, sessionName, socketName) {
        // tc-2x3.6 GAP 2: circuit-breaker quarantine check.
        // A quarantined session has tripped the boundary >= CIRCUIT_BREAKER_TRIP_THRESHOLD
        // times within CIRCUIT_BREAKER_WINDOW_MS.  Reject immediately — do NOT create
        // a fresh session-proxy, which would just re-trip and continue the busy-loop.
        if (this._quarantinedSessions.has(sessionId)) {
            throw new SessionQuarantineError(sessionId, CIRCUIT_BREAKER_TRIP_THRESHOLD, CIRCUIT_BREAKER_WINDOW_MS);
        }
        // Fast path: session-proxy already running
        const existing = this._sessionProxies.get(sessionId);
        if (existing !== undefined) {
            if (existing instanceof Promise) {
                // In-flight creation — wait for it
                const entry = await existing;
                return entry.sessionProxy;
            }
            return existing.sessionProxy;
        }
        // Slow path: create a new session-proxy in-process
        const createPromise = this._createSessionProxy(sessionId, sessionName, socketName);
        // Register the promise immediately so concurrent callers share it.
        // tc-eqgp: count an in-flight creation as a live session-proxy for
        // idle-exit purposes — a claim is in progress and the server-proxy must
        // stay up until that nascent terminal is wired.
        this._sessionProxies.set(sessionId, createPromise);
        this._fireAliveCount();
        let entry;
        try {
            entry = await createPromise;
        }
        catch (err) {
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
        return entry.sessionProxy;
    }
    sessionProxyPid(sessionId) {
        const entry = this._sessionProxies.get(sessionId);
        if (entry === undefined || entry instanceof Promise)
            return null;
        // tc-2x3.3: in-process — the session-proxy IS the server-proxy process.
        return process.pid;
    }
    hasSessionProxy(sessionId) {
        // tc-hfxb.18.4: ready entry OR in-flight creation promise — both register in
        // `_sessionProxies` (the in-flight promise is set synchronously by
        // `ensureSessionProxy` before its first await), so this is true for the
        // entire claim/create window.
        return this._sessionProxies.has(sessionId);
    }
    async sessionMetricsTexts() {
        // tc-44u4.4: gather every READY session-proxy's prom-client exposition.
        // In-flight creations (Promise entries) have no live registry yet — skip.
        const out = [];
        const ready = [];
        for (const [sessionId, entry] of this._sessionProxies) {
            if (entry instanceof Promise)
                continue;
            ready.push({ sessionId, promise: entry.sessionProxy.metrics.metrics() });
        }
        for (const r of ready) {
            out.push({ sessionId: r.sessionId, text: await r.promise });
        }
        return out;
    }
    reapSessionProxy(sessionId) {
        const entry = this._sessionProxies.get(sessionId);
        if (!entry)
            return;
        this._sessionProxies.delete(sessionId);
        this._fireAliveCount();
        if (entry instanceof Promise) {
            // In-flight creation — tear down after it resolves.  ensureSessionProxy's
            // registration is guarded on the promise still being the registered
            // value, so deleting it here means the resolved entry will not be
            // re-registered; we own its teardown.
            void entry.then((e) => this._teardownEntry(e)).catch(() => { });
        }
        else {
            this._teardownEntry(entry);
        }
    }
    reapAll() {
        for (const sessionId of [...this._sessionProxies.keys()]) {
            this.reapSessionProxy(sessionId);
        }
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    /**
     * Create and start a session-proxy IN-PROCESS (D5, tc-4b6k.4).
     *
     * No per-session socket: the broker owns the single well-known socket and
     * hands each attaching connection's transport to `sessionProxy.addClient`.
     * This method just creates the SessionProxy, starts it (spawns `tmux -CC
     * attach` via node-pty), and wires the host-exit teardown.
     *
     * Mirrors the pre-collapse readiness contract: the returned promise resolves
     * ONLY after `sessionProxy.start()` has resolved, so `session.claim` /
     * `session.attach` do not proceed until the pipeline is live and can serve a
     * snapshot (the old "READY\n" handshake guaranteed the same).
     */
    async _createSessionProxy(sessionId, sessionName, socketName) {
        // tc-2x3.4: per-session error boundary — late-binding entry reference.
        //
        // `entry` is declared below (after `server` is created), but `onFatalError`
        // closes over it.  We use a nullable reference patched after the entry is
        // built — same late-bind pattern as `pipelineRef`/`serverRef` in
        // runtime/session-proxy.ts — so the closure never sees a TDZ violation.
        // `onFatalError` only fires AFTER `sessionProxy.start()` resolves (the
        // pipeline is live only then), which is always after `entryRef` is patched.
        let entryRef = null;
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
        const onFatalError = (err) => {
            const entry = entryRef;
            if (entry === null) {
                // Entry not yet patched — this would mean the pipeline fired before
                // start() completed, which is structurally impossible. Defensive no-op.
                return;
            }
            // Guard double-trip: the pipeline stops itself before calling this hook,
            // but defensive against any re-entrant path.
            if (boundaryTripInFlight)
                return;
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
            process.stderr.write(`[session-proxy-supervisor] BOUNDARY TRIP: session "${sessionName}" (id: ${sessionId}) ` +
                `pipeline threw an unhandled exception — tearing down this session's PTY client + per-session ` +
                `socket; sibling sessions are unaffected (tc-2x3.4).\n` +
                `  Error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
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
            const shouldQuarantine = tripLog.length >= CIRCUIT_BREAKER_TRIP_THRESHOLD &&
                now - tripLog[0] <= CIRCUIT_BREAKER_WINDOW_MS;
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
                process.stderr.write(`[session-proxy-supervisor] CIRCUIT BREAKER OPEN: session "${sessionName}" ` +
                    `(id: ${sessionId}) has tripped the error boundary ` +
                    `${CIRCUIT_BREAKER_TRIP_THRESHOLD} times in ${CIRCUIT_BREAKER_WINDOW_MS}ms — ` +
                    `session QUARANTINED; ensureSessionProxy will reject until clearQuarantine() is called. ` +
                    `Fix the underlying parser/reducer bug before re-enabling this session (tc-2x3.6).\n`);
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
            // SIGKILL the tmux child). D5: no per-session socket to close.
            this._teardownEntry(entry);
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
        // Pre-build the entry so the host-exit handler (wired below, after start)
        // can reference its `tornDown` flag and identity.
        const entry = {
            sessionId,
            sessionProxy,
            tornDown: false,
        };
        // tc-2x3.4: patch the late-binding boundary reference so `onFatalError`
        // can find the entry if the pipeline throws.
        entryRef = entry;
        try {
            // Start the session-proxy (spawns tmux -CC attach via node-pty).
            await sessionProxy.start();
        }
        catch (err) {
            // Creation failed before readiness — kill the half-built session-proxy so
            // we leave no running tmux behind, then rethrow so ensureSessionProxy
            // removes the registry slot and the claim fails. D5: no socket to unlink.
            try {
                sessionProxy.kill();
            }
            catch { /* not started */ }
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
        // The SessionProxy's own host.onExit (createSessionProxy's start()) runs
        // synchronously before this handler in registration order and drives
        // broadcastErrorAndClose (session.unavailable), which closes every attached
        // client's transport (now a broker-socket connection). D5: there is no
        // per-session socket for the supervisor to close — we only reap the registry
        // entry and fire the crash handler.
        const onHostDeath = () => {
            if (entry.tornDown)
                return; // intentional reap already owns teardown
            entry.tornDown = true;
            // Reap the registry entry + fire the crash handler, but only if THIS
            // entry is still the registered one (ABA guard: a reap + fresh
            // ensureSessionProxy under the same sessionId must not have its healthy
            // replacement reaped by this late exit).
            const current = this._sessionProxies.get(sessionId);
            if (current === entry) {
                this._sessionProxies.delete(sessionId);
                this._fireAliveCount();
                this._crashHandler?.(sessionId, { sessionName });
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
     * up to 3 s then SIGKILL the tmux child).
     *
     * D5 (tc-4b6k.4): there is no per-session socket, so teardown is just
     * `sessionProxy.stop()`. Any client connections attached to this session are
     * broker-socket connections; the SessionProxy's own host.onExit /
     * broadcastErrorAndClose closes them. Fire-and-forget — `stop()` resolves when
     * tmux exits (≤3 s, then SIGKILL).
     */
    _teardownEntry(entry) {
        if (entry.tornDown)
            return;
        entry.tornDown = true;
        void entry.sessionProxy.stop();
    }
}
export function createSessionProxySupervisor(opts = {}) {
    return new SessionProxySupervisorImpl(opts);
}
//# sourceMappingURL=session-proxy-supervisor.js.map