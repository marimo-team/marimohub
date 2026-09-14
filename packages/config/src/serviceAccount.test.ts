import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { generateServiceAccountToken } from '@marimo-hub/core';
import { serviceAccountsFromEnv } from './serviceAccount';
import { ConfigError } from './errors';
import { buildConfigSummary } from './configSummary';
import { createFromEnv } from './index';

const { token, credential } = await generateServiceAccountToken('ci-deploy', 'initial');
const account = { id: 'ci-deploy', actions: ['org-integration.manage'], credentials: [credential] };
const configured = (value: unknown) => ({ MARIMOHUB_SERVICE_ACCOUNTS: JSON.stringify(value) });

function configError(raw: string): ConfigError {
	try {
		serviceAccountsFromEnv({ MARIMOHUB_SERVICE_ACCOUNTS: raw });
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return error as ConfigError;
	}
	throw new Error('Expected invalid configuration');
}

describe('service account configuration', () => {
	it('disables accounts only when unset or explicitly empty', () => {
		expect(serviceAccountsFromEnv({})).toBeUndefined();
		expect(serviceAccountsFromEnv(configured([]))).toBeUndefined();
		for (const raw of ['', ' ', 'null', '{}', 'true', '[']) {
			expect(configError(raw).opts.variable).toBe('MARIMOHUB_SERVICE_ACCOUNTS');
		}
	});

	it('authenticates without a bucket or a human identity', async () => {
		expect(await serviceAccountsFromEnv(configured([account]))!.verify(token)).toMatchObject({
			id: 'service-account:ci-deploy',
			credential: { kind: 'service-account', id: 'ci-deploy/initial' },
		});
	});

	it.each([
		['missing ID', { ...account, id: undefined }, '0.id'],
		['uppercase ID', { ...account, id: 'Deploy' }, '0.id'],
		['path ID', { ...account, id: '../deploy' }, '0.id'],
		['long ID', { ...account, id: 'x'.repeat(65) }, '0.id'],
		['empty display name', { ...account, name: ' ' }, '0.name'],
		['missing actions', { ...account, actions: undefined }, '0.actions'],
		['empty actions', { ...account, actions: [] }, '0.actions'],
		['wildcard', { ...account, actions: '*' }, '0.actions'],
		['admin action', { ...account, actions: ['admin.access'] }, '0.actions'],
		['project action', { ...account, actions: ['project.read'] }, '0.actions'],
		[
			'duplicate actions',
			{ ...account, actions: ['org-integration.manage', 'org-integration.manage'] },
			'0.actions',
		],
		['missing credentials', { ...account, credentials: undefined }, '0.credentials'],
		['empty credentials', { ...account, credentials: [] }, '0.credentials'],
		[
			'duplicate credential ID',
			{ ...account, credentials: [credential, { ...credential, sha256: 'b'.repeat(64) }] },
			'0.credentials.1.id',
		],
		[
			'duplicate hash',
			{ ...account, credentials: [credential, { ...credential, id: 'other' }] },
			'0.credentials.1.sha256',
		],
		[
			'too many credentials',
			{ ...account, credentials: Array(5).fill(credential) },
			'0.credentials',
		],
		['unknown account field', { ...account, enabled: false }, '0'],
	])('rejects %s with a field path', (_name, value, path) => {
		expect(configError(JSON.stringify([value])).message).toContain(path);
	});

	it.each([
		['missing credential ID', { ...credential, id: undefined }],
		['empty credential ID', { ...credential, id: '' }],
		['invalid credential ID', { ...credential, id: 'key_1' }],
		['uppercase hash', { ...credential, sha256: credential.sha256.toUpperCase() }],
		['short hash', { ...credential, sha256: 'a'.repeat(63) }],
		['nonhex hash', { ...credential, sha256: 'x'.repeat(64) }],
		['plaintext token', { ...credential, sha256: token }],
		['missing hash', { id: credential.id }],
		['invalid expiry', { ...credential, expires_at: 'tomorrow' }],
		['invalid calendar date', { ...credential, expires_at: '2027-02-30T00:00:00Z' }],
		['local expiry', { ...credential, expires_at: '2027-01-01T00:00:00' }],
		['extra secret', { ...credential, token }],
	])('rejects %s without leaking credentials', (_name, value) => {
		const error = configError(JSON.stringify([{ ...account, credentials: [value] }]));
		expect(error.message).toContain('0.credentials.0');
		expect(error.format()).not.toContain(token);
		expect(error.format()).not.toContain(credential.sha256);
	});

	it('rejects duplicate accounts, duplicate hashes across accounts, and excessive input', () => {
		expect(configError(JSON.stringify([account, account])).message).toContain(
			'Account IDs must be unique',
		);
		expect(configError(JSON.stringify([account, { ...account, id: 'other' }])).message).toContain(
			'Credential hashes must be unique',
		);
		expect(configError(JSON.stringify(Array(33).fill(account))).message).toContain('32');
		expect(configError(' '.repeat(65537)).message).toContain('64 KiB');
	});

	it('does not echo malformed JSON or unknown field names in startup errors', () => {
		for (const raw of [
			`["${token}`,
			JSON.stringify([{ ...account, [token]: credential.sha256 }]),
		]) {
			const message = configError(raw).format();
			expect(message).not.toContain(token);
			expect(message).not.toContain(credential.sha256);
		}
	});

	it('redacts the configuration from the admin summary', () => {
		const summary = buildConfigSummary(configured([account]));
		const setting = summary.groups
			.flatMap((group) => group.settings)
			.find((item) => item.key === 'MARIMOHUB_SERVICE_ACCOUNTS');
		expect(setting).toMatchObject({ secret: true, value: null, set: true });
		expect(JSON.stringify(summary)).not.toContain(credential.sha256);
	});

	it('validates before constructing adapters', () => {
		expect(() => createFromEnv({ MARIMOHUB_SERVICE_ACCOUNTS: '{' })).toThrow('expected valid JSON');
	});

	it('accepts the documented generator output without manual token or hash edits', async () => {
		const guide = readFileSync(
			new URL('../../../docs/service-accounts.md', import.meta.url),
			'utf8',
		);
		const code = guide.match(/node --input-type=module <<'JS'\n([\s\S]*?)\nJS/)?.[1];
		expect(code).toBeDefined();
		const generated = JSON.parse(
			execFileSync(process.execPath, ['--input-type=module', '--eval', code!], {
				encoding: 'utf8',
				timeout: 10000,
			}),
		) as { MARIMOHUB_SERVICE_ACCOUNTS: string; MARIMOHUB_TOKEN: string };
		const accounts = serviceAccountsFromEnv(generated)!;
		const principal = await accounts.verify(generated.MARIMOHUB_TOKEN);
		expect(principal).toMatchObject({
			id: 'service-account:ci-deploy',
			credential: { id: 'ci-deploy/initial', kind: 'service-account' },
		});
		expect(Date.parse(principal!.credential.expiresAt!)).toBeGreaterThan(Date.now());
	});
});
