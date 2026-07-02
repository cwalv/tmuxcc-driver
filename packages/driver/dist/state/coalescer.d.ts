/**
 * Dirty-bit coalescer — leading-edge + 1 Hz ceiling + heartbeat (tc-128.2).
 *
 * @module state/coalescer
 *
 * # Why this exists
 *
 * The `RequeryEngine` (tc-128.1) knows HOW to run a requery cycle; it has no
 * opinion on WHEN. This module is the policy layer: it wraps an engine, takes
 * topology-notification calls from the parser, and decides when to run
 * `engine.requery()`.
 *
 * The policy comes from `projects/tmuxcc/docs/state-model.md` §6 (adopted,
 * 2026-06-10):
 *
 * - **Leading edge.** The first notification after a quiet period runs
 *   `requery()` IMMEDIATELY. Rare events (e.g. pane death) almost always land
 *   on quiet, so they get instant service. 1 Hz is a CEILING, not a clock.
 * - **1 Hz ceiling under storms.** Notifications arriving inside the ceiling
 *   window (default 1 s) are folded into a single trailing-edge cycle. Storm
 *   rendering at 1 fps is intentional (see §5: sustained high rate is almost
 *   always a bug).
 * - **Heartbeat.** A slow unconditional cycle catches changes that arrived
 *   with zero notifications (silent panes, future event-vocabulary gaps).
 *   Replaces the old synthetic-reconcile special case.
 *
 * # Failure handling
 *
 * If the engine reports `failed: true` (a `list-*` reply was `%error`), the
 * coalescer treats the cycle as failed: the model stays untouched (the engine
 * already preserved it), the dirty bit is re-armed (the engine already did
 * that), and the coalescer schedules a retry at `now + ceilingMs` rather than
 * busy-retrying. The heartbeat guarantees eventual convergence even if the
 * caller stops feeding notifications.
 *
 * # Single classification choke point (tc-x6l tie-in)
 *
 * `notify(kind?)` is the ONE place a topology notification is classified into
 * "dirty + maybe a kind label". The optional `onNotify(kind)` hook fires
 * exactly once per `notify()` call, before any other work — so a future
 * per-kind counter (tc-x6l) can attach here without restructuring. We don't
 * implement counters; we just shape the seam.
 *
 * # Wiring
 *
 * This module deliberately does NOT wire itself into `RuntimePipeline`. The
 * pipeline swap is tc-128.4. Tests use a synthetic submit + injected clock to
 * exercise the regimes.
 */
import type { RequeryEngine, RequeryResult } from "./requery.js";
import type { NotificationEvent } from "../parser/notifications.js";
/**
 * The edge classification reported alongside each successful cycle's
 * `onDeltas` callback (tc-3si.6). Maps directly onto the `edge` label of
 * the `topology_notify_to_delta_seconds` histogram in metrics/registry.ts.
 *
 * - `leading`: the cycle was fired by `notify()` after a quiet period —
 *   the keystone "served instantly" mode (state-model.md §6).
 * - `trailing`: the cycle ran on the trailing-edge timer (a notify landed
 *   inside the ceiling window and got folded). Bounded by ceiling, ~1 s.
 * - `heartbeat`: the cycle was fired by the unconditional slow heartbeat,
 *   without a triggering notify. The "notify-to-delta" distance for these
 *   cycles is undefined; reporting them under a dedicated edge lets the
 *   metric's reader distinguish heartbeat samples from the latency modes.
 * - `bootstrap`: only used by the runtime for the initial bootstrap
 *   transition (not driven through the coalescer). Same semantics as
 *   heartbeat for the purposes of the histogram.
 */
export type CycleEdge = "leading" | "trailing" | "heartbeat" | "bootstrap";
/**
 * Opaque handle returned by `Clock.setTimeout` and accepted by
 * `Clock.clearTimeout`. The host clock decides the concrete type — Node's
 * real `setTimeout` returns a `Timeout` object; a test clock can use a
 * number. We never compare or read these — the coalescer just round-trips
 * them through the clock.
 */
