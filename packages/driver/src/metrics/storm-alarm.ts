/**
 * Topology-event rate storm alarm (tc-x6l).
 *
 * # Why
 *
 * Legitimate topology-event traffic is bursty by nature:
 *   - Resize drags:    ~60 Hz × N windows, duration < 1 s
 *   - Title churn:     `automatic-rename` per shell command, ~10–100/s, < 2 s
 *   - Agent fan-outs:  scripted `new-window` at machine speed, ~100–500/s, < 5 s
 *
 * The tc-3y8.8 reattach storm produced ~8000 events/s SUSTAINED for minutes.
 *
 * Discriminator: rate over a sliding window. Sustained high rate is near-
 * certainly pathology (§5 state-model.md).
 *
 * # Algorithm: fixed sliding window (ring-buffer of per-second buckets)
 *
 * Maintains N one-second buckets (default N = 5 → 5 s window).  A timer
 * ticks every second: rotate buckets, sum the window, compare to threshold.
 * Event arrivals only call `record()` — one `+= 1` on the current bucket,
 * no allocation per event.
 *
 * On trip:
 *   - Fires `onTrip(breakdown)` ONCE per trip event (re-arms after `resetMs`).
 *   - `breakdown` maps kind → count in the window for per-culprit attribution.
 *   - Logs loudly to stderr (the log line names the storm AND names the culprit).
 *
 * # Threshold default rationale
 *
 * Default: 2500 events in 5 s (= 500/s sustained).
 *
 *   - Well above legit burst ceilings (~500/s agent fan-outs end in seconds).
 *   - Well below the tc-3y8.8 storm floor (~8000/s × 300 s = 2.4M in 5 s).
 *   - 5-second window means sub-second bursts (resize drags) don't accumulate
 *     enough to trip.
 *
 * Override via `StormAlarmOptions.threshold` and `windowMs` for tuning.
 *
 * # Injectable clock
 *
 * Uses the same `Clock` interface from `state/coalescer.ts` so tests can
 * advance time deterministically without real sleeps.
 *
 * @module metrics/storm-alarm
 */

import type { Clock, TimeoutHandle } from "../state/coalescer.js";
import { realClock } from "../state/coalescer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-kind event count within the current alarm window.
 * Keys are the `event.kind` strings from `NotificationEvent`.
 */
export type KindBreakdown = ReadonlyMap<string, number>;

/** Options for `createStormAlarm`. */
export interface StormAlarmOptions {
  /**
   * Injected clock. Defaults to `realClock()`. Tests pass a synthetic clock to
   * control timer firings deterministically without sleeps.
   */
  readonly clock?: Clock;

  /**
   * Sliding window width in milliseconds. The window is approximated by
   * `Math.ceil(windowMs / bucketMs)` one-second buckets. Default: 5000 (5 s).
   */
  readonly windowMs?: number;

  /**
   * Bucket width in milliseconds. Each bucket accumulates events that arrive
   * within one bucket interval. Default: 1000 (1 s).
   *
   * Lower values give finer rate resolution at the cost of more buckets.
   * Keeping `windowMs / bucketMs` small (≤ 10) keeps memory footprint trivial.
   */
  readonly bucketMs?: number;

  /**
   * Total event count threshold over the full sliding window. If the sum of
   * all bucket counts ≥ threshold, the alarm trips.
   *
   * Default: 2500 (500 events/s × 5 s). See module doc for rationale.
   *
   * Set to `Infinity` to disable (useful in tests that only want the counter).
   */
  readonly threshold?: number;

  /**
   * Minimum milliseconds between consecutive trip fires. Prevents log spam
   * when the storm is sustained: the alarm fires once, then resets after
   * `resetMs`. Default: 10_000 (10 s).
   */
  readonly resetMs?: number;

