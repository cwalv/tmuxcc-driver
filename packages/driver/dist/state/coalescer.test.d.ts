/**
 * Tests for src/state/coalescer.ts (tc-128.2).
 *
 * Coverage of the three acceptance regimes from the bead:
 *   - quiet + 1 event → IMMEDIATE requery (leading edge);
 *   - sustained flood → bounded to the 1 Hz ceiling with no missed final
 *     state (trailing-edge fold);
 *   - heartbeat catches a change injected with zero notifications.
 *
 * Plus regression coverage for:
 *   - per-kind `onNotify` hook fires once per notify, before engine work
 *     (the tc-x6l counter seam);
 *   - steady-state `%error` from list-* does NOT wipe the model and the
 *     coalescer retries on the next ceiling boundary (TL design call);
 *   - `stop()` cancels pending timers;
 *   - observer exceptions never break the pipeline.
 *
 * @module state/coalescer.test
 */
export {};
//# sourceMappingURL=coalescer.test.d.ts.map