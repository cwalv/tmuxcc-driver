/**
 * Tests for the model→wire projection (tc-7gp, updated tc-j9c.2 for single-session).
 *
 * Covers:
 *   1. Snapshot reflects full state (single session in `session` field).
 *   2. Deltas are minimal + correct (one change → one delta; sessionId stripped).
 *   3. Round-trip: applyDeltas(projectSnapshot(prev), diffModel(prev, next))
 *      deep-equals projectSnapshot(next).
 *   4. Ordering: pane.opened precedes focus.changed when a new pane is
 *      immediately focused.
 */
export {};
//# sourceMappingURL=projection.test.d.ts.map