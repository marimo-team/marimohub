import { describe, expect, it } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeSourceControlAccounts } from './sourceControlAccounts';
const configured = {
	MARIMOHUB_SOURCE_CONTROL_GITHUB_PUBLISH_ACTOR: 'user',
	MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_ID: 'client',
	MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_SECRET: 'secret',
	MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
	MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: 'configured-private-key',
	MARIMOHUB_APP_BASE_URL: 'https://hub.example',
	MARIMOHUB_SECRETS_KEK: '0123456789abcdef1032547698badcfeffeeddccbbaa99887766554433221100',
};
describe('personal source-control configuration', () => {
	it('preserves defaults and rejects unsupported combinations at startup', () => {
		expect(makeSourceControlAccounts({}, new MemoryBucket())).toEqual({
			githubPublishActor: 'app',
		});
		expect(() =>
			makeSourceControlAccounts(
				{ MARIMOHUB_SOURCE_CONTROL_GITHUB_PUBLISH_ACTOR: 'user' },
				new MemoryBucket(),
			),
		).toThrow('CLIENT_ID');
		expect(() =>
			makeSourceControlAccounts({ ...configured, MARIMOHUB_SECRETS_KEK: '' }, new MemoryBucket()),
		).toThrow('KEK');
	});
	it.each([
		'http://hub.example',
		'https://hub.example/path',
		'https://user:pass@hub.example',
		'https://hub.example?return=foreign',
	])('rejects unsafe callback origin %s', (base) => {
		expect(() =>
			makeSourceControlAccounts(
				{ ...configured, MARIMOHUB_APP_BASE_URL: base },
				new MemoryBucket(),
			),
		).toThrow('HTTPS origin');
	});
	it('requires github.com and retains management when switching back to App mode', () => {
		expect(() =>
			makeSourceControlAccounts(
				{ ...configured, MARIMOHUB_SOURCE_CONTROL_GITHUB_SERVER_URL: 'https://enterprise.example' },
				new MemoryBucket(),
			),
		).toThrow('github.com');
		expect(
			makeSourceControlAccounts(
				{ ...configured, MARIMOHUB_SOURCE_CONTROL_GITHUB_PUBLISH_ACTOR: 'app' },
				new MemoryBucket(),
			).githubAccounts,
		).toBeDefined();
		expect(
			makeSourceControlAccounts(configured, new MemoryBucket()).githubAccounts?.redirectUri,
		).toBe('https://hub.example/api/v1/me/github/callback');
	});
});
