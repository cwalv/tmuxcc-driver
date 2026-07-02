/**
 * Control-plane server — per-client handshake + snapshot + delta stream (tc-dv3).
 *
 * # Responsibility
 *
 * `createControlServer` manages a set of connected clients over the CONTROL plane
 * (structured `ControlMessage` values). For each client it:
 *
 *   1. Runs the session-proxy side of the capability handshake (`runSessionProxyHandshake`).
 *   2. Sends a full snapshot of the current model (`projectSnapshot`) as the
 *      client's first message after the handshake.
 *   3. Subscribes to `RuntimePipeline.onModelChange` and forwards each set of
 *      deltas (`diffModel` output) to the client with a per-connection seq stamp.
 *   4. Cleans up (unsubscribes, removes from active-client set) when the client's
 *      transport closes.
 *
 * # Per-connection sequence counter
 *
 * Every `ControlMessage` carries a `seq` field (MessageBase). For session-proxy-push
 * messages the seq is the DAEMON's per-connection counter, starting at 1 and
 * incrementing by 1 for each message sent to that client.
 *
 *   - The initial snapshot is seq = 1.
 *   - The first batch of deltas after the snapshot starts at seq = 2, each
 *     delta in the batch getting the next value (2, 3, 4, …).
 *   - Seq is PER-CONNECTION: two clients sharing the same server have
 *     independent counters. A client that connects later gets snapshot seq = 1
 *     and deltas 2, 3, … from its own origin.
 *
 * `diffModel` returns deltas with placeholder `seq: 0`. The serve layer stamps
 * real seq values before calling `transport.sendControl`.
 *
 * # Connection lifecycle seam (data-plane / tc-fbz integration)
 *
 * The serve layer owns the CONTROL plane for each client connection.  The data
 * plane (pane byte streams — tc-fbz demux) shares the same per-client Transport
 * but is SEPARATE: tc-fbz calls `transport.sendData(paneId, bytes)` directly and
 * does not go through this server.
 *
 * To wire BOTH planes after accepting a client connection, the caller (tc-93a
 * integration) MUST:
 *
 *   1. Call `server.addClient(sessionProxySideTransport)` — returns a Promise that
 *      resolves with `NegotiatedSession` once the handshake + initial snapshot
 *      are done.  At this point the control stream is live.
 *   2. Use the resolved `NegotiatedSession` (features, protocolVersion) to
 *      configure the data-plane pump (tc-fbz): attach the pane-output demux to
 *      the same transport via `transport.sendData(paneId, bytes)`.
 *
 * The transport close is handled by this server automatically: when the remote
 * closes the connection, the server unsubscribes the control-plane feed.  The
 * data-plane pump (tc-fbz) should use its own `transport.onClose` handler or
 * share the same one (calling `removeClient` is idempotent).
 *
 * # Inbound messages (client → sessionProxy)
 *
 * The control plane is bidirectional.  Most client→session-proxy messages (`command.request`,
 * `input`, `resize.request`) are routed by tc-93a / tc-kvk.  The one exception
 * handled HERE is `resync.request` (tc-7ml.4), because only the serve layer holds
 * the per-connection seq counter and can re-send the snapshot correctly.
 *
 * When `resync.request` arrives this module:
 *   1. Sends `projectSnapshot(pipeline.getModel(), { seq: state.nextSeq })`.
 *   2. Increments `state.nextSeq` — seq monotonically continues (no reset).
 *   3. Subsequent model-change deltas pick up from the next seq value.
 *
 * @module runtime/serve
 */
