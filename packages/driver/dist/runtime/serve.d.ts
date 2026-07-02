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
import type { RuntimePipeline } from "./pipeline.js";
import type { Transport } from "@tmuxcc/protocol";
import { type NegotiatedSession } from "@tmuxcc/protocol";
import type { Capabilities, ClientIdentity, ClientFlags } from "@tmuxcc/protocol";
import type { SessionProxyMessage, ErrorMessage } from "@tmuxcc/protocol";
import type { OriginLookup, CloseCauseLookup } from "../state/projection.js";
import type { ConnectionId } from "@tmuxcc/protocol";
import type { SessionProxyRegistry } from "../metrics/registry.js";
/**
 * Broker-handoff options for {@link ControlServer.addClient} (D5, tc-4b6k.4).
 *
 * In the single-socket topology the broker accepts the connection, runs the ONE
 * `server-proxy.capabilities` handshake, then hands the transport here after a
 * `session.attach`. These options let `addClient` adopt that handshake and
 * continue the connection's seq counter monotonically across the handoff.
 *
 * Both fields absent ⇒ the standalone path (in-memory test pairs, driver-admin
 * one-shots): run the session-proxy handshake and start the seq counter at 1.
 */
export interface AddClientOptions {
    /**
     * First per-connection seq to use — the snapshot's seq. Deltas continue from
     * `startSeq + 1`. Defaults to 1. The broker passes the connection's live
     * `nextSeq` so the session-proxy stream continues the same monotonic counter
     * the handshake + any pre-attach broker messages already advanced.
     */
    startSeq?: number;
    /**
     * Session already negotiated by the broker's `server-proxy.capabilities`
     * handshake for this connection. When present, `addClient` SKIPS
     * `runSessionProxyHandshake` — the single broker handshake already negotiated
     * version + identity, so a second handshake would be redundant ceremony (the
     * S1 smell this bead deletes).
     */
    preNegotiated?: NegotiatedSession;
    /**
     * D4 (tc-4b6k.3): tmux-parity client flags carried on `session.attach`.
     * Stored on `ClientState` and surfaced via `session-proxy.info`. Behavioral
     * enforcement (ignoreSize gate, readOnly gate) lives in session-proxy.ts; this
     * layer stores and exposes the value.
     */
    flags?: ClientFlags;
}
/**
 * Options for `createControlServer`.
 */
export interface ControlServerOptions {
    /**
     * Capabilities the session-proxy advertises during the handshake.
     *
     * Defaults to a capabilities set advertising
     * `WIRE_PROTOCOL_VERSION` and all known wire features.
     */
    capabilities?: Capabilities;
    /**
     * Optional metrics registry for the per-client fan-out counter
     * (tc-3si.6). When provided, every delta sent to a connected client
     * increments `deltas_fanned_out_total{client="cN"}` where `N` is the
     * client's connection slot (1-based, mirroring the order clients
     * connect). The denominator for the fan-out amplification ratio
     * `deltas_fanned_out_total / deltas_emitted_total` (the pipeline owns
     * the denominator side). Per-client `cN` labels are bounded by the
     * attached-client count.
     */
    metrics?: SessionProxyRegistry;
    /**
     * Origin attribution lookup (tc-ozk.2). When provided, the per-client delta
     * stream passes it to `diffModel`, so every `pane.opened` / `window.added`
     * for a verb-caused creation is stamped with its `origin`. Omit to leave all
     * creations untagged (the default — tests / callers without verb-correlation
     * state). The session-proxy factory wires this to the shared
     * VerbOriginRegistry's `lookup`.
     */
    originLookup?: OriginLookup;
    /**
     * Close-cause lookup (tc-u7cu.6). When provided, the delta stream passes it
     * to `diffModel`, so every `pane.closed` for a verb-caused close is stamped
     * with its `cause`. Omit to leave all close deltas untagged (the default —
     * tests / callers without close-verb-correlation state). The session-proxy
     * factory wires this to the shared CloseCauseRegistry's `consume`.
     */
    closeCauseLookup?: CloseCauseLookup;
    /**
     * tc-is5w: session name, used only to tag the dev-gated `[tc-is5w]
     * phase=snapshot` activation-timing line (the first-snapshot leg). Inert
     * unless TMUXCC_PHASE_TIMING is set; omit in callers that don't care.
     */
    sessionName?: string;
}
/**
 * The control-plane server returned by `createControlServer`.
 *
 * Usage:
 *
 * ```ts
 * const server = createControlServer(pipeline);
 *
 * // When a new client transport arrives (e.g. from the IPC listener):
 * const session = await server.addClient(sessionProxySideTransport);
 * // Control stream is live. Now wire the data-plane:
 * attachOutputDemux(sessionProxySideTransport, pipeline.buffers, session);
 *
 * // To inspect connection count:
 * console.log(server.clientCount());
 *
 * // To forcibly disconnect a client (e.g. during shutdown):
 * server.removeClient(sessionProxySideTransport);
 * ```
 */
