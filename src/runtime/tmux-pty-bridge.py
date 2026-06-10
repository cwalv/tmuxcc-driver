#!/usr/bin/env python3
"""
tmux-pty-bridge.py — PTY bridge for tmux -CC control-mode client.

Allocates a POSIX PTY pair, spawns the command given as argv[1:] with the
slave end as its stdin/stdout/stderr, then bridges the master end to this
process's own stdin/stdout (which are pipes to the Node.js TmuxHost).

Why this exists:
  tmux's control-mode client (-CC) calls tcgetattr() on its stdin/stdout at
  startup (even though control-mode traffic is line-oriented text). When those
  fds are plain pipes, tcgetattr fails with ENXIO and tmux exits immediately.
  This bridge satisfies that requirement without requiring a native Node addon.

Protocol:
  - bytes written to this process's stdin are forwarded to the PTY master
    (i.e. delivered as keyboard input to tmux).
  - bytes read from the PTY master are written to this process's stdout
    (i.e. control-mode protocol lines, DCS-wrapped, for the parser).
  - SIGTERM/SIGINT: forward to the child, then clean up and exit.
  - Child exit: exit with the same code.

Die-with-parent (tc-2c5, ext-a design §6.3):
  The bridge must never outlive the daemon that spawned it.  A SIGKILLed
  daemon delivers NO signal here — the bridge is silently reparented.  The
  stdin-EOF path usually catches that (the daemon's death closes the pipe),
  but it is not sufficient on its own: the child may ignore the master-close
  EOF (then the old unbounded proc.wait() hung forever), and a leaked stdin
  write-end would suppress the EOF entirely.  Enforcement, same mechanism as
  the daemon itself:
  - poll getppid() each loop tick; if it differs from the ppid captured at
    startup, the parent died (reparented to init/subreaper) → shut down.
  - child teardown is bounded: 2 s grace after master close, then SIGTERM,
    then 1 s, then SIGKILL.  The tmux server is untouched — only the -CC
    client dies; tmux is the persistence layer.

Usage:
  python3 tmux-pty-bridge.py <command> [args...]

Example:
  python3 tmux-pty-bridge.py tmux -L mysock -CC attach -t main
"""

import os
import pty
import select
import signal
import subprocess
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: tmux-pty-bridge.py <command> [args...]", file=sys.stderr)
        sys.exit(1)

    # tc-2c5 die-with-parent: capture the spawning daemon's pid.  getppid()
    # returning anything else later means the daemon died and we were
    # reparented (to init on classic systems, possibly a subreaper elsewhere —
    # comparing against the initial value covers both, unlike a "== 1" check).
    initial_ppid = os.getppid()

    master_fd, slave_fd = pty.openpty()

    proc = subprocess.Popen(
        sys.argv[1:],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    def cleanup(signum: int = 0, frame: object = None) -> None:  # noqa: ARG001
        try:
            proc.terminate()
        except OSError:
            pass

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    try:
        while True:
            # tc-2c5 die-with-parent: the daemon was SIGKILLed (or otherwise
            # died without closing our stdin).  Stop bridging; the bounded
            # teardown below reaps the child.  Checked every loop tick — the
            # select timeout caps detection latency at ~50 ms when idle.
            if os.getppid() != initial_ppid:
                break

            poll_fds = [master_fd]
            try:
                # Only poll stdin if child is still alive
                if proc.poll() is None:
                    poll_fds.append(stdin_fd)
            except Exception:
                pass

            try:
                readable, _, _ = select.select(poll_fds, [], [], 0.05)
            except (OSError, ValueError):
                break

            if master_fd in readable:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    # Write to stdout (pipe to Node)
                    written = 0
                    while written < len(data):
                        n = os.write(stdout_fd, data[written:])
                        written += n
                except OSError:
                    break

            if stdin_fd in readable:
                try:
                    data = os.read(stdin_fd, 4096)
                    if not data:
                        # EOF on stdin — close the write side so tmux gets EOF
                        break
                    os.write(master_fd, data)
                except OSError:
                    break

            if proc.poll() is not None:
                # Drain any remaining output from the master
                try:
                    while True:
                        r, _, _ = select.select([master_fd], [], [], 0.0)
                        if not r:
                            break
                        data = os.read(master_fd, 4096)
                        if not data:
                            break
                        written = 0
                        while written < len(data):
                            n = os.write(stdout_fd, data[written:])
                            written += n
                except OSError:
                    pass
                break

    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    # Bounded child teardown (tc-2c5).  The old unconditional proc.wait()
    # blocked forever when the child ignored the master-close EOF — exactly
    # how a bridge could outlive a SIGKILLed daemon.  Escalate instead:
    #   master closed (above) → 2 s grace → SIGTERM → 1 s → SIGKILL.
    # A tmux -CC client exits on the EOF within milliseconds, so the happy
    # path never waits; the escalation only fires for wedged/EOF-deaf children.
    if proc.poll() is None:
        try:
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                proc.terminate()
            except OSError:
                pass
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except OSError:
                    pass
                proc.wait()

    ret = proc.returncode
    sys.exit(ret if ret is not None else 0)


if __name__ == "__main__":
    main()
