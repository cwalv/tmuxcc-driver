/**
 * SessionProxyConnection — headless client connection + wire handshake + lifecycle.
 *
 * # Architecture
 *
 * The connection is the single entry point from the wire into the client.
 * It takes a Transport by INJECTION: the caller supplies a real pipe/socket
 * transport or the in-memory pair for tests.  The connection itself never
 * creates a transport — that is always the caller's responsibility.
 *
 * # Lifecycle states
 *
 *   "connecting"  — connect() has been called; the handshake is in flight.
 *                   No post-handshake messages are surfaced yet.
 *   "ready"       — runClientHandshake resolved; the NegotiatedSession is
 *                   available.  Post-handshake control + data messages are
 *                   routed to registered handlers.
 *   "failed"      — the handshake threw HandshakeError.  The connection is
 *                   inert; close() was called internally.
 *   "closed"      — transport closed after "ready" (clean or error), or
 *                   close() was called explicitly.
 *
 * State machine:
 *   (initial)  → "connecting"  [on connect()]
 *   connecting → "ready"       [handshake resolves]
 *   connecting → "failed"      [handshake rejects with HandshakeError]
 *   ready      → "closed"      [transport.onClose fires or close() called]
 *   failed     → (terminal, already closed internally)
 *
 * # Message routing (post-handshake seam for sibling beads)
 *
 * During the handshake ("connecting" state), the transport's onControl handler
 * is owned by runClientHandshake.  When the handshake completes ("ready"),
 * the connection installs its own onControl/onData handlers that route
 * post-handshake messages to the caller-registered handlers.
 *
 * Messages that arrive between the handshake settling and the connection's
 * own handlers being installed are BUFFERED.  The buffer is drained
 * synchronously before connect() resolves, so callers install their handlers
 * AFTER await connect() and still receive all messages.
 *
 * ## Routing seam for sibling beads
 *
 * These methods are the seam that tc-eots (snapshot/delta apply),
 * tc-3fb (pane byte-stream), tc-fpf (input/resize), and tc-7v9
 * (render hooks) build on:
 *
 *   onControl(handler: (msg: SessionProxyMessage) => void): void
 *     Receives all post-handshake session-proxy→client control messages:
 *     snapshot, pane/window/session/layout deltas, command responses,
 *     unsolicited errors.  tc-eots registers here.
 *
 *   onData(handler: (paneId: PaneId, bytes: Uint8Array) => void): void
 *     Receives all post-handshake data-plane frames.  tc-3fb registers here.
 *
 *   send(msg: ClientMessage): void
 *     Low-level client→session-proxy control send.  tc-fpf uses this for input
 *     and resize.request messages; tc-eots may use it for command.request.
 *
 *   state: ConnectionState
 *     Current lifecycle state; tc-7v9 and any render adapter reads this.
 *
 *   onStateChange(handler: (state: ConnectionState) => void): void
 *     Fires whenever state transitions.  Multiple handlers may be registered
 *     (each call appends; unlike transport.onControl, this is NOT replace).
 *
 *   session: NegotiatedSession | undefined
 *     The agreed protocol version + features.  Defined when state === "ready".
 *
 * # NO DOM, NO vscode, NO host API, NO Pseudoterminal
 * This file is headless by design.  Any renderer-specific code belongs in E6+.
 */

