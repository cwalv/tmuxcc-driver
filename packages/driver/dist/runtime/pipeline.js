/**
 * Runtime pipeline — wire stdout→tokenizer→parser→requery-engine→deltas (tc-128.4).
 *
 * This is the SPINE of the session-proxy runtime: it connects a TmuxHost's raw
 * stdout byte stream to the E2 parser (ControlTokenizer + parseNotification +
 * CommandCorrelator) and the requery-driven topology engine + coalescer,
 * maintaining the live SessionModel and broadcasting deltas to subscribers.
 *
 * # Architecture (post tc-128.4)
 *
 * The per-event reducer + BootstrapCoordinator from tc-5dd/tc-835 is GONE. The
 * topology plane is now driven by:
 *
 *   - `RequeryEngine` (tc-128.1) — runs `list-windows` + `list-panes` against
 *     tmux, parses the bootstrap-format replies, diffs against the previous
 *     model. Bootstrap is `engine.requery()` with `prev = empty`; live updates
 *     are `engine.requery()` triggered by the coalescer.
 *   - `Coalescer` (tc-128.2) — wraps the engine with a leading-edge + 1 Hz
 *     ceiling + 30 s heartbeat policy. Topology notifications from tmux are
 *     demoted to a dirty bit via `coalescer.notify(kind)`; the coalescer
 *     decides when to fire `engine.requery()`. On a successful cycle the
 *     coalescer's `onDeltas` handoff feeds the result back into this pipeline
 *     for stamping and broadcast.
 *
 * The classification of notifications is done in `isTopologyEvent` (state/
 * coalescer.ts): topology-affecting `%`-messages flow through the coalescer,
 * everything else (content bytes, flow control, optimistic-update internals,
 * subscription value delivery, exit) is handled directly here.
 *
 * # Data flow
 *
 *   TmuxHost.onData(chunk: Uint8Array)
 *     → ControlTokenizer.push(chunk): ControlToken[]
 *     → route each token:
 *         notification → parseNotification → dispatchEvent:
 *             - output / extended-output → buffers.append (content plane)
 *             - pause / continue / exit → onNotification subscribers
 *             - subscription-changed (sync-watch) → applyPatch (window option)
 *             - internal:set-window-* → applyPatch (optimistic update)
 *             - everything else → coalescer.notify(kind) (topology dirty bit)
 *         block-begin/body/end/error → CommandCorrelator.push(token)
 *             (the engine's submit() expects two %end blocks per requery cycle
 *              via correlator.send() — tc-3si.1)
 *
 * # Bootstrap integration
 *
 *   On start():
 *     1. Construct the RequeryEngine bound to a correlator-driven submit.
 *     2. Construct the Coalescer wrapping the engine, with onDeltas wired
 *        back into this pipeline's broadcast path.
 *     3. Wire host.onData → tokenizer → correlator (notifications routed to
 *        dispatchEvent; command blocks routed to slot promises registered by
 *        correlator.send() — tc-3si.1).
 *     4. Call `engine.requery()` once for the initial bootstrap. The diff
 *        against the empty model produces the full snapshot's worth of
 *        deltas; the coalescer's onDeltas fires the broadcast.
 *     5. Start the coalescer's heartbeat.
 *
 * # Model patch path (optimistic updates + subscription value delivery)
 *
 *   Some notifications carry an authoritative scalar value (the sync-watch
 *   subscription's `value`, the `internal:set-window-*` synthetic events from
 *   input-path's optimistic apply / error reversal). These are NOT topology
 *   changes — the window structure is unchanged — but they need to land in
 *   the model AND propagate as deltas. The pipeline applies a direct model
 *   patch (a SessionModel → SessionModel updater), then broadcasts
 *   `diffModel(prev, next)` exactly the same way a requery cycle would.
 *   The engine's `_model` is also updated so the next requery diffs from the
 *   patched baseline.
 *
 * # Model change signals
 *
 *   Downstream beads consume:
 *   - `getModel()` — current SessionModel (immutable snapshot).
 *   - `onModelChange(cb)` — called after each model update with (newModel,
 *     prevModel). Returns an unsubscribe function. Fires synchronously.
 *
 * @module runtime/pipeline
 */
import { ControlTokenizer } from "../parser/tokenizer.js";
import { parseNotification } from "../parser/notifications.js";
import { CommandCorrelator } from "../parser/correlator.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { checkInvariants, emptyModel, setBoundClient, updatePane, updateWindow, windowId as mintWindowId, } from "../state/model.js";
import { createRequeryEngine } from "../state/requery.js";
import { createCoalescer, isTopologyEvent, realClock, } from "../state/coalescer.js";
import { classifyCommand } from "../metrics/registry.js";
import { decodeOutputPayload } from "../parser/output-codec.js";
import { OscTitleSniffer } from "../parser/osc-title-sniffer.js";
import { PaneNotifyScanner } from "../parser/notify-scanner.js";
import { PaneNotifyRateLimiter, isTier1NotifyKind } from "./notify-rate-limiter.js";
import { paneId as mintPaneId } from "@tmuxcc/protocol";
import { paneBoundOptionName } from "../state/bootstrap.js";
import { phaseLog, phaseNow } from "./phase-timing.js";
import { diffModel } from "../state/projection.js";
import { setOption, listPanes, refreshClientSubscribeWindows, refreshClientSubscribePanes, } from "../parser/commands.js";
// ---------------------------------------------------------------------------
// Subscription name constant (tc-7xv.28)
// ---------------------------------------------------------------------------
/**
 * Name of the tmux control-mode subscription used to detect external
 * synchronize-panes changes (tc-7xv.28).
 *
 * Registered via `refresh-client -B 'sync-watch:@*:#{?synchronize-panes,1,0}'`
 * after bootstrap. When `%subscription-changed sync-watch …` arrives, the
 * pipeline applies a model patch flipping the matching window's
 * `synchronizePanes`.
 */
const SYNC_WATCH_SUBSCRIPTION_NAME = "sync-watch";
/**
 * Name of the tmux control-mode subscription used to source the CANONICAL live
 * pane title (tc-s6ov.4), SUPERSEDING the OSC-0/2 sniff (tc-2mn8).
 *
 * Registered via `refresh-client -B 'title-watch:%*:#{pane_title}'` after
 * bootstrap. The `%*` (all-panes) scope makes tmux re-evaluate `#{pane_title}`
 * for EVERY pane on its 1-second timer and emit `%subscription-changed
 * title-watch …` only when the value changes — so it catches every source of a
 * title change, including OUT-OF-BAND ones the OSC sniff is blind to (another
 * client's `select-pane -T`, automatic title from `#{pane_current_command}`,
 * etc.) because those never flow through THIS client's `%output` stream.
 *
 * The OSC sniffer (tc-2mn8) is RETAINED but demoted: it no longer feeds the
 * canonical `paneTitle` model field; it stays solely to STRIP OSC-0/2 title
 * sequences out of the byte stream so they don't reach the renderer's display
 * surface. See `_dispatchEvent` for the demotion site.
 */
