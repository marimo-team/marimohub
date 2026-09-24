import { execFileSync } from 'node:child_process';
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
});
