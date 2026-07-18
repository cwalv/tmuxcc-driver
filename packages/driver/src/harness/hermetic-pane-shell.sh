#!/bin/sh
# Hermetic driver-test pane shell (tc-j8mx.9).
#
# tmux derives `default-shell` from the $SHELL of the process that STARTS the
# tmux server (the first client); suites point $SHELL here for that one
# invocation so real-tmux test panes never run the operator's login shell —
# see harness/hermetic-shell.ts (spawn-env helpers used by tmux-host.test.ts,
# session-error-boundary.test.ts, integration.test.ts) and the per-suite
# before() in state/reply-row-tmux.test.ts.  The shebang consumes tmux's
# login-shell argv0 ("-hermetic-pane-shell.sh"), so the exec below starts a
# NON-login interactive /bin/sh: no /etc/profile, no ~/.profile, no zle — a
# prompt in ~1 ms whose input handling is kernel-tty-canonical.
#
# Why: any wait on a freshly spawned pane shell reading input or producing
# output (typed "exit", OSC titles, echoed bytes) is otherwise a wait on the
# operator login shell's rc init, racing the spec's deadline.  Measured A/Bs:
# tc-j8mx.3 (vscode Layer-A) 541–653 ms zsh input processing vs 4–6 ms
# /bin/sh; tc-widw (driver unit transients) 806–810 ms to execute a typed
# exit on a quiet host and 1.4 s under 1:1 CPU contention, vs 5–16 ms
# hermetic.  Passing a single-argument pane COMMAND does not escape this —
# tmux runs it via `default-shell -c`, so the operator rc still runs (tc-widw
# measured 520 ms for a "/bin/sh" command pane).  "$@" keeps the wrapper
# transparent for any callers that pass args.
exec /bin/sh "$@"
