/**
 * Pane byte-stream consumer — tc-ekd (E5 Client core, headless).
 *
 * # Purpose
 *
 * Sits between the `SessionProxyConnection.onData` seam and the renderer layer
 * (tc-y8d render-hook).  Routes decoded `(paneId, bytes)` frames to per-pane
 * and/or global handlers, maintaining FIFO ordering per pane and buffering
 * output that arrives before a renderer subscribes.
 *
 * # Consumer API
 *
 * ```ts
 * const consumer = new PaneStreamConsumer();
 *
 * // Connect to a live SessionProxyConnection (after await conn.connect()):
 * const unsub = connectPaneStream(conn, consumer);
 *
 * // Subscribe to a specific pane:
 * const unsubPane = consumer.onPaneOutput(paneId("p0"), (bytes) => {
 *   // bytes: Uint8Array — raw, binary-safe.  Do NOT stringify.
 * });
 *
 * // Subscribe to all panes via global handler:
 * const unsubAll = consumer.onOutput((paneId, bytes) => { ... });
 *
 * // Access bytes buffered before subscription:
 * const buffered = consumer.getBuffered(paneId("p0")); // Uint8Array or undefined
 *
 * // Tear down:
 * unsubPane();
 * unsubAll();
 * unsub(); // disconnects from the connection
 * ```
 *
 * # Ordering guarantee
 *
 * Bytes for a given pane are delivered to all registered handlers in the order
 * they were received from the connection.  The transport and data-plane already
 * preserve per-pane FIFO ordering on the wire; this consumer does not reorder.
 *
 * Delivery is synchronous: when `push(paneId, bytes)` is called, every
 * registered handler fires before `push` returns.  Per-pane ordering is
 * therefore determined entirely by the order in which frames arrive from the
 * connection, which is the wire order.
 *
 * # Backpressure and pre-subscription buffering
 *
 * ## Pre-subscription buffer
 *
 * Output that arrives for a pane before any per-pane handler is registered is
 * accumulated in a per-pane buffer.  When the first per-pane handler is
 * registered, all buffered chunks are flushed synchronously to it before any
 * future live frames arrive, preserving FIFO order.
 *
 * ## Buffer bound and overflow policy
 *
 * Each per-pane pre-subscription buffer is bounded by a configurable byte
 * budget (default: `PRE_SUB_BUFFER_CAP_BYTES` = 4 MiB per pane).  The cap
 * exists to prevent a runaway producer from exhausting process memory while no
 * handler is registered.
 *
 * Overflow policy: **drop-oldest** (FIFO eviction from the front of the
 * chunk queue).  When a new chunk would push the accumulated byte total above
 * the cap, the oldest chunks are discarded one by one until there is room for
 * the new chunk.  Rationale: a renderer that subscribes late is best served by
 * the most-recent output (the current screen state), not by the oldest
 * scrollback.  This mirrors the semantics of a fixed-size terminal scrollback
 * buffer.  Dropped bytes are gone; the handler will see a contiguous suffix of
 * the pre-subscription output.  A custom cap can be supplied via
 * `PaneStreamConsumer` constructor options.
 *
 * The global handler (onOutput) does NOT trigger buffered-flush behaviour: it
 * receives only live frames delivered after it is registered.  Pre-subscription
 * buffering is a per-pane-handler concept.
 *
 * ## True backpressure
 *
 * This consumer is synchronous.  It does not implement flow-control signalling
 * back to the session-proxy.  The bead spec notes that client-side back-pressure to
 * the session-proxy is a flow-control concern handled elsewhere (tc-1ho / future bead).
 * Handlers that cannot keep up with the data rate must do their own buffering.
 *
 * # Non-UTF-8 safety
 *
 * `bytes` delivered to handlers are the exact `Uint8Array` received from the
 * connection.  This consumer NEVER converts bytes to a string, never calls
 * `TextDecoder`, and never strips or replaces byte values.  Handlers receive
 * bytes that may include 0x00, 0xFF, incomplete multi-byte sequences, and any
 * other byte value.
 *
 * @module pane-stream
 */

