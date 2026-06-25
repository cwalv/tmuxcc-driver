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
import type { Transport } from "../wire/transport.js";
import {
  runSessionProxyHandshake,
  type NegotiatedSession,
} from "../wire/handshake.js";
import { WIRE_PROTOCOL_VERSION } from "../wire/envelope.js";
import type { Capabilities } from "../wire/envelope.js";
import type {
  SessionProxyMessage,
  ControlMessage,
  ErrorMessage,
  ClientCountChangedMessage,
} from "../wire/session-proxy-control.js";
import { projectSnapshot } from "../state/projection.js";
import { diffModel } from "../state/projection.js";
import type { OriginLookup, CloseCauseLookup } from "../state/projection.js";
import type { ConnectionId } from "../wire/ids.js";
import { connectionId as mintConnectionId } from "../wire/ids.js";
import type { SessionProxyRegistry } from "../metrics/registry.js";
import { phaseLog, phaseNow } from "./phase-timing.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
   *   1. Run `runSessionProxyHandshake(transport, sessionProxyCapabilities)`.
   *   2. Subscribe to `pipeline.onModelChange` to forward subsequent deltas
   *      (with per-connection seq stamping, starting at seq = 2).
   *   3. Register an `onClose` handler so cleanup happens automatic.
   *   4. Yield one microtask (`await Promise.resolve()`) so the client's
   *      post-handshake `onControl` handler is installed before the snapshot
   *      arrives (see timing contract in serve.ts addClient implementation).
   *   5. Send `projectSnapshot(pipeline.getModel(), { seq: 1 })` as the
   *      client's first message.
   *
   * Resolves with the `NegotiatedSession` from the handshake once the initial
   * snapshot has been sent.  The caller may use `NegotiatedSession.features` to
   * configure the data-plane pump.
   *
   * Rejects with `HandshakeError` if the handshake fails (version mismatch,
   * unexpected message type, or transport closure during handshake).  In that
   * case the transport is closed (if not already) and the client is never added
   * to the active set.
   *
   * @param transport - The session-proxy-side half of a Transport pair for this client.
   */
  addClient(transport: Transport): Promise<NegotiatedSession>;

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
  sendCommandResponse(
    transport: Transport,
    correlationId: string,
    payload: import("../wire/session-proxy-control.js").SessionProxyCommandOkPayload,
  ): void;

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
  sendCommandError(
    transport: Transport,
    correlationId: string,
    code: string,
    message: string,
  ): void;

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
  sendDirected(
    transport: Transport,
    msg: UnstampedSessionProxyMessage,
  ): void;
}

/**
 * A `SessionProxyMessage` without its `seq` field, distributed over the union so
 * each variant's own fields are preserved (a plain `Omit<Union, "seq">` would
 * collapse to only the common keys). The ControlServer stamps `seq` from the
 * per-connection counter before delivery.
 */
export type UnstampedSessionProxyMessage = SessionProxyMessage extends infer M
  ? M extends SessionProxyMessage
    ? Omit<M, "seq">
    : never
  : never;

// ---------------------------------------------------------------------------
// Default capabilities
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
};

// ---------------------------------------------------------------------------
// Per-client connection state
// ---------------------------------------------------------------------------

interface ClientState {
  transport: Transport;
  /** Next seq number for outbound session-proxy messages. Starts at 1. */
  nextSeq: number;
  /**
   * tc-ozk.2: this connection's stable connectionId (`conn<N>`). Minted at
   * addClient, sent to the client in the snapshot, and used to stamp the origin
   * of creations this connection's verbs cause. Slot-pooled like
   * `metricsClientLabel` so cardinality is bounded by max concurrent clients.
   */
  connectionId: ConnectionId;
  /** Unsubscribe from pipeline.onModelChange. */
  unsubModelChange: (() => void) | null;
  /**
   * tc-3si.6: per-connection slot label for the
   * `deltas_fanned_out_total{client}` counter. Minted from a reusable slot
   * pool at addClient time and released on cleanup, so label cardinality is
   * bounded by the max CONCURRENT client count. NOT a stable client
   * identity — just enough to attribute per-slot fan-out volume.
   */
  metricsClientLabel: string;
  /**
   * tc-3si.5: wall-clock timestamp (ms, from `Date.now()`) of the most
   * recent `resync.request` from this client, or `null` if none has fired
   * yet. Used to attribute the next request as either a fresh `gap` (no
   * prior request, or last request landed long ago) or an `escalation`
   * (a second request inside `RESYNC_ESCALATION_WINDOW_MS` of the
   * previous one — the previous snapshot did NOT heal the gap, which is
   * the expected-zero tripwire).
   */
  lastResyncAtMs: number | null;
}

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

class ControlServerImpl implements ControlServer {
  private readonly _pipeline: RuntimePipeline;
  private readonly _capabilities: Capabilities;
  private readonly _metrics: SessionProxyRegistry | undefined;
  /** tc-ozk.2: origin attribution lookup passed to per-client diffModel. */
  private readonly _originLookup: OriginLookup | undefined;
  /** tc-u7cu.6: close-cause lookup passed to per-client diffModel. */
  private readonly _closeCauseLookup: CloseCauseLookup | undefined;
  /** tc-is5w: session name for the dev-gated first-snapshot timing line. */
  private readonly _sessionName: string | undefined;