import {
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "@tmuxcc/session-proxy";
import type {
  Transport,
  SessionProxyMessage,
  ClientMessage,
  NegotiatedSession,
  WireFeature,
  ClientIdentity,
  PaneId,
} from "@tmuxcc/session-proxy";

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a SessionProxyConnection.
 *
 * "connecting" — connect() called; handshake in flight.
 * "ready"      — handshake complete; post-handshake messages are routed.
 * "failed"     — handshake failed (HandshakeError); connection is inert.
 * "closed"     — transport closed after "ready", or close() was called.
 */
export type ConnectionState = "connecting" | "ready" | "failed" | "closed";

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/**
 * Options for SessionProxyConnection.
 *
 * `features` — WireFeature array this client advertises during the handshake.
 *   Defaults to all known stable features.  The effective set is the
 *   intersection with what the session-proxy advertises.
 */
export interface SessionProxyConnectionOptions {
  features?: WireFeature[];
  /**
   * Durable client identity to present at handshake (D2, tc-4b6k.1). When set,
   * it is advertised on `client.capabilities` and the session-proxy captures +
   * logs it. Omit for an anonymous connection (older behavior). Carried and
   * logged only — no behavior depends on it yet.
   */
  identity?: ClientIdentity;
}

/**
 * Handler for post-handshake session-proxy→client control messages.
 * Registered via onControl().
 */
export type SessionProxyMessageHandler = (msg: SessionProxyMessage) => void;

/**
 * Handler for post-handshake data-plane frames.
 * Registered via onData().
 */
export type DataFrameHandler = (paneId: PaneId, bytes: Uint8Array) => void;

/**
 * Handler for connection lifecycle state changes.
 * Registered via onStateChange().  Multiple handlers may be registered;
 * each call to onStateChange() appends (unlike transport.onControl which
 * replaces).
 */
export type StateChangeHandler = (state: ConnectionState) => void;

// ---------------------------------------------------------------------------
// SessionProxyConnection
// ---------------------------------------------------------------------------

/**
 * Headless client connection to the tmuxcc session-proxy.
 *
 * Usage:
 * ```ts
 * const { sessionProxy, client } = createInMemoryTransportPair();
 * const conn = new SessionProxyConnection(client, { features: ["pane-lifecycle"] });
 *
 * conn.onStateChange((s) => console.log("state →", s));
 * conn.onControl((msg) => { ... });  // snapshot/deltas/responses/errors
 * conn.onData((paneId, bytes) => { ... });  // raw pane output
 *
 * const session = await conn.connect();  // runs the wire handshake
 * // session.protocolVersion, session.features available
 * ```
 *
 * Transport is injected by the caller; the connection never creates one.
 * For tests use createInMemoryTransportPair() from @tmuxcc/session-proxy.
 */
export class SessionProxyConnection {
  // ── Injected transport ────────────────────────────────────────────────────

  readonly #transport: Transport;

  // ── Capabilities to advertise ─────────────────────────────────────────────

  readonly #features: readonly WireFeature[];

  // Durable client identity to present at handshake (D2, tc-4b6k.1); undefined
  // → anonymous connection.
  readonly #identity: ClientIdentity | undefined;

  // ── Lifecycle state ───────────────────────────────────────────────────────

  #state: ConnectionState = "connecting";

  // Handlers registered via onStateChange() — appended, not replaced.
  readonly #stateChangeHandlers: StateChangeHandler[] = [];

  // ── Post-handshake message routing ────────────────────────────────────────

  // Single replaceable control handler (mirrors transport.onControl convention).
  #controlHandler: SessionProxyMessageHandler | null = null;

  // Single replaceable data handler.
  #dataHandler: DataFrameHandler | null = null;

  // Buffer for control messages that arrive after handshake settles but before
  // the caller has a chance to install their own handler.
  readonly #pendingControl: SessionProxyMessage[] = [];

  // Buffer for data frames arriving in the same window.
  readonly #pendingData: Array<{ paneId: PaneId; bytes: Uint8Array }> = [];

  // ── Negotiated session ────────────────────────────────────────────────────

  #session: NegotiatedSession | undefined = undefined;

  // ── Connection guard ──────────────────────────────────────────────────────

  // True once connect() has been called; prevents double-connect.
  #connectCalled = false;

  // ── Constructor ───────────────────────────────────────────────────────────

  /**
   * Create a SessionProxyConnection over an injected transport.
   *
   * Does NOT initiate a connection.  Call connect() to start the handshake.
   *
   * @param transport - Wire transport (pipe/socket/in-memory).  Caller owns it.
   * @param opts      - Optional: WireFeature[] to advertise.
   */
  constructor(transport: Transport, opts?: SessionProxyConnectionOptions) {
    this.#transport = transport;
    this.#features = opts?.features ?? [
      "pane-lifecycle",
      "layout-updates",
      "focus-events",
      "input-forwarding",
    ];
    this.#identity = opts?.identity;
    // NOTE: we do NOT install onClose here.  runClientHandshake owns the
    // transport's onClose handler during the handshake and replaces it with a
    // no-op when it settles (see handshake.ts settle()).  We re-install our
    // handler in #installPostHandshakeRouting() after the handshake completes.
    // Close events during the handshake are surfaced as HandshakeError by
    // runClientHandshake itself, so we handle those in the catch block of
    // connect().
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Current lifecycle state.
   *
   * "connecting" → connect() called, handshake in flight.
   * "ready"      → handshake complete, messages routed.
   * "failed"     → HandshakeError; connection is inert.
   * "closed"     → transport closed or close() called.
   */
  get state(): ConnectionState {
    return this.#state;
  }

  /**
   * The NegotiatedSession agreed during the handshake.
   * Defined only when state === "ready".
   */
  get session(): NegotiatedSession | undefined {
    return this.#session;
  }

  /**
   * Run the wire handshake and transition to "ready".
   *
   * MUST be called exactly once.  Resolves with the NegotiatedSession on
   * success; rejects with HandshakeError on failure (state → "failed").
   *
   * Post-handshake messages that arrive before the caller installs their
   * onControl/onData handlers are buffered and drained synchronously inside
   * this method before it returns, so installing handlers AFTER await connect()
   * is safe — no messages are lost.
   */
  async connect(): Promise<NegotiatedSession> {
    if (this.#connectCalled) {
      throw new Error("SessionProxyConnection.connect() must be called exactly once");
    }
    this.#connectCalled = true;

    // State is already "connecting" from construction — emit the initial
    // transition so that state-change listeners see connecting.
    this.#emitState("connecting");

    const clientCapabilities = {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: this.#features as WireFeature[],
    };

    let session: NegotiatedSession;
    try {
      // runClientHandshake owns the transport.onControl + transport.onClose
      // handlers while the handshake is in flight.  It replaces them with
      // no-ops when it settles (see handshake.ts settle()).
      // D2 (tc-4b6k.1): advertise the durable client identity, if the caller
      // supplied one, on the session-proxy wire.
      session = await runClientHandshake(
        this.#transport,
        clientCapabilities,
        "session-proxy.capabilities",
        this.#identity,
      );
    } catch (err) {
      // Handshake failed — transition to "failed" and propagate.
      this.#transition("failed");
      // Close the transport; the caller shouldn't use it after this.
      try {
        this.#transport.close();
      } catch {
        // Ignore close errors during failure path.
      }
      throw err;
    }

    // Handshake complete.  Install post-handshake routing BEFORE we
    // resolve — any synchronous messages (from in-memory transport) that
    // arrive while we drain the buffer should still hit the handler.
    this.#installPostHandshakeRouting();

    // Publish the session and transition state.
    this.#session = session;
    this.#transition("ready");

    // Drain any messages that arrived between handshake settling and
    // now (e.g. snapshot arriving synchronously from in-memory transport).
    this.#drainBuffers();

    return session;
  }

  /**
   * Register a handler for post-handshake session-proxy→client control messages.
   *
   * Replaces any previously registered handler (mirrors transport.onControl
   * convention).  Messages buffered before this handler is installed are
   * delivered synchronously (drained immediately on handler install).
   *
   * NOTE: buffered messages are drained both in connect() (if a handler is
   * already registered) AND here (if the handler is installed after connect()
   * returns).  Calling connectTo() after await connect() is safe — buffered
   * snapshots will be delivered on the connectTo() call.
   *
   * Receives: snapshot, pane/window/session/layout deltas, command responses,
   * unsolicited errors.  Does NOT receive the handshake capabilities messages.
   *
   * Siblings: tc-eots registers here to apply snapshot + deltas.
   */
  onControl(handler: SessionProxyMessageHandler): void {
    this.#controlHandler = handler;
    // Drain any messages buffered while no handler was registered.  This
    // covers the common pattern of calling mirror.connectTo(conn) after
    // await conn.connect() — the snapshot may have arrived during the
    // microtask yield in addClient() and been buffered.
    this.#drainBuffers();
  }

  /**
   * Register a handler for post-handshake data-plane frames (raw pane output).
   *
   * Replaces any previously registered handler.
   *
   * Siblings: tc-3fb registers here to consume pane byte streams.
   */
  onData(handler: DataFrameHandler): void {
    this.#dataHandler = handler;
  }

  /**
   * Register a handler for connection lifecycle state changes.
   *
   * Unlike onControl/onData, this APPENDS: calling onStateChange multiple
   * times registers multiple handlers, all of which fire on each transition.
   * Handlers are called in registration order.
   *
   * Siblings: tc-7v9 (render hook) registers here to react to ready/closed.
   */
  onStateChange(handler: StateChangeHandler): void {
    this.#stateChangeHandlers.push(handler);
  }

  /**
   * Send a client→session-proxy control message over the wire.
   *
   * Low-level primitive.  Callers should only send ClientMessage shapes.
   * Throws if the connection is not in the "ready" state.
   *
   * Siblings: tc-fpf uses this for input and resize.request messages.
   * tc-eots uses this for command.request messages.
   */
  send(msg: ClientMessage): void {
    if (this.#state !== "ready") {
      throw new Error(
        `SessionProxyConnection.send() called in state "${this.#state}"; must be "ready"`,
      );
    }
    this.#transport.sendControl(msg);
  }

  /**
   * Close the connection and the underlying transport.
   *
   * Idempotent: safe to call multiple times or in any state.
   * After close(), state transitions to "closed" (if not already "failed").
   */
  close(): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    this.#transport.close();
    // close() on the in-memory transport fires onClose synchronously which
    // calls #handleTransportClose → #transition("closed"), so we may already
    // be "closed" here.  #transition is idempotent (no-ops if already in
    // target state), so calling it unconditionally is safe.
    this.#transition("closed");
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Install the post-handshake control, data, and close handlers on the
   * transport.  Called once, immediately after runClientHandshake resolves.
   *
   * WHY here and not the constructor: runClientHandshake's settle() function
   * replaces onControl and onClose with no-ops when the handshake finishes.
   * We must re-install our handlers AFTER settle() runs — i.e. after the
   * runClientHandshake promise resolves — otherwise close events after the
   * handshake would be silently swallowed.
   *
   * Messages arriving synchronously (in-memory transport) before connect()
   * returns are stored in the pending buffers and drained by #drainBuffers().
   */
  #installPostHandshakeRouting(): void {
    this.#transport.onControl((msg) => {
      // Only route SessionProxyMessage shapes.  ClientMessage types should never
      // arrive on the client-side transport, but guard just in case.
      if (this.#state === "ready") {
        if (this.#controlHandler !== null) {
          this.#controlHandler(msg as SessionProxyMessage);
        } else {
          this.#pendingControl.push(msg as SessionProxyMessage);
        }
      }
    });

    this.#transport.onData((paneId, bytes) => {
      if (this.#state === "ready") {
        if (this.#dataHandler !== null) {
          this.#dataHandler(paneId, bytes);
        } else {
          this.#pendingData.push({ paneId, bytes });
        }
      }
    });

    // Re-install the close handler AFTER the handshake settled.
    // runClientHandshake's settle() cleared it; we need it back for
    // post-handshake transport closure events (e.g. session-proxy disconnects).
    this.#transport.onClose((err) => {
      this.#handleTransportClose(err);
    });
  }

  /**
   * Drain control + data buffers, delivering buffered messages to registered
   * handlers.  Called once at the end of connect() after state = "ready".
   */
  #drainBuffers(): void {
    if (this.#controlHandler !== null) {
      const handler = this.#controlHandler;
      const msgs = this.#pendingControl.splice(0);
      for (const msg of msgs) {
        handler(msg);
      }
    }

    if (this.#dataHandler !== null) {
      const handler = this.#dataHandler;
      const frames = this.#pendingData.splice(0);
      for (const { paneId, bytes } of frames) {
        handler(paneId, bytes);
      }
    }
  }

  /**
   * Called by the transport's onClose handler.  Transitions to "closed"
   * unless we're already in a terminal state.
   */
  #handleTransportClose(_err?: Error): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    this.#transition("closed");
  }

  /**
   * Transition to a new state and notify all registered state-change handlers.
   * No-ops if already in the target state (idempotent).
   */
  #transition(next: ConnectionState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#emitState(next);
  }

  /** Fire all registered state-change handlers with the given state. */
  #emitState(state: ConnectionState): void {
    for (const handler of this.#stateChangeHandlers) {
      handler(state);
    }
  }
}
