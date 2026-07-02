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
export function createOutputDemux(opts = {}) {
    const _inner = opts.innerStore ?? createPaneBufferStore();
    const _transports = new Set();
    const _pausedPanes = new Set();
    const _onPretopologyDropped = opts.onPretopologyDropped;
    // ---------------------------------------------------------------------------
    // Per-(transport, pane) hydration queues (tc-295a.9).
    //
    // While a transport is hydrating a pane, live %output bytes for that pane are
    // appended to the transport's per-pane queue instead of being fanned out, so
    // they cannot interleave with the clear-then-replay hydration frame the
    // hydrator delivers directly. On endPaneHydration the queue is flushed to the
    // transport in arrival order and removed, resuming live pass-through.
    //
    // Keyed by Transport → (PaneId → ordered chunk list). A transport with no
    // entry (the common case) takes the fast path in _fanOut.
    // ---------------------------------------------------------------------------
    const _hydrating = new Map();
    /**
     * Per-pane accumulator of bytes dropped from the pre-topology buffer
     * (tc-3si.5). Holds the total dropped count for each pane that has
     * overflowed; settled to the `owned` or `foreign` provenance bucket when
     * the pane is later bound or closed.
     */
    const _pendingDroppedBytes = new Map();
    function _settleDroppedBytes(paneId, provenance) {
        const bytes = _pendingDroppedBytes.get(paneId);
        if (bytes === undefined || bytes <= 0)
            return;
        _pendingDroppedBytes.delete(paneId);
        if (_onPretopologyDropped === undefined)
            return;
        try {
            _onPretopologyDropped(bytes, provenance);
        }
        catch {
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
    const _knownPanes = new Set();
    const _pendingFanout = new Map();
    const _pendingFanoutBytes = new Map();
    const _pendingFanoutOverflowed = new Set();
    function _fanOut(paneId, bytes) {
        // sendData MAY return a Promise<void> when the underlying transport is
        // backpressured. Per session-proxy.ts's accountingStore wrapper, the
        // noteDrained call is chained off that Promise; we just need to NOT
        // swallow it. The PaneBufferStore.append contract is synchronous, so
        // we drop the Promise reference here.
        for (const transport of _transports) {
            // tc-295a.9: if this transport is mid-hydration for this pane, queue the
            // bytes instead of fanning out — they must not interleave with the
            // clear-then-replay frame. They are flushed on endPaneHydration.
            const paneQueues = _hydrating.get(transport);
            if (paneQueues !== undefined) {
                const queue = paneQueues.get(paneId);
                if (queue !== undefined) {
                    queue.push(bytes);
                    continue;
                }
            }
            void transport.sendData(paneId, bytes);
        }
    }
    const store = {
        append(paneId, bytes) {
            // Always write to the inner scrollback store (for snapshots + tc-7gp).
            _inner.append(paneId, bytes);
            if (bytes.length === 0)
                return;
            if (_knownPanes.has(paneId)) {
                // Known to the topology model — fan out immediately (unless paused
                // or no transports attached).
                if (_pausedPanes.has(paneId))
                    return;
                if (_transports.size === 0)
                    return;
                _fanOut(paneId, bytes);
                return;
            }
            // Pane not yet known — stage bytes in the pre-topology buffer.
            const current = _pendingFanoutBytes.get(paneId) ?? 0;
            const wouldBe = current + bytes.length;
            if (wouldBe > MAX_PENDING_BYTES_PER_PANE) {
                if (!_pendingFanoutOverflowed.has(paneId)) {
                    _pendingFanoutOverflowed.add(paneId);
                    console.warn(`[output-demux] pre-topology buffer overflow for unknown pane ${paneId}` +
                        ` (staged ${current} bytes + ${bytes.length} bytes exceeds ${MAX_PENDING_BYTES_PER_PANE} byte limit);` +
                        ` dropping ${bytes.length} bytes. Recapture-on-bind will restore content.`);
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
        getContents(paneId) {
            return _inner.getContents(paneId);
        },
        size(paneId) {
            return _inner.size(paneId);
        },
        drop(paneId) {
            _inner.drop(paneId);
        },
        clear() {
            _inner.clear();
        },
    };
    return {
        store,
        attachTransport(transport) {
            _transports.add(transport);
            return () => _transports.delete(transport);
        },
        detachTransport(transport) {
            _transports.delete(transport);
            // tc-295a.9: drop any in-flight hydration queues for this transport —
            // the bytes are gone with the transport (the new spawn rehydrates).
            _hydrating.delete(transport);
        },
        pausePane(paneId) {
            _pausedPanes.add(paneId);
        },
        resumePane(paneId) {
            _pausedPanes.delete(paneId);
        },
        isPanePaused(paneId) {
            return _pausedPanes.has(paneId);
        },
        notifyPaneBound(paneId) {
            if (_knownPanes.has(paneId))
                return; // already known — idempotent
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
                    if (!_knownPanes.has(paneId))
                        return; // pane closed before flush
                    if (_pausedPanes.has(paneId))
                        return; // paused — skip; recapture on bind
                    if (_transports.size === 0)
                        return; // no clients to flush to
                    for (const chunk of chunks) {
                        _fanOut(paneId, chunk);
                    }
                });
            }
        },
        notifyPaneClosed(paneId) {
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
            // tc-295a.9: the pane is gone — discard any per-transport hydration
            // queues for it (the queued live bytes have nowhere to render).
            for (const [transport, paneQueues] of _hydrating) {
                if (paneQueues.delete(paneId) && paneQueues.size === 0) {
                    _hydrating.delete(transport);
                }
            }
        },
        pendingBytes(paneId) {
            return _pendingFanoutBytes.get(paneId) ?? 0;
        },
        isPaneKnown(paneId) {
            return _knownPanes.has(paneId);
        },
        beginPaneHydration(transport, paneId) {
            let paneQueues = _hydrating.get(transport);
            if (paneQueues === undefined) {
                paneQueues = new Map();
                _hydrating.set(transport, paneQueues);
            }
            // Idempotent per (transport, pane): keep the existing queue on a repeat
            // begin so already-queued live bytes are not lost.
            if (!paneQueues.has(paneId)) {
                paneQueues.set(paneId, []);
            }
        },
        endPaneHydration(transport, paneId) {
            const paneQueues = _hydrating.get(transport);
            if (paneQueues === undefined)
                return;
            const queue = paneQueues.get(paneId);
            if (queue === undefined)
                return;
            // Stop queueing FIRST so the flush sends straight through (and any
            // re-entrant append during the flush takes the live path).
            paneQueues.delete(paneId);
            if (paneQueues.size === 0)
                _hydrating.delete(transport);
            // Flush queued live bytes to this transport in arrival order. They land
            // AFTER the clear-then-replay frame (the caller delivers that before
            // calling endPaneHydration), so there is no interleave.
            for (const chunk of queue) {
                void transport.sendData(paneId, chunk);
            }
        },
    };
}
//# sourceMappingURL=output-demux.js.map