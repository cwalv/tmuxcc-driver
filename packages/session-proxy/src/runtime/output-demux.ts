/**
 * Output demux — pipe %output bytes to per-client data-plane frames (tc-fbz).
 *
 * # Architecture
 *
 * The runtime pipeline stores %output/%extended-output bytes in a
 * `PaneBufferStore` via `buffers.append(paneId, bytes)`. The demux intercepts
 * each `append` and fans the raw bytes out to all currently-attached client
 * `Transport`s via `transport.sendData(paneId, bytes)`.
 *
 * # Pane-tracking is always on (post tc-128.4)
 *
 * Under the requery-driven topology pipeline (tc-128) a `%output` frame can
 * arrive for a pane that the model has not learned about yet — the requery
 * loses the race against the in-order notification stream. To avoid leaking
 * bytes for a foreign pane (bind-on-provenance, tc-zna.9) or shipping data
 * frames before the corresponding `pane.opened` delta, the demux always
 * stages bytes for unknown panes in a bounded per-pane buffer until the
 * model announces the pane via `notifyPaneBound`.
 *
 * The pre-tc-128.4 opt-in (`activatePaneTracking()`) and the legacy
 * pass-through mode it gated are gone. Test harnesses that assemble a demux
 * directly now MUST notify it of any panes they expect to receive bytes for —
 * see the `notifyPaneBound` example below or the integration suite for the
 * pattern.
 *
 * # How to wire it
 *
 * ```ts
 * // 1. Create the demux BEFORE the pipeline.
 * const demux = createOutputDemux();
 *
 * // 2. Pass demux.store to the pipeline so it appends through the demux's tap.
 * const pipeline = createRuntimePipeline(host, { buffers: demux.store });
 *
 * // 3. Subscribe to pipeline.onModelChange to keep the known-pane set in sync:
 * pipeline.onModelChange((next, prev) => {
 *   for (const pid of next.panes.keys()) {
 *     if (!demux.isPaneKnown(pid)) demux.notifyPaneBound(pid);
 *   }
 *   for (const pid of prev.panes.keys()) {
 *     if (!next.panes.has(pid)) demux.notifyPaneClosed(pid);
 *   }
 * });
 *
 * // 4. When a client connects, attach its session-proxy-side transport endpoint.
 * const unsub = demux.attachTransport(sessionProxyTransport);
 * // When the client disconnects:
 * unsub();
 *
 * // 5. Optionally pause/resume a pane's data-plane output (tc-1ho flow ctrl).
 * demux.pausePane(paneId);
 * demux.resumePane(paneId);
 * ```
 *
 * # Transport layer
 *
 * The demux calls `transport.sendData(paneId, bytes)` on each attached
 * transport.  The `Transport` interface (wire/transport.ts) is responsible for
 * binary framing (`encodeFrame` in framing.ts) — the demux does NOT call
 * `encodeFrame` directly.
 *
 * # Byte-exactness
 *
 * `bytes` passed through `append` → `sendData` are the same `Uint8Array`
 * produced by `decodeOutputPayload` in the pipeline — raw binary, never
 * decoded to a string.
 *
 * # Output-before-topology buffering (tc-128.3 + tc-128.4)
 *
 * Bytes for a pane that is not yet known are staged in a bounded per-pane
 * buffer (`MAX_PENDING_BYTES_PER_PANE` = 128 KiB). On bind, the staged bytes
 * are flushed to all transports in order, deferred by one microtask so that
 * the synchronous `pane.opened` control-plane delta reaches the client first.
 * Foreign panes (created by another tmux client; bind-on-provenance,
 * tc-zna.9) may never be bound — their buffered bytes are dropped when the
 * pane is closed or the overflow limit is reached, and the content-plane
 * recapture-on-bind contract (a `capture-pane` snapshot when a pane is first
 * served) covers the gap.
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

  /**
   * Called when bytes are dropped from the bounded pre-topology buffer
   * (tc-3si.5). Provenance is **deferred**: the demux accumulates drops
   * per unknown pane, then settles them when the pane is either bound
   * (`notifyPaneBound` → `provenance="owned"`, the F4 symptom — bytes for
   * a pane WE OWN were thrown away) or closed without ever being bound
   * (`notifyPaneClosed` → `provenance="foreign"`, legitimate under
   * bind-on-provenance).
   *
   * This separation is load-bearing: at drop time we don't yet know
   * whether the pane is owned or foreign, so eagerly attributing would
   * bias every overflow as foreign (the model lag IS exactly the gap the
   * staging buffer is designed to bridge). Deferring keeps the `owned`
   * tripwire honest.
   *
   * Hot-path cost: zero (deferred); the counter is bumped at most once
   * per pane-bind / pane-close edge.
   *
   * Throws are caught and swallowed by the demux's wiring so a
   * misbehaving observer cannot break the data plane.
   */
  onPretopologyDropped?: (bytes: number, provenance: "owned" | "foreign") => void;
}

