import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../internal/sha256';
import {
	generateServiceAccountToken,
	ServiceAccountCredentials,
} from './ServiceAccountCredentials';
import type { ServiceAccountsConfig } from './ServiceAccountCredentials';

const initial = await generateServiceAccountToken('deploy', 'initial');
const replacement = await generateServiceAccountToken('deploy', 'replacement');
const config: ServiceAccountsConfig = [
	{
		id: 'deploy',
		name: 'Deployment automation',
		actions: ['org-integration.manage'],
		credentials: [initial.credential],
	},
];
afterEach(() => vi.useRealTimers());

describe('service account credentials', () => {
	it('accepts the shared Rust CLI credential fixture', async () => {
		const fixture = JSON.parse(
			readFileSync(
				new URL('../../../../../apps/cli/tests/fixtures/service-account.json', import.meta.url),
				'utf8',
			),
		) as { token: string; accounts: ServiceAccountsConfig };
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2029-01-01T00:00:00Z'));
		expect(
			await new ServiceAccountCredentials(fixture.accounts).verify(fixture.token),
		).toMatchObject({
			id: 'service-account:ci-deploy',
			credential: { kind: 'service-account', id: 'ci-deploy/initial' },
		});
	});

	it('rejects duplicate actions with an explicit uniqueness error', () => {
		expect(
			() =>
				new ServiceAccountCredentials([
					{ ...config[0], actions: ['org-integration.manage', 'org-integration.manage'] },
				]),
		).toThrow('Actions must be unique');
	});

	it('generates distinct tokens, hashes the entire credential, and exposes bounded provenance', async () => {
		const next = await generateServiceAccountToken('deploy', 'initial');
		expect(next.token).not.toBe(initial.token);
		expect(initial.token).toMatch(/^mhub_sa_deploy_initial_[0-9a-f]{64}$/);
		expect(initial.credential.sha256).toBe(await sha256Hex(initial.token));
		expect(await new ServiceAccountCredentials(config).verify(initial.token)).toEqual({
			id: 'service-account:deploy',
			email: 'deploy@service-accounts.invalid',
			name: 'Deployment automation',
			credential: {
				kind: 'service-account',
				id: 'deploy/initial',
				grant: { actions: ['org-integration.manage'], projects: '*' },
			},
		});
	});

	it.each([
		'',
		'mhub_sa_',
		'mhub_sa_deploy_initial_',
		'mhub_sa_deploy_initial_short',
		initial.token.toUpperCase(),
		`${initial.token}_extra`,
		`${initial.token}extra`,
		initial.token.replace('_deploy_', '_other_'),
		initial.token.replace('_initial_', '_unknown_'),
		initial.token.replace('mhub_sa_', 'mhub_pat_'),
		`mhub_sa_deploy_initial_${'x'.repeat(64)}`,
		`mhub_sa_deploy_initial_${'a'.repeat(100000)}`,
	])('rejects malformed or unknown tokens %#', async (token) => {
		expect(await new ServiceAccountCredentials(config).verify(token)).toBeNull();
	});

	it('rejects a wrong secret even when the account and credential IDs match', async () => {
		const wrong = await generateServiceAccountToken('deploy', 'initial');
		expect(await new ServiceAccountCredentials(config).verify(wrong.token)).toBeNull();
	});

	it('rejects malformed tokens even when their full hash is configured', async () => {
		for (const token of [
			'mhub_sa_deploy_initial_short',
			`mhub_sa_deploy_initial_${'A'.repeat(64)}`,
			`mhub_sa_deploy_initial_${'a'.repeat(64)}\n`,
		]) {
			const accounts = new ServiceAccountCredentials([
				{ ...config[0], credentials: [{ id: 'initial', sha256: await sha256Hex(token) }] },
			]);
			expect(await accounts.verify(token)).toBeNull();
		}
	});

	it('supports the longest IDs and keeps accounts with the same credential ID separate', async () => {
		const longest = await generateServiceAccountToken('a'.repeat(64), 'b'.repeat(64));
		const other = await generateServiceAccountToken('other', 'initial');
		const accounts = new ServiceAccountCredentials([
			...config,
			{ ...config[0], id: 'a'.repeat(64), credentials: [longest.credential] },
			{ ...config[0], id: 'other', credentials: [other.credential] },
		]);
		expect((await accounts.verify(longest.token))?.id).toBe(`service-account:${'a'.repeat(64)}`);
		expect((await accounts.verify(other.token))?.id).toBe('service-account:other');
		expect(await accounts.verify(initial.token.replace('_deploy_', '_other_'))).toBeNull();
	});

	it('expires at the exact boundary on every verification', async () => {
		vi.useFakeTimers();
		const expiresAt = '2030-01-01T00:00:00.000Z';
		const accounts = new ServiceAccountCredentials([
			{
				...config[0],
				credentials: [{ ...initial.credential, expires_at: expiresAt }, replacement.credential],
			},
		]);
		vi.setSystemTime(Date.parse(expiresAt) - 1);
		expect((await accounts.verify(initial.token))?.credential.expiresAt).toBe(expiresAt);
		vi.setSystemTime(Date.parse(expiresAt));
		expect(await accounts.verify(initial.token)).toBeNull();
		vi.setSystemTime(Date.parse(expiresAt) + 1);
		expect(await accounts.verify(initial.token)).toBeNull();
		expect(await accounts.verify(replacement.token)).not.toBeNull();
	});

	it('supports overlapping rotation, credential removal, and account removal across reloads', async () => {
		const overlap = [{ ...config[0], credentials: [initial.credential, replacement.credential] }];
		for (const token of [initial.token, replacement.token]) {
			expect(await new ServiceAccountCredentials(overlap).verify(token)).not.toBeNull();
		}
		const rotated = new ServiceAccountCredentials([
			{ ...config[0], credentials: [replacement.credential] },
		]);
		expect(await rotated.verify(initial.token)).toBeNull();
		expect(await rotated.verify(replacement.token)).not.toBeNull();
		expect(await new ServiceAccountCredentials([]).verify(replacement.token)).toBeNull();
	});

	it('copies configuration and returned grants so callers cannot mutate authorization', async () => {
		const input = structuredClone(config);
		const accounts = new ServiceAccountCredentials(input);
		input[0].credentials.length = 0;
		input[0].actions.length = 0;
		const first = (await accounts.verify(initial.token))!;
		(first.credential.grant!.actions as string[]).push('admin.access');
		expect((await accounts.verify(initial.token))?.credential.grant?.actions).toEqual([
			'org-integration.manage',
		]);
	});

	it.each([
		'',
		'../bad',
		'Uppercase',
		'bad_id',
		'a'.repeat(65),
		'deploy\n',
		'deploy\r',
		'deploy\u2028',
		'deploy\u2029',
	])('rejects invalid generator IDs %j', async (id) => {
		await expect(generateServiceAccountToken(id, 'valid')).rejects.toThrow();
		await expect(generateServiceAccountToken('valid', id)).rejects.toThrow();
	});
});
