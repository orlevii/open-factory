/** Spec §5.1: fixed script, run as `python3 -I -S -c PTY_BRIDGE <claudeBin> setup-token`. Never interpolate into it. */
export const PTY_BRIDGE = String.raw`
import errno, fcntl, os, pty, select, signal, struct, sys, termios
pid, master = pty.fork()
if pid == 0:
    try:
        os.close(3)
    except OSError:
        pass
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    try:
        os.execvp(sys.argv[1], sys.argv[1:])
    finally:
        os._exit(127)
os.write(3, (str(pid) + "\n").encode())
os.close(3)
def stop(_s=None, _f=None):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os._exit(1)
for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(s, stop)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if not data:
            stop()
        os.write(master, data)
    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO:
                break
            raise
        if not data:
            break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