/**
 * Demuxes %output bytes from the runtime pipeline to per-client transports.
 *
 * Obtain via `createOutputDemux()`. Pass `demux.store` as `opts.buffers` to
 * `createRuntimePipeline` so the pipeline appends pane bytes through it.
 */
export interface OutputDemux {
  /**
   * The tapped `PaneBufferStore` to pass as `opts.buffers` to
   * `createRuntimePipeline`.
   *
   * Every `append(paneId, bytes)` call from the pipeline:
   *   1. Writes bytes to the inner scrollback store (for snapshots / tc-7gp).
   *   2. If the pane is known (announced via `notifyPaneBound`): fans bytes
   *      out to all attached transports, unless the pane is paused.
   *   3. If the pane is unknown: stages bytes in the per-pane staging buffer
   *      (bounded by `MAX_PENDING_BYTES_PER_PANE`); excess is dropped with
   *      a warning.
   */
  readonly store: PaneBufferStore;

  /**
   * Attach a client transport to receive all future pane output.
   *
   * Returns an unsubscribe function — call it when the client disconnects.
   * Equivalent to `demux.detachTransport(transport)`.
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
   */
  resumePane(paneId: PaneId): void;

  /**
   * Whether a pane is currently paused.  For testing and diagnostics.
   */
  isPanePaused(paneId: PaneId): boolean;

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
   * Idempotent: calling for an already-known pane is a no-op.
   */
  notifyPaneBound(paneId: PaneId): void;

  /**
   * Notify the demux that `paneId` has been removed from the topology model.
   *
   * The demux marks the pane as unknown and discards any staged bytes.
   *
   * Idempotent: calling for an already-unknown pane is a no-op.
   */
  notifyPaneClosed(paneId: PaneId): void;

  /**
   * Number of bytes currently staged for an unknown pane.
   * Exposed for testing and diagnostics only.
   */
  pendingBytes(paneId: PaneId): number;

  /**
   * Whether `paneId` is currently considered known by the demux.
   * Exposed for testing and diagnostics only.
   */
  isPaneKnown(paneId: PaneId): boolean;
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
 *   2. `createRuntimePipeline(host, { buffers: demux.store })` — pipeline
 *      writes pane bytes into the tapped store.
 *   3. `demux.attachTransport(t)` per connected client — subscribe to output.
 *   4. Subscribe to `pipeline.onModelChange` and call
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
  const _onPretopologyDropped = opts.onPretopologyDropped;

  /**
   * Per-pane accumulator of bytes dropped from the pre-topology buffer
   * (tc-3si.5). Holds the total dropped count for each pane that has
   * overflowed; settled to the `owned` or `foreign` provenance bucket when
   * the pane is later bound or closed.
   */
  const _pendingDroppedBytes = new Map<PaneId, number>();

  function _settleDroppedBytes(paneId: PaneId, provenance: "owned" | "foreign"): void {
    const bytes = _pendingDroppedBytes.get(paneId);
    if (bytes === undefined || bytes <= 0) return;
    _pendingDroppedBytes.delete(paneId);
    if (_onPretopologyDropped === undefined) return;
    try {
      _onPretopologyDropped(bytes, provenance);
    } catch {
      // Observer errors must not break the data plane.
    }
  }

  // ---------------------------------------------------------------------------
  // Pane-tracking state (always on, tc-128.4).
  //
  // _knownPanes: the set of pane IDs the topology model has announced.
  //   Starts empty. Panes are added via notifyPaneBound and removed via
  //   notifyPaneClosed. Fan-out to transports only happens for known panes.
  //
  // _pendingFanout: per-pane staging buffer for bytes that arrived before
  //   the topology model knew about the pane. Bounded per pane by
  //   MAX_PENDING_BYTES_PER_PANE; overflow is dropped with a console.warn.
  //
  // _pendingFanoutBytes: running total bytes buffered per pane.
  //
  // _pendingFanoutOverflowed: tracks which panes have already had their first
  //   overflow warning emitted so that subsequent overflow drops are silent.
  // ---------------------------------------------------------------------------

