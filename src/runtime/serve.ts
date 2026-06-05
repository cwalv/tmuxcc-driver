/**
 * Control-plane server — per-client handshake + snapshot + delta stream (tc-dv3).
 *
 * # Responsibility
 *
 * `createControlServer` manages a set of connected clients over the CONTROL plane
 * (structured `ControlMessage` values). For each client it:
 *
 *   1. Runs the daemon side of the capability handshake (`runDaemonHandshake`).
 *   2. Sends a full snapshot of the current model (`projectSnapshot`) as the
 *      client's first message after the handshake.
 *   3. Subscribes to `RuntimePipeline.onModelChange` and forwards each set of
 *      deltas (`diffModel` output) to the client with a per-connection seq stamp.
 *   4. Cleans up (unsubscribes, removes from active-client set) when the client's
 *      transport closes.
 *
 * # Per-connection sequence counter
 *
 * Every `ControlMessage` carries a `seq` field (MessageBase). For daemon-push
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
 *   1. Call `server.addClient(daemonSideTransport)` — returns a Promise that
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
 * # Inbound messages (client → daemon)
 *
 * The control plane is bidirectional.  Most client→daemon messages (`command.request`,
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
  runDaemonHandshake,
  type NegotiatedSession,
} from "../wire/handshake.js";
import { WIRE_PROTOCOL_VERSION } from "../wire/envelope.js";
import type { Capabilities } from "../wire/envelope.js";
import type {
  DaemonMessage,
  ControlMessage,
  ErrorMessage,
  ClientCountChangedMessage,
} from "../wire/daemon-control.js";
import { projectSnapshot } from "../state/projection.js";
import { diffModel } from "../state/projection.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `createControlServer`.
 */
