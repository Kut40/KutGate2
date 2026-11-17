import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

PREFIX = b"\x00RESIZE "
MAX_CONTROL = 64


def set_size(fd, pid, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    try:
        os.kill(pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass


def parse_control(line):
    parts = line.split(b" ")
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
        return None
    cols, rows = int(parts[0]), int(parts[1])
    if not (1 <= cols <= 500 and 1 <= rows <= 500):
        return None
    return cols, rows


PARTIAL_FLUSH_S = 0.05


def partial_prefix(buf):
    return 0 < len(buf) < len(PREFIX) and PREFIX.startswith(buf)


def split_input(buf):
    out = bytearray()
    sizes = []
    while buf:
        i = buf.find(b"\x00")
        if i < 0:
            out += buf
            buf = b""
            break
        out += buf[:i]
        buf = buf[i:]
        if len(buf) < len(PREFIX):
            if PREFIX.startswith(buf):
                break
            out += buf[:1]
            buf = buf[1:]
            continue
        if not buf.startswith(PREFIX):
            out += buf[:1]
            buf = buf[1:]
            continue
        j = buf.find(b"\n")
        if j < 0:
            if len(buf) > MAX_CONTROL:
                out += buf[:1]
                buf = buf[1:]
                continue
            break
        size = parse_control(buf[len(PREFIX):j])
        if size is not None:
            sizes.append(size)
        buf = buf[j + 1:]
    return bytes(out), buf, sizes


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(2)
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)
    set_size(fd, pid, 80, 24)
    stdin = sys.stdin.fileno()
    stdout = sys.stdout.fileno()
    pending = b""
    stdin_open = True
    while True:
        fds = [fd, stdin] if stdin_open else [fd]
        timeout = PARTIAL_FLUSH_S if stdin_open and partial_prefix(pending) else None
        try:
            ready, _, _ = select.select(fds, [], [], timeout)
        except InterruptedError:
            continue
        if not ready:
            if partial_prefix(pending):
                write_all(fd, pending)
                pending = b""
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError as e:
                if e.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            write_all(stdout, data)
        if stdin_open and stdin in ready:
            data = os.read(stdin, 65536)
            if not data:
                stdin_open = False
                continue
            out, pending, sizes = split_input(pending + data)
            for cols, rows in sizes:
                set_size(fd, pid, cols, rows)
            if out:
                write_all(fd, out)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)


if __name__ == "__main__":
    main()
