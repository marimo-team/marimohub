import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	launchSurfaceProcessCommand,
	stopSurfaceProcessCommand,
	surfaceProcessAliveCommand,
} from './state';

function sh(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile('sh', ['-c', script], (error, stdout, stderr) => {
			const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('surface process scripts', () => {
	let dir: string;
	let pidFile: string;
	let cancelFile: string;
	const spawned: number[] = [];

	beforeEach(async () => {
		dir = join(await mkdtemp(join(tmpdir(), 'surface-state-')), 'vscode');
		pidFile = `${dir}/surface.pid`;
		cancelFile = `${dir}/cancel-attempt-1`;
	});

	afterEach(async () => {
		for (const pid of spawned.splice(0)) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}
		await rm(join(dir, '..'), { recursive: true, force: true });
	});

	function background(script: string): number {
		const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
		child.unref();
		spawned.push(child.pid!);
		return child.pid!;
	}

	async function recordedPid(): Promise<number> {
		await waitFor(
			async () => (await exists(pidFile)) && /^\d+ \S/.test(await readFile(pidFile, 'utf8')),
		);
		return Number((await readFile(pidFile, 'utf8')).split(' ')[0]);
	}

	it('records the launcher PID with an identity that survives exec', async () => {
		const launched = background(launchSurfaceProcessCommand(pidFile, cancelFile, 'sleep 300'));
		const pid = await recordedPid();

		expect(pid).toBe(launched);
		expect(alive(pid)).toBe(true);
		expect((await sh(surfaceProcessAliveCommand(pidFile))).code).toBe(0);
	});

	it('stops the recorded process and removes the PID file', async () => {
		const pid = background(launchSurfaceProcessCommand(pidFile, cancelFile, 'sleep 300'));
		await recordedPid();

		expect((await sh(stopSurfaceProcessCommand(pidFile, { requirePid: true }))).code).toBe(0);
		await waitFor(async () => !alive(pid));
		expect(await exists(pidFile)).toBe(false);
	});

	it('leaves an unrelated process alone when the PID was reused', async () => {
		const bystander = background('exec sleep 300');
		await sh(`mkdir -p '${dir}'`);
		await writeFile(pidFile, `${bystander} not-the-recorded-start-time\n`);

		expect((await sh(surfaceProcessAliveCommand(pidFile))).code).not.toBe(0);
		expect((await sh(stopSurfaceProcessCommand(pidFile, { requirePid: true }))).code).toBe(0);
		expect(alive(bystander)).toBe(true);
		expect(await exists(pidFile)).toBe(false);
	});

	it('removes a stale PID file whose process has exited', async () => {
		const pid = background('exec sleep 300');
		process.kill(pid, 'SIGKILL');
		await waitFor(async () => !alive(pid));
		await sh(`mkdir -p '${dir}'`);
		await writeFile(pidFile, `${pid} 12345\n`);

		expect((await sh(stopSurfaceProcessCommand(pidFile))).code).toBe(0);
		expect(await exists(pidFile)).toBe(false);
	});

	it('fails a required stop when no PID file exists', async () => {
		expect((await sh(stopSurfaceProcessCommand(pidFile, { requirePid: true }))).code).toBe(1);
		expect((await sh(stopSurfaceProcessCommand(pidFile))).code).toBe(0);
	});

	it('refuses to launch after a cancellation marker and removes the marker', async () => {
		await sh(`mkdir -p '${dir}' && touch '${cancelFile}'`);

		const result = await sh(launchSurfaceProcessCommand(pidFile, cancelFile, 'sleep 300'));

		expect(result.code).toBe(1);
		expect(await exists(cancelFile)).toBe(false);
		expect(await exists(pidFile)).toBe(false);
	});

	it('sweeps markers from earlier attempts but keeps the one it just wrote', async () => {
		await sh(`mkdir -p '${dir}' && touch '${dir}/cancel-old-1' '${dir}/cancel-old-2'`);

		expect((await sh(stopSurfaceProcessCommand(pidFile, { cancelFile }))).code).toBe(0);
		expect(await exists(cancelFile)).toBe(true);
		expect(await exists(`${dir}/cancel-old-1`)).toBe(false);
		expect(await exists(`${dir}/cancel-old-2`)).toBe(false);

		expect((await sh(stopSurfaceProcessCommand(pidFile))).code).toBe(0);
		expect(await exists(cancelFile)).toBe(false);
	});

	it('guards every signal behind the recorded identity', () => {
		const guard = 'kill -0 "$pid" 2>/dev/null && test "$(mh_ident "$pid")" = "$want"';
		expect(stopSurfaceProcessCommand(pidFile)).toContain(`if ${guard}; then kill -TERM`);
		expect(surfaceProcessAliveCommand(pidFile)).toContain(guard);
		expect(launchSurfaceProcessCommand(pidFile, cancelFile, 'sleep 1')).toContain(
			`printf '%s %s\\n' "$$" "$(mh_ident $$)" > '${pidFile}'`,
		);
	});
});