export type TimeoutHandle = unknown;
/**
 * Minimal clock surface the coalescer needs. Production wiring binds this to
 * the host's real `setTimeout` / `clearTimeout` / `Date.now`. Tests inject a
 * synthetic clock that advances on demand — no real-time sleeps.
 */
export interface Clock {
    now(): number;
    setTimeout(fn: () => void, ms: number): TimeoutHandle;
    clearTimeout(handle: TimeoutHandle): void;
}
/** Default clock: thin wrapper over the host globals. */
export declare function realClock(): Clock;
/**
 * Optional, opaque label for the topology notification that produced this
 * `notify()` call. The coalescer never interprets it (the whole point of the
 * §6 policy is to never trust event content). It exists purely so the
 * `onNotify` hook — the single classification choke point — can route a per-
 * kind counter (tc-x6l) without us inventing the taxonomy here. Callers pass
 * the raw tmux notification kind, e.g. `"%layout-change"`,
 * `"%window-add"`, `"%pane-died"`.
 */
export type TopologyEventKind = string;
/**
 * Classify a parsed `NotificationEvent` as topology-kind (should trigger a
 * requery) or content-kind / out-of-band (handled elsewhere).
 *
 * The §6 policy demotes every topology-affecting `%`-notification to a dirty
 * bit; this helper is the ONE place where the parser vocabulary is mapped onto
 * "does this invalidate the topology model?". The reducer's per-event
 * interpretation is gone (tc-128.4) — the coalescer only ever cares about the
 * dichotomy, not the specifics.
 *
 * Returns `true` for any event that could reflect a change in the
 * sessions/windows/panes/layout/focus structure. Returns `false` for content-
 * plane events (`output`, `extended-output`), flow control (`pause`,
 * `continue`), purely-informational events (`exit`), the internal synthetic
 * events used by `input-path` for optimistic updates, and `subscription-
 * changed` (which is the polled value feed, not a topology notification).
 *
 * `unknown` keywords default to topology — we'd rather requery a few extra
 * times than miss a change. `%layout-change` arrives as `unknown` (it is not
 * in the parser vocabulary), and it MUST be classified as topology.
 */