export interface ControlServerOptions {
  /**
   * Capabilities the daemon advertises during the handshake.
   *
   * Defaults to a capabilities set advertising
   * `WIRE_PROTOCOL_VERSION` and all known wire features.
   */
  capabilities?: Capabilities;
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
 * const session = await server.addClient(daemonSideTransport);
 * // Control stream is live. Now wire the data-plane:
 * attachOutputDemux(daemonSideTransport, pipeline.buffers, session);
 *
 * // To inspect connection count:
 * console.log(server.clientCount());
 *
 * // To forcibly disconnect a client (e.g. during shutdown):
 * server.removeClient(daemonSideTransport);
 * ```
 */
export interface ControlServer {
  /**
   * Accept a new client connection over the given daemon-side `Transport`.
   *
   * Steps performed:
   *   1. Run `runDaemonHandshake(transport, daemonCapabilities)`.
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
   * @param transport - The daemon-side half of a Transport pair for this client.
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
   * @param transport - The daemon-side transport to remove.
   */
  removeClient(transport: Transport): void;

  /**
   * The number of clients currently receiving control-plane messages.
   * Useful for monitoring and tests.
   */
  clientCount(): number;

  /**
   * Push an unsolicited `ErrorMessage` to ALL currently connected clients.
   *
   * Used by the daemon to notify clients of unrecoverable conditions such as
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
   * Use this for terminal conditions where the daemon cannot continue (e.g.
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
   * @internal — not part of the external daemon API; exposed only for testing.
   */
  broadcastClientCount(): void;
}

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
  /** Next seq number for outbound daemon messages. Starts at 1. */
  nextSeq: number;
  /** Unsubscribe from pipeline.onModelChange. */
  unsubModelChange: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ControlServerImpl implements ControlServer {
  private readonly _pipeline: RuntimePipeline;
  private readonly _capabilities: Capabilities;

  /**
   * Active clients keyed by transport reference. Using the Transport object as
   * the Map key ensures O(1) lookup for addClient/removeClient without needing
   * to assign client ids.
   */
  private readonly _clients = new Map<Transport, ClientState>();

  constructor(pipeline: RuntimePipeline, opts: ControlServerOptions = {}) {
    this._pipeline = pipeline;
    this._capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
  }

  async addClient(transport: Transport): Promise<NegotiatedSession> {
    // Run the daemon-side capability handshake. This will:
    //   • Send daemon.capabilities (seq=1, handled internally by runDaemonHandshake)
    //   • Wait for the client to send client.capabilities
    //   • Negotiate the session (version check + feature intersection)
    //
    // IMPORTANT: runDaemonHandshake resets transport.onControl to a no-op when
    // it settles (via its internal settle() function).  The client side
    // (DaemonConnection.connect / runClientHandshake) installs its own
    // post-handshake onControl handler SYNCHRONOUSLY after runClientHandshake
    // resolves — before yielding to the event loop.  We must therefore defer the
    // snapshot send by at least one microtask after the handshake resolves, so
    // the client's onControl installation has a chance to run.
    //
    // Timing contract (both sides):
    //   Daemon: await handshake → install delta subscription + onClose
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
      session = await runDaemonHandshake(transport, this._capabilities);
    } catch (err) {
      // Handshake failed — transport may already be closed; close defensively.
      try { transport.close(); } catch { /* ignore */ }
      throw err;
    }

    // Allocate per-connection state. seq starts at 1 — the snapshot uses it.
    const state: ClientState = {
      transport,
      nextSeq: 1,
      unsubModelChange: null,
    };
    this._clients.set(transport, state);

    // Subscribe to model changes BEFORE sending the snapshot so that any model
    // changes that fire during the microtask gap below are not silently dropped.
    // Deltas queued before the snapshot is sent would have seq >= 2 (correct) and
    // would arrive AFTER the snapshot (also correct, since sendControl is ordered).
    const unsub = this._pipeline.onModelChange((newModel, prevModel) => {
      // Guard: client may have been removed before this fires.
      if (!this._clients.has(transport)) return;

      const deltas: DaemonMessage[] = diffModel(prevModel, newModel);
      for (const delta of deltas) {
        // Stamp seq on a new object (DaemonMessage fields are readonly; spread).
        const stamped = { ...delta, seq: state.nextSeq };
        state.nextSeq++;
        transport.sendControl(stamped as DaemonMessage);
      }
    });
    state.unsubModelChange = unsub;

    // Auto-cleanup when the transport closes (remote disconnects).
    transport.onClose(() => {
      this._cleanupClient(transport);
    });

    // Inbound control handler: handle resync.request from the client.
    // This is the only client→daemon message the serve layer processes; all
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
        this._handleResyncRequest(transport);
      }
      // All other inbound messages: silently pass through (handled by tc-93a).
    });

    // Defer the snapshot by one microtask so the client's post-handshake
    // onControl handler (installed synchronously in DaemonConnection.connect()
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
      });
      state.nextSeq++;
      transport.sendControl(snapshot);

      // tc-44wu0: notify ALL clients (including the newly-connected one) that
      // the connected-client count has changed. This lets existing clients'
      // status-bar tooltips update live.
      //
      // We broadcast AFTER the snapshot is sent so the new client receives the
      // snapshot first (establishing its initial state) and then the count
      // message (which may confirm or update that count).
      this.broadcastClientCount();
    }

    return session;
  }

  removeClient(transport: Transport): void {
    this._cleanupClient(transport);
  }

  clientCount(): number {
    return this._clients.size;
  }

  broadcastError(error: Omit<ErrorMessage, "seq">): void {
    for (const [transport, state] of this._clients) {
      const stamped: DaemonMessage = { ...error, seq: state.nextSeq } as DaemonMessage;
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
      const stamped: DaemonMessage = { ...error, seq: state.nextSeq } as DaemonMessage;
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
    // tc-44wu0: push the current connected-client count to all clients so
    // the status-bar tooltip updates live.
    const count = this._clients.size;
    const base: Omit<ClientCountChangedMessage, "seq"> = {
      type: "client-count.changed",
      count,
    };
    for (const [transport, state] of this._clients) {
      const stamped: DaemonMessage = { ...base, seq: state.nextSeq } as DaemonMessage;
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
  private _handleResyncRequest(transport: Transport): void {
    const state = this._clients.get(transport);
    if (!state) return; // client may have been removed already (race with close)

    // tc-1elae: include the current client count in the re-sent snapshot so
    // that the status bar tooltip stays accurate after a resync.
    const snapshot = projectSnapshot(this._pipeline.getModel(), {
      seq: state.nextSeq,
      attachedClientCount: this._clients.size,
    });
    state.nextSeq++;
    transport.sendControl(snapshot);
  }

  private _cleanupClient(transport: Transport): void {
    const state = this._clients.get(transport);
    if (!state) return; // already removed or never added

    state.unsubModelChange?.();
    state.unsubModelChange = null;
    this._clients.delete(transport);

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
 * const { daemon: daemonTransport } = createInMemoryTransportPair();
 * const session = await server.addClient(daemonTransport);
 * // session.features describes the negotiated feature set.
 * // The data-plane pump (tc-fbz) should now attach to daemonTransport.sendData.
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
