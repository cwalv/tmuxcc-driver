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
export {};
//# sourceMappingURL=storm-alarm.test.d.ts.map