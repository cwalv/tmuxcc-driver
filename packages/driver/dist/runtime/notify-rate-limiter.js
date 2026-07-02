/**
 * Per-pane pane.notify rate limiter (tc-76m8.1, user-stories.md S9).
 *
 * Driver-side storm defense: a misbehaving pane can spam BEL / progress escapes
 * thousands of times a second. This coalesces that firehose with a per-KIND
 * token bucket so the wire (and the extension's notification surfaces) see a
 * bounded rate, while keeping the tiers isolated:
 *
 *   - Tier 1 (bell, osc9): "interrupting, scarce, addressed". Generous budget —
 *     no legitimate use rings 10 bells/sec. A drop here is a PATHOLOGICAL storm,
 *     surfaced by the caller as an expected-zero tripwire (fail-loud). Isolating
 *     the buckets per kind is load-bearing: a progress firehose must NEVER
 *     consume a bell's budget (which would forge a Tier-1 drop / false tripwire).
 *   - Tier 2 (progress, cmd-exit): decoration-grade. progress is coalesced
 *     aggressively (a progress bar updates every frame; only the latest matters);
 *     its drops are EXPECTED, not a tripwire.
 *
 * Pure logic with an injectable clock — deterministic to unit-test. One instance
 * per pane; dropped when the pane closes (bounded state, no leak).
 *
 * @module runtime/notify-rate-limiter
 */
/**
 * Per-kind budgets. Generous for Tier-1 (drops = tripwire), tight for progress
 * (drops = expected coalescing). Named + documented so a change is a reviewable
 * diff — the exact numbers are policy, the per-kind ISOLATION is the contract.
 */
const BUDGETS = {
    bell: { ratePerSec: 10, capacity: 10 },
    osc9: { ratePerSec: 10, capacity: 10 },
    progress: { ratePerSec: 5, capacity: 3 },
    "cmd-exit": { ratePerSec: 20, capacity: 20 },
};
/**
 * Per-pane, per-kind token-bucket rate limiter.
 *
 * `allow(kind, nowMs)` returns true when the signal is within budget (consuming
 * one token) and false when it must be dropped. The clock is injectable via the
 * `nowMs` argument (default `Date.now()`) so storm tests are deterministic.
 */
export class PaneNotifyRateLimiter {
    _nowFn;
    _buckets = new Map();
    /**
     * @param nowFn - clock, defaults to `Date.now`. Only used when `allow` is
     *   called without an explicit `nowMs`.
     */
    constructor(_nowFn = Date.now) {
        this._nowFn = _nowFn;
    }
    /**
     * Whether a `kind` signal is within budget right now. Consumes a token on
     * true; a false result is a drop the caller must account for (and, for
     * Tier-1 kinds, loud-log as a tripwire).
     */
    allow(kind, nowMs = this._nowFn()) {
        const budget = BUDGETS[kind];
        let bucket = this._buckets.get(kind);
        if (bucket === undefined) {
            // First signal of this kind: full burst, immediately allowed.
            this._buckets.set(kind, { tokens: budget.capacity - 1, lastRefillMs: nowMs });
            return true;
        }
        // Refill by elapsed wall-time, capped at capacity.
        const elapsedMs = nowMs - bucket.lastRefillMs;
        if (elapsedMs > 0) {
            bucket.tokens = Math.min(budget.capacity, bucket.tokens + (elapsedMs / 1000) * budget.ratePerSec);
            bucket.lastRefillMs = nowMs;
        }
        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return true;
        }
        return false;
    }
}
/**
 * Tier-1 kinds ("interrupting, scarce, addressed"). A rate-limit DROP of one of
 * these is an expected-zero tripwire (a real storm or a bug), not routine
 * coalescing — the caller loud-logs it. Tier-2 (progress, cmd-exit) drops are
 * expected and silent.
 */
export function isTier1NotifyKind(kind) {
    return kind === "bell" || kind === "osc9";
}
//# sourceMappingURL=notify-rate-limiter.js.map