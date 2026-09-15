import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceAccountCredentials } from '@marimo-hub/core';
import { parseServiceAccountsConfig } from '@marimo-hub/config/service-accounts';
import { runServiceAccountCommand } from './serviceAccountCommand';

let root: string;
let output: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'service-account-command-'));
	output = join(root, 'credentials');
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

function args(...extra: string[]) {
	return [
		'generate',
		'--account',
		'ci-deploy',
		'--key',
		'initial',
		'--output-dir',
		output,
		...extra,
	];
}

async function generated(directory = output) {
	const json = await readFile(join(directory, 'accounts.json'), 'utf8');
	const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
	const accounts = parseServiceAccountsConfig(json);
	return { json, token, accounts, verifier: new ServiceAccountCredentials(accounts) };
}

function runEntrypoint(input: string[]) {
	return promisify(execFile)(
		process.execPath,
		[
			'--import',
			import.meta.resolve('tsx'),
			fileURLToPath(new URL('./index.ts', import.meta.url)),
			...input,
		],
		{
			env: { ...process.env, MARIMOHUB_AUTH_BACKEND: 'invalid', MARIMOHUB_SERVICE_ACCOUNTS: '{' },
			timeout: 20_000,
		},
	);
}

describe('service-account generate', () => {
	it('writes usable, separate server and client files with a 90-day expiry', async () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const before = Date.now();
		await runServiceAccountCommand(args());
		const { json, token, verifier } = await generated();
		const principal = await verifier.verify(token);
		expect(principal).toMatchObject({
			id: 'service-account:ci-deploy',
			credential: { kind: 'service-account', id: 'ci-deploy/initial' },
		});
		const expiry = Date.parse(principal!.credential.expiresAt!);
		expect(expiry).toBeGreaterThanOrEqual(before + 90 * 86_400_000);
		expect(expiry).toBeLessThanOrEqual(Date.now() + 90 * 86_400_000);
		expect(json).not.toContain(token);
		expect(stdout).not.toHaveBeenCalled();
		if (process.platform !== 'win32') {
			expect((await stat(output)).mode & 0o777).toBe(0o700);
			for (const name of ['accounts.json', 'token'])
				expect((await stat(join(output, name))).mode & 0o777).toBe(0o600);
		}
	});

	it('preserves existing accounts and keys during rotation without changing the input', async () => {
		await runServiceAccountCommand(args());
		const initial = await generated();
		const config = join(output, 'accounts.json');
		const next = join(root, 'next');
		await runServiceAccountCommand(
			args('--key', 'next', '--config', config, '--output-dir', next, '--expires-in-days', '1'),
		);
		const rotated = await generated(next);
		expect(rotated.accounts[0].credentials[0]).toEqual(initial.accounts[0].credentials[0]);
		expect(await rotated.verifier.verify(initial.token)).not.toBeNull();
		expect(await rotated.verifier.verify(rotated.token)).not.toBeNull();
		expect(Date.parse(rotated.accounts[0].credentials[1].expires_at!)).toBeLessThanOrEqual(
			Date.now() + 86_400_000,
		);
		expect(await readFile(config, 'utf8')).toBe(initial.json);
		const other = join(root, 'other');
		await runServiceAccountCommand(
			args('--account', 'other', '--config', config, '--output-dir', other),
		);
		const added = await generated(other);
		expect(added.accounts[0]).toEqual(initial.accounts[0]);
		expect(await added.verifier.verify(added.token)).toMatchObject({ id: 'service-account:other' });
	});

	it('refuses duplicate key IDs and the fifth overlapping key', async () => {
		await runServiceAccountCommand(args());
		const { accounts } = await generated();
		const config = join(output, 'accounts.json');
		await expect(
			runServiceAccountCommand(args('--config', config, '--output-dir', join(root, 'duplicate'))),
		).rejects.toThrow('already exists');
		for (let i = 1; i <= 3; i++)
			accounts[0].credentials.push({ id: `key-${i}`, sha256: String(i).repeat(64) });
		await writeFile(config, JSON.stringify(accounts));
		await expect(
			runServiceAccountCommand(
				args('--key', 'fifth', '--config', config, '--output-dir', join(root, 'fifth')),
			),
		).rejects.toThrow('credentials');
		expect(await readdir(root)).toEqual(['credentials']);
	});

	it('refuses existing directories and symlinks without modifying their files', async () => {
		await runServiceAccountCommand(args());
		const initial = await generated();
		await expect(runServiceAccountCommand(args())).rejects.toThrow('EEXIST');
		const link = join(root, 'link');
		await symlink(output, link, 'dir');
		await expect(runServiceAccountCommand(args('--output-dir', link))).rejects.toThrow('EEXIST');
		expect((await generated()).token).toBe(initial.token);
		expect((await generated()).json).toBe(initial.json);
	});

	it.each(['0', '-1', '1.5', 'Infinity', '3651', '1e2', ''])(
		'rejects invalid lifetimes: %s',
		async (days) => {
			await expect(runServiceAccountCommand(args('--expires-in-days', days))).rejects.toThrow(
				'--expires-in-days',
			);
			expect(await readdir(root)).toEqual([]);
		},
	);

	it.each([['generate'], ['delete'], ['generate', '--unknown'], ['generate', 'unexpected']])(
		'rejects incomplete or unknown commands: %j',
		async (...input) => {
			await expect(runServiceAccountCommand(input)).rejects.toThrow();
			expect(await readdir(root)).toEqual([]);
		},
	);

	it('rejects invalid IDs and configuration before writing output', async () => {
		await expect(runServiceAccountCommand(args('--account', '../invalid'))).rejects.toThrow();
		await expect(runServiceAccountCommand(args('--key', 'Uppercase'))).rejects.toThrow();
		const config = join(root, 'input.json');
		for (const value of ['pasted-secret', '{}', '[{"secret":"pasted-secret"}]']) {
			await writeFile(config, value);
			await expect(runServiceAccountCommand(args('--config', config))).rejects.toThrow(
				'Invalid MARIMOHUB_SERVICE_ACCOUNTS',
			);
			await expect(runServiceAccountCommand(args('--config', config))).rejects.not.toThrow(
				'pasted-secret',
			);
		}
		expect(await readdir(root)).toEqual(['input.json']);
	});

	it('runs through the server entrypoint without configured adapters or server startup', async () => {
		const result = await runEntrypoint(['service-account', ...args()]);
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe('');
		const { token, verifier } = await generated();
		expect(await verifier.verify(token)).not.toBeNull();
	}, 25_000);

	it('shows command help without writing files', async () => {
		const result = await runEntrypoint(['service-account', 'generate', '--help']);
		expect(result.stdout).toContain('--config PATH');
		expect(result.stderr).toBe('');
		expect(await readdir(root)).toEqual([]);
	}, 25_000);

	it('exits unsuccessfully on invalid commands without starting the server', async () => {
		await expect(runEntrypoint(['service-account', 'generate'])).rejects.toMatchObject({
			code: 1,
			stdout: '',
			stderr: '--account, --key, and --output-dir are required\n',
		});
	}, 25_000);
});
