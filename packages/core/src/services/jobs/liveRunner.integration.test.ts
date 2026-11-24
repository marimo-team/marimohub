import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxInstance } from '../../ports/sandbox';
import { JOB_LIVE_RUNNER } from './liveRunner';
import { readRunEvents, readRunFollowShell } from './runFollow';
import type { LiveJobRun, RunFollowEvent } from './runFollow';

// An interpreter whose marimo serves the host protocol, as a live-run sandbox image must
// provide. It is not MARIMO_INTEGRATION_PYTHON: that suite accepts older marimo releases.
const python = process.env.MARIMO_HOST_INTEGRATION_PYTHON;
// Optional: an interpreter whose marimo predates the host protocol, for the fallback path.
const legacyPython = process.env.MARIMO_LEGACY_INTEGRATION_PYTHON;

const cell = (body: string, signature = '_()') =>
	`@app.cell\ndef ${signature}:\n${body
		.split('\n')
		.map((line) => `    ${line}`)
		.join('\n')}\n    return\n`;
const notebook = (...cells: string[]) =>
	`import marimo\n\napp = marimo.App()\n\n\n${cells.join('\n\n')}\n\nif __name__ == "__main__":\n    app.run()\n`;

const NOTEBOOK = `import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo

    print("value:", mo.cli_args().get("value"), flush=True)
    mo.md(f"rendered {mo.cli_args().get('value')}")
    return (mo,)


@app.cell
def _(mo):
    if mo.cli_args().get("fail"):
        raise RuntimeError("boom")
    return


@app.cell
def _(mo):
    mo.md("independent")
    return


if __name__ == "__main__":
    app.run()
`;

const SLOW = `import marimo

app = marimo.App()


@app.cell
def _():
    import time

    import marimo as mo

    print("started", flush=True)
    time.sleep(6)
    mo.md("slow cell done")
    return


if __name__ == "__main__":
    app.run()
`;

const EMPTY = `import marimo

app = marimo.App()

if __name__ == "__main__":
    app.run()
`;