  /**
   * Active clients keyed by transport reference. Using the Transport object as
   * the Map key ensures O(1) lookup for addClient/removeClient without needing
   * to assign client ids.
   */
  private readonly _clients = new Map<Transport, ClientState>();

  /**
   * tc-3si.6: per-connection slot labels for the
   * `deltas_fanned_out_total{client}` counter. Labels are a SLOT pool, not
   * stable client identities: removeClient releases the label back to the
   * free list and the next addClient reuses it, so label cardinality is
   * bounded by the MAX CONCURRENT client count — a monotonic mint would grow
   * the label set forever under reconnect churn (one new label per VS Code
   * window reload, for the lifetime of the session-proxy).
   */
  private readonly _freeClientLabels: string[] = [];
  private _nextClientLabelSeq = 1;

  private _mintClientLabel(): string {
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
  private readonly _freeConnectionIds: ConnectionId[] = [];
  private _nextConnectionSeq = 1;

  private _mintConnectionId(): ConnectionId {
    return this._freeConnectionIds.pop() ?? mintConnectionId(`conn${this._nextConnectionSeq++}`);
  }

  constructor(pipeline: RuntimePipeline, opts: ControlServerOptions = {}) {
    this._pipeline = pipeline;
    this._capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this._metrics = opts.metrics;
    this._originLookup = opts.originLookup;
    this._closeCauseLookup = opts.closeCauseLookup;
    this._sessionName = opts.sessionName;
  }

  async addClient(transport: Transport): Promise<NegotiatedSession> {
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
    // IMPORTANT: runSessionProxyHandshake resets transport.onControl to a no-op when
    // it settles (via its internal settle() function).  The client side
    // (SessionProxyConnection.connect / runClientHandshake) installs its own
    // post-handshake onControl handler SYNCHRONOUSLY after runClientHandshake
    // resolves — before yielding to the event loop.  We must therefore defer the
    // snapshot send by at least one microtask after the handshake resolves, so
    // the client's onControl installation has a chance to run.
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
    let session: NegotiatedSession;
    try {
      session = await runSessionProxyHandshake(transport, this._capabilities);
    } catch (err) {
      // Handshake failed — transport may already be closed; close defensively.
      try { transport.close(); } catch { /* ignore */ }
      throw err;
    }

    // Allocate per-connection state. seq starts at 1 — the snapshot uses it.
    const state: ClientState = {
      transport,
      nextSeq: 1,
      connectionId: this._mintConnectionId(),
      unsubModelChange: null,
      metricsClientLabel: this._mintClientLabel(),
      lastResyncAtMs: null,
    };
    this._clients.set(transport, state);

    // Subscribe to model changes BEFORE sending the snapshot so that any model
    // changes that fire during the microtask gap below are not silently dropped.
    // Deltas queued before the snapshot is sent would have seq >= 2 (correct) and
    // would arrive AFTER the snapshot (also correct, since sendControl is ordered).
    const unsub = this._pipeline.onModelChange((newModel, prevModel) => {
      // Guard: client may have been removed before this fires.
      if (!this._clients.has(transport)) return;

      // tc-ozk.2: pass the origin lookup so verb-caused creations this client
      // sees carry their origin (incl. another client's verb — the multi-client
      // case: client B sees origin.connectionId=A and treats it as not-its-own).
      // tc-u7cu.6: pass the close-cause lookup so verb-caused closes carry cause.
      const deltas: SessionProxyMessage[] = diffModel(prevModel, newModel, this._originLookup, this._closeCauseLookup);
      for (const delta of deltas) {
        // Stamp seq on a new object (SessionProxyMessage fields are readonly; spread).
        const stamped = { ...delta, seq: state.nextSeq };
        state.nextSeq++;
        transport.sendControl(stamped as SessionProxyMessage);
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
    transport.onControl((msg: ControlMessage) => {
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

    // Send the initial snapshot. seq = 1.
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

  removeClient(transport: Transport): void {
    this._cleanupClient(transport);
  }

  clientCount(): number {
    return this._clients.size;
  }

  connectionIdFor(transport: Transport): ConnectionId | undefined {
    return this._clients.get(transport)?.connectionId;
  }

  broadcastError(error: Omit<ErrorMessage, "seq">): void {
    for (const [transport, state] of this._clients) {
      const stamped: SessionProxyMessage = { ...error, seq: state.nextSeq } as SessionProxyMessage;
      state.nextSeq++;
      try {
        transport.sendControl(stamped);
      } catch {
        // Transport may already be closed — clean it up and continue.
        this._cleanupClient(transport);
      }
    }
  }

  broadcastErrorAndClose(error: Omit<ErrorMessage, "seq">): void {
    // Snapshot the client list before iterating — closing triggers onClose
    // which calls _cleanupClient, mutating _clients.  Iterate the snapshot.
    const clients = [...this._clients];
    for (const [transport, state] of clients) {
      const stamped: SessionProxyMessage = { ...error, seq: state.nextSeq } as SessionProxyMessage;
      state.nextSeq++;
      try {
        transport.sendControl(stamped);
      } catch {
        // Transport already closed — fall through to close() below.
      }
      try {
        transport.close();
      } catch {
        // Ignore: already closed.
      }
    }
  }

  broadcastClientCount(): void {
    this.broadcastClientCountTo({});
  }

  /**
   * Internal: broadcast client-count.changed to all clients except (optionally)
   * one excluded transport. Used by `addClient` to skip the newly-connected
   * client (which already received the count via the snapshot).
   */
  private broadcastClientCountTo(opts: { exclude?: Transport }): void {
    const count = this._clients.size;
    const base: Omit<ClientCountChangedMessage, "seq"> = {
      type: "client-count.changed",
      count,
    };
    for (const [transport, state] of this._clients) {
      if (transport === opts.exclude) continue;
      const stamped: SessionProxyMessage = { ...base, seq: state.nextSeq } as SessionProxyMessage;
      state.nextSeq++;
      try {
        transport.sendControl(stamped);
      } catch {
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
  handleResyncRequest(transport: Transport): void {
    const state = this._clients.get(transport);
    if (!state) return; // client may have been removed already (race with close)

    // tc-3si.5: classify this resync as either `gap` (fresh) or
    // `escalation` (a second request from the same client inside the
    // escalation window — the previous snapshot did NOT heal the gap).
    // Escalation is an expected-zero tripwire; loud-log it alongside the
    // counter bump so the bug class lands even when no metric reader is
    // attached.
    const nowMs = Date.now();
    const prevResyncAtMs = state.lastResyncAtMs;
    let cause: "gap" | "escalation" = "gap";
    if (
      prevResyncAtMs !== null &&
      nowMs - prevResyncAtMs < RESYNC_ESCALATION_WINDOW_MS
    ) {
      cause = "escalation";
    }
    state.lastResyncAtMs = nowMs;
    if (this._metrics !== undefined) {
      this._metrics.incResync(cause);
    }
    if (cause === "escalation" && prevResyncAtMs !== null) {
      process.stderr.write(
        `[serve] RESYNC ESCALATION: a second resync.request from client ${state.metricsClientLabel} ` +
          `landed ${nowMs - prevResyncAtMs}ms after the previous one (within the ` +
          `${RESYNC_ESCALATION_WINDOW_MS}ms escalation window). The previous snapshot did not heal the gap — ` +
          `the wire's sequence invariant is broken or the client's gap detector is misfiring (tc-3si.5).\n`,
      );
    }

    // tc-1elae: include the current client count in the re-sent snapshot so
    // that the status bar tooltip stays accurate after a resync.
    const snapshot = projectSnapshot(this._pipeline.getModel(), {
      seq: state.nextSeq,
      attachedClientCount: this._clients.size,
      // tc-ozk.2: re-send the connectionId so a reconnecting client re-learns it.
      connectionId: state.connectionId,
    });
    state.nextSeq++;
    transport.sendControl(snapshot);
  }

  sendCommandResponse(
    transport: Transport,
    correlationId: string,
    payload: import("../wire/session-proxy-control.js").SessionProxyCommandOkPayload,
  ): void {
    const state = this._clients.get(transport);
    if (!state) return; // not in active client set
    const msg: import("../wire/session-proxy-control.js").SessionProxyCommandResponseMessage = {
      type: "command.response",
      seq: state.nextSeq,
      correlationId,
      result: { ok: true, payload },
    };
    state.nextSeq++;
    try {
      transport.sendControl(msg);
    } catch {
      // Transport may have closed concurrently — clean up.
      this._cleanupClient(transport);
    }
  }

  sendCommandError(
    transport: Transport,
    correlationId: string,
    code: string,
    message: string,
  ): void {
    const state = this._clients.get(transport);
    if (!state) return; // not in active client set
    const msg: import("../wire/session-proxy-control.js").SessionProxyCommandResponseMessage = {
      type: "command.response",
      seq: state.nextSeq,
      correlationId,
      result: { ok: false, code, message },
    };
    state.nextSeq++;
    try {
      transport.sendControl(msg);
    } catch {
      // Transport may have closed concurrently — clean up.
      this._cleanupClient(transport);
    }
  }

  sendDirected(
    transport: Transport,
    msg: UnstampedSessionProxyMessage,
  ): void {
    const state = this._clients.get(transport);
    if (!state) return; // not in active client set
    const stamped = { ...msg, seq: state.nextSeq } as SessionProxyMessage;
    state.nextSeq++;
    try {
      transport.sendControl(stamped);
    } catch {
      // Transport may have closed concurrently — clean up.
      this._cleanupClient(transport);
    }
  }

  private _cleanupClient(transport: Transport): void {
    const state = this._clients.get(transport);
    if (!state) return; // already removed or never added

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
export function createControlServer(
  pipeline: RuntimePipeline,
  opts?: ControlServerOptions,
): ControlServer {
  return new ControlServerImpl(pipeline, opts);
}