const TITLE_WATCH_SUBSCRIPTION_NAME = "title-watch";
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
class RuntimePipelineImpl {
    _host;
    _opts;
    _tokenizer;
    _correlator;
    _engine = null;
    _coalescer = null;
    _modelChangeHandlers = new Set();
    _notificationHandlers = new Set();
    _paneNotifyHandlers = new Set();
    _unsubData = null;
    /**
     * Per-pane OSC title sniffers (tc-2mn8).
     *
     * Keyed by the wire PaneId string (e.g. "p3"). Each sniffer maintains its
     * own streaming parser state across %output chunks so that a title sequence
     * spanning two chunks is correctly reassembled.
     *
     * Entries are created lazily on first output for a pane and removed when the
     * pane closes (via onModelChange — see the cleanup in start()).
     */
    _oscSniffers = new Map();
    /**
     * Per-pane attention/status escape scanners + rate limiters (tc-76m8.1, S9).
     *
     * Keyed by the wire PaneId string. Each scanner keeps its own bounded state
     * machine across %output chunks (so a notification split across chunks is
     * recognised); each limiter keeps per-kind token buckets so a storm in one
     * pane cannot flood the wire. Created lazily on first output for a pane and
     * removed when the pane closes (alongside `_oscSniffers`).
     */
    _notifyScanners = new Map();
    _notifyLimiters = new Map();
    _started = false;
    _stopped = false;
    _live = false;
    /**
     * Notifications that arrived during the initial bootstrap `engine.requery()`
     * are buffered here and drained after `live = true`. Without this, every
     * pre-reply notification would dirty the engine mid-cycle and force a
     * loop — tmux replies for the looped cycles never arrive in test harnesses
     * (and in production they would but at unnecessary cost). The first
     * authoritative list-* snapshot already accounts for whatever state those
     * notifications would imply.
     */
    _bootstrapBuffer = [];
    buffers;
    constructor(host, opts = {}) {
        this._host = host;
        this.buffers = opts.buffers ?? createPaneBufferStore();
        this._opts = {
            buffers: this.buffers,
            checkInvariantsOnUpdate: opts.checkInvariantsOnUpdate ?? false,
            ceilingMs: opts.ceilingMs ?? 1000,
            heartbeatMs: opts.heartbeatMs ?? 30_000,
            bootstrapRequeryTimeoutMs: opts.bootstrapRequeryTimeoutMs ?? 3500,
            sessionName: opts.sessionName,
            onSwitchClientDetected: opts.onSwitchClientDetected,
            clock: opts.clock ?? realClock(),
            onTopologyNotify: opts.onTopologyNotify,
            metrics: opts.metrics,
            teardownThreshold: opts.teardownThreshold,
            onFatalError: opts.onFatalError,
        };
        // The correlator routes notification tokens back to _onNotificationToken
        // synchronously (called within the correlator's push() handler).
        //
        // tc-3si.1: wire the correlator's `write` callback to host.write — this is
        // what gives `correlator.send` its atomic "register slot + write" property.
        // Once the pipeline is stopped we drop writes (matches the previous
        // _writeSlottedCommand stop-gate behaviour).
        //
        // tc-3si.5: forward unsolicited-block and pending-changed events into
        // the metrics registry. The hooks are bypassed entirely when no
        // registry is wired (test setups that don't care about metrics), so
        // there's zero cost outside production wiring.
        this._correlator = new CommandCorrelator({
            onNotification: (token) => this._onNotificationToken(token),
            write: (data) => {
                if (this._stopped)
                    return;
                this._host.write(data);
            },
            onUnsolicitedBlock: () => {
                const metrics = this._opts.metrics;
                if (metrics === undefined)
                    return;
                metrics.incCorrelatorUnsolicitedBlock();
                // tc-3si.5: storm-alarm-style alert path — name the event so the
                // bug class stays visible in stderr even when no metric reader is
                // attached. One line per incident; not parsed by anything.
                process.stderr.write(`[correlator] UNSOLICITED REPLY BLOCK: a %end/%error closed with no pending slot to bind to. ` +
                    `Under tc-3si.1's atomic slot+write this is structurally impossible — a slot-less command path ` +
                    `has regressed (the flow-load-F4 class). Bytes intended for whoever DID register the next slot ` +
                    `are now mis-bound (tc-3si.5).\n`);
            },
            onPendingChanged: (depth, oldestAgeSeconds) => {
                const metrics = this._opts.metrics;
                if (metrics === undefined)
                    return;
                metrics.setCorrelatorPending(depth, oldestAgeSeconds);
            },
        });
        this._tokenizer = new ControlTokenizer();
    }
    // -------------------------------------------------------------------------
    // Public interface
    // -------------------------------------------------------------------------
    async start() {
        if (this._started)
            return;
        this._started = true;
        // Wire host.onData → tokenizer → correlator (which routes notifications
        // back to _onNotificationToken).
        //
        // tc-2x3.4: per-session error boundary — wrap the inner dispatch in a
        // try/catch so a parser/reducer/pipeline exception in session A cannot
        // propagate out of this event-loop callback and crash the whole
        // server-proxy process (which now hosts ALL sessions in ONE event loop).
        // On a caught error:
        //   1. Log loudly to stderr with the session name (attribution).
        //   2. Stop this pipeline (no further processing on the broken stack).
        //   3. Call opts.onFatalError(err) — the supervisor wires this to its
        //      per-session teardown + reattach path so only THIS session is
        //      recycled; sibling sessions are unaffected.
        //
        // If onFatalError is not supplied (backward-compat for tests): log to
        // stderr only.  The pipeline is stopped regardless so a broken pipeline
        // doesn't silently continue producing garbage.
        this._unsubData = this._host.onData((chunk) => {
            try {
                const tokens = this._tokenizer.push(chunk);
                for (const token of tokens) {
                    this._correlator.push(token);
                }
            }
            catch (err) {
                // Do NOT re-throw: that would unwind out of the PTY data event and
                // into the shared event loop, crashing all sessions.
                const sessionLabel = this._opts.sessionName ?? "<unknown-session>";
                process.stderr.write(`[pipeline] FATAL: session "${sessionLabel}" parser/reducer/pipeline threw an unhandled exception — ` +
                    `triggering per-session error boundary (tc-2x3.4).\n` +
                    `  Error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
                // Stop this pipeline immediately so we don't process further data on
                // the now-broken parse state (tokenizer and correlator may be in an
                // undefined mid-parse position).
                this.stop();
                // Delegate teardown + reattach to the supervisor (or whoever wired
                // onFatalError). If no handler is wired, the log line above is the
                // only signal — backward-compat for test setups.
                this._opts.onFatalError?.(err);
            }
        });
        // Build the engine's submit: the correlator's atomic `send` (slot + write
        // together) is exactly the right primitive (tc-3si.1). `_send` wraps it
        // with command_round_trip_seconds / commands-issued observation
        // (tc-3si.6) — every slotted command path (requery submit, setup writes,
        // pipeline.send/sendBatch) flows through the same wrapper.
        //
        // tc-3si.5: the requery engine's submit ALSO observes
        // `requery_round_trip_seconds` (the requery-only histogram, separate
        // from `command_round_trip_seconds{kind}` so a fattening tail is
        // visible without filtering). Implemented by wrapping `_send` here
        // rather than inside the engine so the engine stays metric-free.
        const submit = (command) => {
            const metrics = this._opts.metrics;
            if (metrics === undefined)
                return this._send(command);
            const startedAt = this._opts.clock.now();
            const promise = this._send(command);
            promise.then(() => {
                const seconds = (this._opts.clock.now() - startedAt) / 1000;
                metrics.observeRequeryRoundTrip(seconds);
            }, () => { });
            return promise;
        };
        const engineOpts = { submit };
        if (this._opts.sessionName !== undefined) {
            engineOpts.sessionName = this._opts.sessionName;
        }
        // tc-3si.2: forward the teardown-confirmation threshold to the engine,
        // and wire the per-outcome counter to the metrics registry. The engine
        // also loud-logs to stderr on refuted (storm-alarm-style alert path)
        // independently of whether metrics are wired, so the bug-class trail
        // survives metric-less test setups.
        if (this._opts.teardownThreshold !== undefined) {
            engineOpts.teardownThreshold =
                this._opts.teardownThreshold;
        }
        const metricsRegistry = this._opts.metrics;
        if (metricsRegistry !== undefined) {
            engineOpts.onTeardownOutcome =
                (outcome) => metricsRegistry.incTeardownConfirmation(outcome);
            // tc-3si.5: the engine reports per-reason failed cycles and budget
            // exhaustion separately. The engine also loud-logs the budget-
            // exhausted path to stderr unconditionally (so the bug class lands
            // even when metrics aren't wired); the counters here are the
            // forensic surface for session-proxy.info readers.
            engineOpts.onCycleFailed =
                (reason) => metricsRegistry.incRequeryFailedCycle(reason);
            engineOpts.onBudgetExhausted =
                () => metricsRegistry.incRequeryBudgetExhausted();
        }
        const engine = createRequeryEngine(engineOpts);
        this._engine = engine;
        // Build the coalescer wrapping the engine. onDeltas is the broadcast
        // handoff: when a clean requery cycle commits, fan out the deltas through
        // our existing onModelChange subscribers (which take (next, prev) and
        // re-derive their own deltas via diffModel — we pass result.next and the
        // engine's pre-cycle model).
        //
        // We capture `prevModel` at the moment the requery starts (in the engine
        // itself) but the coalescer only sees the *cumulative* deltas against the
        // engine's pre-call model — we want the model-change signal to carry the
        // same baseline. The engine atomically swaps `_model = candidate` before
        // resolving the Promise that onDeltas reads, so by the time onDeltas fires
        // `engine.getModel() === result.next`. We track our own "last broadcast
        // model" to recover the pre-update baseline for the onModelChange contract.
        let lastBroadcastModel = emptyModel();
        const coalescer = createCoalescer({
            engine,
            clock: this._opts.clock,
            ceilingMs: this._opts.ceilingMs,
            heartbeatMs: this._opts.heartbeatMs,
            onDeltas: (result, meta) => {
                // The engine already committed result.next to its internal _model.
                // Compute the prev → next transition for our subscribers.
                if (result.failed)
                    return; // defensive — coalescer skips this anyway
                const prev = lastBroadcastModel;
                const next = result.next;
                if (prev === next)
                    return; // no observable change (e.g. heartbeat no-op)
                lastBroadcastModel = next;
                // tc-3si.6: observe topology_notify_to_delta_seconds BEFORE the
                // model-change broadcast so the timestamp captures "delta
                // produced", not "all subscribers serviced". The histogram's
                // `edge` label is set per the coalescer's classification (leading
                // / trailing / heartbeat); heartbeat cycles report against the
                // synthetic firstNotifyAt = lastRequeryAt-ish distance (the
                // heartbeat interval), which lands in a high bucket far from the
                // leading/trailing modes.
                const metrics = this._opts.metrics;
                if (metrics !== undefined) {
                    const broadcastAt = this._opts.clock.now();
                    if (meta.firstNotifyAt !== null) {
                        const seconds = (broadcastAt - meta.firstNotifyAt) / 1000;
                        metrics.observeNotifyToDelta(seconds, meta.edge);
                    }
                    else if (meta.edge === "heartbeat") {
                        // Heartbeat without a triggering notify: the diagnostic value
                        // is just "the heartbeat ticked"; report a constant-shape
                        // sample at the heartbeat interval so the bucket-it-lands-in
                        // is the heartbeat interval itself (always far above the
                        // leading/trailing modes — they read clean).
                        metrics.observeNotifyToDelta(this._opts.heartbeatMs / 1000, "heartbeat");
                    }
                    metrics.incDeltasEmitted(result.deltas.length);
                    // tc-3si.5: trigger attribution + per-cycle delta-count
                    // distribution. The CycleMeta.edge vocabulary aligns with the
                    // RequeryTrigger label (minus `reconnect`, which is reserved).
                    metrics.incRequeryCycle(meta.edge);
                    metrics.observeDeltasPerCycle(result.deltas.length);
                    // tc-3si.5: expected-zero tripwire — a heartbeat cycle that
                    // found a real change means a topology change reached us with
                    // NO triggering notification. The heartbeat self-healed, but
                    // upstream is silently lossy. Loud-log alongside the counter
                    // (storm-alarm-style alert path).
                    if (meta.edge === "heartbeat" && result.deltas.length > 0) {
                        metrics.incRequeryHeartbeatChange(result.deltas.length);
                        process.stderr.write(`[pipeline] HEARTBEAT FOUND CHANGES: a heartbeat cycle's diff carried ${result.deltas.length} ` +
                            `delta${result.deltas.length === 1 ? "" : "s"} — tmux state changed without a triggering ` +
                            `notification (event-vocabulary gap / dropped notification). The heartbeat self-healed; ` +
                            `the upstream notification stream is silently lossy (tc-3si.5).\n`);
                    }
                }
                this._emitModelChange(next, prev);
            },
            onError: (err) => {
                console.warn("[pipeline] coalescer requery rejected:", err);
            },
        });
        this._coalescer = coalescer;
        // tc-128.4: bootstrap = `engine.requery()` with prev = empty. The diff
        // against the empty model produces the full snapshot's worth of deltas.
        //
        // We do NOT route bootstrap through the coalescer (engine.requery() is
        // called directly) because we need to know exactly when bootstrap resolves
        // so start() can resolve at the right moment. The coalescer's onDeltas
        // does NOT fire for this call — only for cycles the coalescer itself
        // drove via _runRequery — so we broadcast the initial result manually and
        // align `lastBroadcastModel` to the committed snapshot.
        //
        // While the bootstrap cycle is in flight, _dispatchEvent buffers all
        // notifications instead of feeding the coalescer — see _bootstrapBuffer.
        // After commit we drain the buffer; replays that classify as topology
        // mark dirty and the coalescer's leading-edge fire picks them up.
        const initialResult = await this._bootstrapRequeryWithRetry(engine);
        if (initialResult.failed) {
            // Bootstrap %error: leave the model empty (the engine already did) and
            // let the coalescer's heartbeat retry. We still mark the pipeline live
            // so the runtime doesn't deadlock waiting on start().
            console.warn("[pipeline] bootstrap requery failed (list-* returned %error); heartbeat will retry");
        }
        else {
            // Broadcast the empty → bootstrap transition once. Subscribers derive
            // their own deltas via diffModel(prev, next) — diffing empty against
            // the bootstrap snapshot yields the full set of pane.opened /
            // window.added / focus.changed etc. messages.
            //
            // tc-3si.6: count the deltas this bootstrap will fan out. We do NOT
            // observe `topology_notify_to_delta_seconds` for bootstrap — there
            // was no triggering notify (the cycle was driven directly by start()
            // for lifecycle reasons; see the longer comment above). The
            // bootstrap cycle's command_round_trip_seconds samples already
            // landed via the wrapped submit closure.
            if (this._opts.metrics !== undefined) {
                this._opts.metrics.incDeltasEmitted(initialResult.deltas.length);
                // tc-3si.5: bootstrap is a pipeline-level cycle too — credit it
                // to the `bootstrap` trigger and feed the per-cycle delta-count
                // histogram. Distinguishing bootstrap on the cycle counter lets
                // the reader confirm the bootstrap spike on `deltas_per_cycle`
                // matches the engine's first commit.
                this._opts.metrics.incRequeryCycle("bootstrap");
                this._opts.metrics.observeDeltasPerCycle(initialResult.deltas.length);
            }
            this._emitModelChange(initialResult.next, emptyModel());
            lastBroadcastModel = initialResult.next;
            // Also re-emit with prev === next === initialResult.next so OutputDemux
            // pane-tracking (which uses demux.isPaneKnown() instead of a prev/next
            // diff to detect bootstrap panes) has a deterministic trigger point.
            // Subscribers that derive deltas via diffModel see a zero-delta result
            // here and ignore it.
            this._emitModelChange(initialResult.next, initialResult.next);
        }
        this._live = true;
        // tc-95lue §3.4: Enable monitor-activity on all windows (global window
        // default) so that tmux tracks pane activity.
        //
        // The setup commands are written BEFORE the drain below. With correlator
        // slots registered (correlator.send is atomic) production correctness is
        // order-independent — replies bind to slots in write order either way —
        // but writing setup first means a test harness that acks each command as
        // it is written stays reply-order == write-order relative to the healing
        // requery the drain may fire.
        this._sendSetup(setOption("window-global", "monitor-activity", "on"), "set-option monitor-activity");
        // tc-7xv.28: register a per-window subscription so the runtime detects
        // synchronize-panes changes made by external tmux clients.
        this._sendSetup(refreshClientSubscribeWindows(SYNC_WATCH_SUBSCRIPTION_NAME, "#{?synchronize-panes,1,0}"), "refresh-client sync-watch subscribe");
        // tc-s6ov.4: register an all-panes (%*) subscription on #{pane_title} so the
        // CANONICAL pane title is sourced from tmux's per-pane format diff, not the
        // OSC-0/2 sniff (tc-2mn8). This catches every out-of-band title source —
        // another client's `select-pane -T`, automatic title from the current
        // command — that never flows through this client's %output stream. tmux's
        // 1s timer walks all panes (incl. ones created later) and only emits on
        // change, so the subscription lifecycle is handled by tmux itself: no
        // per-pane subscribe/unsubscribe, no leak.
        this._sendSetup(refreshClientSubscribePanes(TITLE_WATCH_SUBSCRIPTION_NAME, "#{pane_title}"), "refresh-client title-watch subscribe");
        // Drain notifications buffered during bootstrap. Replay every buffered event
        // uniformly through _dispatchEvent. Topology events route to the normal
        // choke point (onTopologyNotify + coalescer.notify), which treats them as a
        // dirty bit: the coalescer fires ONE leading-edge requery (coalescer._lastRequeryAt
        // is untouched by the engine-direct bootstrap cycle, so the first notify fires
        // immediately). Content-plane events (output / extended-output / pause /
        // continue / subscription-changed / internal:*) reach their usual sinks.
        //
        // Cost: one ~ms requery at startup when a topology notification raced the
        // bootstrap window. The diff is empty when the snapshot already reflects the
        // change; non-empty when it doesn't (staleness bounded by the requery round-
        // trip, not by the 30 s heartbeat).
        //
        // _dispatchEvent now sees _bootstrapBuffer === null and routes each event
        // to its proper sink without re-buffering.
        const buffered = this._bootstrapBuffer ?? [];
        this._bootstrapBuffer = null;
        for (const event of buffered) {
            this._dispatchEvent(event);
        }
        // Start the coalescer's heartbeat so silent changes get caught.
        coalescer.start();
    }
    /**
     * Run the BOOTSTRAP requery with a bounded per-attempt timeout, re-issuing
     * on a stall (tc-hfxb.15).
     *
     * THE BUG: the bootstrap requery (`engine.requery()` — a `list-windows` /
     * `list-panes` round-trip over the freshly-forked `tmux -CC` stream) has no
     * timeout anywhere in the chain. Under host load that FIRST round-trip can
     * lose the CPU race and stall; with no timeout it stalls FOREVER, silently
     * consuming the caller's whole connect budget (the e2e suite's 15 s
     * terminal-appearance wait fails at serial position ~22 under load — the
     * tc-crnt.17 / tc-0eds class). The only existing retry
     * (`connectWithBoundedRetry` in the extension) fires on a thrown REJECTION,
     * never on a stall.
     *
     * THE FIX (driver-side, idempotent locus): race each `engine.requery()`
     * attempt against `bootstrapRequeryTimeoutMs`. On timeout, the stalled
     * cycle's two `list-*` correlator slots are still pending; CANCEL them via
     * `correlator.cancelOldest` (which leaves drained placeholders in the FIFO so
     * a late `%end` can't mis-bind a subsequent command — the tc-3si.1 mis-bind
     * class), let the abandoned `engine.requery()` settle, then RE-ISSUE. The
     * requery is a PURE, IDEMPOTENT read (it does NOT mint anything — unlike the
     * extension's `session.createUnique`, which is why the retry belongs HERE and
     * not extension-side), so re-issuing after a stall is safe. The 15 s envelope
     * is UNCHANGED — this makes a transient stall RECOVERABLE within budget, not
     * a budget bump. Same shape as tc-vw10's un-timeout'd liveness probe.
     *
     * Bounded to `MAX_BOUNDED_ATTEMPTS` timed attempts (default 3500 ms each ⇒
     * ≤ ~10.5 s, comfortably inside 15 s); after that a final UNBOUNDED attempt
     * runs so a slow-but-live tmux still completes against the caller's outer
     * budget rather than being abandoned. A non-positive `bootstrapRequeryTimeoutMs`
     * disables the bounded path entirely (single unbounded `engine.requery()` —
     * the pre-tc-hfxb.15 behaviour).
     */
    async _bootstrapRequeryWithRetry(engine) {
        // tc-is5w: phase-split activation timing — the bootstrap-requery leg. This
        // span runs inside `await sessionProxy.start()`, which is inside the broker's
        // ensure leg, so it nests under the `phase=claim` line's ensure_ms. The
        // freshly-forked tmux bootstrap-requery is the prime suspect for the tc-jlyi
        // residual; this line names the attempt count + outcome on every activation.
        // Emitted in a finally so all return paths are covered. Inert unless gated.
        const _phaseT0 = phaseNow();
        let _phaseAttempts = 0;
        let _phaseOutcome = "ok";
        try {
            const timeoutMs = this._opts.bootstrapRequeryTimeoutMs;
            if (timeoutMs <= 0) {
                // Bounded retry disabled — original single unbounded round-trip.
                _phaseAttempts = 1;
                return await engine.requery();
            }
            // Each bootstrap cycle issues exactly two `list-*` commands (windows,
            // panes); on a stall both slots are still pending. Cancel both.
            const BOOTSTRAP_SLOT_COUNT = 2;
            const MAX_BOUNDED_ATTEMPTS = 3;
            const clock = this._opts.clock;
            for (let attempt = 1; attempt <= MAX_BOUNDED_ATTEMPTS; attempt++) {
                _phaseAttempts = attempt;
                if (this._stopped) {
                    _phaseOutcome = "stopped";
                    return await engine.requery();
                }
                const cyclePromise = engine.requery();
                let timedOut = false;
                const timeoutResult = await new Promise((resolve) => {
                    const handle = clock.setTimeout(() => {
                        timedOut = true;
                        resolve("timeout");
                    }, timeoutMs);
                    cyclePromise.then(() => {
                        clock.clearTimeout(handle);
                        resolve("done");
                    }, () => {
                        // The cycle settled (rejected) on its own — e.g. a prior cancel's
                        // %error, or a correlator protocol anomaly. Treat as "done" and
                        // let the await below surface the result/rejection uniformly.
                        clock.clearTimeout(handle);
                        resolve("done");
                    });
                });
                if (timeoutResult === "done" || !timedOut) {
                    // The cycle resolved before the deadline. Await it for the value
                    // (or to re-throw a genuine rejection — the bounded-retry only
                    // recovers from STALLS, not from real protocol failures).
                    // tc-is5w: outcome=ok; `attempts` (>1 if earlier attempts timed out)
                    // already carries the retry envelope.
                    return await cyclePromise;
                }
                // Stall: the deadline fired first. Cancel the stalled cycle's two
                // `list-*` slots so a late reply can't mis-bind, then let the abandoned
                // `engine.requery()` settle (the cancel rejects its submit Promises ⇒
                // its `Promise.all` rejects ⇒ the engine clears its in-flight latch) so
                // the next loop's `engine.requery()` issues a FRESH cycle rather than
                // re-latching the dead one.
                const cancelled = this._correlator.cancelOldest(BOOTSTRAP_SLOT_COUNT, new Error(`bootstrap requery attempt ${attempt} stalled past ${timeoutMs} ms — ` +
                    `cancelling slots and re-issuing (tc-hfxb.15)`));
                process.stderr.write(`[pipeline] bootstrap requery STALLED (attempt ${attempt}/${MAX_BOUNDED_ATTEMPTS}, ` +
                    `> ${timeoutMs} ms); cancelled ${cancelled} correlator slot(s) and re-issuing. ` +
                    `The freshly-forked tmux server's first list-* round-trip lost the CPU race under ` +
                    `host load (tc-hfxb.15 / tc-crnt.17 class).\n`);
                await cyclePromise.then(() => { }, () => { });
            }
            // Bounded attempts exhausted: fall back to one final UNBOUNDED requery so a
            // slow-but-live tmux still bootstraps against the caller's outer budget.
            _phaseOutcome = "exhausted";
            return await engine.requery();
        }
        catch (err) {
            _phaseOutcome = "error";
            throw err;
        }
        finally {
            phaseLog({
                phase: "bootstrap",
                session: this._opts.sessionName,
                bootstrap_ms: phaseNow() - _phaseT0,
                attempts: _phaseAttempts,
                outcome: _phaseOutcome,
            });
        }
    }
    /**
     * Fire-and-forget setup write. The correlator's `send` is the atomic
     * primitive (slot + write together); we just attach a logger to the
     * Promise so `%error` replies for setup commands surface to the operator.
     */
    _sendSetup(command, label) {
        if (this._stopped)
            return;
        void this._send(command).then((result) => {
            if (!result.ok) {
                console.warn(`[pipeline] ${label} failed: %error`);
            }
        }, () => {
            // Correlator rejection (protocol anomaly / teardown) — nothing to do
            // for a fire-and-forget setup command.
        });
    }
    /**
     * Slot + write via the correlator's atomic `send` (tc-3si.1), wrapped with
     * commands-issued / command_round_trip_seconds{kind} observation
     * (tc-3si.6). Every slotted command path — the requery submit, setup
     * writes, and the public send/sendBatch used by input-path and
     * flow-control — flows through here, so per-kind RTT covers the seam
     * end-to-end. Rejections (correlator protocol anomaly / teardown) are NOT
     * observed — those aren't normal round-trips.
     */
    _send(command) {
        const metrics = this._opts.metrics;
        if (metrics === undefined) {
            return this._correlator.send(command);
        }
        const startedAt = this._opts.clock.now();
        metrics.incCommandsIssued();
        const kind = classifyCommand(command);
        const promise = this._correlator.send(command);
        promise.then(() => {
            const seconds = (this._opts.clock.now() - startedAt) / 1000;
            metrics.observeCommandRoundTrip(seconds, kind);
        }, () => { });
        return promise;
    }
    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        this._coalescer?.stop();
        this._unsubData?.();
        this._unsubData = null;
        // tc-2mn8 / tc-76m8.1: drop all per-pane streaming state on shutdown.
        this._oscSniffers.clear();
        this._notifyScanners.clear();
        this._notifyLimiters.clear();
    }
    getModel() {
        return this._engine?.getModel() ?? emptyModel();
    }
    isLive() {
        return this._live;
    }
    onModelChange(handler) {
        this._modelChangeHandlers.add(handler);
        return () => {
            this._modelChangeHandlers.delete(handler);
        };
    }
    onNotification(handler) {
        this._notificationHandlers.add(handler);
        return () => {
            this._notificationHandlers.delete(handler);
        };
    }
    onPaneNotify(handler) {
        this._paneNotifyHandlers.add(handler);
        return () => {
            this._paneNotifyHandlers.delete(handler);
        };
    }
    patchModel(updater) {
        const engine = this._engine;
        if (engine === null)
            return; // not yet started
        const prev = engine.getModel();
        const next = updater(prev);
        if (next === prev)
            return; // no-op
        // Commit the patch into the engine's internal model so future requery
        // diffs use this as the baseline. The engine exposes `setModel` for this
        // use case (see requery.ts).
        engine.setModel(next);
        // tc-3si.6: a patch is a pipeline-level model change too — count its
        // deltas against deltas_emitted_total so the fan-out amplification
        // ratio (deltas_fanned_out / deltas_emitted) stays consistent with
        // the per-client per-delta fan-out counter.
        //
        // tc-3si.5: a patch is NOT a requery cycle — `requery_cycles_total`
        // stays clean of patches (they don't go through the engine), but the
        // `deltas_per_cycle` histogram WANTS them so the per-cycle delta
        // shape covers the whole pipeline (a flapping subscription value
        // shows up there even though it never runs a requery).
        if (this._opts.metrics !== undefined) {
            const deltas = diffModel(prev, next);
            this._opts.metrics.incDeltasEmitted(deltas.length);
            this._opts.metrics.observeDeltasPerCycle(deltas.length);
        }
        this._emitModelChange(next, prev);
    }
    injectNotification(event) {
        if (this._engine === null)
            return; // not yet started
        this._dispatchEvent(event);
    }
    async applyClientBinding(clientId) {
        // Anonymous connection: no per-client slot to read; bound resolves to false.
        if (clientId === undefined)
            return;
        const engine = this._engine;
        if (engine === null || this._stopped)
            return;
        // Scope the read to the bound session by its immutable id ($N). The model
        // holds exactly one session (wire id "sN"); derive N.
        const sess = engine.getModel().sessions.values().next().value;
        if (sess === undefined)
            return; // no session yet (pre-bootstrap)
        const tmuxSessionId = Number.parseInt(String(sess.sessionId).slice(1), 10);
        if (Number.isNaN(tmuxSessionId))
            return;
        const optionName = paneBoundOptionName(clientId);
        const cmd = listPanes({
            sessionId: tmuxSessionId,
            format: `#{pane_id}\t#{${optionName}}`,
        });
        const result = await this.send(cmd);
        if (!result.ok)
            return; // best-effort — carry-forward keeps any prior state
        // Parse "%N\t<1|empty>" rows into the set of panes this client has bound.
        const boundPanes = new Set();
        const text = new TextDecoder().decode(result.body);
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "")
                continue;
            const [paneRaw, boundRaw] = trimmed.split("\t");
            if (paneRaw === undefined || !paneRaw.startsWith("%"))
                continue;
            const n = paneRaw.slice(1);
            if (!/^\d+$/.test(n))
                continue;
            if ((boundRaw ?? "").trim() === "1")
                boundPanes.add(mintPaneId("p" + n));
        }
        // Patch each pane's boundClients membership for this client to match tmux
        // (canonical): a full per-client reconcile, so a slot cleared while the
        // client was away is dropped too.
        this.patchModel((model) => {
            let changed = false;
            const panes = new Map(model.panes);
            for (const [id, pane] of model.panes) {
                const nextSet = setBoundClient(pane.boundClients, clientId, boundPanes.has(id));
                if (nextSet !== pane.boundClients) {
                    panes.set(id, { ...pane, boundClients: nextSet });
                    changed = true;
                }
            }
            return changed ? { ...model, panes } : model;
        });
    }
    send(command) {
        return this._send(command);
    }
    refreshCorrelatorPendingGauge() {
        const metrics = this._opts.metrics;
        if (metrics === undefined)
            return;
        const snap = this._correlator.pendingSnapshot();
        metrics.setCorrelatorPending(snap.depth, snap.oldestAgeSeconds);
    }
    sendBatch(commands) {
        const metrics = this._opts.metrics;
        if (metrics === undefined) {
            return this._correlator.sendBatch(commands);
        }
        const startedAt = this._opts.clock.now();
        const promises = this._correlator.sendBatch(commands);
        promises.forEach((promise, i) => {
            metrics.incCommandsIssued();
            const kind = classifyCommand(commands[i]);
            promise.then(() => {
                const seconds = (this._opts.clock.now() - startedAt) / 1000;
                metrics.observeCommandRoundTrip(seconds, kind);
            }, () => { });
        });
        return promises;
    }
    // -------------------------------------------------------------------------
    // Internal: notification dispatch
    // -------------------------------------------------------------------------
    /**
     * Called by the CommandCorrelator for every notification token that arrives
     * between (or before/after) command blocks. Parses the token, then routes
     * by event kind:
     *
     *   - content plane (output / extended-output) → append to buffers
     *   - flow control / exit → just fire onNotification subscribers
     *   - sync-watch subscription → apply a window-option model patch
     *   - internal:set-window-* synthetic → apply optimistic-update model patch
     *   - everything else → coalescer.notify(kind) (dirty bit)
     *
     * The onNotification subscribers fire for EVERY parsed event regardless of
     * category — this preserves the FlowController contract that pause/continue
     * are observed even though they don't change the model.
     */
    _onNotificationToken(token) {
        const event = parseNotification(token);
        this._dispatchEvent(event);
    }
    /** Internal dispatch shared by parser-driven events and synthetic injects. */
    _dispatchEvent(event) {
        const engine = this._engine;
        const coalescer = this._coalescer;
        if (engine === null || coalescer === null) {
            // Not yet started; should not happen in practice because start() wires
            // onData before any notifications arrive. Defensive no-op.
            return;
        }
        // Bootstrap buffering: while the initial requery cycle is in flight, queue
        // every event and let the live drain replay them after the bootstrap
        // model commits. The list-* replies already account for whatever state
        // these notifications imply; replaying afterward classifies the residual
        // tail (output bytes for the first frame, %session-changed echoing the
        // bound session, etc.) without forcing the engine's loop on dirty mid-
        // bootstrap to wait for tmux replies the test harness never feeds.
        if (this._bootstrapBuffer !== null) {
            this._bootstrapBuffer.push(event);
            return;
        }
        // Content plane: append bytes to the per-pane buffer (the demux's tap
        // fans these out). No model change, no topology dirty.
        if (event.kind === "output" || event.kind === "extended-output") {
            const pid = mintPaneId("p" + event.paneId);
            const decoded = decodeOutputPayload(event.rawPayload);
            // tc-2mn8 / tc-s6ov.4: run the per-pane OSC sniffer to STRIP OSC-0/2 title
            // sequences out of the byte stream (so they don't reach the renderer's
            // display surface). Each pane has its own streaming sniffer to handle
            // sequences that span multiple %output chunks. The sniffer returns:
            //   - passthrough: decoded bytes with title OSC sequences stripped
            //   - updatedTitle: title parsed from a complete OSC-0/2 (NO LONGER USED
            //     as the canonical title source — see below)
            let sniffer = this._oscSniffers.get(pid);
            if (sniffer === undefined) {
                sniffer = new OscTitleSniffer();
                this._oscSniffers.set(pid, sniffer);
            }
            const sniffResult = sniffer.feed(decoded);
            // Pass the stripped bytes to the scrollback buffer + demux fan-out.
            const bytes = sniffResult.passthrough;
            this.buffers.append(pid, bytes);
            // tc-s6ov.4: the CANONICAL paneTitle is now sourced from the title-watch
            // %* subscription (see _applyTitleWatchPatch), NOT from
            // sniffResult.updatedTitle. The sniff was blind to out-of-band title
            // changes (another client's `select-pane -T`, automatic title from
            // #{pane_current_command}) that never flow through this client's %output.
            // The subscription's #{pane_title} format diff catches all of them. We
            // keep the sniffer ONLY for its byte-stripping side-effect above and
            // deliberately DROP sniffResult.updatedTitle here to avoid two writers
            // racing on the same model field (the OSC-stripped value would also be
            // reported a beat later by the subscription anyway).
            // tc-3si.6: aggregate output-throughput accounting. Two hot-path
            // calls per frame: one counter inc + one histogram observe, no
            // allocation, no per-byte work. Aggregate (no per-pane label —
            // cardinality rule, see metrics/registry.ts module doc).
            if (this._opts.metrics !== undefined && bytes.length > 0) {
                this._opts.metrics.incOutputBytes(bytes.length);
                this._opts.metrics.observeOutputFrameSize(bytes.length);
            }
            // tc-76m8.1 (S9): scan the DECODED raw pty bytes for attention/status
            // escapes and emit `pane.notify` for BOTH bound and unbound panes (the
            // driver is the sole observer of unbound panes). This is a PURE TAP —
            // `decoded`/`bytes` are unchanged; the render path above is byte-identical.
            // Scanning `decoded` (pre-title-strip) is deliberate: the scanner consumes
            // a BEL that terminates an OSC-0/2 title as the OSC terminator, so it is
            // NOT miscounted as a bell.
            if (this._paneNotifyHandlers.size > 0 || this._opts.metrics !== undefined) {
                this._scanPaneNotify(pid, decoded);
            }
            this._fireNotificationHandlers(event);
            return;
        }
        // Subscription value delivery (sync-watch): apply a window-option patch.
        // We classify this as content-kind (not a structure change), so it does
        // NOT trip the coalescer.
        if (event.kind === "subscription-changed" &&
            event.name === SYNC_WATCH_SUBSCRIPTION_NAME &&
            event.windowId !== null) {
            this._applySyncWatchPatch(event.windowId, event.value);
            this._fireNotificationHandlers(event);
            return;
        }
        // tc-s6ov.4: CANONICAL pane title delivery (title-watch %* subscription).
        // tmux re-evaluates #{pane_title} per pane and emits this only on change,
        // catching every source incl. out-of-band ones the OSC sniff misses. This
        // SUPERSEDES the sniffer as the source of the model's paneTitle field.
        // Content-kind: a title change is not a structural change, so it must NOT
        // trip the coalescer (no requery).
        if (event.kind === "subscription-changed" &&
            event.name === TITLE_WATCH_SUBSCRIPTION_NAME &&
            event.paneId !== null) {
            this._applyTitleWatchPatch(event.paneId, event.value);
            this._fireNotificationHandlers(event);
            return;
        }
        // Internal synthetic events (optimistic updates from input-path). Apply
        // a window-option patch directly. These never come from tmux; the
        // classifier in coalescer.ts also returns false for them.
        if (event.kind === "internal:set-window-sync") {
            this.patchModel((model) => {
                const win = model.windows.get(event.windowId);
                if (win === undefined)
                    return model;
                if (win.synchronizePanes === event.on)
                    return model;
                return updateWindow(model, event.windowId, { synchronizePanes: event.on });
            });
            this._fireNotificationHandlers(event);
            return;
        }
        if (event.kind === "internal:set-window-monitor-activity") {
            this.patchModel((model) => {
                const win = model.windows.get(event.windowId);
                if (win === undefined)
                    return model;
                if (win.monitorActivity === event.on)
                    return model;
                return updateWindow(model, event.windowId, { monitorActivity: event.on });
            });
            this._fireNotificationHandlers(event);
            return;
        }
        if (event.kind === "internal:set-window-monitor-silence") {
            this.patchModel((model) => {
                const win = model.windows.get(event.windowId);
                if (win === undefined)
                    return model;
                if (win.monitorSilence === event.seconds)
                    return model;
                return updateWindow(model, event.windowId, { monitorSilence: event.seconds });
            });
            this._fireNotificationHandlers(event);
            return;
        }
        // tc-1a8z: durable pane-name optimistic update (@tmuxcc_label). Patch the
        // pane's `label` directly; a later requery re-confirms it from the option.
        if (event.kind === "internal:set-pane-label") {
            this.patchModel((model) => {
                const pane = model.panes.get(event.paneId);
                if (pane === undefined)
                    return model;
                if (pane.label === event.label)
                    return model;
                return updatePane(model, event.paneId, { label: event.label });
            });
            this._fireNotificationHandlers(event);
            return;
        }
        // tc-i9aq.1: durable pane policy/intent optimistic update
        // (@tmuxcc-bound/-detach/-icon). Patch only the fields this write touched;
        // a later requery re-confirms them (and the RESOLVED detach) from tmux.
        if (event.kind === "internal:set-pane-policy") {
            this.patchModel((model) => {
                const pane = model.panes.get(event.paneId);
                if (pane === undefined)
                    return model;
                const patch = {};
                // tc-4b6k.2 (D3): binding intent is per-client — the write touched the
                // ISSUING client's slot only, so flip that client's membership in the
                // pane's boundClients set (event.clientId names the issuer).
                if (event.bound !== undefined && event.clientId !== undefined) {
                    const nextSet = setBoundClient(pane.boundClients, event.clientId, event.bound);
                    if (nextSet !== pane.boundClients)
                        patch.boundClients = nextSet;
                }
                if (event.detach !== undefined) {
                    const next = event.detach === null ? undefined : event.detach;
                    if (pane.detach !== next)
                        patch.detach = next;
                }
                if (event.icon !== undefined) {
                    const next = event.icon === null ? undefined : event.icon;
                    if (pane.icon !== next)
                        patch.icon = next;
                }
                if (Object.keys(patch).length === 0)
                    return model;
                return updatePane(model, event.paneId, patch);
            });
            this._fireNotificationHandlers(event);
            return;
        }
        // Topology classification: anything that may have changed the structure
        // gets demoted to a dirty bit; the coalescer drives the requery.
        if (isTopologyEvent(event)) {
            const kind = event.kind === "unknown" ? event.keyword : event.kind;
            this._opts.onTopologyNotify?.(kind);
            coalescer.notify(kind);
            this._fireNotificationHandlers(event);
            return;
        }
        // Out-of-band: pause / continue / exit / unrecognised internal — fire
        // notification subscribers (FlowController, exit handlers) but no model
        // touch.
        this._fireNotificationHandlers(event);
    }
    /** Apply the sync-watch value to the matching window. */
    _applySyncWatchPatch(tmuxWindowId, value) {
        const on = value.trim() === "1";
        const wid = mintWindowId("w" + tmuxWindowId);
        this.patchModel((model) => {
            const win = model.windows.get(wid);
            if (win === undefined)
                return model;
            if (win.synchronizePanes === on)
                return model;
            return updateWindow(model, wid, { synchronizePanes: on });
        });
    }
    /**
     * Apply the title-watch value to the matching pane (tc-s6ov.4).
     *
     * `value` is the verbatim `#{pane_title}` expansion — NOT trimmed: a pane
     * title may legitimately contain leading/trailing spaces, and the empty
     * string is a valid title (the shell cleared it). Idempotent: no model
     * touch when the value is unchanged (mirrors the prior OSC-sniff guard).
     */
    _applyTitleWatchPatch(tmuxPaneId, value) {
        const pid = mintPaneId("p" + tmuxPaneId);
        this.patchModel((model) => {
            const pane = model.panes.get(pid);
            if (pane === undefined)
                return model;
            if (pane.paneTitle === value)
                return model;
            return updatePane(model, pid, { paneTitle: value });
        });
    }
    _fireNotificationHandlers(event) {
        if (this._notificationHandlers.size === 0)
            return;
        for (const handler of this._notificationHandlers) {
            try {
                handler(event);
            }
            catch (e) {
                console.warn("[pipeline] notification handler threw:", e);
            }
        }
    }
    /**
     * tc-76m8.1 (S9): run the per-pane escape scanner over the decoded pty bytes,
     * apply the per-(pane,kind) rate limiter, and emit the survivors as
     * `pane.notify`. `pid` is the wire PaneId string; `decoded` is NOT modified.
     */
    _scanPaneNotify(pid, decoded) {
        let scanner = this._notifyScanners.get(pid);
        if (scanner === undefined) {
            scanner = new PaneNotifyScanner();
            this._notifyScanners.set(pid, scanner);
        }
        const detections = scanner.scan(decoded);
        if (detections.length === 0)
            return;
        let limiter = this._notifyLimiters.get(pid);
        if (limiter === undefined) {
            limiter = new PaneNotifyRateLimiter();
            this._notifyLimiters.set(pid, limiter);
        }
        const metrics = this._opts.metrics;
        const paneId = mintPaneId(pid);
        for (const det of detections) {
            if (!limiter.allow(det.kind)) {
                // Rate-limited drop. For Tier-1 kinds this is an expected-zero tripwire
                // (a real storm or a bug) — count it AND loud-log per the repo fail-loud
                // norm. Tier-2 (progress/cmd-exit) drops are routine coalescing: counted
                // (for the ratio) but not loud.
                metrics?.incPaneNotifyDropped(det.kind);
                if (isTier1NotifyKind(det.kind)) {
                    process.stderr.write(`[pipeline] PANE-NOTIFY RATE LIMIT: dropped a Tier-1 ${det.kind} notification for pane ${pid} — ` +
                        `the pane is emitting addressed signals faster than the per-kind budget. Expected-zero ` +
                        `tripwire (pane_notify_dropped_total{kind=${det.kind}}); investigate a notification storm (tc-76m8.1).\n`);
                }
                continue;
            }
            metrics?.incPaneNotify(det.kind);
            this._firePaneNotifyHandlers(det.payload === undefined
                ? { paneId, kind: det.kind }
                : { paneId, kind: det.kind, payload: det.payload });
        }
    }
    _firePaneNotifyHandlers(notify) {
        if (this._paneNotifyHandlers.size === 0)
            return;
        for (const handler of this._paneNotifyHandlers) {
            try {
                handler(notify);
            }
            catch (e) {
                console.warn("[pipeline] pane-notify handler threw:", e);
            }
        }
    }
    _emitModelChange(model, prev) {
        if (this._opts.checkInvariantsOnUpdate) {
            const violations = checkInvariants(model);
            if (violations.length > 0) {
                console.warn("[pipeline] invariant violations after model update:", violations);
            }
        }
        // tc-2mn8 / tc-76m8.1: clean up per-pane streaming state for panes that have
        // left the model. This keeps memory bounded: each closed pane's OSC title
        // sniffer, notify scanner, and notify rate limiter are dropped when the pane
        // is no longer known to the model.
        if (this._oscSniffers.size > 0 || this._notifyScanners.size > 0) {
            for (const [pid] of prev.panes) {
                if (model.panes.has(pid))
                    continue;
                this._oscSniffers.delete(pid);
                this._notifyScanners.delete(pid);
                this._notifyLimiters.delete(pid);
            }
        }
        for (const handler of this._modelChangeHandlers) {
            try {
                handler(model, prev);
            }
            catch (e) {
                console.warn("[pipeline] model-change handler threw:", e);
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create a `RuntimePipeline` that connects a `TmuxHost`'s stdout bytes to the
 * requery-driven topology engine + coalescer (tc-128.4).
 *
 * The pipeline is not yet started. Call `pipeline.start()` after (or while)
 * calling `host.start()`.
 *
 * @param host - A TmuxHost (already created; start() may or may not have been called).
 * @param opts - Optional options (shared buffers, invariant checking,
 *               coalescer timing, classification hook).
 * @returns A RuntimePipeline whose `start()` fires the bootstrap requery and
 *          wires the data path.
 *
 * @example
 * ```ts
 * const host = createTmuxHost({ socketName: "myapp" });
 * const buffers = createPaneBufferStore();
 * const pipeline = createRuntimePipeline(host, { buffers });
 *
 * pipeline.onModelChange((model, prev) => {
 *   const deltas = diffModel(prev, model);
 *   // broadcast deltas to clients (serve.ts)
 * });
 *
 * await host.start();
 * await pipeline.start();  // bootstrap requery resolves; pipeline is live
 *
 * // Ongoing: model updates arrive via onModelChange as the coalescer fires
 * // Pane bytes: pipeline.buffers.getContents(paneId) (read by tc-fbz)
 *
 * // Shutdown:
 * pipeline.stop();
 * await host.stop();
 * ```
 */
export function createRuntimePipeline(host, opts) {
    return new RuntimePipelineImpl(host, opts);
}
export { diffModel };
//# sourceMappingURL=pipeline.js.map