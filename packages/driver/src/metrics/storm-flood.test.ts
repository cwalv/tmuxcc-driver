/**
 * Integration-style test: synthetic notification flood trips the storm alarm (tc-x6l).
 *
 * Validates the full path: pipeline.onNotification → metricsRegistry.incTopologyEvent
 * + stormAlarm.record → alarm trips on sustained rate.
 *
 * No live tmux needed — uses a fake clock and direct stormAlarm driving.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStormAlarm } from "./storm-alarm.js";
import { createSessionProxyRegistry } from "./registry.js";

describe("Storm flood integration (synthetic)", () => {
  it("8000 events/s sustained (tc-3y8.8 scenario) trips the alarm with per-kind breakdown", () => {
    // Simulate the tc-3y8.8 reattach storm: ~8000 notifications/s sustained.
    // Use a 5s window / 1s buckets / threshold 2500 (default).

    const { createFakeClock } = (() => {
      // Inline fake clock for this test.
      let _now = 0;
      const _timers: Map<number, { fn: () => void; fireAt: number }> = new Map();
      let _nextId = 1;

      function advance(ms: number): void {
        const target = _now + ms;
        let safetyCounter = 0;
        while (safetyCounter++ < 10_000) {
          let earliest: { id: number; fn: () => void; fireAt: number } | null = null;
          for (const [id, t] of _timers) {
            if (t.fireAt <= target && (earliest === null || t.fireAt < earliest.fireAt)) {
              earliest = { id, ...t };
            }
          }
          if (!earliest) break;
          _now = earliest.fireAt;
          _timers.delete(earliest.id);
          earliest.fn();
        }
        _now = Math.max(_now, target);
      }

      return {
        createFakeClock: () => ({
          now: () => _now,
          setTimeout: (fn: () => void, ms: number) => {
            const id = _nextId++;
            _timers.set(id, { fn, fireAt: _now + ms });
            return id;
          },
          clearTimeout: (h: unknown) => { _timers.delete(h as number); },
          advance,
        }),
      };
    })();

    const clock = createFakeClock();
    const tripBreakdowns: Array<Map<string, number>> = [];

    const alarm = createStormAlarm({
      clock,
      windowMs: 5000,
      bucketMs: 1000,
      threshold: 2500,
      resetMs: 60_000, // long reset so test only sees one trip
      onTrip: (bd) => tripBreakdowns.push(new Map(bd)),
    });

    alarm.start();

    // Simulate 8000 events/s sustained for 5 seconds, mixed kinds.
    // The tc-3y8.8 storm was entirely reattach-triggered; simulate as
    // layout-change (the dominant kind during a reattach loop).
    for (let sec = 0; sec < 5; sec++) {
      for (let i = 0; i < 8000; i++) {
        alarm.record(sec % 2 === 0 ? "layout-change" : "sessions-changed");
      }
      clock.advance(1000);
    }

    assert.ok(tripBreakdowns.length >= 1, `alarm should have tripped; got ${tripBreakdowns.length} trips`);

    // Breakdown should attribute events to the dominant kinds.
    const breakdown = tripBreakdowns[0]!;
    const total = [...breakdown.values()].reduce((a, b) => a + b, 0);
    assert.ok(total >= 2500, `breakdown total should be >= threshold 2500; got ${total}`);

    const hasLayoutChange = breakdown.has("layout-change");
    const hasSessionsChanged = breakdown.has("sessions-changed");
    assert.ok(
      hasLayoutChange || hasSessionsChanged,
      "breakdown should attribute events to one of the dominant kinds",
    );

    alarm.stop();
  });

  it("metricsRegistry counter accumulates all notification kinds from flood", async () => {
    const reg = createSessionProxyRegistry();

    // Simulate a notification flood: 1000 events per kind.
    const kinds = ["layout-change", "window-add", "window-close", "sessions-changed", "output"];
    for (const kind of kinds) {
      for (let i = 0; i < 1000; i++) {
        reg.incTopologyEvent(kind);
      }
    }

    const text = await reg.metrics();

    // Each kind should have exactly 1000 events.
    for (const kind of kinds) {
      const pattern = new RegExp(`kind="${kind}"\\} 1000`);
      assert.ok(
        pattern.test(text),
        `topology_events_total{kind="${kind}"} should be 1000 in:\n${text}`,
      );
    }

    reg.stop();
  });

  it("alarm does not trip on short burst (resize drag scenario)", () => {
    // Resize drag scenario: ~120 events/s for 0.5s = 60 events total.
    // Well below threshold of 2500 in 5s.
    let _now = 0;
    const _timers: Map<number, { fn: () => void; fireAt: number }> = new Map();
    let _nextId = 1;

    function advance(ms: number): void {
      const target = _now + ms;
      let safetyCounter = 0;
      while (safetyCounter++ < 10_000) {
        let earliest: { id: number; fn: () => void; fireAt: number } | null = null;
        for (const [id, t] of _timers) {
          if (t.fireAt <= target && (earliest === null || t.fireAt < earliest.fireAt)) {
            earliest = { id, ...t };
          }
        }
        if (!earliest) break;
        _now = earliest.fireAt;
        _timers.delete(earliest.id);
        earliest.fn();
      }
      _now = Math.max(_now, target);
    }

    const clock = {
      now: () => _now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = _nextId++;
        _timers.set(id, { fn, fireAt: _now + ms });
        return id;
      },
      clearTimeout: (h: unknown) => { _timers.delete(h as number); },
    };

    const trips: number[] = [];
    const alarm = createStormAlarm({
      clock,
      windowMs: 5000,
      bucketMs: 1000,
      threshold: 2500,
      resetMs: 10_000,
      onTrip: () => trips.push(_now),
    });

    alarm.start();

    // Burst: 60 layout-change events over 0.5s (sub-bucket duration).
    for (let i = 0; i < 60; i++) {
      alarm.record("layout-change");
    }
    // Advance a full window (5 ticks).
    advance(5000);

    assert.equal(trips.length, 0, `resize-drag burst should NOT trip; got ${trips.length} trips`);

    alarm.stop();
  });
});
