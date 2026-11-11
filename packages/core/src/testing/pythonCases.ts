import { spawn } from 'node:child_process';

export interface PythonCase {
	/** `sys.argv[1:]` for the case. */
	argv?: string[];
	stdin?: string;
	/** Environment overrides layered on the harness process environment. */
	env?: Record<string, string>;
	cwd?: string;
}

export interface PythonCaseResult {
	status: number;
	stdout: string;
	stderr: string;
}

// Each case runs the script source as `__main__` in fresh globals, the way
// `python3 script.py args` would, so a script ending in `raise SystemExit` or
// printing to stderr behaves as in production while paying one interpreter start.
const HARNESS = String.raw`
import contextlib, io, json, os, sys, traceback
spec = json.loads(sys.stdin.buffer.read().decode('utf-8'))
code = compile(spec['source'], spec['filename'], 'exec')
environment = dict(os.environ)
results = []
for case in spec['cases']:
    out, err = io.StringIO(), io.StringIO()
    sys.argv = [spec['filename'], *case.get('argv', [])]
    sys.stdin = io.TextIOWrapper(io.BytesIO(case.get('stdin', '').encode('utf-8')))
    os.environ.clear()
    os.environ.update(environment)
    os.environ.update(case.get('env', {}))
    if case.get('cwd'):
        os.chdir(case['cwd'])
    status = 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(code, {'__name__': '__main__', '__file__': spec['filename']})
    except SystemExit as exit:
        if exit.code is None or isinstance(exit.code, int):
            status = exit.code or 0
        else:
            err.write(str(exit.code) + '\n')
            status = 1
    except BaseException:
        err.write(traceback.format_exc())
        status = 1
    results.append({'status': status, 'stdout': out.getvalue(), 'stderr': err.getvalue()})
sys.__stdout__.write(json.dumps(results))
`;

/**
 * Run `source` once per case inside a single `python3 -I` process. Cases must
 * not depend on each other's interpreter state; filesystem state they create
 * is visible to later cases, so give each case its own directories.
 */
export function runPythonCases(
	source: string,
	cases: PythonCase[],
	filename = 'script.py',
): Promise<PythonCaseResult[]> {
	return new Promise((resolve, reject) => {
		const child = spawn('python3', ['-I', '-c', HARNESS], { stdio: 'pipe' });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('error', reject);
		child.on('close', (status) => {
			if (status !== 0) {
				reject(
					new Error(
						`python case harness exited with ${status}: ${Buffer.concat(stderr).toString()}`,
					),
				);
				return;
			}
			const results = JSON.parse(Buffer.concat(stdout).toString()) as PythonCaseResult[];
			if (results.length !== cases.length) {
				reject(
					new Error(`python case harness returned ${results.length} of ${cases.length} results`),
				);
				return;
			}
			resolve(results);
		});
		child.stdin.end(JSON.stringify({ source, filename, cases }));
	});
}
