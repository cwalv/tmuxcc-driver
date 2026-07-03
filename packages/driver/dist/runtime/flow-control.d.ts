/**
 * Flow-control coordinator — high/low-water backpressure + honor
 * %pause/%continue via refresh-client -A (tc-1ho).
 *
 * # Problem
 *
 * A firehose pane (e.g. `yes`) can emit bytes faster than the client can
 * consume them.  Without backpressure the session-proxy buffers unboundedly and the
 * client's receive queue grows without bound.
 *
 * tmux's control-mode provides flow control via `refresh-client -A`:
 *   - `%<pane>:pause`    — ask tmux to stop sending %output for that pane
 *   - `%<pane>:continue` — ask tmux to resume
 *
 * tmux acknowledges with a `%pause %<pane>` / `%continue %<pane>` notification
 * when the pause/resume has taken effect on the tmux side.
 *
 * # Contract — normative invariants (FC-N)
 *
 * Tests cite these by number (`// verifies FC-3`); a failing assertion should
 * name the clause in dispute. Asserting anything STRONGER than these clauses
 * is a test bug, not a product bug (see tc-cbh, where a test assumed FC-5's
 * negation). Conventions: packages/session-proxy/TESTING.md.
 *
 *   FC-1  Ledger. The ledger is (pane × client). One %output append for a pane
 *         fans into EVERY registered client's sub-ledger; a drain credit debits
 *         ONLY the crediting client's sub-ledger. Per client:
 *           subBuffered(p,c) = Σ onPaneBytes(p,n) − Σ noteDrained(c,p,n),
 *         clamped at 0. bufferedBytes(p) = max over clients of subBuffered(p,c)
 *         (the slowest client's backlog — the quantity that drives pause/resume,
 *         tc-0wtb). Updates are synchronous, applied on-receipt. At N=1 this
 *         reduces to the single shared counter (one sub-ledger == the max).
 *   FC-2  Pause edge. An upward crossing of HIGH_WATER (strict >) by the MAX
 *         over clients gates the demux and issues `refresh-client -A '%N:pause'`
 *         synchronously within the onPaneBytes call that crossed. The pause is
 *         shared/global per pane (the session-proxy is a single control-mode
 *         client to tmux). No re-pause while paused.
 *   FC-3  Resume edge. Resume is evaluated synchronously within noteDrained:
 *         it fires iff the pane is backpressure-paused and ALL clients' backlogs
 *         have fallen to or at LOW_WATER (inclusive ≤; see the comment at the
 *         check). One slow client keeps the pane paused for everyone (its queue
 *         is the resource bound FC exists to enforce). isPanePaused() reflects
 *         the transition before noteDrained returns. removeClient re-evaluates
 *         the max: detaching the slowest client may itself drop the max to or
 *         below low-water and trigger a resume.
 *   FC-4  Gate-dropped bytes are not retained (tc-2ztp). "Buffered" counts
 *         only bytes actually owed to a transport — the quantity the resume
 *         edge can clear. The demux DROPS bytes that arrive while a pane is
 *         paused (output-demux's append returns early for a paused pane: no
 *         fan-out, no resume-time flush), so those bytes never reach any
 *         transport's sendData and are never credited via noteDrained.
 *         Retaining them would pin the resume MAX above LOW_WATER forever once
 *         the producer stops. So onPaneBytes does NOT retain bytes that arrive
 *         while already paused (it still witnesses them via onBytesWhilePaused
 *         for the FC-5 tripwire), and the pausing call clamps each client's
 *         sub-ledger back to HIGH_WATER (the crossing chunk's overshoot is
 *         gate-dropped too — production pauses the demux before fanning it out).
 *   FC-5  In-flight observability. The pause command is asynchronous w.r.t.
 *         tmux: bytes tmux flushed before honoring the pause still ARRIVE at
 *         the session-proxy after isPanePaused() flips true. They are witnessed
 *         via onBytesWhilePaused (a small bounded burst at each pause edge;
 *         sustained growth = tmux is not honoring the pause), but per FC-4 they
 *         do NOT raise bufferedBytes — the demux drops them, so they are not
 *         owed to any transport. bufferedBytes is therefore frozen at the pause
 *         instant (capped at HIGH_WATER) until a drain credit or further append
 *         after resume moves it.
 *
 * # Design
 *
 * ## Two sources of pause/resume
 *
 * 1. **Backpressure (high/low-water)**: the session-proxy's own byte accounting.
 *    Each time `onPaneBytes(paneId, n)` is called (by whoever appends to the
 *    demux store), the `n` bytes are credited to EVERY registered client's
 *    per-pane sub-ledger — the demux fans one append out to all N attached
 *    transports, so each client independently owes those bytes until its own
 *    transport drains them.  When the MAX backlog over clients crosses the
 *    HIGH-WATER mark the controller:
 *      a. Sends `refresh-client -A '%<tmuxN>:pause'` to tmux via the
 *         slot-write `send` callback (typically `pipeline.send`).
 *      b. Calls `demux.pausePane(paneId)` to gate fan-out immediately, before
 *         tmux's `%pause` notification arrives (eliminates the notification
 *         round-trip from the gate path).
 *
 *    When a client notifies that bytes have been drained
 *    (`noteDrained(clientKey, id, n)`) the controller debits ONLY that client's
 *    sub-ledger, and when ALL clients' backlogs have fallen to/below the
 *    LOW-WATER mark it:
 *      a. Sends `refresh-client -A '%<tmuxN>:continue'` to tmux.
 *      b. Calls `demux.resumePane(paneId)` to open the fan-out gate.
 *
 *    ## Why per-client ledgers (tc-0wtb)
 *
 *    A single shared counter over-credits under N≥2 simultaneously-attached
 *    clients: one `onPaneBytes(+n)` is matched by N independent
 *    `noteDrained(−n)` (one per draining transport), so the counter nets
 *    +n−N·n, clamps at 0, and never reaches high-water — backpressure is
 *    silently disabled and the slowest consumer's transport queue grows
 *    unbounded.  Per-client sub-ledgers keep each client's debit local; pausing
 *    on the MAX (the slowest client) and resuming only when ALL are drained
 *    bounds the worst consumer.  The pause/resume command itself stays shared
 *    (`refresh-client -A` pauses tmux for every downstream client) — the
 *    sub-ledgers decide only TIMING.  At N=1 this is exactly the old behavior.
 *
 *    The client set is maintained via `addClient(clientKey)` /
 *    `removeClient(clientKey)`.  A client attaching mid-flood starts at 0 (its
 *    history replay is delivered on the raw transport and never counted; only
 *    live deltas from its attach point are credited).  When zero clients are
 *    registered the controller accounts against a single implicit client, which
 *    is the N=1 reduction used by direct-drive callers/tests.
 *
 * 2. **Honor tmux's unsolicited %pause/%continue**: tmux may also send these
 *    notifications on its own (e.g. capacity management across multiple clients).
 *    `onPauseNotification(paneId)` and `onContinueNotification(paneId)` handle
 *    those by updating the demux gate accordingly.
 *
 * ## Water-mark policy and defaults
 *
 *   HIGH_WATER_DEFAULT = 256 KiB (262 144 bytes)
 *   LOW_WATER_DEFAULT  =  64 KiB ( 65 536 bytes)
 *
 * Rationale:
 *   - 256 KiB is large enough to absorb burst output without false pausing
 *     under normal workloads (a `yes` at full speed emits ~100 MB/s; 256 KiB
 *     gives ~2.5 ms of headroom — plenty for a drain cycle).
 *   - 64 KiB hysteresis gap prevents rapid pause/resume oscillation (chattering)
 *     when the pane output rate is close to the client drain rate.
 *   - Both values are configurable via opts.
 *
 * ## No bytes are dropped
 *
 *   - Pausing stops NEW output at the source (tmux), not at the buffer level.
 *   - Bytes already written to the demux store before the pause command reaches
 *     tmux are still delivered; the demux gate only prevents further fan-out
 *     while paused.
 *   - `noteDrained` removes bytes from the logical counter without touching the
 *     scrollback store — the store is append-only (tc-fx2's concern).
 *
 * ## API seam for tc-93a (integration test)
 *
 *   tc-93a drives a flood via the pipeline's notification path:
 *     1. Call `fc.onPaneBytes(paneId, byteCount)` for each append.
 *     2. Observe the `send` callback's recorded commands for pause/continue.
 *     3. Call `fc.noteDrained(paneId, byteCount)` to simulate client drain.
 *     4. Observe resume command + demux gate state.
 *
 *   Alternatively tc-93a can subscribe to pipeline notifications and call the
 *   notification helpers directly.
 *
 * ## Testability
 *
 *   The controller works with any `send` callback that returns a
 *   `Promise<CommandResult>` (tests inject one that records the issued
 *   command strings) and any OutputDemux (use a real `createOutputDemux()`
 *   with fake transports).  No real tmux needed.
 *
 * @module runtime/flow-control
 */