export declare function isTopologyEvent(event: NotificationEvent): boolean;
/** Options for `createCoalescer`. */
export interface CoalescerOptions {
    /** The wrapped requery engine. */
    readonly engine: RequeryEngine;
    /**
     * Injected clock. Defaults to `realClock()`. Tests pass a synthetic clock
     * to control `now()` and timer firings deterministically.
     */
    readonly clock?: Clock;
    /**
     * Minimum spacing between requery cycles, in milliseconds. Default 1000
     * (1 Hz, the design's nominal ceiling). The FIRST notification after a
     * quiet period of at least this long fires immediately — see the module
     * doc on "leading edge". Storms inside the window fold into one trailing-
     * edge cycle.
     */
    readonly ceilingMs?: number;
    /**
     * Heartbeat interval in milliseconds. The coalescer runs an unconditional
     * `requery()` this often (whether or not the dirty bit is set), to catch
     * changes that arrived with zero notifications — silent panes and any
     * future event-vocabulary gap. Default 30_000 (30 s): slow enough to be
     * free in steady state, fast enough that the worst-case stale window is
     * bounded. Set to a small value in tests to exercise the regime.
     */
    readonly heartbeatMs?: number;
    /**
     * Optional observer fired once per `notify()` call, before any other work.
     * This is the single classification choke point that tc-x6l (per-kind
     * topology event counters + storm alarm) attaches to. The coalescer never
     * interprets `kind`; the hook is purely an emit point. Throws are caught
     * and ignored so a misbehaving observer cannot break the pipeline.
     */
    readonly onNotify?: (kind: TopologyEventKind | undefined) => void;
    /**
     * Optional error sink for failures inside `requery()` (rejected Promises
     * or unexpected throws). The coalescer always re-arms dirty + schedules a
     * retry on failure; this hook is purely for logging/observability. Throws
     * here are caught and ignored.
     */
    readonly onError?: (err: unknown) => void;
    /**
     * Optional sink invoked once per SUCCESSFUL `engine.requery()` completion,
     * with the freshly-converged model and the wire deltas needed to transform
     * the previous served model into it. This is the handoff the pipeline uses
     * to broadcast deltas to clients — the coalescer drives requery cycles, and
     * this hook lets the runtime stamp + emit the resulting deltas without
     * polling the engine.
     *
     * Fired ONLY on successful cycles: when the engine reports `failed: true`
     * (a `%error` reply, or convergence budget exhausted), this is NOT called —
     * the engine and coalescer handle the retry path internally and the runtime
     * never sees a torn snapshot.
     *
     * The hook may receive an empty `deltas` array (a clean requery cycle that
     * found no observable change — e.g. a heartbeat in steady state, or a
     * trailing-edge cycle whose dirty signal was driven by a notification that
     * did not actually alter the structure). The runtime should treat empty as
     * a no-op (no deltas to send) but still update any "last served model"
     * snapshot if it tracks one.
     *
     * # `meta` (tc-3si.6)
     *
     * `meta.edge` is the cycle edge — `leading` / `trailing` / `heartbeat` —
     * used to label the `topology_notify_to_delta_seconds` histogram so the
     * keystone latency promise stays observable. `meta.firstNotifyAt` is the
     * `clock.now()` timestamp at which THIS cycle's triggering `notify()`
     * arrived (the FIRST notify since the last cycle completed); the runtime
     * computes the histogram's notify-to-delta sample as
     * `clock.now() - firstNotifyAt` at broadcast time. Heartbeat cycles
     * report `firstNotifyAt === null` and should be observed under the
     * `heartbeat` edge with a synthetic large value (the heartbeat interval),
     * NOT included in the leading/trailing modes.
     *
     * Throws here are caught and ignored so a misbehaving subscriber cannot
     * break the pipeline.
     */
    readonly onDeltas?: (result: RequeryResult, meta: CycleMeta) => void;
}
/**
 * Per-cycle metadata reported alongside `onDeltas` (tc-3si.6). Lets the
 * runtime route the `edge` label onto `topology_notify_to_delta_seconds`
 * and compute the notify-to-delta distance from `firstNotifyAt`.
 */
export interface CycleMeta {
    /** Which edge of the §6 policy fired this cycle. */
    readonly edge: CycleEdge;
    /**
     * Timestamp (from the injected clock) of the first `notify()` call since
     * the previous successful cycle completed. `null` for heartbeat cycles
     * (no triggering notification). Used by the runtime as the "t=0" point
     * for the `topology_notify_to_delta_seconds` observation.
     */
    readonly firstNotifyAt: number | null;
}
/**
 * Public surface of the dirty-bit coalescer.
 */
export interface Coalescer {
    /**
     * Receive one topology notification. The parser calls this for every
     * topology-relevant `%`-message; the coalescer marks the engine dirty and
     * decides whether to fire immediately (leading edge — quiet period ended)
     * or schedule a trailing-edge cycle (ceiling window still active).
     *
     * `kind` is forwarded verbatim to the `onNotify` hook for counter routing
     * (tc-x6l). The coalescer never reads it.
     */
    notify(kind?: TopologyEventKind): void;
    /**
     * Arm the heartbeat timer. Idempotent: calling twice is a no-op. The
     * coalescer's other timers are armed on demand by `notify()`; this just
     * starts the slow unconditional tick.
     */
    start(): void;
    /**
     * Cancel all pending timers (trailing-edge fire AND heartbeat). Does not
     * touch the engine's dirty bit, does not cancel an in-flight `requery()`
     * Promise (the engine itself has no cancel surface). Idempotent. Safe to
     * call from a teardown path.
     */
    stop(): void;
}
/**
 * Create a `Coalescer` wrapping the given engine. See module docs for the
 * leading-edge / 1 Hz ceiling / heartbeat policy.
 */
export declare function createCoalescer(opts: CoalescerOptions): Coalescer;
//# sourceMappingURL=coalescer.d.ts.map