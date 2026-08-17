import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeSourceControlPublishing } from './sourceControl';

function privateKey(): string {
	return generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs8', format: 'pem' })
		.toString();
}

describe('makeSourceControlPublishing', () => {
	it('is disabled when GitHub App credentials are absent', () => {
		expect(makeSourceControlPublishing({})).toEqual({});
	});

	it('treats whitespace-only credentials as absent', () => {
		expect(
			makeSourceControlPublishing({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '  ',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: '\n',
			}),
		).toEqual({});
	});

	it('registers the GitHub publisher without exposing other providers', () => {
		const result = makeSourceControlPublishing({
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey(),
		});
		if (!result.sourceControlPublishers) throw new Error('Expected source control configuration');

		expect(result.sourceControlPublishers.getPublisher('github')?.provider).toBe('github');
		expect(result.sourceControlPublishers.getPublisher('gitlab')).toBeUndefined();
		expect(result.sourceControlPublishers.configuredProviders()).toEqual(['github']);
	});

	it.each([
		[
			{ MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123' },
			'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY',
		],
		[
			{ MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey() },
			'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID',
		],
	])('rejects partial GitHub App configuration', (env, variable) => {
		expect(() => makeSourceControlPublishing(env)).toThrow(new RegExp(variable));
	});

	it('rejects an invalid GitHub App private key at startup', () => {
		expect(() =>
			makeSourceControlPublishing({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: 'not-a-key',
			}),
		).toThrow(/MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY/);
	});

	it.each(['not-an-id', '0', '-1', '1.5'])('rejects invalid GitHub App id %s', (appId) => {
		expect(() =>
			makeSourceControlPublishing({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: appId,
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey(),
			}),
		).toThrow(/must be a positive integer/);
	});

	it('trims the app id and accepts a base64-encoded private key', () => {
		const result = makeSourceControlPublishing({
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: ' 123 ',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey()).toString('base64'),
		});
		expect(result.sourceControlPublishers?.configuredProviders()).toEqual(['github']);
	});

	it('does not include invalid private-key material in configuration errors', () => {
		const secret = 'not-a-key-secret-value';
		let thrown: unknown;
		try {
			makeSourceControlPublishing({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: secret,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).not.toContain(secret);
	});
});
