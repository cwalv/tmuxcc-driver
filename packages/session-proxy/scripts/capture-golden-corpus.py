#!/usr/bin/env python3
"""
Golden-corpus capture driver (tc-3y8.5).

Drives a tmux `-CC` (or `-C`) attach over a PTY and records the raw
control-mode bytes to a file.  Used to produce the *.raw fixtures in
src/parser/golden/ for the parser golden tests.

The script mirrors the original tmux34-session.raw capture:
  list-windows, new-window, split-window, list-panes, list-sessions,
  then a printf injecting non-UTF-8 bytes (\\xc0 \\xfe \\xff),
  select-layout, detach-client.

Usage:
  python3 capture-golden-corpus.py <socket-name> <C|CC> <out-file>

Mechanism:
  * Opens a fresh PTY pair manually (not pty.fork()), then sets the slave
    to noecho/no-canon BEFORE exec.  This stops the kernel tty layer from
    bouncing our writes back into the recorded stream.
  * Spawns `tmux -L <sock> <flag> attach -t s0` in a child with the slave
    as its controlling tty (so tmux's tcgetattr() succeeds).
  * Writes command lines to the PTY master with brief settle delays.
  * Records all PTY-master output to <out-file>.

Reproducing the cross-version captures (throwaway docker):

  # pre-3.4 (tmux 3.2a on ubuntu:22.04 — tmux32a-C.raw)
  docker run --rm -v "$PWD":/work -w /work ubuntu:22.04 bash -c '
    apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y tmux python3 >/dev/null
    python3 capture-golden-corpus.py tmuxcc-test-3y85-1 C /work/tmux32a-C.raw
    tmux -L tmuxcc-test-3y85-1 kill-server'

  # post-3.4 (tmux 3.5a on debian:trixie — tmux35a-C.raw)
  docker run --rm -v "$PWD":/work -w /work debian:trixie bash -c '
    apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y tmux python3 >/dev/null
    python3 capture-golden-corpus.py tmuxcc-test-3y85-2 C /work/tmux35a-C.raw
    tmux -L tmuxcc-test-3y85-2 kill-server'

  # -CC DCS-wrapped (host tmux 3.4 — tmux34-CC.raw)
  python3 capture-golden-corpus.py tmuxcc-test-3y85-3 CC tmux34-CC.raw
  tmux -L tmuxcc-test-3y85-3 kill-server

Notes:
  * The tmux server is left running afterwards; the caller kills it (see
    `tmux -L <sock> kill-server` above).
  * Captures are timestamp-dependent — re-running yields a different
    timestamp in each %begin/%end line, so a strict byte-equal regen would
    require timestamp normalization.  Golden tests therefore assert
    *event* shape, not byte-identical input.
"""

import os
import pty
import select
import signal
import sys
import termios
import time


def main() -> None:
    if len(sys.argv) != 4:
        print("usage: capture.py <socket-name> <C|CC> <out-file>", file=sys.stderr)
        sys.exit(2)

    sock = sys.argv[1]
    mode = sys.argv[2]
    out_path = sys.argv[3]

    if mode == "C":
        flag = "-C"
    elif mode == "CC":
        flag = "-CC"
    else:
        print(f"unknown mode {mode!r} (expected C or CC)", file=sys.stderr)
        sys.exit(2)

    # Start a fresh tmux server with one session, no profile, no config.
    # Use a minimal bash (--norc, no PS1 cruft) so `printf '\xc0\xfe\xff'`
    # in send-keys produces real non-UTF-8 bytes back through %output.
    # The PS1 is set to a fixed string to make captures reproducible.
    rc = os.system(
        f"tmux -L {sock} -f /dev/null new-session -d -s s0 "
        f"'PS1=\"$ \" bash --norc --noprofile' "
        f"&& tmux -L {sock} set-option -g status off"
    )
    if rc != 0:
        print("failed to start tmux server", file=sys.stderr)
        sys.exit(1)

    # Open a fresh PTY pair manually so we can configure the slave's
    # termios (no echo, no canonical mode) BEFORE exec.  pty.fork() would
    # leave the slave in cooked mode and our writes would bounce back.
    master_fd, slave_fd = pty.openpty()

    # Set slave to raw (noecho, no canon) so input we feed isn't echoed
    # back to us.  tmux's tcgetattr() will see a valid termios.
    try:
        attrs = termios.tcgetattr(slave_fd)
        attrs[3] &= ~(termios.ECHO | termios.ICANON | termios.ISIG)  # lflag
        termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)
    except termios.error:
        pass

    pid = os.fork()
    if pid == 0:
        # Child: become session leader, make slave our controlling tty.
        os.setsid()
        try:
            import fcntl

            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        except Exception:
            pass
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        os.close(master_fd)
        os.execvp("tmux", ["tmux", "-L", sock, flag, "attach", "-t", "s0"])
        os._exit(127)
    os.close(slave_fd)

    out_fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)

    def drain(deadline: float) -> None:
        """Read available master_fd bytes to out_fd until idle or deadline."""
        while time.monotonic() < deadline:
            timeout = max(0.0, deadline - time.monotonic())
            r, _, _ = select.select([master_fd], [], [], min(0.2, timeout))
            if not r:
                # Quiescent for one tick — assume the burst is done.
                return
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                return
            if not chunk:
                return
            os.write(out_fd, chunk)

    def send(line: str, settle: float = 0.4) -> None:
        # Drain anything pending first so we capture the response in the file
        # in order.
        drain(time.monotonic() + 0.2)
        os.write(master_fd, line.encode("utf-8"))
        drain(time.monotonic() + settle)

    # Let the initial attach burst land.
    drain(time.monotonic() + 0.6)

    # In -CC mode, tmux sends control-mode commands prefixed with no special
    # input form — the user types tmux command-prompt commands.  In both -C
    # and -CC modes, single-line input lines beginning with arbitrary text are
    # NOT auto-executed: we need to issue them via the command-mode escape.
    #
    # However, the simplest path that matches the original 3.4 capture is:
    # send raw control-mode commands as text lines.  In -C/-CC mode, lines
    # the user types are interpreted as commands by tmux.

    # Roughly the script from the original capture:
    send("list-windows\n")
    send("new-window\n", settle=0.8)
    send("split-window -h\n", settle=0.8)
    send("list-panes\n")
    send("list-sessions\n")
    # Inject a non-UTF-8 byte sequence into the pane-0 shell.  We send the
    # literal command-line text, which the bash in pane 0 then interprets;
    # printf's \xNN expansion produces the raw bytes 0xc0 0xfe 0xff back
    # through %output (cat echoes everything; here the shell writes
    # straight to its tty which tmux captures).
    send(
        "send-keys -t s0:0.0 \"printf '\\\\xc0\\\\xfe\\\\xff test bytes\\\\n'\" Enter\n",
        settle=1.2,
    )
    # Trigger an explicit layout-change by selecting a different layout.
    send("select-layout even-horizontal\n", settle=0.8)
    # Detach (this is what gives a clean %exit).
    send("detach-client\n", settle=1.0)

    # Wait for child to exit, then drain any final bytes.
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    drain(time.monotonic() + 1.0)

    # Forcibly close if still alive.
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

    os.close(out_fd)
    os.close(master_fd)


if __name__ == "__main__":
    main()
