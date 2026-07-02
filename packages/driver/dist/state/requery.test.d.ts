/**
 * Tests for src/state/requery.ts (tc-128.1).
 *
 * Coverage:
 *   - Pure `requeryDiff` core: bootstrap (prev=empty), reconnect (prev=same),
 *     idempotent (no deltas when nothing changes), `%error` fallbacks.
 *   - Reparenting (break-pane): same pane id, new window → no spurious
 *     pane.opened/pane.closed; the diff carries the layout updates.
 *   - Dead-pane semantics: a pane absent from the next list-panes reply is
 *     closed; a pane still present (e.g. remain-on-exit dead) survives.
 *   - `RequeryEngine` driver: basic cycle, getModel mirrors the latest cycle,
 *     dirty mid-flight triggers a re-run on completion, concurrent requery()
 *     calls share the in-flight promise (single cycle, no parallel runs).
 *   - Property-style round-trip on random model pairs: replay deltas onto a
 *     deep clone of `prev` and assert the result deep-equals `next`.
 *
 * @module state/requery.test
 */
export {};
//# sourceMappingURL=requery.test.d.ts.map