import { runSessionProxyHandshake, } from "@tmuxcc/protocol";
import { WIRE_PROTOCOL_VERSION, describeClientIdentity } from "@tmuxcc/protocol";
import { projectSnapshot } from "../state/projection.js";
import { diffModel } from "../state/projection.js";
import { connectionId as mintConnectionId } from "@tmuxcc/protocol";
import { phaseLog, phaseNow, PHASE_TIMING_ENABLED } from "./phase-timing.js";
// ---------------------------------------------------------------------------
// Default capabilities
// ---------------------------------------------------------------------------
const DEFAULT_CAPABILITIES = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    // tc-76m8.2: "client-read-only" advertises that this driver enforces
    // ClientFlags.readOnly (silent input swallow + loud verb rejection).
    // Extension checks for this feature before offering "Attach read-only" (D9 pattern).
    features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding", "client-read-only"],
};
/**
 * Window inside which a second `resync.request` from the same client is
 * classified as `escalation` rather than `gap` (tc-3si.5).
 *
 * The wire client's documented state machine is: detect a seq gap →
 * send resync.request → wait for snapshot → if a gap persists AFTER the
 * snapshot delivers, close the transport. A second resync.request before
 * `close()` would only happen if the client's gap-detection loop is
 * broken (resync.request without waiting for snapshot completion) or if
 * the snapshot itself was structurally invalid (didn't carry the seq
 * baseline forward).
 *
 * 30 s is intentionally generous: a snapshot RTT plus a settling pause
 * is well under 1 s in practice, so an escalation arriving within 30 s
 * is unambiguously "the previous resync didn't fix anything". We'd
 * rather catch a slow regression than miss a fast one.
 */