  const _knownPanes = new Set<PaneId>();
  const _pendingFanout = new Map<PaneId, Uint8Array[]>();
  const _pendingFanoutBytes = new Map<PaneId, number>();
  const _pendingFanoutOverflowed = new Set<PaneId>();

  function _fanOut(paneId: PaneId, bytes: Uint8Array): void {
    // sendData MAY return a Promise<void> when the underlying transport is
    // backpressured. Per session-proxy.ts's accountingStore wrapper, the
    // noteDrained call is chained off that Promise; we just need to NOT
    // swallow it. The PaneBufferStore.append contract is synchronous, so
    // we drop the Promise reference here.
    for (const transport of _transports) {
      void transport.sendData(paneId, bytes);
    }
  }

  const store: PaneBufferStore = {
    append(paneId: PaneId, bytes: Uint8Array): void {
      // Always write to the inner scrollback store (for snapshots + tc-7gp).
      _inner.append(paneId, bytes);

      if (bytes.length === 0) return;

      if (_knownPanes.has(paneId)) {
        // Known to the topology model — fan out immediately (unless paused
        // or no transports attached).
        if (_pausedPanes.has(paneId)) return;
        if (_transports.size === 0) return;
        _fanOut(paneId, bytes);
        return;
      }

      // Pane not yet known — stage bytes in the pre-topology buffer.
      const current = _pendingFanoutBytes.get(paneId) ?? 0;
      const wouldBe = current + bytes.length;

      if (wouldBe > MAX_PENDING_BYTES_PER_PANE) {
        if (!_pendingFanoutOverflowed.has(paneId)) {
          _pendingFanoutOverflowed.add(paneId);
          console.warn(
            `[output-demux] pre-topology buffer overflow for unknown pane ${paneId}` +
            ` (staged ${current} bytes + ${bytes.length} bytes exceeds ${MAX_PENDING_BYTES_PER_PANE} byte limit);` +
            ` dropping ${bytes.length} bytes. Recapture-on-bind will restore content.`,
          );
        }
        // tc-3si.5: accumulate the dropped byte count; provenance is
        // resolved at bind / close time. Counter increments are deferred
        // off the hot path — at most one per pane edge.
        _pendingDroppedBytes.set(paneId, (_pendingDroppedBytes.get(paneId) ?? 0) + bytes.length);
        return;
      }

      let chunks = _pendingFanout.get(paneId);
      if (chunks === undefined) {
        chunks = [];
        _pendingFanout.set(paneId, chunks);
      }
      chunks.push(bytes);
      _pendingFanoutBytes.set(paneId, wouldBe);
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

    notifyPaneBound(paneId: PaneId): void {
      if (_knownPanes.has(paneId)) return; // already known — idempotent
      _knownPanes.add(paneId);

      // tc-3si.5: the pane is OWNED — credit any accumulated dropped bytes
      // to provenance=owned (the F4 symptom — bytes for a pane we own were
      // thrown away). The drops happened ALREADY, before this bind; this
      // is just the deferred attribution.
      _settleDroppedBytes(paneId, "owned");

      // Flush any staged bytes to all attached transports, deferred by one
      // microtask so that control-plane model-change handlers (which send
      // `pane.opened` to clients) have a chance to fire first.
      const chunks = _pendingFanout.get(paneId);
      _pendingFanout.delete(paneId);
      _pendingFanoutBytes.delete(paneId);

      if (chunks !== undefined && chunks.length > 0) {
        queueMicrotask(() => {
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
      // tc-3si.5: if the pane is closing WITHOUT ever being bound
      // (knownPanes never picked it up), any accumulated drops are
      // FOREIGN. If it WAS bound, the owned settlement already happened
      // inside notifyPaneBound; the entry has been cleared so the
      // _settleDroppedBytes call here is a no-op in that case.
      const wasKnown = _knownPanes.has(paneId);
      _settleDroppedBytes(paneId, wasKnown ? "owned" : "foreign");

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
  };
}
