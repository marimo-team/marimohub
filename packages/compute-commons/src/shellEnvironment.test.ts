import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ShellEnvironment, privateEnvironmentWriteCommand } from './shellEnvironment';

describe('ShellEnvironment', () => {
	it.skipIf(process.platform === 'win32')(
		'preserves quoting, forced values and image defaults without secrets in argv',
		async () => {
			const paths: string[] = [];
			const env = new ShellEnvironment(async (path, content) => {
				paths.push(path);
				execFileSync('sh', ['-c', privateEnvironmentWriteCommand(path)], { input: content });
			});
			try {
				const token = "a'b\n$(touch should-not-exist); secret";
				const command = await env.command(
					'printf "%s|%s|%s" "$TOKEN" "$CACHE" "$FALLBACK"',
					{ TOKEN: token },
					{ TOKEN: 'wrong', CACHE: 'wrong', FALLBACK: 'default' },
				);
				expect(command).not.toContain(token);
				expect(
					execFileSync('sh', ['-c', command], {
						env: { ...process.env, CACHE: 'image' },
						encoding: 'utf8',
					}),
				).toBe(`${token}|image|default`);
				expect(statSync(paths[0]).mode & 0o777).toBe(0o600);
				expect(statSync(dirname(paths[0])).mode & 0o777).toBe(0o700);
			} finally {
				for (const path of paths) rmSync(dirname(path), { recursive: true, force: true });
			}
		},
	);

	it('shares preparation across concurrent commands and rewrites only on env changes', async () => {
		const write = vi.fn(async () => {});
		const env = new ShellEnvironment(write);
		const commands = await Promise.all(
			['one', 'two'].map((cmd) => env.command(cmd, { TOKEN: 'first' })),
		);
		expect(write).toHaveBeenCalledTimes(1);
		expect(commands[0].split(' ||')[0]).toBe(commands[1].split(' ||')[0]);
		const updated = await env.command('three', { TOKEN: 'second' });
		expect(write).toHaveBeenCalledTimes(2);
		expect(updated.split(' ||')[0]).not.toBe(commands[0].split(' ||')[0]);
	});

	it('propagates write failure and permits a retry', async () => {
		const write = vi
			.fn()
			.mockRejectedValueOnce(new Error('write failed'))
			.mockResolvedValue(undefined);
		const env = new ShellEnvironment(write);
		await expect(env.command('run', { TOKEN: 'value' })).rejects.toThrow('write failed');
		await expect(env.command('run', { TOKEN: 'value' })).resolves.toContain('env.sh');
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('does no I/O without env and refuses invalid names before writing', async () => {
		const write = vi.fn(async () => {});
		const env = new ShellEnvironment(write);
		expect(await env.command('run', {})).toBe('run');
		await expect(env.command('run', { 'A; bad': 'value' })).rejects.toThrow(
			'Invalid environment name',
		);
		expect(write).not.toHaveBeenCalled();
	});
	it('keeps a newer environment cached when an older in-flight write fails', async () => {
		let rejectOld!: (error: Error) => void;
		const oldWrite = new Promise<void>((_resolve, reject) => {
			rejectOld = reject;
		});
		const write = vi
			.fn<(_path: string, _content: string) => Promise<void>>()
			.mockReturnValueOnce(oldWrite)
			.mockResolvedValue(undefined);
		const env = new ShellEnvironment(write);
		const oldCommand = env
			.command('old-command', { TOKEN: 'old' })
			.catch((error: unknown) => error);
		const newCommand = await env.command('new-command', { TOKEN: 'new' });
		const failure = new Error('old write failed');
		rejectOld(failure);
		expect(await oldCommand).toBe(failure);
		expect(await env.command('new-command', { TOKEN: 'new' })).toBe(newCommand);
		expect(write).toHaveBeenCalledTimes(2);
		await env.command('retry-old', { TOKEN: 'old' });
		expect(write).toHaveBeenCalledTimes(3);
	});

	it('rejects all commands waiting on a failed shared write and retries only once', async () => {
		let rejectWrite!: (error: Error) => void;
		const pendingWrite = new Promise<void>((_resolve, reject) => {
			rejectWrite = reject;
		});
		const write = vi.fn().mockReturnValueOnce(pendingWrite).mockResolvedValue(undefined);
		const env = new ShellEnvironment(write);
		const commands = Promise.allSettled(
			['one', 'two'].map((command) => env.command(command, { TOKEN: 'value' })),
		);
		expect(write).toHaveBeenCalledOnce();
		const failure = new Error('write failed');
		rejectWrite(failure);
		expect(await commands).toEqual([
			{ status: 'rejected', reason: failure },
			{ status: 'rejected', reason: failure },
		]);
		await Promise.all(['one', 'two'].map((command) => env.command(command, { TOKEN: 'value' })));
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('prepares changed defaults and drops the prefix when all values are cleared', async () => {
		const write = vi.fn(async () => {});
		const env = new ShellEnvironment(write);
		const first = await env.command('run', {}, { CACHE: 'first' });
		const second = await env.command('run', {}, { CACHE: 'second' });
		expect(first).not.toBe(second);
		expect(write).toHaveBeenCalledTimes(2);
		expect(await env.command('run', {})).toBe('run');
		expect(write).toHaveBeenCalledTimes(2);
	});

	it.skipIf(process.platform === 'win32')(
		'does not execute a command when its environment file disappeared',
		async () => {
			const env = new ShellEnvironment(async () => {});
			const command = await env.command('printf command-ran', { TOKEN: 'value' });
			const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe('');
		},
	);

	it.each(['', '1INVALID', 'INVALID-NAME', 'A\nB'])(
		'rejects invalid default names before writing (%j)',
		async (name) => {
			const write = vi.fn(async () => {});
			await expect(
				new ShellEnvironment(write).command('run', {}, { [name]: 'value' }),
			).rejects.toThrow('Invalid environment name');
			expect(write).not.toHaveBeenCalled();
		},
	);
});
