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
 * // 3. When a client connects, attach its session-proxy-side transport endpoint.
 * const unsub = demux.attachTransport(sessionProxyTransport);
 * // When the client disconnects:
 * unsub();           // or: demux.detachTransport(sessionProxyTransport)
 *
 * // 4. Optionally pause/resume a pane's data-plane output (tc-1ho flow ctrl).
 * demux.pausePane(paneId);
 * demux.resumePane(paneId);
 *
 * // 5. (tc-128.3) To enable output-before-topology buffering, call
 * //    activatePaneTracking() once at startup, then notify the demux when
 * //    panes appear/disappear from the model:
 * demux.activatePaneTracking();
 * demux.notifyPaneBound(paneId);   // when a pane appears in the model
 * demux.notifyPaneClosed(paneId);  // when a pane is removed from the model
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
 * # Output-before-topology buffering (tc-128.3)
 *
 * Under requery (tc-128), a `%output` event can arrive for a pane whose ID is
 * not yet in the model (the requery snapshot loses the race against the
 * in-order notification stream). The same race exists during bootstrap: the
 * bootstrap coordinator buffers topology notifications while awaiting the
 * list-windows / list-panes replies, so the first `%output` bytes for a new
 * pane may arrive before the model knows about it.
 *
 * Rather than forwarding bytes for an unknown pane to transports (which would
 * arrive before the `pane.opened` delta the client needs to interpret them),
 * the demux can hold them in a bounded per-pane staging buffer until the model
 * announces the pane via `notifyPaneBound`. On bind, the staged bytes are
 * flushed in order to all transports, immediately following the `pane.opened`
 * delta (which the control-plane server sends synchronously in the same
 * model-change tick). If the buffer overflows `MAX_PENDING_BYTES_PER_PANE`
 * before the pane is bound, the excess is dropped and the overflow is logged:
 * the content-plane recapture-on-bind contract (a `capture-pane` snapshot is
 * sent to the client when a pane is first served) makes the client whole again
 * for the missing bytes.
 *
 * **Activation**: pane tracking is OPT-IN via `activatePaneTracking()`. Before
 * this call, the demux fans out bytes for ALL pane IDs immediately (legacy
 * pass-through behaviour). After the call, bytes for unknown panes are staged
 * until `notifyPaneBound` promotes them to known. This lets existing unit tests
 * and manually-assembled test harnesses work without pane-tracking wiring,
 * while `createSessionProxy` opts in for production.
 *
 * Foreign panes (created by another tmux client; bind-on-provenance, tc-zna.9)
 * may never become known. Their buffered bytes are dropped and logged when
 * the overflow limit is reached. `notifyPaneClosed` discards any staging
 * buffer when a pane is removed from the model — this covers the case where a
 * pane is created and destroyed between two requery cycles without ever being
 * seen by a client.
 *
 * The wiring in `session-proxy.ts` calls `activatePaneTracking()` once and
 * then calls `notifyPaneBound` / `notifyPaneClosed` from a
 * `pipeline.onModelChange` subscriber, so the topology and content planes
 * converge in the same event-loop tick.
 *
 * @module runtime/output-demux
 */

