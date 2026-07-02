/**
 * Unit tests for the per-pane pane.notify rate limiter (tc-76m8.1, S9).
 *
 * Covers the AC: storm rate-limiting, the per-kind budget isolation that keeps a
 * progress firehose from forging a Tier-1 (bell/osc9) drop, and the tier
 * classification the pipeline uses to decide whether a drop is an expected-zero
 * tripwire. The clock is injected via `allow(kind, nowMs)` so every assertion is
 * deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PaneNotifyRateLimiter, isTier1NotifyKind } from "./notify-rate-limiter.js";

/** Count how many of `n` back-to-back signals of `kind` are allowed at `nowMs`. */
function allowedAt(limiter: PaneNotifyRateLimiter, kind: Parameters<PaneNotifyRateLimiter["allow"]>[0], n: number, nowMs: number): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (limiter.allow(kind, nowMs)) allowed++;
  return allowed;
}

describe("notify-rate-limiter: token bucket", () => {
  it("allows the first signal of a kind immediately", () => {
    const rl = new PaneNotifyRateLimiter();
    assert.equal(rl.allow("bell", 0), true);
  });

  it("bell: a same-instant storm is capped at the burst budget (10), the rest dropped", () => {
    const rl = new PaneNotifyRateLimiter();
    // 100 bells at the same timestamp: capacity 10 → 10 allowed, 90 dropped.
    assert.equal(allowedAt(rl, "bell", 100, 0), 10);
  });

  it("bell: budget refills over wall-time", () => {
    const rl = new PaneNotifyRateLimiter();
    assert.equal(allowedAt(rl, "bell", 100, 0), 10); // drain the burst
    // rate 10/sec → after 1 s, ~10 tokens back.
    assert.equal(allowedAt(rl, "bell", 100, 1000), 10);
    // half a second later → ~5 more.
    assert.equal(allowedAt(rl, "bell", 100, 1500), 5);
  });

  it("progress is coalesced tighter than bell (smaller burst)", () => {
    const rl = new PaneNotifyRateLimiter();
    const progressBurst = allowedAt(rl, "progress", 100, 0);
    const bellBurst = allowedAt(new PaneNotifyRateLimiter(), "bell", 100, 0);
    assert.ok(progressBurst < bellBurst, `progress burst ${progressBurst} should be < bell burst ${bellBurst}`);
    assert.ok(progressBurst >= 1, "at least the first progress passes");
  });
});

describe("notify-rate-limiter: per-kind isolation (Tier-1 protection)", () => {
  it("a progress firehose does NOT consume the bell budget", () => {
    const rl = new PaneNotifyRateLimiter();
    // Flood progress at t=0 (drains only the progress bucket).
    allowedAt(rl, "progress", 10_000, 0);
    // A bell arriving in the same instant is still fully within its own budget.
    assert.equal(allowedAt(rl, "bell", 100, 0), 10, "bell budget must be untouched by the progress storm");
  });

  it("draining bell does not affect osc9 or cmd-exit", () => {
    const rl = new PaneNotifyRateLimiter();
    allowedAt(rl, "bell", 100, 0);
    assert.ok(rl.allow("osc9", 0), "osc9 has its own bucket");
    assert.ok(rl.allow("cmd-exit", 0), "cmd-exit has its own bucket");
  });
});

describe("notify-rate-limiter: tier classification", () => {
  it("bell and osc9 are Tier-1 (drops are tripwires)", () => {
    assert.equal(isTier1NotifyKind("bell"), true);
    assert.equal(isTier1NotifyKind("osc9"), true);
  });

  it("progress and cmd-exit are not Tier-1 (drops are routine coalescing)", () => {
    assert.equal(isTier1NotifyKind("progress"), false);
    assert.equal(isTier1NotifyKind("cmd-exit"), false);
  });
});

describe("notify-rate-limiter: uses the injected clock by default", () => {
  it("a stubbed nowFn drives refill without real time", () => {
    let now = 0;
    const rl = new PaneNotifyRateLimiter(() => now);
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (rl.allow("bell")) allowed++;
    assert.equal(allowed, 10, "same virtual instant → burst only");
    now = 1000;
    assert.ok(rl.allow("bell"), "advancing the stubbed clock refills the bucket");
  });
});
