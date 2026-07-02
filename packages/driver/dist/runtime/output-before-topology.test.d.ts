/**
 * Output-before-topology buffering tests (tc-128.3, tc-128.4).
 *
 * Acceptance criteria (post tc-128.4, pane tracking is always-on):
 *   A1. Split storm: bytes that arrive for a pane before the model knows about
 *       it are buffered, then flushed to transports in order once the pane is
 *       bound — every byte lands in the right terminal.
 *   A2. Foreign-pane containment: bytes for a pane that is never bound stay in
 *       the overflow-bounded staging buffer and are not fanned out to transports;
 *       overflow is dropped with a log, not accumulated unboundedly.
 *   A3. Ordering guarantee: `pane.opened` (control plane) always precedes the
 *       flushed data bytes (data plane) at the client.
 *   A5. Bootstrap path: panes present in the initial model after bootstrap are
 *       bound correctly and receive subsequent output without staging.
 *
 * NOTE (tc-128.4): A4 (legacy pass-through behaviour without
 * `activatePaneTracking`) is RETIRED. The opt-in toggle is gone — pane
 * tracking is the only mode. Test harnesses must call notifyPaneBound for
 * every pane they expect bytes for.
 *
 * @module runtime/output-before-topology.test
 */
export {};
//# sourceMappingURL=output-before-topology.test.d.ts.map