/**
 * tc-bpn — self-tests for sweepOrphanedSockets() boot-sweep logic.
 *
 * # What this proves
 *
 *   B1. sweep skips own-pid socket (never reaps a socket whose pid segment
 *       matches process.pid).
 *
 *   B2. sweep skips a socket belonging to a live other-PID process (spawn a
 *       child node process that stays alive, register a socket with its pid,
 *       assert it survives a sweep call).
 *
 *   B3. sweep kills a socket belonging to a dead PID (spawn-and-exit, wait
 *       for the child to exit, then sweep).
 *
 *   B4. trackSocket("tmuxcc-foo") throws (regex rejects no-pid form).
 *
 *   B5. trackSocket("tmuxcc-test-foo") throws (regex rejects non-numeric pid).
 *
 *   B6. sweep ignores entries that don't start with "tmuxcc-test-" in the
 *       same tmux socket directory.
 *
 * # Isolation
 *
 * These tests manipulate socket files directly in `/tmp/tmux-<uid>/`.  To
 * avoid interfering with real tmux servers or concurrent test agents, the
 * tests only CREATE and then immediately CLEAN UP socket files they minted
 * themselves.  They never run `tmux kill-server` against real servers.
 *
 * @module runtime/test-tmux-cleanup-boot-sweep.test
 */
export {};
//# sourceMappingURL=test-tmux-cleanup-boot-sweep.test.d.ts.map