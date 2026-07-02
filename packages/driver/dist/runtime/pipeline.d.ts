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
import type { NotificationEvent } from "../parser/notifications.js";
import type { CommandResult } from "../parser/correlator.js";
import type { PaneBufferStore } from "../state/scrollback.js";
import type { SessionModel } from "../state/model.js";
import type { SwitchClientOutcome } from "../state/switch-client.js";
import { type Clock, type TopologyEventKind } from "../state/coalescer.js";
import type { SessionProxyRegistry } from "../metrics/registry.js";
import type { PaneId, PaneNotifyKind, PaneNotifyPayload } from "@tmuxcc/protocol";
import type { TmuxHost } from "./tmux-host.js";
import { diffModel } from "../state/projection.js";
import type { SessionProxyMessage } from "@tmuxcc/protocol";
/**
 * Called after each model update with the new and previous model.
 * Returning an unsubscribe function from `onModelChange` allows cleanup.
 */
export type ModelChangeHandler = (model: SessionModel, prev: SessionModel) => void;
/**
 * Called for every notification token emitted by the pipeline, regardless of
 * whether the notification causes a model change.  This is the seam for
 * components (e.g. FlowController) that must act on %pause / %continue /
 * %extended-output without going through the model.
 *
 * Fired synchronously, inside the same event-loop tick as the notification
 * arrival.  Only called while the pipeline is live (after start() resolves).
 *
 * Returns an unsubscribe function.
 */
export type NotificationHandler = (event: NotificationEvent) => void;
/**
 * Sink invoked for every topology notification the pipeline classifies as
 * topology-dirty (i.e. those forwarded to `coalescer.notify(kind)`). This is
 * the single classification choke point tc-x6l per-kind counters subscribe to;
 * see the wiring in `runtime/session-proxy.ts`.
 *
 * The hook is purely observational — it does not influence policy. `kind` is
 * the raw `NotificationEvent.kind` (e.g. "window-add", "layout-change", or
 * an unknown keyword).
 */
export type TopologyNotifyHandler = (kind: TopologyEventKind) => void;
/**
 * One attention/status signal the pipeline recognised on a pane's `%output`
 * byte stream (tc-76m8.1, user-stories.md S9), after driver-side rate limiting.
 * `paneId` is the WIRE pane id ("p3"); emitted for BOTH bound and unbound panes.
 * The ControlServer broadcasts these to clients as `pane.notify`.
 */
export interface PaneNotifyEmission {
    readonly paneId: PaneId;
    readonly kind: PaneNotifyKind;
    readonly payload?: PaneNotifyPayload;
}
/**
 * Called for every rate-limited `pane.notify` the escape scanner emits.
 * The control-plane server subscribes to broadcast them to clients. Fired
 * synchronously from the `%output` dispatch path; only while the pipeline is
 * live. Returns an unsubscribe function.
 */
