/**
 * Unit tests for the topology-event-rate storm alarm (tc-x6l).
 *
 * All tests use injected/fake time — no real sleeps.
 * Verifies:
 *   1. A short burst (sub-window duration) does NOT trip the alarm.
 *   2. A sustained rate above threshold DOES trip the alarm.
 *   3. The per-kind breakdown in the trip callback is correct.
 *   4. The reset timer prevents re-trip within the reset window.
 *   5. Alarm re-trips after the reset window expires.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createStormAlarm } from "./storm-alarm.js";
import type { Clock, TimeoutHandle } from "../state/coalescer.js";

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

interface FakeTimer {
  fn: () => void;
  fireAt: number;
}

/**
 * Deterministic fake clock for unit tests.
 *
 * `advance(ms)` moves the clock forward and fires any timers whose
 * `fireAt` <= the new time.  Fires in chronological order.
 */
function createFakeClock(): Clock & { advance(ms: number): void; now(): number } {
  let _now = 0;
  const _timers: Map<number, FakeTimer> = new Map();
  let _nextId = 1;

  function advance(ms: number): void {
    const target = _now + ms;
    // Fire timers in order until we reach target.
    // Re-check after each fire because timers may add new timers.
    let safetyCounter = 0;
    while (safetyCounter++ < 10_000) {
      // Find the earliest pending timer that fires at or before `target`.
      let earliest: { id: number; timer: FakeTimer } | null = null;
      for (const [id, timer] of _timers) {
        if (timer.fireAt <= target) {
          if (earliest === null || timer.fireAt < earliest.timer.fireAt) {
            earliest = { id, timer };
          }
        }
      }
      if (earliest === null) break;
      // Advance clock to the timer's fire time, then fire it.
      _now = earliest.timer.fireAt;
      _timers.delete(earliest.id);
      earliest.timer.fn();
    }
    // Advance to target (may be past the last timer).
    _now = Math.max(_now, target);
  }

  return {
    now(): number {
      return _now;
    },
    setTimeout(fn: () => void, ms: number): TimeoutHandle {
      const id = _nextId++;
      _timers.set(id, { fn, fireAt: _now + ms });
      return id;
    },
    clearTimeout(handle: TimeoutHandle): void {
      _timers.delete(handle as number);
    },
    advance,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StormAlarm", () => {
  // -------------------------------------------------------------------------
  // Test 1: burst does NOT trip
  // -------------------------------------------------------------------------
  it("burst below threshold does NOT trip the alarm", () => {
    const clock = createFakeClock();
    const trips: Array<Map<string, number>> = [];

    const alarm = createStormAlarm({
      clock,
      windowMs: 5000,  // 5-second window
      bucketMs: 1000,  // 1-second buckets
      threshold: 2500, // 2500 events in 5s
      resetMs: 10_000,
      onTrip: (breakdown) => trips.push(new Map(breakdown)),
    });

    alarm.start();

    // Inject 1000 events in the FIRST bucket — a burst.
    // After one bucket rotation (1s), those events are still in the window
    // but the total is 1000 < 2500 threshold.
    for (let i = 0; i < 1000; i++) {
      alarm.record("layout-change");
    }

    // Advance 1s (one bucket tick fires, evaluates sum = 1000 < 2500).
    clock.advance(1000);

    assert.equal(trips.length, 0, "burst of 1000 events should NOT trip (1000 < 2500)");

    alarm.stop();
  });

  // -------------------------------------------------------------------------
  // Test 2: sustained rate DOES trip
  // -------------------------------------------------------------------------
  it("sustained rate above threshold DOES trip the alarm", () => {
    const clock = createFakeClock();
    const trips: Array<Map<string, number>> = [];

    const alarm = createStormAlarm({
      clock,
      windowMs: 5000,
      bucketMs: 1000,
      threshold: 100,  // low threshold for test: 100 events in 5 buckets
      resetMs: 10_000,
      onTrip: (breakdown) => trips.push(new Map(breakdown)),
    });

    alarm.start();

    // Inject 30 events per bucket for 5 buckets = 150 events in the window.
    // After each 1s tick, the sum grows; after bucket 4 it should exceed 100.
    for (let bucket = 0; bucket < 5; bucket++) {
      for (let i = 0; i < 30; i++) {
        alarm.record("window-add");
      }
      clock.advance(1000);
    }

    assert.ok(trips.length >= 1, `alarm should have tripped; got ${trips.length} trips`);

    alarm.stop();
  });

  // -------------------------------------------------------------------------
  // Test 3: per-kind breakdown is correct
  // -------------------------------------------------------------------------
  it("trip breakdown contains per-kind counts", () => {
    const clock = createFakeClock();
    const trips: Array<Map<string, number>> = [];

    const alarm = createStormAlarm({
      clock,
      windowMs: 5000,
      bucketMs: 1000,
      threshold: 50,  // trip after 50 events
      resetMs: 60_000, // long reset so we don't re-trip during this test
      onTrip: (breakdown) => trips.push(new Map(breakdown)),
    });

    alarm.start();

    // Record mixed kinds: 30 layout-change + 25 window-renamed = 55 total.
    for (let i = 0; i < 30; i++) alarm.record("layout-change");
    for (let i = 0; i < 25; i++) alarm.record("window-renamed");

    // Advance enough for the alarm to evaluate.
    clock.advance(1000);
    clock.advance(1000);

    assert.ok(trips.length >= 1, "alarm should trip with 55 events > threshold 50");

    const breakdown = trips[0]!;
    assert.ok(
      (breakdown.get("layout-change") ?? 0) >= 30,
      `layout-change count should be >= 30; got ${breakdown.get("layout-change")}`,
    );
    assert.ok(
      (breakdown.get("window-renamed") ?? 0) >= 25,
      `window-renamed count should be >= 25; got ${breakdown.get("window-renamed")}`,
    );

    alarm.stop();
  });

  // -------------------------------------------------------------------------
  // Test 4: reset timer prevents re-trip within reset window
  // -------------------------------------------------------------------------
  it("alarm does NOT re-trip within the reset window", () => {
    const clock = createFakeClock();
    const trips: number[] = [];

    const alarm = createStormAlarm({
      clock,
      windowMs: 3000,
      bucketMs: 1000,
      threshold: 10,
      resetMs: 10_000, // 10s reset window
      onTrip: () => trips.push(clock.now()),
    });

    alarm.start();

    // First trip: inject events and advance enough to trip.
    for (let i = 0; i < 50; i++) alarm.record("layout-change");
    clock.advance(1000);

    const tripsAfterFirst = trips.length;
    assert.ok(tripsAfterFirst >= 1, "should have tripped once");

    // Continue injecting high-rate events within the reset window.
    for (let i = 0; i < 50; i++) alarm.record("layout-change");
    clock.advance(1000);
    for (let i = 0; i < 50; i++) alarm.record("layout-change");
    clock.advance(1000);

    // Should not have tripped again (resetMs=10s has not elapsed).
    assert.equal(trips.length, tripsAfterFirst, "alarm should NOT re-trip within reset window");

    alarm.stop();
  });

  // -------------------------------------------------------------------------
  // Test 5: alarm re-trips after reset window expires
  // -------------------------------------------------------------------------
  it("alarm re-trips after the reset window expires", () => {
    const clock = createFakeClock();
    const trips: number[] = [];

    const alarm = createStormAlarm({
      clock,
      windowMs: 3000,
      bucketMs: 1000,
      threshold: 10,
      resetMs: 5000, // 5s reset window
      onTrip: () => trips.push(clock.now()),
    });

    alarm.start();

    // First trip.
    for (let i = 0; i < 50; i++) alarm.record("layout-change");
    clock.advance(1000);
    assert.ok(trips.length >= 1, "should have tripped once");

    // Advance past the reset window (5s + some buffer).
    clock.advance(5000);

    // Inject another storm.
    for (let i = 0; i < 50; i++) alarm.record("window-add");
    clock.advance(1000);
    for (let i = 0; i < 50; i++) alarm.record("window-add");
    clock.advance(1000);

    assert.ok(trips.length >= 2, `alarm should re-trip after reset; got ${trips.length} trips`);

    alarm.stop();
  });

  // -------------------------------------------------------------------------
  // Test 6: windowTotal and windowBreakdown reflect current state
  // -------------------------------------------------------------------------
  it("windowTotal and windowBreakdown reflect current bucket state", () => {
    const clock = createFakeClock();

    const alarm = createStormAlarm({
      clock,
      windowMs: 3000,
      bucketMs: 1000,
      threshold: 99999, // never trip
    });

    alarm.start();

    // Record some events.
    for (let i = 0; i < 10; i++) alarm.record("layout-change");
    for (let i = 0; i < 5; i++) alarm.record("window-add");

    // Total should be 15 (still in current bucket, no tick yet).
    assert.equal(alarm.windowTotal(), 15);

    const bd = alarm.windowBreakdown();
    assert.equal(bd.get("layout-change"), 10);
    assert.equal(bd.get("window-add"), 5);

    alarm.stop();
  });

  // -------------------------------------------------------------------------
  // Test 7: old buckets fall out of the window after enough ticks
  // -------------------------------------------------------------------------
  it("old bucket events fall out of the window after window duration", () => {
    const clock = createFakeClock();

    const alarm = createStormAlarm({
      clock,
      windowMs: 3000, // 3 buckets × 1s
      bucketMs: 1000,
      threshold: 99999,
    });

    alarm.start();

    // Inject events in the first bucket.
    for (let i = 0; i < 100; i++) alarm.record("layout-change");

    // Advance 3 full buckets (the old bucket should have rotated out).
    clock.advance(1000); // tick 1: rotates bucket 0 → bucket 1
    clock.advance(1000); // tick 2: rotates bucket 1 → bucket 2
    clock.advance(1000); // tick 3: rotates bucket 2 → bucket 0 (overwriting original)

    // The 100 events from bucket 0 should now be cleared.
    assert.equal(alarm.windowTotal(), 0, "old events should have expired from the window");

    alarm.stop();
  });

  // -------------------------------------------------------------------------
  // Test 8: undefined kind is recorded as "unknown"
  // -------------------------------------------------------------------------
  it("undefined kind is recorded under 'unknown' label", () => {
    const clock = createFakeClock();

    const alarm = createStormAlarm({
      clock,
      windowMs: 5000,
      bucketMs: 1000,
      threshold: 99999,
    });

    alarm.start();

    alarm.record(undefined);
    alarm.record(undefined);

    const bd = alarm.windowBreakdown();
    assert.equal(bd.get("unknown"), 2);

    alarm.stop();
  });
});
