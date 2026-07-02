/**
 * Tests for TmuxHost (tc-kyp).
 *
 * Two test suites:
 *
 * 1. Hermetic (fake-tmux): exercises pipe/lifecycle/onData/onExit plumbing
 *    against fake-tmux.js — a synthetic fixture that emits canned control-mode
 *    bytes. Spawned directly as a plain child process (piped stdio, no PTY).
 *    Deterministic; no real tmux dependency.
 *
 * 2. Real tmux 3.4: spawns actual tmux on a private socket, verifies the DCS
 *    intro arrives, write() is accepted, stop()/kill() cleanly terminates.
 *    Guarded by tmux availability. Always tears down the server in after().
 *
 * NOTE: the hermetic suite bypasses TmuxHostImpl and wires directly to the
 * child_process so the PTY bridge is NOT involved. That isolates plumbing from
 * the bridge. The real-tmux suite uses createTmuxHost() end-to-end (bridge
 * included).
 */
export {};
//# sourceMappingURL=tmux-host.test.d.ts.map