export type PaneNotifyHandler = (notify: PaneNotifyEmission) => void;
/** Options for `createRuntimePipeline`. */
export interface RuntimePipelineOptions {
    /**
     * Per-pane byte buffer store. Defaults to a new store created with
     * `createPaneBufferStore()`. Callers may supply their own to share it
     * with tc-fbz (demux) or with test assertions.
     */
    buffers?: PaneBufferStore;
    /**
     * If true, check model invariants after every notification event and
     * log violations (does NOT throw). Useful for development / tests.
     * Default: false (no invariant checks in production hot path).
     */
    checkInvariantsOnUpdate?: boolean;
    /**
     * The tmux session name this session-proxy is attached to.
     * Forwarded to the bootstrap commands so `list-windows`/`list-panes` scope
     * to a single session (avoiding cross-session contamination on a shared
     * tmux server). Also used by the runtime to derive `boundSessionId` for
     * switch-client narrowing (`onSwitchClientDetected`).
     */
    sessionName?: string;
    /**
     * Called when the runtime detects a switch-client drift from the bound
     * session (tc-j9c.7). The reducer that originally fired this on
     * `%session-changed` is retired (tc-128.4); the runtime now infers drift
     * by inspecting model deltas from the requery engine — the session-proxy
     * factory (runtime/session-proxy.ts) wires this for production.
     *
     * NOTE (tc-128.4): drift inference is wired by the session-proxy factory,
     * not in this module. This option is forwarded as a no-op anchor so existing
     * test wiring compiles; the actual narrowing is the factory's concern.
     *
     * "reattach"    — bound session still present.
     * "unavailable" — bound session gone.
     */
    onSwitchClientDetected?: (outcome: SwitchClientOutcome) => void;
    /**
     * Clock injected into the coalescer. Defaults to the real wall clock.
     * Tests inject a synthetic clock to control heartbeat / ceiling timing.
     */
    clock?: Clock;
    /**
     * Coalescer ceiling in milliseconds (1 Hz default). See coalescer docs.
     * Most callers leave this at the default.
     */
    ceilingMs?: number;
    /**
     * Coalescer heartbeat in milliseconds (30 s default). The slow unconditional
     * tick that catches changes arriving with zero notifications.
     */
    heartbeatMs?: number;
    /**
     * Optional sink for the topology classification choke point (tc-x6l). Fires
     * once per topology-classified notification, BEFORE the coalescer's policy
     * runs — same vocabulary as the previous `pipeline.onNotification` call for
     * counter routing, but scoped to topology only (output/pause/continue and
     * the internal synthetic events are never reported here).
     *
     * The session-proxy factory uses this to drive per-kind counters + the
     * storm alarm.
     */
    onTopologyNotify?: TopologyNotifyHandler;
    /**
     * Teardown-confirmation threshold for the requery engine guard
     * (tc-3si.2). A clean cycle whose candidate would close ≥ this fraction
     * of either the previous model's panes or its windows is held back and
     * confirmed by a follow-up cycle before being served — defending
     * clients against any future regression of the tc-128.4 garbage-snapshot
     * mis-bind class. Default 0.8 (80%). Forwarded to
     * `createRequeryEngine({ teardownThreshold })`.
     */
    teardownThreshold?: number;
    /**
     * Optional metrics registry for the latency/throughput histograms
     * (tc-3si.6). When provided, the pipeline:
     *
     *   - Observes `command_round_trip_seconds{kind}` for every slotted
     *     command write (requery list-* pair, optimistic-update set-option,
     *     refresh-client flow-control, …). The `kind` label comes from
     *     `classifyCommand(commandLine)`.
     *   - Observes `topology_notify_to_delta_seconds{edge}` once per
     *     successful coalescer cycle: notify timestamp → broadcast.
     *   - Increments `deltas_emitted_total` by the wire-delta count of each
     *     emitted cycle (the denominator of the fan-out amplification ratio).
     *   - Increments `output_bytes_total` and observes
     *     `output_frame_size_bytes` for every decoded `%output` /
     *     `%extended-output` payload, AGGREGATE (no per-pane labels —
     *     cardinality rule, see metrics/registry.ts).
     *
     * Wired by `runtime/session-proxy.ts`. The pipeline is otherwise
     * metrics-free — every observation lives behind this option so unit
     * tests that don't care about metrics don't have to construct a
     * registry just to construct a pipeline.
     */
    metrics?: SessionProxyRegistry;
    /**
     * Called when the per-session notification-processing pipeline catches an
     * unhandled exception (tc-2x3.4 per-session error boundary).
     *
     * The pipeline's `host.onData` handler wraps its tokenizer → correlator →
     * _dispatchEvent call stack in a try/catch. If anything in that stack throws
     * (a parser bug, a reducer throwing on a malformed notification, etc.) the
     * error is CAUGHT — it does not propagate out of the event-loop callback and
     * cannot crash the whole process — and this callback fires with the caught
     * error.
     *
     * After calling this hook the pipeline STOPS itself (`stop()`) so no further
     * processing happens on the now-broken pipeline. The caller is expected to
     * tear down and reattach the session-proxy (the supervisor does this via
     * `_teardownEntry` + lazy respawn).
     *
     * If this option is not supplied, a caught error is logged to stderr but the
     * pipeline is NOT stopped — this preserves backward-compatibility for callers
     * (tests, integration setups) that do not wire an error boundary.
     */
    onFatalError?: (err: unknown) => void;
    /**
     * Bounded timeout (ms) for each attempt of the BOOTSTRAP requery in
     * `start()` (tc-hfxb.15). The bootstrap requery is a `list-windows` /
     * `list-panes` round-trip over the freshly-forked `tmux -CC` stream; under
     * host load that first round-trip can STALL, and the round-trip has no
     * timeout anywhere in the chain. A single stall would silently consume the
     * caller's whole connect budget (the e2e suite's 15 s terminal-appearance
     * wait — see tc-hfxb.15 / tc-crnt.17).
     *
     * On timeout, `start()` CANCELS the stalled requery's correlator slots (so a
     * late `%end` can't mis-bind a subsequent command — see
     * `CommandCorrelator.cancelOldest`) and RE-ISSUES the requery. The requery is
     * a pure, idempotent read, so re-issuing is safe. The 15 s envelope is
     * unchanged — this makes a transient stall RECOVERABLE within budget rather
     * than fatal. Same class as tc-vw10's un-timeout'd liveness probe.
     *
     * Default 3500 ms (well under the 15 s envelope, with room for ~2-3
     * attempts). Set to 0 / a non-positive value to DISABLE the bounded retry
     * and fall back to a single unbounded `engine.requery()` (the pre-tc-hfxb.15
     * behaviour) — used only by tests that assert the old shape.
     */
    bootstrapRequeryTimeoutMs?: number;
}
/**
 * RuntimePipeline — the live tmux→model spine (requery-driven, tc-128.4).
 *
 * Lifecycle:
 *   const pipeline = createRuntimePipeline(host, { buffers });
 *   pipeline.onModelChange((model, prev) => { ... });
 *   await pipeline.start();   // issues bootstrap requery, wires onData
 *   // model updates arrive via onModelChange when the coalescer fires
 *   pipeline.stop();          // unsubscribes from host data, stops coalescer
 *   pipeline.getModel();      // always safe to call
 */
