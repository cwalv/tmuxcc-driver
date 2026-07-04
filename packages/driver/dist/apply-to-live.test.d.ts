/**
 * apply-to-live.test.ts — real-tmux behavioral coverage for the tc-gjdx.4
 * apply-to-live merge-diff + preview (idempotent safe direction).
 *
 * AC behavioral guarantees:
 *   T1. Preview equals the subsequent apply's created set (preview-equals-apply
 *       invariant): dryRun and real apply compute the same would-create set via
 *       the shared templateDiff function.
 *   T2. Name-matching windows are left alone — only missing windows/panes are
 *       created (idempotent safe direction).
 *   T3. A re-apply of the same template to an already-satisfied session is a
 *       no-op (empty diff, no tmux side effects).
 *   T4. Mid-apply failure surfaces a loud error (failed verb + created-so-far
 *       state) with NO rollback; existing windows are untouched; failure
 *       semantics match tc-gjdx.3.
 *
 * Seeding: tests that need a clean baseline use session.create WITH a template
 * so apply-at-create (tc-gjdx.3) kills the throwaway initial window and the
 * session starts with exactly the seeded windows.
 *
 * Harness: each test spins up its own broker on a unique `-L` socket + private
 * runtime dir, tmux-guarded, and issues real `tmux` queries for ground truth.
 * Runs in the serialized real-tmux lane (--test-concurrency=1).
 *
 * @module apply-to-live.test
 */
export {};
//# sourceMappingURL=apply-to-live.test.d.ts.map