#!/usr/bin/env python3
"""Minimal pty harness for testing the Ink TUI.

WHY THIS EXISTS: Ink refuses to render interactively unless stdout is a tty, so the
TUI cannot be tested through ordinary pipes. The obvious tool, `script`, is a dead
end here — it calls tcgetattr on its OWN stdout and dies with
"Operation not supported on socket" when that's a pipe, and `stdio: ignore`
(/dev/null) isn't a tty either, so it fails the same way.

So: allocate a real pty, run the command as its session leader, mirror everything
the child writes into a transcript file, and accept keystrokes on our stdin. Node
drives this instead of `script`.

Usage:  pty-runner.py <transcript-file> <cols> <rows> <cmd> [args...]
Stdin is forwarded to the child verbatim (so "1\r" answers a question).

RESIZE: send SIGUSR1 and the runner re-reads "<transcript-file>.size" (a "COLS ROWS"
line), applies it to the pty and forwards SIGWINCH to the child. A layout that only
works at the size it started at isn't a layout, and this is the only way to prove a
resize re-budgets the rows — Ink learns the new size from the pty, not from us.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd: int, cols: int, rows: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main() -> int:
    if len(sys.argv) < 5:
        print("usage: pty-runner.py <transcript> <cols> <rows> <cmd> [args...]", file=sys.stderr)
        return 2

    transcript_path, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    argv = sys.argv[4:]

    pid, master = pty.fork()
    if pid == 0:
        # Child: set a sane window size BEFORE exec, so Ink lays out for the size the
        # test expects rather than an 80x24 default.
        set_winsize(0, cols, rows)
        os.execvp(argv[0], argv)
        os._exit(127)

    # SIGUSR1 = "re-read the size file and resize the pty". The signal only sets a flag;
    # the ioctl happens in the loop, because doing real work in a handler is how you get
    # an EINTR-mangled read.
    resize_pending = [False]

    def on_usr1(_sig, _frm):
        resize_pending[0] = True

    signal.signal(signal.SIGUSR1, on_usr1)
    size_path = transcript_path + ".size"

    # Parent: pump child output -> transcript, our stdin -> child.
    transcript = open(transcript_path, "wb", buffering=0)
    stdin_fd = sys.stdin.fileno()
    watch = [master, stdin_fd]
    try:
        while True:
            if resize_pending[0]:
                resize_pending[0] = False
                try:
                    with open(size_path) as fh:
                        new_cols, new_rows = (int(x) for x in fh.read().split()[:2])
                    set_winsize(master, new_cols, new_rows)
                    # Ink listens for SIGWINCH; without it the pty is the new size but
                    # the app never re-lays-out, which is indistinguishable from a
                    # layout that ignores the terminal size.
                    os.kill(pid, signal.SIGWINCH)
                except (OSError, ValueError):
                    pass

            try:
                readable, _, _ = select.select(watch, [], [], 0.2)
            except InterruptedError:
                continue

            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as e:
                    # EIO is the normal "child closed the pty" signal on Linux/macOS.
                    if e.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                transcript.write(data)

            if stdin_fd in readable:
                try:
                    keys = os.read(stdin_fd, 4096)
                except OSError:
                    keys = b""
                if keys:
                    os.write(master, keys)
                else:
                    # EOF on our stdin. Stop watching it — an EOF fd reads as
                    # always-ready in select, which would spin this loop at 100% CPU.
                    # The child stays alive; only our input side is done.
                    watch = [master]

            # Reap without blocking, so a child that exits while quiet still ends us.
            done, status = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                # Drain whatever is still buffered in the pty before leaving.
                try:
                    while True:
                        data = os.read(master, 65536)
                        if not data:
                            break
                        transcript.write(data)
                except OSError:
                    pass
                return os.waitstatus_to_exitcode(status)
    finally:
        transcript.close()
        try:
            os.close(master)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
