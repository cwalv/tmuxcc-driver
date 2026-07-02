/**
 * tmux-south.test.ts — unit tests for the south-side tmux command surface.
 *
 * tc-zcqr: the original `_doClaimSession` race ("Session not found after
 * creation") was rooted in two south-side properties:
 *
 *   1. `createSession` discarded the new session id and forced the caller
 *      to learn it via a follow-up `tmux list-sessions`.
 *   2. `listSessions` silently coerced ANY non-zero status into an empty
 *      array — so a transient `list-sessions` failure (5 s timeout,
 *      `error connecting to /tmp/...` after socket churn, etc.) was
 *      indistinguishable from "no sessions" and erased the just-created
 *      session from the server-proxy's cache.
 *
 * These tests pin both invariants:
 *
 *   - createSession returns the authoritative `tmuxId` of the just-created
 *     session in a single round-trip (no follow-up list-sessions needed).
 *   - listSessions returns `null` for transient errors and `[]` for the
 *     "server has no sessions" case (status 0 with empty stdout, OR a
 *     "no server running" stderr from tmux 3.x).
 *
 * @module tmux-south.test
 */
export {};
//# sourceMappingURL=tmux-south.test.d.ts.map