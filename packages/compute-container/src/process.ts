const PROCESS_IDENTITY = `def process_identity(pid):
    with open('/proc/' + str(pid) + '/stat') as stat:
        return stat.read().rsplit(')', 1)[1].split()[19]`;

// Keep the group leader alive until orphaned descendants have also exited and been reaped.
export const SUPERVISE_PROCESS = `import ctypes, os, signal, subprocess, sys
libc = ctypes.CDLL(None, use_errno=True)
PR_SET_CHILD_SUBREAPER = 36
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'Could not supervise process descendants')
process = None
pending_signals = set()
def handle_signal(sig, _):
    if process is None:
        pending_signals.add(sig)
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGUSR1, signal.SIGUSR2):
    signal.signal(sig, handle_signal)
process = subprocess.Popen(['sh', '-lc', sys.argv[1]])
for sig in pending_signals:
    os.killpg(os.getpgrp(), sig)
while True:
    try:
        os.wait()
    except InterruptedError:
        continue
    except ChildProcessError:
        break`;

// A private process group lets surface cleanup leave the kernel and other surfaces running.
export const START_PROCESS = `import os, signal, subprocess, sys
${PROCESS_IDENTITY}
with open(sys.argv[2], 'w') as log:
    process = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(SUPERVISE_PROCESS)}, sys.argv[3]], stdin=subprocess.DEVNULL,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
try:
    try:
        identity = process_identity(process.pid)
    except FileNotFoundError:
        identity = None
    if identity is not None:
        with open(sys.argv[1], 'w') as record:
            record.write(str(process.pid) + ' ' + identity)
except Exception:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    raise`;

// A reused PID must not let an old process handle signal an unrelated process.
export const KILL_PROCESS = `import os, signal, sys
${PROCESS_IDENTITY}
try:
    with open(sys.argv[1]) as record:
        pid, identity = record.read().split()
    if process_identity(pid) == identity:
        sig = sys.argv[2]
        os.killpg(int(pid), getattr(signal, sig if sig.startswith('SIG') else 'SIG' + sig))
except (FileNotFoundError, ProcessLookupError):
    pass`;
