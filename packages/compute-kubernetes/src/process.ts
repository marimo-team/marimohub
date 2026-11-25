import { shellQuote } from '@marimo-hub/compute-commons';

// The kernel writes directly to disk. A slow or failed container log sink must
// never block stderr or delay the crash diagnostics read by the control plane.
const FOLLOW_STDERR = `import os, sys, time
source, done, sink = sys.argv[1:]
try:
    output = os.open(sink, os.O_WRONLY | os.O_APPEND | os.O_NONBLOCK)
except OSError:
    sys.exit(0)
with open(source, 'rb', buffering=0) as log:
    while True:
        finished = os.path.exists(done)
        # Bound each pass even if a descendant keeps writing after the kernel exits.
        remaining = os.fstat(log.fileno()).st_size - log.tell()
        while remaining > 0:
            chunk = log.read(min(remaining, 4096))
            if not chunk:
                break
            remaining -= len(chunk)
            try:
                os.write(output, chunk)
            except BlockingIOError:
                pass  # Dropped bytes remain available in the authoritative file.
            except OSError:
                sys.exit(0)
        if finished:
            break
        time.sleep(0.05)
os.close(output)
`;

function processFiles(logFile: string) {
	return {
		stdout: shellQuote(logFile),
		stderr: shellQuote(`${logFile}.stderr`),
		done: shellQuote(`${logFile}.done`),
	};
}

export function processLogCommand(logFile: string): string {
	const files = processFiles(logFile);
	// Streams are grouped, not chronological; neither read depends on the follower.
	return `cat ${files.stdout} ${files.stderr} 2>/dev/null || true`;
}

export function detachedLaunch(
	processCommand: string,
	logFile: string,
	sink = '/proc/1/fd/2',
): string {
	const files = processFiles(logFile);
	const command = `sh -lc ${shellQuote(processCommand)}`;
	const follow = `python3 -I -c ${shellQuote(FOLLOW_STDERR)} ${files.stderr} ${files.done} ${shellQuote(sink)}`;
	// Reap both children without substituting the supervisor's PID for the kernel's.
	// Close the exec transport after echoing the PID so launch returns immediately.
	const supervisor = [
		`rm -f ${files.done}`,
		`: >${files.stdout}; : >${files.stderr}`,
		`${command} >>${files.stdout} 2>>${files.stderr} </dev/null & pid=$!`,
		'echo "$pid"',
		'exec >/dev/null 2>&1',
		`${follow} & follower=$!`,
		'wait "$pid"',
		`: >${files.done}`,
		'wait "$follower"',
		`rm -f ${files.done}`,
	].join('; ');
	return `setsid sh -c ${shellQuote(supervisor)} </dev/null 2>/dev/null &`;
}
