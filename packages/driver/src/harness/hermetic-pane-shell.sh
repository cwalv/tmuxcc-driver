#!/bin/sh
# Hermetic driver-test pane shell (tc-j8mx.9).
#
# tmux derives `default-shell` from the $SHELL of the process that starts the
# tmux server; set-hermetic-shell.mjs points $SHELL here (via --import before
# the test runner loads any test files) so real-tmux test panes never run the
# operator's login shell.  The shebang consumes tmux's login-shell argv0
# ("-hermetic-pane-shell.sh"), so the exec below starts a NON-login interactive
# /bin/sh: no /etc/profile, no ~/.profile, no zle — a prompt in ~1 ms whose
# input handling is kernel-tty-canonical.
#
# Why: the pane_title Layer-A specs (reply-row-tmux.test.ts "pane_title" suite)
# poll `#{pane_title}` for a specific OSC-set value.  On the operator's
# interactive shell (e.g. zprezto zsh), precmd rewrites the terminal title from
# the prompt hook, racing the OSC-set value on BOTH read paths.  This is the
# same class tc-j8mx.3 retired in the vscode Layer-A harness; see that bead's
# A/B: 541–653 ms zsh input processing vs 4–6 ms /bin/sh.  "$@" keeps the
# wrapper transparent for any callers that pass args.
exec /bin/sh "$@"
