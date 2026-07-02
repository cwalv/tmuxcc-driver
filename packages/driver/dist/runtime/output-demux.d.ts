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
import type { PaneBufferStore } from "../state/scrollback.js";
import type { Transport } from "@tmuxcc/protocol";
import type { PaneId } from "@tmuxcc/protocol";
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
    /**
     * tc-295a.9: begin per-pane hydration for ONE transport.
     *
     * While a (transport, pane) pair is hydrating, live `%output` bytes for that
     * pane are QUEUED for that transport instead of being fanned out, so they
     * cannot interleave with the clear-then-replay hydration frame the hydrator
     * delivers directly via `transport.sendData`. Other transports are
     * unaffected (a warm client keeps receiving live bytes for the pane).
     *
     * The no-interleave property is a DRIVER guarantee: the queue is held here,
     * not by client convention. Call `endPaneHydration` to flush + resume.
     *
     * Idempotent per (transport, pane): a second begin without an intervening end
     * keeps the existing queue.
     */
    beginPaneHydration(transport: Transport, paneId: PaneId): void;
    /**
     * tc-295a.9: end per-pane hydration for ONE transport.
     *
     * Flushes any bytes queued during the hydration window to `transport` in
     * arrival order, then resumes live pass-through for that (transport, pane).
     * No-op if the pair was not hydrating.
     *
     * MUST be called AFTER the clear-then-replay frame has been delivered to the
     * transport so the queued live bytes land after the replayed history.
     */
    endPaneHydration(transport: Transport, paneId: PaneId): void;
}
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
export declare function createOutputDemux(opts?: OutputDemuxOptions): OutputDemux;
//# sourceMappingURL=output-demux.d.ts.map