describe.skipIf(!python)('live job runner against real marimo', { timeout: 120_000 }, () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'marimohub-live-runner-'));
		await mkdir(join(root, '__marimo__'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	interface RunOptions {
		file?: string;
		interpreter?: string;
		/** Called once the runner process exists. */
		started?: (child: ReturnType<typeof spawn>) => void;
	}

	async function run(source: string, parameters: string[] = [], options: RunOptions = {}) {
		const file = options.file ?? 'notebook.py';
		await mkdir(join(root, file, '..'), { recursive: true });
		await writeFile(join(root, file), source);
		const output = '__marimo__/job_output.html';
		const args = ['-c', JOB_LIVE_RUNNER, file, '-o', output, ...parameters];
		const started = Date.now();
		const result = await new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			// A legacy interpreter must not pick up the primary one's marimo from PYTHONPATH.
			const env =
				options.interpreter === undefined ? process.env : { ...process.env, PYTHONPATH: undefined };
			const child = spawn(options.interpreter ?? python!, args, { cwd: root, env });
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
			child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
			const guard = setTimeout(() => child.kill('SIGKILL'), 100_000);
			child.on('close', (code, signal) => {
				clearTimeout(guard);
				resolve({ code, signal, stdout, stderr });
			});
			options.started?.(child);
		});
		const html = await readFile(join(root, output), 'utf8').catch(() => null);
		return {
			...result,
			html,
			seconds: (Date.now() - started) / 1000,
			files: await readdir(join(root, '__marimo__')),
		};
	}

	const exec = (command: string, args: string[]) =>
		new Promise<{ success: true; stdout: string; stderr: string }>((resolve) => {
			execFile(command, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (_e, stdout, stderr) =>
				resolve({ success: true, stdout, stderr }),
			);
		});
	const sandbox = {
		exec: (command: string) => exec('sh', ['-c', command]),
		readFile: async (path: string) =>
			readFile(path, 'utf8').then(
				(content) => ({ success: true as const, content }),
				() => ({ success: false as const, content: '' as const, error: { code: 'NOT_FOUND' } }),
			),
	} as unknown as SandboxInstance;
	const live = () => ({ live: { workdir: root } }) as LiveJobRun;

	/** Read the run's stream as a follower would, until its host is gone. */
	async function follow(batches: (events: RunFollowEvent[]) => void = () => {}) {
		const events: RunFollowEvent[] = [];
		let cursor: string | undefined;
		for (let attempt = 0; attempt < 400; attempt++) {
			const batch = await readRunEvents(sandbox, live(), cursor);
			if ('gone' in batch) {
				if (events.length > 0) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
				continue;
			}
			batches(batch.events);
			events.push(...batch.events);
			cursor = batch.events.findLast((event) => event.id)?.id ?? cursor;
		}
		return { events, cursor };
	}

	const hostDescriptor = async () =>
		JSON.parse(await readFile(join(root, '__marimo__/.job_host.json'), 'utf8')) as {
			url: string;
		};
	const listening = (port: number) =>
		new Promise<boolean>((resolve) => {
			const socket = connect(port, '127.0.0.1');
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});

	it('runs every cell once, forwards parameters, and writes the export', async () => {
		const result = await run(NOTEBOOK, ['--', '--value', '42']);

		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('value: 42\n');
		expect(result.html).toContain('rendered 42');
		expect(result.html).toContain('independent');
		// The follower descriptor carries the host token and must not outlive the server.
		expect(result.files).not.toContain('.job_host.json');
	});

	it('exits 1 for a failed cell, keeps independent cells, and still writes the export', async () => {
		const result = await run(NOTEBOOK, ['--', '--value', '7', '--fail', 'yes']);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe('value: 7\n');
		expect(result.stderr).toContain('RuntimeError: boom');
		expect(result.html).toContain('independent');
	});

	it('ignores results saved by an earlier session of the notebook', async () => {
		await run(NOTEBOOK, ['--', '--value', '1']);

		const result = await run(NOTEBOOK, ['--', '--value', '2']);

		expect(result.stdout).toBe('value: 2\n');
		expect(result.html).toContain('rendered 2');
		expect(result.html).not.toContain('rendered 1');
	});

	it('loads the export from the configured asset origin, with stylesheets marked as marimo’s own', async () => {
		const result = await run(NOTEBOOK, [
			'--asset-url',
			'https://assets.example/marimo/{version}',
			'--',
			'--value',
			'3',
		]);

		expect(result.code).toBe(0);
		expect(result.html).toMatch(
			/<link rel="stylesheet" title="marimo" crossorigin href="https:\/\/assets\.example\/marimo\/\d[^/]*\/assets\//,
		);
		expect(result.html).not.toContain('cdn.jsdelivr.net');
	});

	it('exports a notebook without cells', async () => {
		const result = await run(EMPTY);

		expect(result.code).toBe(0);
		expect(result.html).toContain('<html');
	});

	it('lets a follower read the run while it executes, and nothing after it ends', async () => {
		const target = { url: 'https://hub.example/api/run-follow/v1', token: 'mhub_follow_x.y' };

		expect(await readRunEvents(sandbox, live(), undefined)).toEqual({ gone: true });
		expect(await readRunFollowShell(sandbox, live(), target)).toBeUndefined();

		const finished = run(SLOW);
		let shell: string | undefined;
		const pending: Promise<void>[] = [];
		const { events, cursor } = await follow(() => {
			if (shell === undefined && pending.length === 0) {
				pending.push(
					readRunFollowShell(sandbox, live(), target).then((html) => {
						shell = html;
					}),
				);
			}
		});
		await Promise.all(pending);
		const result = await finished;

		expect(result.code).toBe(0);
		expect(shell).toContain('"url": "https://hub.example/api/run-follow/v1"');
		expect(shell).toContain('"authToken": "mhub_follow_x.y"');
		expect(shell).not.toContain('marimohub-follow');
		const names = events.map((event) => event.event);
		expect(names.slice(0, names.indexOf('ready'))).toEqual(
			expect.arrayContaining(['notebook', 'cell', 'document']),
		);
		// The host exits as soon as the run is exported, so the last batch can precede completion.
		expect(names).toContain('run');
		expect(names).toContain('execution');
		// A follower renders outputs only, so the client never asks for these.
		expect(names).not.toContain('console');
		expect(names).not.toContain('variable');
		expect(await readRunEvents(sandbox, live(), cursor)).toEqual({ gone: true });
		expect(result.files).not.toContain('.job_follow.html');
	});

	it('keeps a run with several multi-megabyte outputs followable and exports them in full', async () => {
		const big = notebook(
			'@app.cell\ndef _():\n    import time\n    import marimo as mo\n    return mo, time\n',
			...['a', 'b', 'c', 'd'].map((letter) =>
				cell(`time.sleep(1)\nmo.plain_text("${letter}" * 5_000_000)`, '_(mo, time)'),
			),
			cell('time.sleep(6)\nmo.md("after the large outputs")', '_(mo, time)'),
		);
		const finished = run(big);
		const sizes: number[] = [];

		const { events } = await follow((batch) =>
			sizes.push(batch.reduce((total, event) => total + event.data.length, 0)),
		);
		const result = await finished;

		expect(result.code).toBe(0);
		expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
		const outputs = events.filter((event) => event.event === 'output');
		expect(
			outputs.filter((event) => event.data.includes('too large to follow live')).length,
		).toBeGreaterThanOrEqual(1);
		expect(outputs.every((event) => event.data.length < 100_000)).toBe(true);
		expect(result.html!.length).toBeGreaterThan(15_000_000);
	});

	it('fails within seconds when the kernel exits, where the export would hang', async () => {
		const result = await run(notebook(cell('import os\nprint("before", flush=True)\nos._exit(7)')));

		expect(result.code).toBe(2);
		expect(result.seconds).toBeLessThan(40);
		expect(result.stdout).toBe('before\n');
		expect(result.stderr).toContain('The kernel exited with error code 7');
		expect(result.html).toBeNull();
	});

	it('fails a cell that reads standard input instead of waiting for it', async () => {
		const result = await run(notebook(cell('name = input("name? ")')));

		expect(result.code).toBe(1);
		expect(result.seconds).toBeLessThan(40);
		expect(result.stderr).toContain('EOFError');
		expect(result.html).toContain('<html');
	});

	it.each([
		['a cell exits the interpreter', cell('import sys\nsys.exit(3)'), 'SystemExit: 3'],
		['a cell has a syntax error', cell('x = (1 +'), 'SyntaxError'],
	])('exits 1 and still runs independent cells when %s', async (_name, broken, message) => {
		const result = await run(notebook(broken, cell('print("independent", flush=True)')));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(message);
		expect(result.stdout).toContain('independent');
		expect(result.html).toContain('<html');
	});

	it('exits 1 when two cells define the same name', async () => {
		const result = await run(
			notebook(
				'@app.cell\ndef _():\n    x = 1\n    return (x,)\n',
				'@app.cell\ndef _():\n    x = 2\n    return (x,)\n',
			),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Multiple cells define x');
		expect(result.html).toContain('<html');
	});

	it('treats mo.stop and disabled cells as success', async () => {
		const result = await run(
			notebook(
				'@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)\n',
				'@app.cell\ndef _(mo):\n    mo.stop(True, mo.md("stopped here"))\n    x = 1\n    return (x,)\n',
				cell('print("downstream", x)', '_(x)'),
				'@app.cell(disabled=True)\ndef _():\n    y = 1\n    return (y,)\n',
				cell('print("needs y", y)', '_(y)'),
				cell('print("independent", flush=True)'),
			),
		);

		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('independent\n');
		expect(result.html).toContain('stopped here');
	});

	it('keeps paths and parameter values with spaces, quotes, and non-ASCII text intact', async () => {
		const result = await run(
			notebook(
				cell(
					'import json\nimport marimo as mo\nprint(json.dumps(mo.cli_args().to_dict(), ensure_ascii=False), flush=True)',
				),
			),
			['--', '--value', `it's "q" $HOME; rm -rf /`, '--empty', '', '--text', 'héllo wörld'],
			{ file: 'sub dir/ünï code.py' },
		);

		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			value: `it's "q" $HOME; rm -rf /`,
			empty: '',
			text: 'héllo wörld',
		});
	});

	it('stops its server and removes its follower files when terminated mid-run', async () => {
		let port = 0;
		const result = await run(SLOW, [], {
			started: (child) => {
				void (async () => {
					for (let attempt = 0; attempt < 600 && port === 0; attempt++) {
						port = await hostDescriptor().then(
							(descriptor) => Number(new URL(descriptor.url).port),
							() => 0,
						);
						if (port === 0) await new Promise((resolve) => setTimeout(resolve, 50));
					}
					child.kill('SIGTERM');
				})();
			},
		});

		expect(result.code).toBe(143);
		expect(port).toBeGreaterThan(0);
		expect(await listening(port)).toBe(false);
		expect(result.files).not.toContain('.job_host.json');
		expect(result.files).not.toContain('.job_follow.html');
		expect(result.html).toBeNull();
	});

	it('exits when terminated before its server has started', async () => {
		const result = await run(SLOW, [], {
			started: (child) => setTimeout(() => child.kill('SIGTERM'), 300),
		});

		// The interpreter may die on the signal before the runner has installed its handler.
		expect(result.code === 143 || result.signal === 'SIGTERM').toBe(true);
		expect(result.seconds).toBeLessThan(20);
		expect(result.html).toBeNull();
		expect(result.files).toEqual([]);
	});

	it('starts marimo through a launcher, for the live run and for the fallback', async () => {
		// Stands in for the hub's launcher: it records its arguments, then runs marimo. The guard
		// matters because the kernel process re-imports the main module.
		await writeFile(
			join(root, 'launcher.py'),
			[
				'import runpy, sys',
				'if __name__ == "__main__":',
				'    open("launched.txt", "a").write(" ".join(sys.argv[1:3]) + "\\n")',
				'    sys.argv[0] = "marimo"',
				'    runpy.run_module("marimo", run_name="__main__")',
			].join('\n'),
		);
		const launcher = ['--launcher', join(root, 'launcher.py')];

		const live = await run(NOTEBOOK, [...launcher, '--', '--value', '6']);
		const fallback = await run('print("just a script")\n', launcher);

		expect(live.code).toBe(0);
		expect(live.stdout).toBe('value: 6\n');
		expect(fallback.stderr).toContain('this run cannot be followed');
		const launched = (await readFile(join(root, 'launched.txt'), 'utf8')).trim().split('\n');
		expect(launched.map((line) => line.split(' ')[0])).toEqual(['edit', 'edit', 'export']);
	});

	it('falls back to the plain export for a script that is not a notebook', async () => {
		const result = await run('print("just a script")\n');

		expect(result.stderr).toContain('this run cannot be followed');
		expect(result.stderr).toContain('exporting without a live view');
		expect(result.code).not.toBe(0);
		expect(result.html).toBeNull();
	});

	it.skipIf(!legacyPython)(
		'falls back to the plain export when marimo has no host protocol',
		async () => {
			const result = await run(NOTEBOOK, ['--', '--value', '9'], { interpreter: legacyPython });

			expect(result.stderr).toContain('this run cannot be followed');
			expect(result.code).toBe(0);
			expect(result.html).toContain('rendered 9');
			expect(result.files).not.toContain('.job_host.json');
		},
	);

	describe('follow client against a broken host', () => {
		const descriptor = (url: string) =>
			writeFile(
				join(root, '__marimo__/.job_host.json'),
				JSON.stringify({ url, token: 't', notebook_id: 'nb-1', notebook: 'notebook.py' }),
			);

		async function host(respond: Parameters<typeof createServer>[1]) {
			const server = createServer(respond);
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			await descriptor(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
			return server;
		}

		it('reports a host that is not serving for an empty, corrupt, or stale descriptor', async () => {
			await writeFile(join(root, '__marimo__/.job_host.json'), '');
			expect(await readRunEvents(sandbox, live(), undefined)).toEqual({ gone: true });

			await writeFile(join(root, '__marimo__/.job_host.json'), '{"url": ');
			expect(await readRunEvents(sandbox, live(), undefined)).toEqual({ gone: true });

			const server = await host(() => {});
			await new Promise((resolve) => server.close(resolve));
			expect(await readRunEvents(sandbox, live(), 'e:1')).toEqual({ gone: true });
		});

		it('rejects a host that refuses the request', async () => {
			const server = await host((_request, response) => {
				response.writeHead(400).end('{"title": "kinds has no kind named output"}');
			});

			await expect(readRunEvents(sandbox, live(), undefined)).rejects.toMatchObject({
				code: 'SERVICE_UNAVAILABLE',
			});
			server.close();
		});

		it('replaces an output that cannot fit a reply, and leaves the next event for the next reply', async () => {
			const output = (id: string, megabytes: number) =>
				`{"output":{"id":"${id}","execution_id":"x1","media":{"mimetype":"text/plain","data":"${'x'.repeat(megabytes * 1024 * 1024)}"}}}`;
			const server = await host((_request, response) => {
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				response.write(`id: e:1\nevent: output\ndata: ${output('o1', 5)}\n\n`);
				response.write(`id: e:2\nevent: output\ndata: ${output('o2', 3)}\n\n`);
				response.write(`id: e:3\nevent: output\ndata: ${output('o3', 3)}\n\n`);
			});

			const batch = await readRunEvents(sandbox, live(), 'e:0');
			server.closeAllConnections();
			server.close();

			const events = 'events' in batch ? batch.events : [];
			expect(events.map((event) => event.id)).toEqual(['e:1', 'e:2']);
			expect(JSON.parse(events[0].data)).toEqual({
				output: {
					id: 'o1',
					execution_id: 'x1',
					media: {
						mimetype: 'text/plain',
						data: 'This output is too large to follow live. It appears when the run finishes.',
					},
				},
			});
			expect(events[1].data).toHaveLength(output('o2', 3).length);
		});

		it('rejects a snapshot the host never completes', { timeout: 30_000 }, async () => {
			const server = await host((_request, response) => {
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				response.write(`event: cell\ndata: {"cell":{"id":"c1"}}\n\n`);
			});

			await expect(readRunEvents(sandbox, live(), undefined)).rejects.toMatchObject({
				code: 'SERVICE_UNAVAILABLE',
			});
			server.closeAllConnections();
			server.close();
		});
	});

	it('exits 2 without an export when the arguments are malformed', async () => {
		const result = await run(NOTEBOOK, ['--unexpected']);

		expect(result.code).toBe(2);
		expect(result.html).toBeNull();
	});
});