import type { PaneId } from "@remux/session-proxy";
import type { SessionProxyConnection } from "./connection.js";

// ---------------------------------------------------------------------------
// Buffer cap
// ---------------------------------------------------------------------------

/**
 * Default per-pane pre-subscription buffer cap: 4 MiB.
 *
 * Chosen to comfortably hold several screens of terminal output (a typical
 * 80×24 terminal at ~4 bytes/char is ~7 KiB per full screen) while remaining
 * well under any reasonable per-process memory budget.  Applications that
 * attach renderers promptly (the normal case) will never come close to this
 * limit.
 */
export const PRE_SUB_BUFFER_CAP_BYTES = 4 * 1024 * 1024; // 4 MiB

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options for `PaneStreamConsumer`.
 */
export interface PaneStreamConsumerOptions {
  /**
   * Maximum total byte size of the pre-subscription buffer per pane.
   *
   * When the buffer would exceed this limit, the oldest chunks are evicted
   * (drop-oldest policy) until there is room for the incoming chunk.
   *
   * @default PRE_SUB_BUFFER_CAP_BYTES (4 MiB)
   */
  preSubBufferCapBytes?: number;
}

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

/**
 * Handler for raw output bytes from a specific pane.
 *
 * `bytes` is a `Uint8Array` forwarded directly from the data-plane frame.
 * It is binary-safe: may contain any byte value, including 0x00 and sequences
 * that are not valid UTF-8.  Do NOT convert to string without an explicit,
 * byte-exact charset decoder.
 */
export type PaneOutputHandler = (bytes: Uint8Array) => void;

/**
 * Global handler that receives output bytes for every pane.
 *
 * Called after all per-pane handlers for the same frame have fired.
 * Receives only live frames (frames arriving after the handler is registered).
 * Pre-subscription buffering does NOT apply to global handlers.
 */
export type GlobalOutputHandler = (paneId: PaneId, bytes: Uint8Array) => void;

// ---------------------------------------------------------------------------
// PaneStreamConsumer
// ---------------------------------------------------------------------------

/**
 * Per-pane byte-stream consumer.
 *
 * Routes decoded `(paneId, bytes)` frames delivered by `SessionProxyConnection.onData`
 * to per-pane handlers and/or a global output handler.
 *
 * Construct one, then wire it to a connected `SessionProxyConnection` using
 * `connectPaneStream(conn, consumer)`.
 *
 * Thread model: synchronous / single-threaded.  All method calls must come from
 * the same event-loop tick as the underlying transport.
 */
export class PaneStreamConsumer {
  // ── Configuration ──────────────────────────────────────────────────────────

  /** Maximum total bytes held per pane in the pre-subscription buffer. */
  readonly #capBytes: number;

  // ── Per-pane handler table ─────────────────────────────────────────────────

  /** Map of paneId → list of handlers registered for that pane. */
  readonly #paneHandlers: Map<PaneId, PaneOutputHandler[]> = new Map();

  // ── Pre-subscription buffer ────────────────────────────────────────────────

  /**
   * Map of paneId → ordered list of byte chunks received before the first
   * per-pane handler was registered.  Cleared (per pane) on first handler
   * registration.
   */
  readonly #preSub: Map<PaneId, Uint8Array[]> = new Map();

  /**
   * Map of paneId → current total byte count in `#preSub` for that pane.
   * Maintained in sync with `#preSub` to avoid recomputing on every push.
   */
  readonly #preSubBytes: Map<PaneId, number> = new Map();

  // ── Global handler ─────────────────────────────────────────────────────────

  /** List of global handlers (receive all pane output, live frames only). */
  readonly #globalHandlers: GlobalOutputHandler[] = [];

