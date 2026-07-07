/**
 * claim-session.test.ts — unit tests for the claim/activate path (tc-u4ny.2).
 *
 * # Coverage focus
 *
 * These tests target the structured-code discrimination in `doClaimSession`.
 * Instead of substring-matching tmux's free-text stderr, claim-session
 * discriminates via {@link isCommandError} with the structured code exported
 * from tmux-south — keeping the adapter's prose wording adapter-internal.
 *
 * ## Lost-create-race path (tc-u4ny.2)
 *
 * The "lost-create-race" path: `createSession` throws the session-name-taken
 * code (tmux-south classifies the collision) AND the subsequent `lookupByName`
 * still cannot find the session (deleted between the collision and the
 * refresh). The handler must throw `CommandError("internal", ...)` — not a
 * raw-prose error — so the dispatcher's `toCommandFailure` encodes it.
 *
 * The test is guarded by real-tmux availability because it uses a live
 * `createSession` call to trigger the name collision.
 *
 * @module claim-session.test
 */
export {};
//# sourceMappingURL=claim-session.test.d.ts.map