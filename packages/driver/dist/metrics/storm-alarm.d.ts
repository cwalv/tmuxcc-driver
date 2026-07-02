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
import type { Clock } from "../state/coalescer.js";
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
export declare function createStormAlarm(opts?: StormAlarmOptions): StormAlarm;
//# sourceMappingURL=storm-alarm.d.ts.map