  // ── Constructor ───────────────────────────────────────────────────────────

  /**
   * Create a PaneStreamConsumer.
   *
   * @param opts - Optional tuning.  See {@link PaneStreamConsumerOptions}.
   */
  constructor(opts?: PaneStreamConsumerOptions) {
    this.#capBytes = opts?.preSubBufferCapBytes ?? PRE_SUB_BUFFER_CAP_BYTES;
  }

  // ── Core delivery ──────────────────────────────────────────────────────────

  /**
   * Push a decoded `(paneId, bytes)` frame into the consumer.
   *
   * This is the core intake method.  Normally called by the connector returned
   * from `connectPaneStream`, but can also be called directly in tests.
   *
   * Ordering: handlers for `paneId` receive chunks in the order `push` is
   * called.  Within a single `push` call, per-pane handlers fire first, then
   * global handlers.
   *
   * Non-UTF-8 safe: `bytes` is forwarded as-is, never stringified.
   */
  push(paneId: PaneId, bytes: Uint8Array): void {
    const handlers = this.#paneHandlers.get(paneId);

    if (handlers === undefined || handlers.length === 0) {
      // No per-pane handler yet — buffer the chunk, enforcing the byte cap.
      let buf = this.#preSub.get(paneId);
      if (buf === undefined) {
        buf = [];
        this.#preSub.set(paneId, buf);
        this.#preSubBytes.set(paneId, 0);
      }

      // If the incoming chunk alone exceeds the cap, keep only its tail so we
      // store exactly capBytes of the most-recent data.
      const incomingBytes = bytes.length > this.#capBytes
        ? bytes.subarray(bytes.length - this.#capBytes)
        : bytes;

      // Evict oldest chunks until there is room for the incoming chunk.
      let total = this.#preSubBytes.get(paneId)!;
      while (buf.length > 0 && total + incomingBytes.length > this.#capBytes) {
        total -= buf.shift()!.length;
      }
      buf.push(incomingBytes);
      this.#preSubBytes.set(paneId, total + incomingBytes.length);
    } else {
      // Deliver to all per-pane handlers in registration order.
      for (const h of handlers) {
        h(bytes);
      }
    }

    // Global handlers always receive live frames.
    for (const g of this.#globalHandlers) {
      g(paneId, bytes);
    }
  }

  // ── Per-pane subscription ──────────────────────────────────────────────────

  /**
   * Register a handler for output bytes from a specific pane.
   *
   * If there are pre-subscription bytes buffered for `paneId` (bytes that
   * arrived before this call), they are flushed synchronously to `handler`
   * in order before any future live frames arrive.  This ensures no output
   * is lost regardless of when the renderer subscribes.
   *
   * Multiple handlers may be registered for the same pane; all receive every
   * chunk in registration order.
   *
   * @param paneId  - The pane to subscribe to.
   * @param handler - Called with each raw `Uint8Array` chunk, in arrival order.
   * @returns An unsubscribe function.  Call it to deregister the handler.
   *          After unsubscribing, future frames are no longer delivered.
   *          If this was the last handler for the pane, new frames will be
   *          buffered again until a new handler is registered.
   */
  onPaneOutput(paneId: PaneId, handler: PaneOutputHandler): () => void {
    let handlers = this.#paneHandlers.get(paneId);
    if (handlers === undefined) {
      handlers = [];
      this.#paneHandlers.set(paneId, handlers);
    }

    handlers.push(handler);

    // Flush pre-subscription buffer to this handler (and any others already
    // registered for this pane).  We flush only to the newly registered handler
    // here — any previously registered handlers already received these bytes
    // when they subscribed (or were already present when the bytes arrived and
    // the bytes went directly to them).
    //
    // Implementation note: the first handler for a pane flushes the entire
    // buffered backlog.  A second handler registering later does NOT receive
    // the backlog (it was already delivered to the first).  This matches the
    // "don't lose initial output" acceptance criterion: at least one handler
    // always gets the full stream.
    const buffered = this.#preSub.get(paneId);
    if (buffered !== undefined && buffered.length > 0) {
      // Drain the buffer to this new handler only (subsequent handlers see only
      // live frames — they missed the pre-subscription window).
      const toDeliver = buffered.splice(0);
      for (const chunk of toDeliver) {
        handler(chunk);
      }
      // Buffer is now empty; remove the entries so future frames go live.
      this.#preSub.delete(paneId);
      this.#preSubBytes.delete(paneId);
    }

    return () => {
      const list = this.#paneHandlers.get(paneId);
      if (list === undefined) return;
      const idx = list.indexOf(handler);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    };
  }

  // ── Global subscription ───────────────────────────────────────────────────

  /**
   * Register a handler that receives output bytes for ALL panes.
   *
   * The handler receives only live frames (frames arriving after registration).
   * Pre-subscription buffering does NOT apply: bytes that arrived before this
   * call are not replayed.  Use `onPaneOutput` if you need pre-subscription
   * bytes for a specific pane.
   *
   * Called after all per-pane handlers have fired for the same frame.
   *
   * @param handler - Called with `(paneId, bytes)` for every live frame.
   * @returns An unsubscribe function.
   */
  onOutput(handler: GlobalOutputHandler): () => void {
    this.#globalHandlers.push(handler);
    return () => {
      const idx = this.#globalHandlers.indexOf(handler);
      if (idx !== -1) {
        this.#globalHandlers.splice(idx, 1);
      }
    };
  }

  // ── Buffered-bytes accessor ────────────────────────────────────────────────

  /**
   * Return a copy of all bytes buffered for a pane that has no handler yet,
   * as a single concatenated `Uint8Array`.
   *
   * Returns `undefined` if no bytes are buffered for the pane (either no frames
   * have arrived yet, or a handler was already registered and the buffer was
   * flushed).
   *
   * This is a COPY — mutations do not affect the internal buffer.
   *
   * Typical use: introspection/debugging.  Normal renderers use `onPaneOutput`,
   * which flushes the buffer automatically on registration.
   */
  getBuffered(paneId: PaneId): Uint8Array | undefined {
    const chunks = this.#preSub.get(paneId);
    if (chunks === undefined || chunks.length === 0) return undefined;

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Connector — wires a SessionProxyConnection to a PaneStreamConsumer
// ---------------------------------------------------------------------------

/**
 * Wire a `SessionProxyConnection` to a `PaneStreamConsumer`.
 *
 * Registers `consumer.push` as the connection's `onData` handler so that all
 * post-handshake data-plane frames are routed through the consumer.
 *
 * MUST be called AFTER `await conn.connect()` to avoid racing with the
 * handshake-time message buffer.  Frames buffered during the handshake are
 * drained synchronously inside `connect()` before it resolves; they will be
 * delivered to the consumer immediately via `push`.
 *
 * Note: `SessionProxyConnection.onData` replaces any previously registered handler.
 * Call `disconnect()` (the returned function) before registering a different
 * handler on the same connection, or use only one consumer per connection.
 *
 * @param conn     - A connected `SessionProxyConnection` (state must be "ready").
 * @param consumer - The `PaneStreamConsumer` to receive frames.
 * @returns A disconnect function.  Call it to stop routing frames to `consumer`.
 *          After disconnect, the connection's `onData` handler is replaced with
 *          a no-op so it no longer buffers internally either.
 */
export function connectPaneStream(
  conn: SessionProxyConnection,
  consumer: PaneStreamConsumer,
): () => void {
  conn.onData((paneId, bytes) => {
    consumer.push(paneId, bytes);
  });

  return () => {
    // Replace with a no-op.  Cannot remove the handler entirely (the transport
    // interface has no "removeHandler" concept — each onData call replaces).
    conn.onData(() => {
      // disconnected
    });
  };
}
