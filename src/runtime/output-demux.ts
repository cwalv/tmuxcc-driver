/**
 * Output demux — pipe %output bytes to per-client data-plane frames (tc-fbz).
 *
 * # Architecture
 *
 * The runtime pipeline stores %output/%extended-output bytes in a
 * `PaneBufferStore` via the reducer's `ctx.buffers.append(paneId, bytes)` call.
 * The demux intercepts each `append` and immediately fans the raw bytes out to
 * all currently-attached client `Transport`s via `transport.sendData(paneId,
 * bytes)`.
 *
 * # How to wire it
 *
 * ```ts
 * // 1. Create the demux (and its tapped store) BEFORE creating the pipeline.
 * const demux = createOutputDemux();
 *
 * // 2. Pass `demux.store` to the pipeline so the reducer writes into it.
 * const pipeline = createRuntimePipeline(host, { buffers: demux.store });
 *
 * // 3. When a client connects, attach its daemon-side transport endpoint.
 * const unsub = demux.attachTransport(daemonTransport);
 * // When the client disconnects:
 * unsub();           // or: demux.detachTransport(daemonTransport)
 *
 * // 4. Optionally pause/resume a pane's data-plane output (tc-1ho flow ctrl).
 * demux.pausePane(paneId);
 * demux.resumePane(paneId);
 * ```
 *
 * # Transport layer
 *
 * The demux calls `transport.sendData(paneId, bytes)` on each attached
 * transport.  The `Transport` interface (wire/transport.ts) is responsible for
 * binary framing (`encodeFrame` in framing.ts) — the demux does NOT call
 * `encodeFrame` directly.  This keeps the demux decoupled from the wire
 * framing format; both the in-memory transport (for tests) and a real socket
 * transport handle serialisation identically from the demux's perspective.
 *
 * # Byte-exactness
 *
 * `bytes` passed through `append` → `sendData` are the same `Uint8Array`
 * produced by `decodeOutputPayload` in the reducer — raw binary, never
 * decoded to a string.  Non-UTF-8 bytes (e.g. [0xFF, 0x00, 0xFE]) pass
 * through unmodified.  NEVER stringify or base64-encode this data.
 *
 * # Per-pane sequencing
 *
 * `encodeFrame` requires a per-pane monotonically-increasing `seq` counter.
 * Because this demux delegates framing to the `Transport` implementation,
 * sequence tracking is the transport's responsibility.  If a future bead
 * calls `encodeFrame` directly here, add a `Map<PaneId, number>` counter and
 * increment before each `encodeFrame` call.  The `append` tap in the tapped
 * store is the correct injection point for that.
 *
 * # Flow-control seam (tc-1ho)
 *
 * tc-1ho (flow control) intercepts output by calling `demux.pausePane(id)`
 * before bytes pile up.  While paused, bytes are still written to the inner
 * scrollback store (for snapshots) but are NOT fanned out to transports.
 * tc-1ho calls `demux.resumePane(id)` once the client has caught up.
 *
 * For per-client pause granularity (pause pane X only for client Y), extend
 * the API to `pausePane(id, transport?)` — the fan-out loop in the tapped
 * store's `append` is the right place to filter by transport.
 *
 * @module runtime/output-demux
 */