import { createPaneBufferStore } from "../state/scrollback.js";
import type { PaneBufferStore } from "../state/scrollback.js";
import type { Transport } from "../wire/transport.js";
import type { PaneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of bytes buffered per unknown pane before overflow-drop.
 *
 * Sized to hold roughly 1–2 s of typical terminal output (~50 KiB/s) with
 * generous headroom.  Once exceeded the excess bytes are dropped; the
 * content-plane recapture-on-bind (capture-pane snapshot) fills the client in
 * when the pane eventually becomes known.
 */
const MAX_PENDING_BYTES_PER_PANE = 128 * 1024; // 128 KiB

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
   *   2. If pane tracking is NOT active (see `activatePaneTracking`):
   *      fans bytes out to all attached transports immediately, unless paused.
   *   3. If pane tracking IS active AND the pane is known (announced via
   *      `notifyPaneBound`): fans bytes out immediately, unless paused.
   *   4. If pane tracking IS active AND the pane is unknown: stages the bytes
   *      in the per-pane staging buffer (bounded by `MAX_PENDING_BYTES_PER_PANE`);
   *      excess is dropped with a warning.
   */
  readonly store: PaneBufferStore;

  /**
   * Attach a client transport to receive all future pane output.
   *
   * Returns an unsubscribe function — call it when the client disconnects.
   * Equivalent to `demux.detachTransport(transport)`.
   *
   * @param transport - The session-proxy-side half of an `InMemoryTransportPair` (or
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

  /**
   * Activate output-before-topology buffering (tc-128.3).
   *
   * After this call, bytes for pane IDs not yet announced via `notifyPaneBound`
   * are staged in a bounded buffer rather than being fanned out immediately.
   * The buffer is flushed when the pane is announced (or dropped on overflow).
   *
   * Before this call, all appends fan out immediately regardless of pane
   * membership (legacy pass-through behaviour — safe for tests that don't
   * track the model).
   *
   * Called once by `createSessionProxy` at startup.  Idempotent.
   */
  activatePaneTracking(): void;

  /**
   * Notify the demux that `paneId` is now known to the topology model.
   *
   * Called from `pipeline.onModelChange` when a new pane appears in the
   * session model (either from bootstrap or a requery diff).  The demux will:
   *   1. Mark the pane as known (future `append` calls fan out immediately).
   *   2. Flush any bytes staged in the pre-topology buffer to all attached
   *      transports in arrival order, deferred by one microtask to ensure
   *      the control-plane `pane.opened` delta reaches clients first.
   *
   * No-op if pane tracking is not active (see `activatePaneTracking`).
   * Idempotent: calling for an already-known pane is a no-op.
   */
  notifyPaneBound(paneId: PaneId): void;

  /**
   * Notify the demux that `paneId` has been removed from the topology model.
   *
   * Called from `pipeline.onModelChange` when a pane disappears from the
   * session model.  The demux will:
   *   1. Mark the pane as unknown.
   *   2. Discard any bytes staged in the pre-topology buffer for this pane.
   *
   * No-op if pane tracking is not active.
   * Idempotent: calling for an already-unknown pane is a no-op.
   */
  notifyPaneClosed(paneId: PaneId): void;

  /**
   * Number of bytes currently staged for an unknown pane.
   * Returns 0 for known, unseen, or if pane tracking is not active.
   * Exposed for testing and diagnostics only.
   */
  pendingBytes(paneId: PaneId): number;

  /**
   * Whether `paneId` is currently considered known by the demux.
   * Always returns false if pane tracking is not active.
   * Exposed for testing and diagnostics only.
   */
  isPaneKnown(paneId: PaneId): boolean;

  /**
   * Whether pane tracking has been activated via `activatePaneTracking()`.
   * Exposed for testing and diagnostics only.
   */
  isPaneTrackingActive(): boolean;
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
 *   4. (tc-128.3) `demux.activatePaneTracking()` — opt into buffering.
 *   5. (tc-128.3) Subscribe to `pipeline.onModelChange` and call
 *      `demux.notifyPaneBound` / `demux.notifyPaneClosed` to keep the
 *      known-pane set in sync.
 *
 * @param opts - Optional options (custom inner store).
 * @returns An `OutputDemux` whose `store` must be supplied to the pipeline.
 */
export function createOutputDemux(opts: OutputDemuxOptions = {}): OutputDemux {
  const _inner: PaneBufferStore = opts.innerStore ?? createPaneBufferStore();
  const _transports = new Set<Transport>();
  const _pausedPanes = new Set<PaneId>();

  // ---------------------------------------------------------------------------
  // Pane-tracking state (tc-128.3)
  //
  // _trackingActive: false until activatePaneTracking() is called. When false,
  //   all appends fan out immediately (legacy pass-through).
  //
  // _knownPanes: the set of pane IDs the topology model has announced.
  //   Starts empty. Panes are added via notifyPaneBound and removed via
  //   notifyPaneClosed. Fan-out to transports only happens for known panes
  //   when tracking is active.
  //
  // _pendingFanout: per-pane staging buffer for bytes that arrived before
  //   the topology model knew about the pane. Bounded per pane by
  //   MAX_PENDING_BYTES_PER_PANE; overflow is dropped with a console.warn.
  //   Entries are deleted when the pane is bound (flushed) or closed
  //   (discarded).
  //
  // _pendingFanoutBytes: running total bytes buffered per pane, used to
  //   enforce the overflow limit without iterating all chunks.
  //
  // _pendingFanoutOverflowed: tracks which panes have already had their first
  //   overflow warning emitted so that subsequent overflow drops are silent.
  // ---------------------------------------------------------------------------

  let _trackingActive = false;
  const _knownPanes = new Set<PaneId>();
  const _pendingFanout = new Map<PaneId, Uint8Array[]>();
  const _pendingFanoutBytes = new Map<PaneId, number>();
  const _pendingFanoutOverflowed = new Set<PaneId>();

  // ---------------------------------------------------------------------------
  // Internal: fan out bytes to all transports for a known, unpaused pane.
  // ---------------------------------------------------------------------------

  function _fanOut(paneId: PaneId, bytes: Uint8Array): void {
    // sendData MAY return a Promise<void> when the underlying transport is
    // backpressured (kernel send buffer full).  Per the upstream session-proxy's
    // accountingStore wrapper (session-proxy.ts addClient), the noteDrained call
    // is chained off that Promise; we just need to NOT swallow it.  The
    // PaneBufferStore.append contract is synchronous (legacy callers do not
    // await), so we drop the Promise reference here — fc.noteDrained still
    // fires correctly because session-proxy.ts chains it off the same Promise.
    //
    // tc-7xv.6 / tc-7xv.24 wedge fix: callers of demux.store.append that DO
    // care about backpressure (e.g. a future smarter pipeline) can switch to
    // an awaiting append; the contract upgrade is straightforward.
    for (const transport of _transports) {
      void transport.sendData(paneId, bytes);
    }
  }

  // ---------------------------------------------------------------------------
  // Tapped PaneBufferStore
  //
  // Every method delegates to _inner.  The tap fires in `append` to either
  // fan output out to attached transports (pass-through or known pane) or
  // stage it in the pre-topology buffer (tracking active + unknown pane).
  // ---------------------------------------------------------------------------

  const store: PaneBufferStore = {
    append(paneId: PaneId, bytes: Uint8Array): void {
      // Always write to the inner scrollback store (for snapshots + tc-7gp).
      _inner.append(paneId, bytes);

      if (bytes.length === 0) return;

      if (!_trackingActive) {
        // Legacy pass-through: fan out immediately for all pane IDs.
        if (_pausedPanes.has(paneId)) return;
        if (_transports.size === 0) return;
        _fanOut(paneId, bytes);
        return;
      }

      if (_knownPanes.has(paneId)) {
        // Pane is known to the topology model — fan out immediately (unless
        // paused or no transports attached).
        if (_pausedPanes.has(paneId)) return;
        if (_transports.size === 0) return;
        _fanOut(paneId, bytes);
      } else {
        // Pane not yet known — stage bytes in the pre-topology buffer.
        const current = _pendingFanoutBytes.get(paneId) ?? 0;
        const wouldBe = current + bytes.length;

        if (wouldBe > MAX_PENDING_BYTES_PER_PANE) {
          if (!_pendingFanoutOverflowed.has(paneId)) {
            // First chunk that pushes us over the limit — emit one warning.
            // Subsequent overflows for this pane are dropped silently.
            _pendingFanoutOverflowed.add(paneId);
            console.warn(
              `[output-demux] pre-topology buffer overflow for unknown pane ${paneId}` +
              ` (staged ${current} bytes + ${bytes.length} bytes exceeds ${MAX_PENDING_BYTES_PER_PANE} byte limit);` +
              ` dropping ${bytes.length} bytes. Recapture-on-bind will restore content.`,
            );
          }
          // Drop this chunk (do not stage it). The scrollback store still has
          // the bytes, so capture-pane at bind time will recover them.
          return;
        }

        // Stage the bytes (within the limit).
        let chunks = _pendingFanout.get(paneId);
        if (chunks === undefined) {
          chunks = [];
          _pendingFanout.set(paneId, chunks);
        }
        chunks.push(bytes);
        _pendingFanoutBytes.set(paneId, wouldBe);
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

    activatePaneTracking(): void {
      _trackingActive = true;
    },

    notifyPaneBound(paneId: PaneId): void {
      if (!_trackingActive) return; // no-op when tracking not active
      if (_knownPanes.has(paneId)) return; // already known — idempotent

      _knownPanes.add(paneId);

      // Flush any staged bytes to all attached transports, deferred by one
      // microtask so that control-plane model-change handlers (which send
      // `pane.opened` to clients) have a chance to fire first.  All
      // model-change handlers run synchronously in the same tick; the
      // microtask fires after they all complete, ensuring clients see
      // `pane.opened` before any flushed data bytes.
      const chunks = _pendingFanout.get(paneId);
      _pendingFanout.delete(paneId);
      _pendingFanoutBytes.delete(paneId);

      if (chunks !== undefined && chunks.length > 0) {
        queueMicrotask(() => {
          // Re-check conditions at flush time: pane may have been closed,
          // paused, or the transport set may have changed in the interim.
          if (!_knownPanes.has(paneId)) return; // pane closed before flush
          if (_pausedPanes.has(paneId)) return; // paused — skip; recapture on bind
          if (_transports.size === 0) return;   // no clients to flush to
          for (const chunk of chunks) {
            _fanOut(paneId, chunk);
          }
        });
      }
    },

    notifyPaneClosed(paneId: PaneId): void {
      if (!_trackingActive) return; // no-op when tracking not active
      _knownPanes.delete(paneId);
      _pendingFanout.delete(paneId);
      _pendingFanoutBytes.delete(paneId);
      _pendingFanoutOverflowed.delete(paneId);
    },

    pendingBytes(paneId: PaneId): number {
      return _pendingFanoutBytes.get(paneId) ?? 0;
    },

    isPaneKnown(paneId: PaneId): boolean {
      return _knownPanes.has(paneId);
    },

    isPaneTrackingActive(): boolean {
      return _trackingActive;
    },
  };
}