import type { OutputDemux } from "./output-demux.js";
import type { PaneId } from "@tmuxcc/protocol";
import type { CommandResult } from "../parser/correlator.js";
/** Default high-water mark in bytes (256 KiB). Pause triggered above this. */
export declare const DEFAULT_HIGH_WATER_BYTES = 262144;
/** Default low-water mark in bytes (64 KiB). Resume triggered below this. */
export declare const DEFAULT_LOW_WATER_BYTES = 65536;
/**
 * Opaque per-client identity for the per-client FC-1 ledgers (tc-0wtb).
 *
 * Any stable object reference unique to a client connection works — in
 * production wiring (session-proxy.ts) this is the client's `Transport`.  The
 * controller only ever uses it as a `Map`/`Set` key (reference identity); it
 * never inspects the value.
 */
export type ClientKey = object;
/**
 * Invariant-tripwire hooks (tc-d7i).
 *
 * Each hook witnesses an FC-N contract clause (see module header) that
 * cannot be deterministically unit-asserted because it depends on real tmux
 * timing. The controller stays metrics-free; production wiring
 * (session-proxy.ts) forwards these to the metrics registry and loud-logs
 * the expected-zero ones.
 */
export interface FlowControllerMetricsHooks {
    /**
     * `noteDrained` could not debit what a drain credit claimed: the credit
     * exceeded the crediting client's per-pane sub-ledger (clamped at 0), or
     * named a (pane × client) sub-ledger that does not exist at all (nothing
     * debited, no entry materialized). Expected never — every call is an FC-1
     * accounting bug (double credit, drain for a dead pane/client). Per-client
     * ledgers (tc-0wtb) make the old multi-client structural over-credit
     * impossible, and the draining wrapper suppresses the deferred credits an
     * abrupt client death releases (tc-76m8.27), so this is a genuine
     * expected-zero tripwire — the production wiring (session-proxy.ts) fails
     * loud (throws) on it.
     */
    onDrainClamped?(paneId: PaneId, excessBytes: number): void;
    /**
     * Bytes arrived while the pane was already paused — the FC-5 in-flight
     * window. These are gate-dropped by the demux and NOT retained in the
     * ledger (FC-4, tc-2ztp); this hook is pure observability. Expected: a
     * small bounded burst right after each pause edge (output tmux flushed
     * before honoring the pause); sustained growth = tmux is not honoring the
     * pause command.
     */
    onBytesWhilePaused?(paneId: PaneId, byteCount: number): void;
    /**
     * A pause/continue `refresh-client -A` reply came back `%error`.
     * Expected never. kind="continue" is the worst case: tmux keeps holding
     * the pane's output — a frozen terminal if no later resume succeeds.
     * Correlator rejection (session teardown with the slot in flight) is
     * deliberately NOT reported — it would pollute the expected-zero signal
     * at every session close.
     */
    onCommandFailed?(kind: "pause" | "continue"): void;
}
/** Options for `createFlowController`. */
export interface FlowControllerOptions {
    /**
     * High-water mark in bytes per pane.
     * When buffered bytes exceed this value the controller pauses the pane.
     * Default: 262_144 (256 KiB).
     */
    highWaterBytes?: number;
    /**
     * Low-water mark in bytes per pane.
     * When buffered bytes fall below this value after a pause the controller
     * resumes the pane.  Must be < highWaterBytes.
     * Default: 65_536 (64 KiB).
     */
    lowWaterBytes?: number;
    /**
     * Override the default PaneId → tmux numeric ID mapping.
     * Default strips the "p" prefix and parses the decimal integer.
     * Supply a registry-backed function for multi-session namespacing.
     */
    paneIdToTmux?: (id: PaneId) => number;
    /** Invariant-tripwire hooks (tc-d7i). See `FlowControllerMetricsHooks`. */
    metrics?: FlowControllerMetricsHooks;
}
/**
 * FlowController — coordinates per-pane pause/resume between the demux gate
 * and the upstream tmux refresh-client -A command.
 *
 * Obtain via `createFlowController(host, demux, opts?)`.
 */
