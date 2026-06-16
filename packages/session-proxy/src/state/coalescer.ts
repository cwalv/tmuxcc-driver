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

// ---------------------------------------------------------------------------
// Cycle edges (tc-3si.6) — exported for callers that route the edge label
// onto the `topology_notify_to_delta_seconds` histogram.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Clock abstraction (injectable for tests)
// ---------------------------------------------------------------------------

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
export function realClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => {
      // Node typings want a NodeJS.Timeout; the host-global signature
      // accepts the round-tripped opaque value. Cast at the boundary.
      globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]);
    },
  };
}

// ---------------------------------------------------------------------------
// Notification classification (tc-x6l seam)
// ---------------------------------------------------------------------------

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
export function isTopologyEvent(event: NotificationEvent): boolean {
  switch (event.kind) {
    // Content plane — bytes streamed to a pane.
    case "output":
    case "extended-output":
      return false;

    // Flow control — out-of-band signals for the FlowController.
    case "pause":
    case "continue":
      return false;

    // Lifecycle — handled by the runtime's onExit path, not topology.
    case "exit":
      return false;

    // Subscription value delivery (e.g. the sync-watch poll). Handled by the
    // runtime as a model patch on the matching window, NOT a topology change.
    case "subscription-changed":
      return false;

    // Optimistic / compensating model patches injected by input-path. These
    // mutate the model directly via the pipeline's patch path; they are not
    // signals from tmux about topology drift.
    case "internal:set-window-sync":
    case "internal:set-window-monitor-activity":
    case "internal:set-window-monitor-silence":
    // tc-1a8z: durable pane-name optimistic/compensating patch.
    case "internal:set-pane-label":
      return false;

    // Everything else from tmux — every topology-affecting notification —
    // is a dirty bit. We don't enumerate them positively: any future tmux
    // event we don't recognize lands in "unknown" and falls through here.
    case "window-add":
    case "window-close":
    case "window-renamed":
    case "window-pane-changed":
    case "session-changed":
    case "client-session-changed":
    case "session-renamed":
    case "sessions-changed":
    case "session-window-changed":
    case "pane-mode-changed":
    case "unknown":
      return true;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Coalescer interface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `Coalescer` wrapping the given engine. See module docs for the
 * leading-edge / 1 Hz ceiling / heartbeat policy.
 */
export function createCoalescer(opts: CoalescerOptions): Coalescer {
  return new CoalescerImpl(opts);
}

/** Default ceiling: 1 Hz. */
const DEFAULT_CEILING_MS = 1000;

/** Default heartbeat: 30 s. Slow, free in steady state, bounds staleness. */
const DEFAULT_HEARTBEAT_MS = 30_000;

class CoalescerImpl implements Coalescer {
  private readonly _engine: RequeryEngine;
  private readonly _clock: Clock;
  private readonly _ceilingMs: number;
  private readonly _heartbeatMs: number;
  private readonly _onNotify: ((kind: TopologyEventKind | undefined) => void) | undefined;
  private readonly _onError: ((err: unknown) => void) | undefined;
  private readonly _onDeltas: ((result: RequeryResult, meta: CycleMeta) => void) | undefined;

  /**
   * Timestamp of the FIRST `notify()` call since the last cycle's commit,
   * or `null` if no notify has arrived since (i.e. the next cycle, if any,
   * will be a heartbeat). The runtime uses this as the "t=0" for the
   * notify-to-delta histogram (tc-3si.6).
   */
  private _firstNotifyAt: number | null = null;

  /**
   * Edge classification for the next cycle. Set by `_maybeFire` /
   * `_armHeartbeat` at the moment the cycle is scheduled; consumed by
   * `_runRequery` when it eventually fires and forwarded to `onDeltas`
   * (tc-3si.6).
   */
  private _pendingEdge: CycleEdge = "leading";

  /**
   * True when the next cycle was scheduled by the heartbeat tick rather
   * than by a real `notify()` call. Survives `_maybeFire`'s edge
   * recomputation so the eventual cycle is reported as `heartbeat` even
   * if the elapsed-since-last-requery happens to satisfy the leading-edge
   * test (tc-3si.6).
   *
   * Cleared by `_runRequery` after the edge has been latched for the
   * cycle in flight.
   */
  private _heartbeatPending = false;

  /**
   * Wall-clock timestamp of the most recent `requery()` invocation start, or
   * `-Infinity` if none has run yet (so the first notify always passes the
   * "quiet for ≥ceilingMs" leading-edge test).
   */
  private _lastRequeryAt = Number.NEGATIVE_INFINITY;

  /** Pending trailing-edge timer handle, or `null` if none is armed. */
  private _trailingHandle: TimeoutHandle | null = null;

  /** Heartbeat timer handle, or `null` if `start()` hasn't been called or `stop()` cleared it. */
  private _heartbeatHandle: TimeoutHandle | null = null;

  /** True iff we're inside `_runRequery` — used to fold mid-cycle notifies. */
  private _inFlight = false;

  constructor(opts: CoalescerOptions) {
    this._engine = opts.engine;
    this._clock = opts.clock ?? realClock();
    this._ceilingMs = opts.ceilingMs ?? DEFAULT_CEILING_MS;
    this._heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this._onNotify = opts.onNotify;
    this._onError = opts.onError;
    this._onDeltas = opts.onDeltas;
  }

  notify(kind?: TopologyEventKind): void {
    // Fire the classification hook FIRST, before any policy or engine work.
    // This is the single choke point tc-x6l will attach per-kind counters to,
    // and we don't want a counter to silently desync if a policy bug causes
    // us to skip the dirty mark.
    if (this._onNotify !== undefined) {
      try {
        this._onNotify(kind);
      } catch {
        // Observer errors must not break the pipeline.
      }
    }

    // tc-3si.6: capture the timestamp of the FIRST notify since the last
    // cycle's commit. The runtime uses this as the "t=0" for the
    // notify-to-delta histogram observation; subsequent notifies in the
    // same cycle window collapse into this one (the whole point of the
    // coalescer — they share a fire). Cleared on cycle commit.
    if (this._firstNotifyAt === null) {
      this._firstNotifyAt = this._clock.now();
    }

    this._engine.markDirty();
    this._maybeFire();
  }

  start(): void {
    this._armHeartbeat();
  }

  stop(): void {
    if (this._trailingHandle !== null) {
      this._clock.clearTimeout(this._trailingHandle);
      this._trailingHandle = null;
    }
    if (this._heartbeatHandle !== null) {
      this._clock.clearTimeout(this._heartbeatHandle);
      this._heartbeatHandle = null;
    }
  }

  /**
   * Decide whether the freshly-arrived notification should fire a leading
   * edge (cycle immediately) or fold into the already-scheduled trailing
   * edge (cycle at `_lastRequeryAt + ceilingMs`).
   *
   * Decision tree:
   *   - If a cycle is in flight: the engine's mid-flight rearm has it —
   *     `engine.markDirty()` already ensured the engine will re-run on
   *     completion. We don't schedule anything else.
   *   - Else if a trailing-edge timer is already armed: nothing to do; the
   *     trailing fire will pick up this notification's dirty bit.
   *   - Else if we've been quiet for ≥ ceilingMs (leading edge): fire now.
   *   - Else: schedule the trailing edge for `_lastRequeryAt + ceilingMs`.
   */
  private _maybeFire(): void {
    if (this._inFlight) return;
    if (this._trailingHandle !== null) return;

    const now = this._clock.now();
    const elapsed = now - this._lastRequeryAt;
    if (elapsed >= this._ceilingMs) {
      // Leading edge. Quiet for at least the ceiling window — fire now.
      // tc-3si.6: a heartbeat that lands on a quiet leading-edge moment
      // (the common case — heartbeat interval is 30 s by default, ceiling
      // is 1 s) is still classified as `heartbeat` for the metric.
      this._pendingEdge = this._heartbeatPending ? "heartbeat" : "leading";
      this._runRequery();
      return;
    }

    // Inside the ceiling window. Schedule the trailing edge.
    // (A heartbeat coinciding with a busy ceiling window collapses into a
    // trailing-edge cycle — there's an open notify storm being served, so
    // the cycle is a trailing edge of THAT, not a heartbeat.)
    this._pendingEdge = this._heartbeatPending ? "heartbeat" : "trailing";
    const wait = this._ceilingMs - elapsed;
    this._trailingHandle = this._clock.setTimeout(() => {
      this._trailingHandle = null;
      this._runRequery();
    }, wait);
  }

  /**
   * Kick off one engine cycle. Records the start timestamp (so the ceiling
   * window opens NOW, not at completion — a 500 ms requery should not
   * itself count against the 1 Hz budget for trailing-edge follow-ups).
   * Handles failure by re-arming a retry at `now + ceilingMs`.
   */
  private _runRequery(): void {
    this._lastRequeryAt = this._clock.now();
    this._inFlight = true;
    // Capture the edge + first-notify-at snapshot AT FIRE TIME — these are
    // about THIS cycle. We clear `_firstNotifyAt` here so the next notify
    // arriving DURING the cycle starts a fresh "t=0" for the NEXT cycle
    // (tc-3si.6). The engine's mid-flight rearm path uses markDirty(); a
    // mid-flight notify also lands in _onCycleSettled which calls
    // _maybeFire() — by then `_firstNotifyAt` is the new cycle's trigger.
    const cycleEdge = this._pendingEdge;
    const cycleFirstNotifyAt = this._firstNotifyAt;
    this._firstNotifyAt = null;
    this._heartbeatPending = false;

    this._engine.requery().then(
      (result) => this._onCycleSettled(result, null, cycleEdge, cycleFirstNotifyAt),
      (err) => this._onCycleSettled(null, err, cycleEdge, cycleFirstNotifyAt),
    );
  }

  /**
   * Cycle completion path: clear the in-flight flag, react to failure /
   * mid-cycle dirties, and re-evaluate whether another fire is needed.
   */
  private _onCycleSettled(
    result: RequeryResult | null,
    err: unknown,
    edge: CycleEdge,
    firstNotifyAt: number | null,
  ): void {
    this._inFlight = false;

    if (err !== undefined && err !== null) {
      if (this._onError !== undefined) {
        try {
          this._onError(err);
        } catch {
          // Swallow observer errors.
        }
      }
      // On thrown rejection (the engine should never throw in practice, but
      // a broken submit might): treat as a failed cycle. Stay dirty, retry.
      // The notify-to-delta sample is preserved across the retry (we did
      // not yet observe), so restore `_firstNotifyAt` if we cleared it.
      if (this._firstNotifyAt === null && firstNotifyAt !== null) {
        this._firstNotifyAt = firstNotifyAt;
      }
      this._engine.markDirty();
      this._scheduleRetryAfterFailure();
      return;
    }

    if (result !== null && result.failed) {
      // Steady-state %error from list-*. Engine already left the model
      // alone and re-armed dirty; we only need to defer the retry to the
      // next ceiling boundary so we don't busy-loop into the same error.
      // Preserve the notify-to-delta trigger so the retry observes from
      // the original notify, not the retry's fire moment.
      if (this._firstNotifyAt === null && firstNotifyAt !== null) {
        this._firstNotifyAt = firstNotifyAt;
      }
      this._scheduleRetryAfterFailure();
      return;
    }

    // Successful cycle: hand the converged result to the runtime so it can
    // stamp + broadcast the deltas. This fires BEFORE evaluating whether to
    // schedule another cycle, so any synchronous follow-up the consumer does
    // (e.g. updating a "last served model" reference) lands before the next
    // requery's startModel snapshot is taken.
    //
    // tc-3si.6: `meta` carries the edge label + firstNotifyAt so the runtime
    // can route the notify-to-delta sample onto the histogram.
    if (result !== null && this._onDeltas !== undefined) {
      try {
        this._onDeltas(result, { edge, firstNotifyAt });
      } catch {
        // Subscriber errors must not break the pipeline.
      }
    }

    // Successful cycle. If the engine is somehow still dirty (something
    // notified between the cycle's end and this callback running — possible
    // if the engine's own mid-flight rearm didn't catch it because a
    // notification arrived literally as the cycle resolved), evaluate
    // whether to fire again or schedule a trailing edge.
    if (this._engine.isDirty()) {
      this._maybeFire();
    }
  }

  /**
   * After a failed cycle, schedule one retry at the next ceiling boundary.
   * Uses the same trailing-edge machinery: if a notification arrives in the
   * meantime, the trailing-edge fire will pick up the dirty bit; if not,
   * the retry fires unconditionally (the engine is still dirty after
   * failure, so `requery()` will re-issue the commands).
   */
  private _scheduleRetryAfterFailure(): void {
    if (this._trailingHandle !== null) return;
    const now = this._clock.now();
    const elapsed = now - this._lastRequeryAt;
    const wait = Math.max(0, this._ceilingMs - elapsed);
    this._trailingHandle = this._clock.setTimeout(() => {
      this._trailingHandle = null;
      this._runRequery();
    }, wait);
  }

  /**
   * Arm the slow heartbeat. The heartbeat runs `requery()` unconditionally
   * (no dirty-bit check) — that's the whole point: it self-heals against
   * silent panes and event-vocabulary gaps. It does NOT bypass the ceiling:
   * if a cycle ran recently the heartbeat just observes that and lets the
   * trailing edge handle the next observation. The heartbeat re-arms itself
   * regardless of whether the tick fired a cycle.
   */
  private _armHeartbeat(): void {
    if (this._heartbeatHandle !== null) return;
    this._heartbeatHandle = this._clock.setTimeout(() => {
      this._heartbeatHandle = null;
      // Unconditional: even without a dirty bit, ask the engine. We DO
      // honor the ceiling though — same path as a notify with no kind.
      // The engine's mid-flight slot handles concurrent cycles fine.
      //
      // tc-3si.6: classify this cycle as `heartbeat` UNLESS a real notify
      // had already arrived (in which case the notify's "t=0" stands and
      // the cycle is reported as the notify's edge). The
      // `_heartbeatPending` flag survives `_maybeFire`'s edge
      // recomputation; `_runRequery` consumes and clears it.
      if (this._firstNotifyAt === null) {
        this._heartbeatPending = true;
      }
      this._engine.markDirty();
      this._maybeFire();
      // Re-arm. Heartbeats keep ticking until stop().
      this._armHeartbeat();
    }, this._heartbeatMs);
  }
}
