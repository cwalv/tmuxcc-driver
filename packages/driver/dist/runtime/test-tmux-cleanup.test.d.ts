/**
 * tc-blk — self-tests for the test-tmux-cleanup safety net.
 *
 * # What this proves
 *
 *   S1. trackSocket() rejects names outside the `tmuxcc-` prefix (blast-radius
 *       guard so we never accidentally kill the user's own tmux server).
 *
 *   S2. killTmuxServer() is idempotent and never throws — safe to call on a
 *       socket that was never started, or on one already dead.
 *
 *   S3. flushAllTracked() actually kills tracked tmux servers (real-tmux
 *       guarded). After flush(), the socket is no longer connectable. This is
 *       the regression test for the bead's "throws mid-body" criterion: we
 *       deliberately spawn a real tmux server, then simulate a thrown test
 *       body by NOT calling per-test cleanup — only the process-level flush.
 *
 *   S4. After flush(), the tracked set is empty (so process-exit/SIGINT
 *       handlers, which also walk the set, won't double-kill).
 *
 * # Why a separate self-test
 *
 * The shared helper is the safety net for every other real-tmux test in the
 * project. If it regresses silently, leaks return. Testing it explicitly here
 * means a regression breaks a fast, focused test rather than only being
 * visible as accumulated orphans in `ps` after a long ci run.
 *
 * @module runtime/test-tmux-cleanup.test
 */
export {};
//# sourceMappingURL=test-tmux-cleanup.test.d.ts.map