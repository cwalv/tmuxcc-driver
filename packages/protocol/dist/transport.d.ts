/**
 * Transport seam — the abstraction the wire protocol rides over.
 *
 * # Two-plane design
 *
 * The wire carries two logically distinct channels over a single transport
 * connection:
 *
 * ## Control plane (structured messages)
 *   Carries ControlMessage values — typed, JSON-serializable, low-volume.
 *   Examples: pane-lifecycle events, layout updates, input commands.
 *   The control plane is structured because these messages need to be
 *   inspected, logged, and routed by type.  JSON/text encoding is fine at
 *   the volumes involved.
 *
 * ## Data plane (raw byte frames)
 *   Carries terminal output bytes for a specific pane.  This is the hot path:
 *   a busy terminal can push megabytes per second.  Using JSON or base64 on
 *   this path would triple the bytes on the wire and add per-character parsing
 *   cost.  Instead, data-plane frames are raw Uint8Array chunks tagged only
 *   with a PaneId.  The framing format (length-prefix, etc.) is defined by
 *   bead tc-2mq; this seam only deals in decoded frames.
 *
 * # Why a seam?
 *
 * The Transport interface is implemented independently for each concrete
 * transport (the broker's production socket transport, and an in-process pair
 * for tests).  Wire-level code (sessionProxy, client, codec) depends only on
 * this interface so that the concrete transport can be swapped without changing
 * any wire logic.
 *
 * # Imports
 *   - ControlMessage  — from tc-auj (control schema bead)
 *   - PaneId          — from ids.ts (shared primitive, used by both planes)
 */
import type { ControlMessage } from "./session-proxy-control.js";
import type { PaneId } from "./ids.js";
/** Called when a control-plane message arrives from the remote endpoint. */
export type ControlHandler = (msg: ControlMessage) => void;
/**
 * Called when a data-plane frame arrives from the remote endpoint.
 *
 * @param paneId - Which pane's output stream these bytes belong to.
 * @param bytes  - Raw terminal output bytes. Binary; may contain any byte
 *                 value including 0x00 and values that are not valid UTF-8.
 *                 Do NOT stringify or base64-encode; pass through as-is.
 */
export type DataHandler = (paneId: PaneId, bytes: Uint8Array) => void;
/** Called when the transport connection closes. */
export type CloseHandler = (err?: Error) => void;
/**
 * A bidirectional two-plane communication channel between session-proxy and client.
 *
 * Implementations:
 *   - In-process paired transport (this file) — internal only, for unit tests.
 *   - The production transport is the broker's socket transport (server-proxy /
 *     broker layer), which implements this same interface.
 *
 * There is no WebSocket transport — that is speculative until a real
 * browser/remote consumer exists; file a fresh bead if one materializes.
 *
 * No concrete-transport details (socket fds, pipe handles) may appear in this
 * interface or in the wire types that use it.
 *
 * ## Method conventions
 *
 * `send*` methods deliver a message or bytes to the remote endpoint.  They
 * return `void` synchronously for the common case; implementations that need
 * to back-pressure (e.g. when the socket send-buffer is full) may return a
 * Promise that resolves when the data has been accepted.
 *
 * `onControl` and `onData` register a single handler for the lifetime of the
 * transport. Calling them a second time replaces the previous handler.
 *
 * `onClose` is a multi-handler subscription: each call registers an additional
 * handler and returns an unsubscribe function. All registered handlers fire
 * when the transport closes.  Calling the returned unsubscribe deregisters only
 * that handler; other subscribers are unaffected.
 *
 * Handlers are invoked synchronously in the in-memory implementation; real
 * transports may invoke them on the next event-loop tick.
 *
 * `close()` tears down the transport.  After `close()` returns, no further
 * handler calls will be made.  Calling `close()` on an already-closed
 * transport is a no-op.
 */
export interface Transport {
    /**
     * Send a structured control-plane message to the remote endpoint.
     *
     * Returns void (or a Promise<void> for back-pressured transports).
     * The caller need not await unless it needs delivery confirmation.
     */
    sendControl(msg: ControlMessage): void | Promise<void>;
    /**
     * Register a handler for incoming control-plane messages.
     * Replaces any previously registered handler.
     */
    onControl(handler: ControlHandler): void;
    /**
     * Send raw terminal-output bytes for the given pane to the remote endpoint.
     *
     * `bytes` MUST be passed as a Uint8Array.  Do not convert to string or
     * base64 — that defeats the purpose of a separate data plane.
     *
     * The byte framing format (length-prefix, pane-id encoding on the wire) is
     * defined by bead tc-2mq and is opaque to this interface; implementations
     * are responsible for serialising and deserialising frames.
     */
    sendData(paneId: PaneId, bytes: Uint8Array): void | Promise<void>;
    /**
     * Register a handler for incoming data-plane frames.
     * Replaces any previously registered handler.
     */
    onData(handler: DataHandler): void;
    /**
     * Register a handler called when the transport closes (cleanly or with an
     * error).  Multiple handlers may be registered; all fire on close.
     *
     * Returns an unsubscribe function.  Call it to deregister this specific
     * handler without affecting other subscribers.
     *
     * If the transport closes with an error, the handler receives the Error
     * object.  A clean close passes no argument (err is undefined).
     */
    onClose(handler: CloseHandler): () => void;
    /**
     * Close the transport.  Delivers a close notification to the onClose handler
     * of the *remote* endpoint (if paired), then to this endpoint's own handler.
     * Subsequent send* calls on a closed transport throw or silently drop,
     * depending on the implementation.
     *
     * @param err - Optional error to propagate to close handlers.
     */
    close(err?: Error): void;
}
/**
 * A pair of Transport endpoints wired together in memory.
 *
 * Messages/bytes sent on `session-proxy` arrive on `client`, and vice-versa.
 * The two endpoints share no I/O — delivery is synchronous and immediate.
 * This makes the pair ideal for deterministic unit tests that don't need a
 * real socket.
 *
 * Usage:
 * ```ts
 * const { sessionProxy, client } = createInMemoryTransportPair();
 *
 * client.onControl((msg) => { ... });
 * sessionProxy.sendControl({ type: "pane.opened", seq: 1, ... });
 * // handler fires synchronously
 * ```
 */
export interface InMemoryTransportPair {
    /** The session-proxy-side endpoint. Send here to deliver to the client. */
    sessionProxy: Transport;
    /** The client-side endpoint. Send here to deliver to the session-proxy. */
    client: Transport;
}
/**
 * Create a paired in-memory transport for testing session-proxy↔client interactions
 * without a real socket.
 *
 * Both endpoints start open.  Call `sessionProxy.close()` or `client.close()` to
 * tear down the pair; the close propagates to the remote endpoint's onClose
 * handler.
 */
export declare function createInMemoryTransportPair(): InMemoryTransportPair;
//# sourceMappingURL=transport.d.ts.map