export interface RuntimePipeline {
    /**
     * Wire the pipeline to the host: subscribes to `host.onData`, fires the
     * initial bootstrap requery, and resolves once the engine has committed
     * its first clean model.
     *
     * The host must be started (or start()ing) before calling this.
     */
    start(): Promise<void>;
    /**
     * Unsubscribe from `host.onData` and stop the coalescer. Idempotent. Does
     * NOT stop the host. After stop(), the model reflects the last state
     * before stop().
     */
    stop(): void;
    /**
     * The current live SessionModel. Always safe to call; returns the empty
     * model before start() resolves.
     */
    getModel(): SessionModel;
    /**
     * Whether the bootstrap phase has completed and the pipeline is live.
     * False before start() resolves (or if start() hasn't been called).
     */
    isLive(): boolean;
    /**
     * Register a callback for model updates. Called synchronously after each
     * update. Returns an unsubscribe function.
     *
     * Downstream seam:
     *   - serve.ts uses this to broadcast deltas to connected clients.
     *   - session-proxy.ts uses this to drive the OutputDemux pane-tracking.
     */
    onModelChange(handler: ModelChangeHandler): () => void;
    /**
     * Register a callback for every notification event, fired synchronously
     * before the model-change signal (and even for no-op notifications like
     * %pause / %continue that do not change the model).
     *
     * Only called while the pipeline is live (after start() resolves).
     * Returns an unsubscribe function.
     *
     * Use this for components (e.g. FlowController) that need to react to
     * %pause / %continue without going through the model.
     */
    onNotification(handler: NotificationHandler): () => void;
    /**
     * Register a callback for every `pane.notify` the escape scanner emits
     * (tc-76m8.1, S9) — attention/status signals recognised on the per-pane
     * `%output` byte stream, after driver-side rate limiting. Fired synchronously
     * from the output-dispatch path, for BOTH bound and unbound panes.
     *
     * Downstream seam: serve.ts subscribes and broadcasts each as a `pane.notify`
     * server-push to all connected clients. Returns an unsubscribe function.
     */
    onPaneNotify(handler: PaneNotifyHandler): () => void;
    /**
     * Inject a synthetic `NotificationEvent` into the pipeline as if it had
     * arrived from tmux. Used by `input-path.ts` for the optimistic-update
     * pattern (tc-7xv.12): after sending a tmux command, callers inject the
     * expected model change so the model + delta stream are updated immediately
     * without waiting for a tmux notification.
     *
     * Under the requery-driven pipeline (tc-128.4), the `internal:set-window-*`
     * events route through `patchModel` (the path that also handles
     * `%subscription-changed sync-watch`). Topology-classified events injected
     * here would be treated as a dirty-bit trigger (engine.requery), but in
     * practice only the `internal:*` variants are injected by the runtime.
     *
     * No-op before start() resolves.
     */
    injectNotification(event: NotificationEvent): void;
    /**
     * Apply a synthetic model patch directly to the engine's stored model and
     * broadcast the resulting deltas (tc-128.4 replacement for the
     * pre-requery `injectNotification` path).
     *
     * Used by:
     *   - input-path.ts for optimistic-update apply + error reversal of
     *     `synchronize-panes` / `monitor-activity` / `monitor-silence`.
     *   - this module itself for `%subscription-changed sync-watch` (the polled
     *     value feed for external `synchronize-panes` changes).
     *
     * The updater receives the current model and returns the patched model
     * (using the structural helpers in `state/model.ts`). If the patched model
     * is reference-equal to the input (no change), the patch is a no-op and
     * no `onModelChange` callback fires.
     *
     * The patched model is also committed to the engine so future requery diffs
     * use it as the baseline — without this, the next requery cycle would emit
     * a compensating delta that undoes the patch.
     *
     * No-op before start() resolves (engine not yet wired).
     */
    patchModel(updater: (model: SessionModel) => SessionModel): void;
    /**
     * Reconstruct one client's durable per-pane binding intent from tmux and
     * patch it into the model (D3, tc-4b6k.2).
     *
     * Binding intent is per (pane, client-identity), stored in the per-client
     * `@tmuxcc-bound-<key>` user-options. The bulk session-scoped requery does
     * NOT read these (it has no notion of the client set), so when a client
     * connects — the cold-attach / VS Code-reload path — its slot must be read
     * once and applied before its snapshot is projected, or a reconnecting client
     * would briefly see `bound=false` for a pane it durably bound. This issues a
     * single `list-panes -F #{@tmuxcc-bound-<key>}` for the bound session, then
     * patches each pane's `boundClients` membership for `clientId` to match tmux
     * (canonical). Steady-state changes ride the optimistic set-object-policy
     * patch + the requery carry-forward; this is the reconstruction seam.
     *
     * No-op for an anonymous connection (undefined clientId — never bound) or
     * before the pipeline is live / has a session. Best-effort: a `%error` reply
     * leaves the model untouched (the carry-forward keeps any prior state).
     *
     * The returned Promise resolves once the read has been applied (or skipped),
     * so the caller can await it before sending the snapshot.
     */
    applyClientBinding(clientId: string | undefined): Promise<void>;
    /**
     * The PaneBufferStore used by this pipeline for %output/%extended-output bytes.
     * tc-fbz reads from this store to frame pane byte content for the wire.
     */
    readonly buffers: PaneBufferStore;
    /**
     * Atomically register a correlator slot AND write the command (tc-3si.1).
     *
     * This is the ONLY legal command-send path under the requery pipeline: the
     * slot registration and the host write happen together so the FIFO pairing
     * stays in sync regardless of what other writers are doing concurrently.
     * Without the pairing, a command's `%end` reply could mis-bind to a
     * concurrent requery's `list-*` slot, corrupting the engine's topology
     * snapshot (see tc-128.4 / tc-3si).
     *
     * The returned Promise resolves with the matching `CommandResult` once tmux's
     * reply block completes (`ok=true` on `%end`, `false` on `%error`).
     * Fire-and-forget callers may ignore it — the slot is still registered, so
     * the FIFO sequence stays correct. Awaiting callers (e.g. input-path's
     * optimistic-update error reversal) observe the result.
     *
     * No production caller may write a tmux command outside this method; the
     * `runtime-command-seam` dependency-cruiser rule rejects `tmux-host.ts`
     * imports from modules that would tempt them to bypass it.
     */
    send(command: string): Promise<CommandResult>;
    /**
     * Atomically register N slots AND write N command lines as ONE chunk
     * (tc-3si.1).
     *
     * Use when a caller needs tmux to process several command lines without
     * permitting another writer to interleave between them (e.g. the
     * resize-managed-window transaction in input-path: window-size manual →
     * resize-window → resize-pane×N). Each command line still gets its own
     * `%begin/%end` block; the returned Promises resolve in submission order.
     *
     * Equivalent to N individual `send()` calls except for the atomicity: this
     * method emits ONE host write with all lines joined by `\n`, so no other
     * writer can land bytes in between.
     */
    sendBatch(commands: readonly string[]): Promise<CommandResult>[];
    /**
     * Re-snapshot the correlator's pending-slot depth and oldest-slot age
     * into the metrics registry's gauges (tc-3si.5).
     *
     * The correlator's `onPendingChanged` hook drives the gauges on every
     * register / close edge, but the OLDEST slot's AGE grows continuously
     * while the queue is non-empty — so a reader that hits
     * `session-proxy.info` between command edges would see a stale age.
     * Calling this immediately before `metricsRegistry.metrics()` keeps the
     * exposition fresh without polling on a timer.
     *
     * No-op when no metrics registry is wired.
     */
    refreshCorrelatorPendingGauge(): void;
}
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
export declare function createRuntimePipeline(host: TmuxHost, opts?: RuntimePipelineOptions): RuntimePipeline;
export type { SessionProxyMessage };
export { diffModel };
//# sourceMappingURL=pipeline.d.ts.map