  /**
   * Called when the alarm trips. Receives the per-kind breakdown of events
   * counted in the current window (for culprit attribution in the log line).
   *
   * Throws in this callback are caught and swallowed so a misbehaving handler
   * cannot break the pipeline.
   */
  readonly onTrip?: (breakdown: KindBreakdown) => void;
}

/** Public interface of the storm alarm. */
export interface StormAlarm {
  /**
   * Record one event of the given kind.
   *
   * Hot-path safe: a single `+=` on the current bucket array slot.
   * No allocation per call.
   *
   * @param kind - The notification event kind (e.g. "layout-change"). May be
   *               `undefined` for synthetic/unknown events — recorded under
   *               the key `"unknown"`.
   */
  record(kind: string | undefined): void;

  /**
   * Start the evaluation timer. Idempotent: calling twice is a no-op.
   * Must be called to enable periodic alarm evaluation.
   */
  start(): void;

  /**
   * Stop the evaluation timer. Idempotent. Does not clear accumulated counts.
   */
  stop(): void;

  /**
   * Return the per-kind breakdown for the current window (snapshot).
   * Useful for exposing in `server-proxy.info` alongside the counter text.
   */
  windowBreakdown(): KindBreakdown;

  /**
   * Return the total event count across all buckets in the current window.
   */
  windowTotal(): number;

  /**
   * Return the configured threshold (events in window before alarm trips).
   * Useful for including in the `session-proxy.info` response for context.
   */
  readonly threshold: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default window width: 5 seconds. */
const DEFAULT_WINDOW_MS = 5_000;

/** Default bucket width: 1 second. */
const DEFAULT_BUCKET_MS = 1_000;

/**
 * Default threshold: 2500 events in 5 s (500/s sustained).
 *
 * Rationale (from state-model.md §5 + tc-3y8.8 forensics):
 *   - Legitimate bursts top out at ~500/s for < 5 s (agent fan-outs).
 *     5 s × 500/s = 2500 — our threshold is exactly the legit ceiling,
 *     meaning a true storm (e.g. 8000/s for 5 s = 40000 events) trips with
 *     several orders-of-magnitude headroom.
 *   - Short bursts (resize drags < 1 s) accumulate <<2500 and do NOT trip.
 *   - The reset period (10 s default) prevents log spam during sustained storms.
 */
const DEFAULT_THRESHOLD = 2500;

/** Default alarm reset window: 10 seconds between consecutive trip fires. */
const DEFAULT_RESET_MS = 10_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class StormAlarmImpl implements StormAlarm {
  private readonly _clock: Clock;
  private readonly _bucketCount: number;
  private readonly _bucketMs: number;
  readonly threshold: number;
  private readonly _resetMs: number;
  private readonly _onTrip: ((breakdown: KindBreakdown) => void) | undefined;

  /**
   * Ring buffer of event counts: one entry per bucket, indexed by
   * `_currentBucket % _bucketCount`.  Each entry is a total count.
   */
  private readonly _bucketTotals: number[];

  /**
   * Ring buffer of per-kind breakdowns: mirrors `_bucketTotals` but keyed by
   * kind string.  Only populated when `_onTrip` is set — the breakdown is
   * needed for attribution on trip.
   */
  private readonly _bucketKinds: Map<string, number>[];

  /** Index of the most recent bucket in the ring. */
  private _currentBucket = 0;

  /**
   * Timestamp (from `clock.now()`) when the current bucket was last rotated.
   * Used to determine when to advance the ring on the next tick.
   */
  private _lastRotateAt: number;

  /** Whether `start()` has been called and `stop()` has NOT been called. */
  private _running = false;

  /** Pending timer handle (re-armed each tick). */
  private _timerHandle: TimeoutHandle | null = null;

  /**
   * Timestamp of the last trip fire, or `-Infinity` if never tripped.
   * Guards the `resetMs` re-arm window.
   */
  private _lastTripAt = Number.NEGATIVE_INFINITY;

  constructor(opts: StormAlarmOptions) {
    this._clock = opts.clock ?? realClock();
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const bucketMs = opts.bucketMs ?? DEFAULT_BUCKET_MS;
    this._bucketMs = bucketMs;
    this._bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs));
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this._resetMs = opts.resetMs ?? DEFAULT_RESET_MS;
    this._onTrip = opts.onTrip;

