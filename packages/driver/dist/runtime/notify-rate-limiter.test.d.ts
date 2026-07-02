/**
 * Unit tests for the per-pane pane.notify rate limiter (tc-76m8.1, S9).
 *
 * Covers the AC: storm rate-limiting, the per-kind budget isolation that keeps a
 * progress firehose from forging a Tier-1 (bell/osc9) drop, and the tier
 * classification the pipeline uses to decide whether a drop is an expected-zero
 * tripwire. The clock is injected via `allow(kind, nowMs)` so every assertion is
 * deterministic.
 */
export {};
//# sourceMappingURL=notify-rate-limiter.test.d.ts.map