/**
 * apply-at-create.test.ts — real-tmux behavioral coverage for the tc-gjdx.3
 * template compiler + apply-at-create transaction.
 *
 * These are the AC's behavioral guarantees, and they are all REAL-TMUX:
 *   T1. Apply-at-create produces the expected topology + geometry + cwd + env,
 *       sets @tmuxcc-template, and surfaces it on the session row.
 *   T2. Exactly-once under racing claims (the broker serialises per name — only
 *       the created:true claimant applies).
 *   T3. No apply on reattach / re-claim (apply is gated on created:true).
 *   T4. Mid-transaction failure surfaces a loud error naming the failed verb +
 *       created-so-far state, with NO rollback (the partial session persists).
 *   T5. The tc-128 coalescer absorbs a many-window apply burst: the model
 *       converges with no refuted-confirmation tripwire.
 *
 * Harness: each test spins up its own broker on a unique `-L` socket + private
 * runtime dir, tmux-guarded, and issues real `tmux` queries for ground truth.
 * Runs in the serialized real-tmux lane (--test-concurrency=1).
 *
 * @module apply-at-create.test
 */
export {};
//# sourceMappingURL=apply-at-create.test.d.ts.map