    this._lastRotateAt = this._clock.now();

    // Initialise ring buffers (pre-allocated, no per-event allocation).
    this._bucketTotals = new Array(this._bucketCount).fill(0) as number[];
    this._bucketKinds = Array.from({ length: this._bucketCount }, () => new Map<string, number>());
  }

  record(kind: string | undefined): void {
    const k = kind ?? "unknown";
    this._bucketTotals[this._currentBucket] = (this._bucketTotals[this._currentBucket] ?? 0) + 1;
    const kindMap = this._bucketKinds[this._currentBucket]!;
    kindMap.set(k, (kindMap.get(k) ?? 0) + 1);
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._armTick();
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this._timerHandle !== null) {
      this._clock.clearTimeout(this._timerHandle);
      this._timerHandle = null;
    }
  }

  windowBreakdown(): KindBreakdown {
    const merged = new Map<string, number>();
    for (const kindMap of this._bucketKinds) {
      for (const [k, v] of kindMap) {
        merged.set(k, (merged.get(k) ?? 0) + v);
      }
    }
    return merged;
  }

  windowTotal(): number {
    let sum = 0;
    for (const v of this._bucketTotals) {
      sum += v;
    }
    return sum;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _armTick(): void {
    if (!this._running) return;
    this._timerHandle = this._clock.setTimeout(() => {
      this._timerHandle = null;
      this._tick();
    }, this._bucketMs);
  }

  private _tick(): void {
    if (!this._running) return;

    // Advance the ring: rotate to the next bucket index, clear it (it now
    // represents the fresh "current" bucket).
    this._currentBucket = (this._currentBucket + 1) % this._bucketCount;
    this._bucketTotals[this._currentBucket] = 0;
    const kindMap = this._bucketKinds[this._currentBucket]!;
    kindMap.clear();
    this._lastRotateAt = this._clock.now();

    // Evaluate: sum the window.
    const total = this.windowTotal();
    if (total >= this.threshold) {
      const now = this._clock.now();
      if (now - this._lastTripAt >= this._resetMs) {
        this._lastTripAt = now;
        this._fireTrip();
      }
    }

    this._armTick();
  }

  private _fireTrip(): void {
    const breakdown = this.windowBreakdown();
    const total = this.windowTotal();

    // Log loudly to stderr: names the storm AND the culprit kinds.
    const breakdownStr = [...breakdown.entries()]
      .sort((a, b) => b[1] - a[1]) // sort by count descending
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");

    process.stderr.write(
      `[storm-alarm] TOPOLOGY EVENT STORM: ${total} events in ${this._bucketCount * this._bucketMs / 1000}s window ` +
      `(threshold=${this.threshold}). Per-kind breakdown: ${breakdownStr || "(none)"}\n`,
    );

    if (this._onTrip !== undefined) {
      try {
        this._onTrip(breakdown);
      } catch {
        // Swallow observer errors — must not break the pipeline.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a topology-event-rate storm alarm.
 *
 * Call `alarm.start()` to begin periodic evaluation.
 * Call `alarm.record(kind)` for every topology event on the hot path.
 * Call `alarm.stop()` on shutdown.
 *
 * @example
 * ```ts
 * const alarm = createStormAlarm({
 *   onTrip: (breakdown) => {
 *     // custom handling; alarm already logged to stderr
 *   },
 * });
 * alarm.start();
 *
 * // On every topology notification:
 * alarm.record(event.kind);
 *
 * // On shutdown:
 * alarm.stop();
 * ```
 */
export function createStormAlarm(opts: StormAlarmOptions = {}): StormAlarm {
  return new StormAlarmImpl(opts);
}
