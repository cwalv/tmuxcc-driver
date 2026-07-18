/**
 * Hermetic pane-shell wiring for real-tmux suites (tc-j8mx.9 / tc-widw).
 *
 * tmux derives `default-shell` from the $SHELL of the process that STARTS the
 * tmux server (the first client), and runs both default panes and
 * single-argument pane commands through it (`default-shell -c`).  A test wait
 * that depends on a freshly spawned pane shell reading input or producing
 * output is therefore transitively a wait on the operator's login-shell rc
 * initialization — measured at 700–810 ms on a quiet host and 1.4 s under
 * 1:1 CPU contention (tc-widw), unbounded in general — racing the spec's
 * deadline.  Pointing $SHELL at hermetic-pane-shell.sh removes that term
 * entirely: /bin/sh reads typed-ahead input in ~5 ms quiet, 9–16 ms under
 * 24-way contention.
 *
 * default-shell is baked into the server at start, so only the
 * server-starting invocation needs the override; later clients (send-keys,
 * list-panes, attach) are unaffected by their own $SHELL.
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the non-login /bin/sh pane-shell wrapper. */
export const HERMETIC_PANE_SHELL = resolve(__dir, "hermetic-pane-shell.sh");

/**
 * Loud existence check: a missing or non-executable wrapper must fail the
 * suite, not silently fall back to the operator shell (which would re-arm
 * the race this module exists to retire).
 */
function assertWrapperExecutable(): void {
  accessSync(HERMETIC_PANE_SHELL, fsConstants.X_OK);
}

/**
 * Full environment for a child_process spawn that starts a tmux server:
 * process.env with $SHELL pointed at the hermetic wrapper.
 */
export function hermeticShellEnv(): NodeJS.ProcessEnv {
  assertWrapperExecutable();
  return { ...process.env, SHELL: HERMETIC_PANE_SHELL };
}

/**
 * Override map for the TmuxHost `env` option (tmux-host.ts merges it over
 * process.env at spawn): just the $SHELL replacement.
 */
export function hermeticShellOverride(): Record<string, string> {
  assertWrapperExecutable();
  return { SHELL: HERMETIC_PANE_SHELL };
}