export interface FlowController {
    /**
     * Record that `byteCount` bytes have been appended for `paneId`.
     *
     * Called by the caller each time bytes are appended to the demux store
     * (i.e. wrap around the append tap or call from the pipeline layer).
     * When the cumulative total crosses the high-water mark the controller
     * issues a pause command and gates the demux.
     */
    onPaneBytes(paneId: PaneId, byteCount: number): void;
    /**
     * Register a client so its per-pane sub-ledger participates in accounting
     * (tc-0wtb). Idempotent. Subsequent `onPaneBytes` calls fan bytes into this
     * client's sub-ledger; a client added mid-flood starts at 0 (only live
     * deltas from here on are credited — its history replay is on the raw
     * transport and is never counted).
     */
    addClient(clientKey: ClientKey): void;
    /**
     * Deregister a client (tc-0wtb): drop its per-pane sub-ledgers and
     * re-evaluate every paused pane's MAX. Detaching the slowest client may drop
     * the max to/below low-water and trigger a resume, so this fires the resume
     * edge where warranted. Idempotent.
     */
    removeClient(clientKey: ClientKey): void;
    /**
     * Record that `byteCount` bytes have been drained (acknowledged by the
     * client or freed from the send queue) for `paneId`, debiting ONLY
     * `clientKey`'s per-pane sub-ledger (tc-0wtb).
     *
     * When ALL clients' backlogs for the pane have fallen to/below the low-water
     * mark while the pane is paused, the controller issues a continue command and
     * opens the demux gate. `clientKey` may be omitted by direct-drive callers
     * (tests / the single-client integration layer); it then debits the implicit
     * default client used when no clients are explicitly registered.
     */
    noteDrained(paneId: PaneId, byteCount: number, clientKey?: ClientKey): void;
    /**
     * Honor an incoming `%pause %<pane>` notification from tmux.
     *
     * Gates the demux fan-out for the pane (idempotent if already paused by
     * backpressure logic).  The `paneId` is the wire-format branded id ("p<N>").
     */
    onPauseNotification(paneId: PaneId): void;
    /**
     * Honor an incoming `%continue %<pane>` notification from tmux.
     *
     * Opens the demux fan-out gate for the pane (idempotent if already resumed).
     */
    onContinueNotification(paneId: PaneId): void;
    /**
     * Handle an incoming `%extended-output` notification.
     *
     * `%extended-output` carries an age/staleness field for output produced
     * while tmux was paused.  This controller does not act on the age field
     * but must not choke on the notification.  The byte count is forwarded
     * to `onPaneBytes` so backpressure accounting stays accurate.
     *
     * @param paneId     Wire-format pane id.
     * @param byteCount  Byte length of the extended-output payload.
     */
    onExtendedOutput(paneId: PaneId, byteCount: number): void;
    /**
     * Whether a pane is currently paused by the flow controller.
     * Mirrors `demux.isPanePaused(paneId)` — provided for diagnostic convenience.
     */
    isPanePaused(paneId: PaneId): boolean;
    /**
     * Current buffered byte count for a pane: the MAX backlog over all clients —
     * i.e. the slowest client's sub-ledger (tc-0wtb). This is the quantity the
     * pause/resume edges are evaluated against. For diagnostics/tests.
     */
    bufferedBytes(paneId: PaneId): number;
}
/**
 * Create a `FlowController` that coordinates per-pane pause/resume between
 * the demux client-side gate and the upstream tmux refresh-client -A command.
 *
 * # Wiring
 *
 * The controller takes a slot+write `send` callback (typically
 * `pipeline.send`) — under the requery pipeline EVERY tmux command write must
 * be slotted by construction, so there is no raw-host fallback (tc-3si.1).
 * Tests inject a fake `send` that captures the issued commands.
 *
 * ```ts
 * const demux = createOutputDemux();
 * const fc = createFlowController(pipeline.send.bind(pipeline), demux, {
 *   highWaterBytes: 262_144,
 *   lowWaterBytes:  65_536,
 * });
 *
 * // 1. Wrap the demux store's append to account bytes:
 * //    (or call fc.onPaneBytes from the pipeline notification handler)
 * const wrappedStore: PaneBufferStore = {
 *   ...demux.store,
 *   append(paneId, bytes) {
 *     demux.store.append(paneId, bytes);
 *     fc.onPaneBytes(paneId, bytes.length);
 *   },
 * };
 *
 * // 2. Wire the pipeline to the wrapped store:
 * const pipeline = createRuntimePipeline(host, { buffers: wrappedStore });
 *
 * // 3. Forward pause/continue notifications from the pipeline:
 * //    (subscribe to model changes or hook the correlator's onNotification)
 * //    fc.onPauseNotification(paneId)    — on %pause %<pane>
 * //    fc.onContinueNotification(paneId) — on %continue %<pane>
 * //    fc.onExtendedOutput(paneId, bytes.length) — on %extended-output
 *
 * // 4. Notify when client drains (e.g. from the serve layer after sendData):
 * //    fc.noteDrained(paneId, byteCount)
 * ```
 *
 * # Water-mark policy
 *
 *   HIGH_WATER = 256 KiB (default): pause requested when buffered > HIGH_WATER.
 *   LOW_WATER  =  64 KiB (default): resume requested when buffered < LOW_WATER
 *                                   (only after a pause).
 *   Hysteresis gap = 192 KiB — prevents rapid pause/resume oscillation.
 *
 * @param send  Atomic slot+write callback (typically `pipeline.send`).
 * @param demux OutputDemux whose `pausePane`/`resumePane` gate client fan-out.
 * @param opts  Optional water-mark overrides and id-mapping override.
 */
export declare function createFlowController(send: (command: string) => Promise<CommandResult>, demux: OutputDemux, opts?: FlowControllerOptions): FlowController;
//# sourceMappingURL=flow-control.d.ts.map