const RESYNC_ESCALATION_WINDOW_MS = 30_000;
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
class ControlServerImpl {
    _pipeline;
    _capabilities;
    _metrics;
    /** tc-ozk.2: origin attribution lookup passed to per-client diffModel. */
    _originLookup;
    /** tc-u7cu.6: close-cause lookup passed to per-client diffModel. */
    _closeCauseLookup;
    /** tc-is5w: session name for the dev-gated first-snapshot timing line. */
    _sessionName;
    /**
     * Active clients keyed by transport reference. Using the Transport object as
     * the Map key ensures O(1) lookup for addClient/removeClient without needing
     * to assign client ids.
     */
    _clients = new Map();
    /**
     * tc-3si.6: per-connection slot labels for the
     * `deltas_fanned_out_total{client}` counter. Labels are a SLOT pool, not
     * stable client identities: removeClient releases the label back to the
     * free list and the next addClient reuses it, so label cardinality is
     * bounded by the MAX CONCURRENT client count — a monotonic mint would grow
     * the label set forever under reconnect churn (one new label per VS Code
     * window reload, for the lifetime of the session-proxy).
     */
    _freeClientLabels = [];
    _nextClientLabelSeq = 1;
    _mintClientLabel() {
        return this._freeClientLabels.pop() ?? `c${this._nextClientLabelSeq++}`;
    }
    /**
     * tc-ozk.2: per-connection connectionId slot pool. Like the metrics label
     * pool, connectionIds are slot-pooled (released on disconnect, reused on the
     * next connect) so their cardinality is bounded by the max concurrent client
     * count rather than growing forever under reconnect churn. NOT a stable
     * client identity across reconnects — only a stable name for the duration of
     * ONE connection, which is exactly what verb-origin attribution needs.
     */
    _freeConnectionIds = [];
    _nextConnectionSeq = 1;
    _mintConnectionId() {
        return this._freeConnectionIds.pop() ?? mintConnectionId(`conn${this._nextConnectionSeq++}`);
    }
    constructor(pipeline, opts = {}) {
        this._pipeline = pipeline;
        this._capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
        this._metrics = opts.metrics;
        this._originLookup = opts.originLookup;
        this._closeCauseLookup = opts.closeCauseLookup;
        this._sessionName = opts.sessionName;
    }
    async addClient(transport, opts = {}) {
        // tc-is5w: phase-split activation timing — the first-snapshot leg. t0 at
        // addClient entry; the span covers the capability handshake + microtask
        // yield + first snapshot send. This leg fires on the CLIENT-connect event
        // (decoupled from the broker claim), so it is its own `[tc-is5w]
        // phase=snapshot` line keyed by session, not folded into the claim line.
        const _phaseSnapT0 = phaseNow();
        // Run the session-proxy-side capability handshake. This will:
        //   • Send session-proxy.capabilities (seq=1, handled internally by runSessionProxyHandshake)
        //   • Wait for the client to send client.capabilities
        //   • Negotiate the session (version check + feature intersection)
        //
        // D5 (tc-4b6k.4): when the broker hands off an already-handshaken connection
        // (opts.preNegotiated present), SKIP this handshake — the single
        // `server-proxy.capabilities` handshake already negotiated version + identity
        // for this connection; a second handshake here is the S1 ceremony this bead
        // deletes.
        //
        // IMPORTANT (standalone path): runSessionProxyHandshake resets
        // transport.onControl to a no-op when it settles (via its internal settle()
        // function).  The client side (SessionProxyConnection.connect /
        // runClientHandshake) installs its own post-handshake onControl handler
        // SYNCHRONOUSLY after runClientHandshake resolves — before yielding to the
        // event loop.  We must therefore defer the snapshot send by at least one
        // microtask after the handshake resolves, so the client's onControl
        // installation has a chance to run.
        //
        // Timing contract (both sides):
        //   SessionProxy: await handshake → install delta subscription + onClose
        //           → await one microtask (Promise.resolve())
        //           → send snapshot
        //   Client: await handshake → install onControl synchronously (no await)
        //           → now safe to receive snapshot
        //
        // With a synchronous (in-memory) transport the microtask yield is enough.
        // With an async (socket) transport the delivery itself is deferred, so by
        // the time the snapshot bytes arrive the client's onControl is already set.
        let session;
        if (opts.preNegotiated !== undefined) {
            session = opts.preNegotiated;
        }
        else {
            try {
                session = await runSessionProxyHandshake(transport, this._capabilities);
            }
            catch (err) {
                // Handshake failed — transport may already be closed; close defensively.
                try {
                    transport.close();
                }
                catch { /* ignore */ }
                throw err;
            }
        }
        // Allocate per-connection state. seq starts at `startSeq` (default 1) — the
        // snapshot uses it. In the broker-handoff path this continues the same
        // per-connection counter the handshake + pre-attach broker messages advanced.
        const state = {
            transport,
            nextSeq: opts.startSeq ?? 1,
            connectionId: this._mintConnectionId(),
            unsubModelChange: null,
            metricsClientLabel: this._mintClientLabel(),
            // D2 (tc-4b6k.1): capture the durable identity the client advertised on
            // client.capabilities (undefined if none). Surfaced in session-proxy.info.
            identity: session.clientIdentity,
            lastResyncAtMs: null,
            // D4 (tc-4b6k.3): capture the tmux-parity flags from session.attach.
            // Behavioral enforcement lives in session-proxy.ts; stored here for info.
            flags: opts.flags,
        };
        this._clients.set(transport, state);
        // D2 (tc-4b6k.1): log the connecting client's durable identity. No behavior
        // depends on it yet — this is the "carried and logged only" surface, and
        // the connected-identity list is also exposed via session-proxy.info.
        process.stderr.write(`session-proxy: client connected (${state.connectionId}) identity=` +
            `${describeClientIdentity(session.clientIdentity)}\n`);
        // tc-4b6k.2 (D3): reconstruct THIS client's durable per-pane binding intent
        // from tmux and patch it into the model BEFORE we subscribe this client to
        // deltas and BEFORE its snapshot is projected. Binding is per-client and the
        // bulk requery doesn't read it, so without this a reconnecting client (VS
        // Code reload — same workspace-derived identity) would briefly see bound=false
        // for a pane it durably bound. Done before onModelChange subscription so the
        // patch's broadcast doesn't emit a pre-snapshot delta to this client (its
        // handler isn't installed yet); other clients' resolved bound is unchanged by
        // a foreign client's slot, so they see nothing. Best-effort (a %error leaves
        // the model as-is); we don't fail the connection on it.
        try {
            await this._pipeline.applyClientBinding(session.clientIdentity?.id);
        }
        catch {
            // Reconstruction is best-effort; a live delta / next connect re-establishes.
        }
        // Guard: the client may have disconnected during the read round-trip.
        if (!this._clients.has(transport))
            return session;
        // Subscribe to model changes BEFORE sending the snapshot so that any model
        // changes that fire during the microtask gap below are not silently dropped.
        // Deltas queued before the snapshot is sent would have seq >= 2 (correct) and
        // would arrive AFTER the snapshot (also correct, since sendControl is ordered).
        const unsub = this._pipeline.onModelChange((newModel, prevModel) => {
            // Guard: client may have been removed before this fires.
            if (!this._clients.has(transport))
                return;
            // tc-ozk.2: pass the origin lookup so verb-caused creations this client
            // sees carry their origin (incl. another client's verb — the multi-client
            // case: client B sees origin.connectionId=A and treats it as not-its-own).
            // tc-u7cu.6: pass the close-cause lookup so verb-caused closes carry cause.
            // tc-4b6k.2 (D3): resolve per-client binding intent for THIS client's
            // identity — the pane.opened/pane.policy-changed `bound` reflects this
            // client's own view, so two clients see independent bound state.
            const deltas = diffModel(prevModel, newModel, {
                originLookup: this._originLookup,
                closeCauseLookup: this._closeCauseLookup,
                clientId: state.identity?.id,
            });
            for (const delta of deltas) {
                // Stamp seq on a new object (SessionProxyMessage fields are readonly; spread).
                const stamped = { ...delta, seq: state.nextSeq };
                state.nextSeq++;
                // tc-jlyi.7: per-connection delta egress — the seq the BROKER sent on
                // this connection. Paired with the EDH mirror's per-delta seq trace
                // (clients/ts/mirror.ts), a control delta the broker emits (seq=N) that
                // the mirror never applies (last applied < N) reveals the tc-295a.31
                // tail-drop that a gap check can't (nothing follows to expose it). The
                // PHASE_TIMING_ENABLED guard keeps this hot fan-out byte-identical when
                // the flag is unset (no per-delta field allocation / write).
                if (PHASE_TIMING_ENABLED) {
                    phaseLog({
                        inst: "tc-jlyi.7",
                        hop: "delta-emit",
                        conn: state.connectionId,
                        seq: stamped.seq,
                        type: delta.type,
                        paneId: delta.paneId,
                        windowId: delta.windowId,
                    });
                }
                transport.sendControl(stamped);
                // tc-3si.6: count the fan-out. The denominator
                // (deltas_emitted_total) is incremented once per pipeline cycle in
                // pipeline.ts; the per-client `cN` label keeps this counter
                // tractable while still letting the fan-out amplification ratio
                // be checked against the attached-client count.
                this._metrics?.incDeltasFannedOut(state.metricsClientLabel);
            }
        });
        state.unsubModelChange = unsub;
        // Auto-cleanup when the transport closes (remote disconnects).
        transport.onClose(() => {
            this._cleanupClient(transport);
        });
        // Inbound control handler: handle resync.request from the client.
        // This is the only client→session-proxy message the serve layer processes; all
        // other inbound messages (command.request, input, resize.request) are
        // routed by the integration layer (tc-93a / tc-kvk).
        //
        // NOTE: transport.onControl is single-slot (replace semantics). Installing
        // it here means the integration layer MUST NOT also install onControl on
        // the same transport after addClient returns — or it must proxy resync.request
        // to this server. For now the integration code is in-process and aware of
        // this constraint.
        transport.onControl((msg) => {
            if (msg.type === "resync.request") {
                this.handleResyncRequest(transport);
            }
            // All other inbound messages: silently pass through (handled by tc-93a).
        });
        // Defer the snapshot by one microtask so the client's post-handshake
        // onControl handler (installed synchronously in SessionProxyConnection.connect()
        // after runClientHandshake resolves) is registered before the snapshot
        // arrives.  See timing contract in the comment above.
        await Promise.resolve();
        // Send the initial snapshot at seq = startSeq (default 1; the broker's
        // continued counter in the handoff path).
        // Guard: the client may have been removed during the microtask gap (e.g.
        // transport closed between handshake settle and here).
        if (this._clients.has(transport)) {
            // tc-1elae: include the client count at snapshot time so the VS Code
            // status bar can render "Attached clients: K" (§11.4). The count is
            // captured HERE (after the microtask yield, just before sending) so it
            // reflects the state at the moment this client receives its snapshot.
            // Note: this client has already been added to _clients above, so the
            // count includes the current connection.
            const snapshot = projectSnapshot(this._pipeline.getModel(), {
                seq: state.nextSeq,
                attachedClientCount: this._clients.size,
                // tc-ozk.2: tell this client its own connectionId.
                connectionId: state.connectionId,
                // tc-4b6k.2 (D3): resolve pane.bound for this client's identity.
                clientId: state.identity?.id,
            });
            state.nextSeq++;
            transport.sendControl(snapshot);
            // tc-44wu0: notify OTHER clients that the connected-client count has
            // changed. The newly-connected client already received the current count
            // via the snapshot's `attachedClientCount` field, so re-sending it would
            // be redundant — and would shift its delta seq from the expected lastSeq+1.
            this.broadcastClientCountTo({ exclude: transport });
            // tc-is5w: first-snapshot leg complete (handshake → snapshot sent). Inert
            // unless TMUXCC_PHASE_TIMING is set.
            phaseLog({
                phase: "snapshot",
                session: this._sessionName,
                snapshot_ms: phaseNow() - _phaseSnapT0,
            });
        }
        return session;
    }
    removeClient(transport) {
        this._cleanupClient(transport);
    }
    clientCount() {
        return this._clients.size;
    }
    connectionIdFor(transport) {
        return this._clients.get(transport)?.connectionId;
    }
    clientIdentityFor(transport) {
        return this._clients.get(transport)?.identity;
    }
    connectedClientIdentities() {
        const out = [];
        for (const state of this._clients.values()) {
            const entry = {};
            if (state.identity !== undefined)
                entry.identity = state.identity;
            if (state.flags !== undefined)
                entry.flags = state.flags;
            out.push(entry);
        }
        return out;
    }
    broadcastError(error) {
        for (const [transport, state] of this._clients) {
            const stamped = { ...error, seq: state.nextSeq };
            state.nextSeq++;
            try {
                transport.sendControl(stamped);
            }
            catch {
                // Transport may already be closed — clean it up and continue.
                this._cleanupClient(transport);
            }
        }
    }
    broadcastErrorAndClose(error) {
        // Snapshot the client list before iterating — closing triggers onClose
        // which calls _cleanupClient, mutating _clients.  Iterate the snapshot.
        const clients = [...this._clients];
        for (const [transport, state] of clients) {
            const stamped = { ...error, seq: state.nextSeq };
            state.nextSeq++;
            try {
                transport.sendControl(stamped);
            }
            catch {
                // Transport already closed — fall through to close() below.
            }
            try {
                transport.close();
            }
            catch {
                // Ignore: already closed.
            }
        }
    }
    broadcastClientCount() {
        this.broadcastClientCountTo({});
    }
    /**
     * Internal: broadcast client-count.changed to all clients except (optionally)
     * one excluded transport. Used by `addClient` to skip the newly-connected
     * client (which already received the count via the snapshot).
     */
    broadcastClientCountTo(opts) {
        const count = this._clients.size;
        const base = {
            type: "client-count.changed",
            count,
        };
        for (const [transport, state] of this._clients) {
            if (transport === opts.exclude)
                continue;
            const stamped = { ...base, seq: state.nextSeq };
            state.nextSeq++;
            try {
                transport.sendControl(stamped);
            }
            catch {
                // Transport may already be closed — clean it up and continue.
                this._cleanupClient(transport);
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------
    /**
     * Handle a resync.request from a client.
     *
     * Re-sends the full snapshot at the next per-connection seq without resetting
     * the counter.  Subsequent deltas continue from there.  Only this one client
     * is affected; the pipeline and other clients are untouched.
     */
    handleResyncRequest(transport) {
        const state = this._clients.get(transport);
        if (!state)
            return; // client may have been removed already (race with close)
        // tc-3si.5: classify this resync as either `gap` (fresh) or
        // `escalation` (a second request from the same client inside the
        // escalation window — the previous snapshot did NOT heal the gap).
        // Escalation is an expected-zero tripwire; loud-log it alongside the
        // counter bump so the bug class lands even when no metric reader is
        // attached.
        const nowMs = Date.now();
        const prevResyncAtMs = state.lastResyncAtMs;
        let cause = "gap";
        if (prevResyncAtMs !== null &&
            nowMs - prevResyncAtMs < RESYNC_ESCALATION_WINDOW_MS) {
            cause = "escalation";
        }
        state.lastResyncAtMs = nowMs;
        if (this._metrics !== undefined) {
            this._metrics.incResync(cause);
        }
        if (cause === "escalation" && prevResyncAtMs !== null) {
            process.stderr.write(`[serve] RESYNC ESCALATION: a second resync.request from client ${state.metricsClientLabel} ` +
                `landed ${nowMs - prevResyncAtMs}ms after the previous one (within the ` +
                `${RESYNC_ESCALATION_WINDOW_MS}ms escalation window). The previous snapshot did not heal the gap — ` +
                `the wire's sequence invariant is broken or the client's gap detector is misfiring (tc-3si.5).\n`);
        }
        // tc-1elae: include the current client count in the re-sent snapshot so
        // that the status bar tooltip stays accurate after a resync.
        const snapshot = projectSnapshot(this._pipeline.getModel(), {
            seq: state.nextSeq,
            attachedClientCount: this._clients.size,
            // tc-ozk.2: re-send the connectionId so a reconnecting client re-learns it.
            connectionId: state.connectionId,
            // tc-4b6k.2 (D3): resolve pane.bound for this client's identity.
            clientId: state.identity?.id,
        });
        state.nextSeq++;
        transport.sendControl(snapshot);
    }
    sendCommandResponse(transport, correlationId, payload) {
        const state = this._clients.get(transport);
        if (!state)
            return; // not in active client set
        const msg = {
            type: "command.response",
            seq: state.nextSeq,
            correlationId,
            result: { ok: true, payload },
        };
        state.nextSeq++;
        try {
            transport.sendControl(msg);
        }
        catch {
            // Transport may have closed concurrently — clean up.
            this._cleanupClient(transport);
        }
    }
    sendCommandError(transport, correlationId, code, message) {
        const state = this._clients.get(transport);
        if (!state)
            return; // not in active client set
        const msg = {
            type: "command.response",
            seq: state.nextSeq,
            correlationId,
            result: { ok: false, code, message },
        };
        state.nextSeq++;
        try {
            transport.sendControl(msg);
        }
        catch {
            // Transport may have closed concurrently — clean up.
            this._cleanupClient(transport);
        }
    }
    sendDirected(transport, msg) {
        const state = this._clients.get(transport);
        if (!state)
            return; // not in active client set
        const stamped = { ...msg, seq: state.nextSeq };
        state.nextSeq++;
        try {
            transport.sendControl(stamped);
        }
        catch {
            // Transport may have closed concurrently — clean up.
            this._cleanupClient(transport);
        }
    }
    _cleanupClient(transport) {
        const state = this._clients.get(transport);
        if (!state)
            return; // already removed or never added
        state.unsubModelChange?.();
        state.unsubModelChange = null;
        this._clients.delete(transport);
        this._freeClientLabels.push(state.metricsClientLabel);
        // tc-ozk.2: return the connectionId to the slot pool for reuse.
        this._freeConnectionIds.push(state.connectionId);
        // tc-44wu0: notify remaining clients that the count has decreased.
        // Only broadcast if there are still clients to notify (no-op if the
        // last client just disconnected).
        if (this._clients.size > 0) {
            this.broadcastClientCount();
        }
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create a control-plane server that manages connected clients over a
 * `RuntimePipeline`.
 *
 * ```ts
 * const pipeline = createRuntimePipeline(host, { buffers });
 * await pipeline.start();
 *
 * const server = createControlServer(pipeline);
 *
 * // For each new client connection (e.g. from the IPC accept loop):
 * const { sessionProxy: sessionProxyTransport } = createInMemoryTransportPair();
 * const session = await server.addClient(sessionProxyTransport);
 * // session.features describes the negotiated feature set.
 * // The data-plane pump (tc-fbz) should now attach to sessionProxyTransport.sendData.
 * ```
 *
 * @param pipeline - The live runtime pipeline (already started).
 * @param opts     - Optional server options (e.g. custom capabilities).
 * @returns A `ControlServer` that accepts client transports and manages their
 *          control-plane streams.
 */
export function createControlServer(pipeline, opts) {
    return new ControlServerImpl(pipeline, opts);
}
//# sourceMappingURL=serve.js.map