import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { shellQuote } from '@marimo-hub/compute-commons';
import { detachedLaunch, processLogCommand } from './process';

const exec = promisify(execFile);
const roots: string[] = [];
const pids: number[] = [];

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'mh-process-'));
	roots.push(root);
	if (process.platform === 'darwin') {
		// macOS has no setsid executable; use the same session boundary via Python.
		await writeFile(
			join(root, 'setsid'),
			'#!/usr/bin/python3\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n',
			{ mode: 0o755 },
		);
	}
	const log = join(root, "process 'quoted'.log");
	const sink = join(root, 'container.log');
	await writeFile(sink, '');
	return { root, log, sink };
}

async function launch(command: string, log: string, sink: string) {
	const result = await exec(
		'sh',
		['-c', `PATH=${shellQuote(dirname(log))}:$PATH; ${detachedLaunch(command, log, sink)}`],
		{
			timeout: 3000,
		},
	);
	expect(result.stderr).toBe('');
	expect(result.stdout).toMatch(/^\d+\n$/);
	const pid = Number(result.stdout.trim());
	expect(pid).toBeGreaterThan(1);
	pids.push(pid);
	return pid;
}

async function exited(pid: number) {
	await expect
		.poll(
			() => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			},
			{ timeout: 5000 },
		)
		.toBe(true);
}

async function logs(log: string) {
	return (await exec('sh', ['-c', processLogCommand(log)])).stdout;
}

afterEach(async () => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already reaped */
		}
	}
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('detached process logging', () => {
	it('captures an immediate crash directly and forwards only stderr', async () => {
		const { log, sink } = await fixture();
		const pid = await launch('printf "stdout\\n"; printf "fatal\\n" >&2; exit 1', log, sink);
		await exited(pid);
		expect(await logs(log)).toBe('stdout\nfatal\n');
		await expect.poll(() => readFile(sink, 'utf8')).toBe('fatal\n');
	});

	it('returns the command PID and reaps it after a signal', async () => {
		const { log, sink } = await fixture();
		const pid = await launch('echo $$:$PPID; exec sleep 60', log, sink);
		await expect.poll(() => readFile(log, 'utf8')).toMatch(new RegExp(`^${pid}:\\d+\\n$`));
		const supervisor = (await readFile(log, 'utf8')).trim().split(':')[1];
		process.kill(pid, 'SIGTERM');
		await exited(pid);
		await expect
			.poll(async () => (await exec('ps', ['-axo', 'ppid='])).stdout.split(/\s+/))
			.not.toContain(supervisor);
	});

	it('keeps logs when the container sink cannot be opened', async () => {
		const { root, log } = await fixture();
		const pid = await launch('echo out; echo failure >&2', log, join(root, 'missing', 'sink'));
		await exited(pid);
		expect(await logs(log)).toBe('out\nfailure\n');
	});

	it('keeps logs when the forwarding interpreter fails to start', async () => {
		const { root, log, sink } = await fixture();
		const bin = join(root, 'python3');
		await writeFile(bin, '#!/bin/sh\nexit 127\n', { mode: 0o755 });
		// The supervisor inherits PATH; the login shell's environment is independent.
		const pid = await launch('echo fatal >&2', log, sink);
		await exited(pid);
		expect(await logs(log)).toBe('fatal\n');
		expect(await readFile(sink, 'utf8')).toBe('');
	});

	it('does not block the command when the container sink is full', async () => {
		const { root, log } = await fixture();
		const sink = join(root, 'blocked');
		await exec('mkfifo', [sink]);
		const reader = await open(sink, constants.O_RDWR | constants.O_NONBLOCK);
		try {
			const command = `python3 -c ${shellQuote('import os; os.write(2, b"x" * 1048576)')}`;
			const pid = await launch(command, log, sink);
			await exited(pid);
			expect((await readFile(`${log}.stderr`)).length).toBe(1048576);
		} finally {
			await reader.close();
		}
	});

	it('keeps stderr writable after the follower is killed', async () => {
		const { root, log, sink } = await fixture();
		const followerPid = join(root, 'follower.pid');
		const release = join(root, 'release');
		await writeFile(
			join(root, 'python3'),
			`#!/bin/sh\necho $$ >${shellQuote(followerPid)}\nexec /usr/bin/python3 "$@"\n`,
			{ mode: 0o755 },
		);
		const pid = await launch(
			`while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done; echo after-follower >&2`,
			log,
			sink,
		);
		await expect.poll(async () => Number(await readFile(followerPid, 'utf8'))).toBeGreaterThan(1);
		process.kill(Number(await readFile(followerPid, 'utf8')), 'SIGKILL');
		await writeFile(release, '');
		await exited(pid);
		expect(await logs(log)).toBe('after-follower\n');
	});

	it.skipIf(process.platform !== 'linux')(
		'keeps stderr when the open sink rejects writes',
		async () => {
			const { log } = await fixture();
			const pid = await launch('echo disk-full >&2', log, '/dev/full');
			await exited(pid);
			expect(await logs(log)).toBe('disk-full\n');
		},
	);

	it('retains both streams when reading legacy logs without a stderr spool', async () => {
		const { log } = await fixture();
		await writeFile(log, 'legacy output\n');
		expect(await logs(log)).toBe('legacy output\n');
	});
});