import { createPaneBufferStore } from "../state/scrollback.js";
import type { PaneBufferStore } from "../state/scrollback.js";
import type { Transport } from "../wire/transport.js";
import type { PaneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `createOutputDemux`.
 */
export interface OutputDemuxOptions {
  /**
   * Optional existing `PaneBufferStore` to wrap as the inner scrollback store.
   * Defaults to a new store created by `createPaneBufferStore()`.
   * Supplying your own lets you share the store with test assertions or
   * another component (e.g. the snapshot projection, tc-7gp).
   */
  innerStore?: PaneBufferStore;
}

/**
 * Demuxes %output bytes from the runtime pipeline to per-client transports.
 *
 * Obtain via `createOutputDemux()`.  Pass `demux.store` as `opts.buffers` to
 * `createRuntimePipeline` so the reducer writes into it.
 */
export interface OutputDemux {
  /**
   * The tapped `PaneBufferStore` to pass as `opts.buffers` to
   * `createRuntimePipeline`.
   *
   * Every `append(paneId, bytes)` call from the reducer:
   *   1. Writes bytes to the inner scrollback store (for snapshots / tc-7gp).
   *   2. Fans bytes out to all attached transports' data planes, unless the
   *      pane is paused.
   */
  readonly store: PaneBufferStore;

  /**
   * Attach a client transport to receive all future pane output.
   *
   * Returns an unsubscribe function — call it when the client disconnects.
   * Equivalent to `demux.detachTransport(transport)`.
   *
   * @param transport - The daemon-side half of an `InMemoryTransportPair` (or
   *   a real socket transport).  Bytes sent via `sendData` on this endpoint
   *   arrive on the `client` endpoint's `onData` handler.
   */
  attachTransport(transport: Transport): () => void;

  /**
   * Remove a previously-attached transport from the fan-out.  Idempotent.
   */
  detachTransport(transport: Transport): void;

  /**
   * Pause data-plane fan-out for a pane.
   *
   * While paused, `append` calls for that pane still update the scrollback
   * store but are NOT sent to any attached transport.  tc-1ho (flow control)
   * calls this before issuing a tmux pause-pane command.
   */
  pausePane(paneId: PaneId): void;

  /**
   * Resume data-plane fan-out for a previously-paused pane.
   *
   * Subsequent `append` calls for that pane will again fan out to all
   * transports.  tc-1ho calls this after the client acknowledges the backlog.
   */
  resumePane(paneId: PaneId): void;

  /**
   * Whether a pane is currently paused.  For testing and diagnostics.
   */
  isPanePaused(paneId: PaneId): boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an `OutputDemux`.
 *
 * The demux wraps a `PaneBufferStore` with a tap that fans out each
 * `append(paneId, bytes)` to all attached `Transport`s via
 * `transport.sendData(paneId, bytes)`.
 *
 * Wire ordering:
 *   1. `createOutputDemux()` — build demux + tapped store.
 *   2. `createRuntimePipeline(host, { buffers: demux.store })` — reducer
 *      writes into the tapped store.
 *   3. `demux.attachTransport(t)` per connected client — subscribe to output.
 *
 * @param opts - Optional options (custom inner store).
 * @returns An `OutputDemux` whose `store` must be supplied to the pipeline.
 */
export function createOutputDemux(opts: OutputDemuxOptions = {}): OutputDemux {
  const _inner: PaneBufferStore = opts.innerStore ?? createPaneBufferStore();
  const _transports = new Set<Transport>();
  const _pausedPanes = new Set<PaneId>();

  // ---------------------------------------------------------------------------
  // Tapped PaneBufferStore
  //
  // Every method delegates to _inner.  The tap fires in `append` to fan output
  // out to attached transports (unless the pane is paused).
  // ---------------------------------------------------------------------------

  const store: PaneBufferStore = {
    append(paneId: PaneId, bytes: Uint8Array): void {
      // Always write to the inner scrollback store (for snapshots + tc-7gp).
      _inner.append(paneId, bytes);

      // Skip fan-out if: pane paused, no bytes, or no transports attached.
      if (_pausedPanes.has(paneId)) return;
      if (bytes.length === 0) return;
      if (_transports.size === 0) return;

      // Fan out to all attached transports — byte-exact, no copy or stringify.
      for (const transport of _transports) {
        transport.sendData(paneId, bytes);
      }
    },

    getContents(paneId: PaneId): Uint8Array {
      return _inner.getContents(paneId);
    },

    size(paneId: PaneId): number {
      return _inner.size(paneId);
    },

    drop(paneId: PaneId): void {
      _inner.drop(paneId);
    },

    clear(): void {
      _inner.clear();
    },
  };

  return {
    store,

    attachTransport(transport: Transport): () => void {
      _transports.add(transport);
      return () => _transports.delete(transport);
    },

    detachTransport(transport: Transport): void {
      _transports.delete(transport);
    },

    pausePane(paneId: PaneId): void {
      _pausedPanes.add(paneId);
    },

    resumePane(paneId: PaneId): void {
      _pausedPanes.delete(paneId);
    },

    isPanePaused(paneId: PaneId): boolean {
      return _pausedPanes.has(paneId);
    },
  };
}