export interface ControlServer {
    /**
     * Accept a new client connection over the given session-proxy-side `Transport`.
     *
     * Steps performed:
     *   1. Run `runSessionProxyHandshake(transport, sessionProxyCapabilities)` —
     *      UNLESS `opts.preNegotiated` is supplied (D5, tc-4b6k.4: the broker
     *      already ran the single `server-proxy.capabilities` handshake for this
     *      connection), in which case the handshake is skipped and the supplied
     *      session is adopted.
     *   2. Subscribe to `pipeline.onModelChange` to forward subsequent deltas
     *      (with per-connection seq stamping, starting at `startSeq + 1`).
     *   3. Register an `onClose` handler so cleanup happens automatic.
     *   4. Yield one microtask (`await Promise.resolve()`) so the client's
     *      post-handshake `onControl` handler is installed before the snapshot
     *      arrives (see timing contract in serve.ts addClient implementation).
     *   5. Send `projectSnapshot(pipeline.getModel(), { seq: startSeq })` as the
     *      client's first message.
     *
     * Resolves with the `NegotiatedSession` (from the handshake, or the supplied
     * `preNegotiated`) once the initial snapshot has been sent.
     *
     * Rejects with `HandshakeError` if the handshake fails (version mismatch,
     * unexpected message type, or transport closure during handshake).  In that
     * case the transport is closed (if not already) and the client is never added
     * to the active set.
     *
     * @param transport - The session-proxy-side half of a Transport pair for this client.
     * @param opts      - D5 broker-handoff options (skip handshake, continue seq).
     */
    addClient(transport: Transport, opts?: AddClientOptions): Promise<NegotiatedSession>;
    /**
     * Remove a client and stop sending to it.
     *
     * Idempotent: calling for a transport that is not tracked (already removed,
     * or never added) is a no-op.  Does NOT close the transport.
     *
     * Normally called automatically when the transport's `onClose` fires.
     * The integration layer (tc-93a) may also call this explicitly during
     * controlled shutdown to stop delta delivery before closing the socket.
     *
     * @param transport - The session-proxy-side transport to remove.
     */
    removeClient(transport: Transport): void;
    /**
     * The number of clients currently receiving control-plane messages.
     * Useful for monitoring and tests.
     */
    clientCount(): number;
    /**
     * The connectionId assigned to `transport` at `addClient` time (tc-ozk.2).
     *
     * Returns `undefined` if the transport is not in the active client set. Used
     * by the session-proxy's verb responder to stamp the origin of a verb-caused
     * creation with the connection that issued the verb.
     */
    connectionIdFor(transport: Transport): ConnectionId | undefined;
    /**
     * The durable client identity `transport` presented at handshake (D2/D3), or
     * `undefined` if the transport is not in the active set or advertised none.
     *
     * Used by the session-proxy's verb router to key a per-client write (binding
     * intent, tc-4b6k.2) to the ISSUING connection's identity — the `set-option
     * -pt %N @tmuxcc-bound-<key>` the `set-object-policy` verb emits must land in
     * the caller's own slot.
     */
    clientIdentityFor(transport: Transport): ClientIdentity | undefined;
    /**
     * Per-client facts for each currently-connected client (D2/D4, tc-4b6k.1,
     * tc-4b6k.3). One entry per live client, in connection order; `identity` is
     * absent for a client that advertised none; `flags` is absent when none were
     * sent on `session.attach`. Consumed by the `session-proxy.info` handler to
     * surface `info.clients[]`. Carried for observability only.
     */
    connectedClientIdentities(): ReadonlyArray<{
        readonly identity?: ClientIdentity;
        readonly flags?: ClientFlags;
    }>;
    /**
     * Push an unsolicited `ErrorMessage` to ALL currently connected clients.
     *
     * Used by the session-proxy to notify clients of unrecoverable conditions such as
     * `session.unavailable` (tmux process exited unexpectedly).  Each copy
     * stamped with the correct per-connection `seq` before delivery.
     *
     * Clients that are removed concurrently are silently skipped.
     */
    broadcastError(error: Omit<ErrorMessage, "seq">): void;
    /**
     * Send an error to all connected clients and then close their transports.
     *
     * Equivalent to `broadcastError(error)` followed by closing every transport.
     * The `onClose` cleanup runs automatically via the existing `transport.onClose`
     * handler installed during `addClient`, so the server state is consistent.
     *
     * Use this for terminal conditions where the session-proxy cannot continue (e.g.
     * `session.unavailable` due to switch-client beyond recovery).
     */
    broadcastErrorAndClose(error: Omit<ErrorMessage, "seq">): void;
    /**
     * Push a `ClientCountChangedMessage` to ALL currently connected clients.
     *
     * Called internally after a client connects or disconnects (tc-44wu0).
     * Public so that integration tests can assert on its shape without mocking
     * internal state.  Normal code should call `addClient` / `removeClient` —
     * those methods call this automatically.
     *
     * @internal — not part of the external session-proxy API; exposed only for testing.
     */
    broadcastClientCount(): void;
    /**
     * Handle a `resync.request` message from a specific client transport.
     *
     * Re-sends the full snapshot at the next per-connection seq without resetting
     * the counter.  Subsequent deltas continue from there.  Only the given client
     * is affected; the pipeline and other clients are untouched.
     *
     * Exposed so that integration layers (e.g. session-proxy.ts) that ALSO install a
     * `transport.onControl` handler (replacing the one installed by `addClient`)
     * can proxy `resync.request` messages through here rather than silently
     * dropping them.
     *
     * @param transport - The session-proxy-side transport of the requesting client.
     */
    handleResyncRequest(transport: Transport): void;
    /**
     * Send a `command.response` to a specific client using the per-connection seq counter.
     *
     * Used by integration layers (e.g. session-proxy.ts) that intercept
     * `command.request` messages (such as `session-proxy.info`) before they reach
     * `handleClientMessage` and need to send a directed response using the correct
     * seq number.
     *
     * No-op if the transport is not in the active client set.
     *
     * @param transport     - The session-proxy-side transport of the target client.
     * @param correlationId - The correlationId from the matching command.request.
     * @param payload       - The successful response payload.
     */
    sendCommandResponse(transport: Transport, correlationId: string, payload: import("@tmuxcc/protocol").SessionProxyCommandOkPayload): void;
    /**
     * Send a FAILED `command.response` (`result.ok = false`) to a specific client
     * using the per-connection seq counter (tc-ozk.1 + B5b).
     *
     * This is the command-attributable error path: when a verb's tmux command
     * comes back as `%error`, the failure belongs to THIS command request, so it
     * is delivered here as `result.ok = false` rather than as an unsolicited
     * ErrorMessage.  See SessionProxyCommandResponseMessage docs for the
     * command.response vs error split.
     *
     * No-op if the transport is not in the active client set.
     *
     * @param transport     - The session-proxy-side transport of the target client.
     * @param correlationId - The correlationId from the matching command.request.
     * @param code          - Machine-readable error code (e.g. "verb.failed").
     * @param message       - Human-readable error description (for logging).
     */
    sendCommandError(transport: Transport, correlationId: string, code: string, message: string): void;
    /**
     * Send an unsolicited session-proxy→client message to ONE client using its
     * per-connection seq counter (tc-295a.8 / tc-295a.9).
     *
     * The caller supplies the message WITHOUT `seq`; this stamps the next
     * per-connection value before delivery. Used by the session-proxy's attach +
     * hydration path to emit `pane.hydration.begin` / `pane.hydration.end` and
     * `pane.attach.failed` directed at the attaching transport only (these are
     * per-transport, not broadcast — a warm sibling client must not see another
     * client's hydration sentinels).
     *
     * No-op if the transport is not in the active client set.
     *
     * @param transport - The session-proxy-side transport of the target client.
     * @param msg       - The message to send, minus `seq`.
     */
    sendDirected(transport: Transport, msg: UnstampedSessionProxyMessage): void;
}
/**
 * A `SessionProxyMessage` without its `seq` field, distributed over the union so
 * each variant's own fields are preserved (a plain `Omit<Union, "seq">` would
 * collapse to only the common keys). The ControlServer stamps `seq` from the
 * per-connection counter before delivery.
 */
export type UnstampedSessionProxyMessage = SessionProxyMessage extends infer M ? M extends SessionProxyMessage ? Omit<M, "seq"> : never : never;
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
export declare function createControlServer(pipeline: RuntimePipeline, opts?: ControlServerOptions): ControlServer;
//# sourceMappingURL=serve.d.ts.map