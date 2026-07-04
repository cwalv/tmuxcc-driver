/**
 * Unit tests for the session-template applicator (tc-gjdx.3), driven by a FAKE
 * `send` seam (no real tmux). These pin the interpreter contract:
 *   - compile→apply order (query initial window, awareness FIRST, new-window,
 *     splits of the previously-created pane, select-layout, kill-initial LAST);
 *   - runtime id threading (each `-P -F` result feeds the next step);
 *   - the vocabulary bridge reaches the wire (command → shellCommand);
 *   - fail-loud, no-rollback partial failure (stop at first failure, report the
 *     failed verb + created-so-far, issue NO destructive compensations).
 *
 * The real-tmux behaviour (topology/geometry/cwd/env, exactly-once, coalescer
 * burst) is covered in apply-at-create.test.ts.
 */
export {};
//# sourceMappingURL=apply.test.d.ts.map