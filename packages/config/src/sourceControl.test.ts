import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeSourceControl } from './sourceControl';

function privateKey(): string {
	return generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs8', format: 'pem' })
		.toString();
}

describe('makeSourceControl', () => {
	it('is disabled when GitHub App credentials are absent', () => {
		expect(makeSourceControl({})).toEqual({});
	});

	it('treats whitespace-only credentials as absent', () => {
		expect(
			makeSourceControl({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '  ',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: '\n',
			}),
		).toEqual({});
	});

	it('registers the GitHub adapter as publisher and reader without exposing other providers', () => {
		const result = makeSourceControl({
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey(),
		});
		if (!result.sourceControl) throw new Error('Expected source control configuration');

		expect(result.sourceControl.getPublisher('github')?.provider).toBe('github');
		expect(result.sourceControl.getPublisher('gitlab')).toBeUndefined();
		expect(result.sourceControl.getReader('github')?.provider).toBe('github');
		expect(result.sourceControl.getReader('gitlab')).toBeUndefined();
		expect(result.sourceControl.publisherProviders()).toEqual(['github']);
		expect(result.sourceControl.readerProviders()).toEqual(['github']);
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
		expect(() => makeSourceControl(env)).toThrow(new RegExp(variable));
	});

	it('rejects an invalid GitHub App private key at startup', () => {
		expect(() =>
			makeSourceControl({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: 'not-a-key',
			}),
		).toThrow(/MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY/);
	});

	it.each(['not-an-id', '0', '-1', '1.5'])('rejects invalid GitHub App id %s', (appId) => {
		expect(() =>
			makeSourceControl({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: appId,
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey(),
			}),
		).toThrow(/must be a positive integer/);
	});

	it('trims the app id and accepts a base64-encoded private key', () => {
		const result = makeSourceControl({
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: ' 123 ',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey()).toString('base64'),
		});
		expect(result.sourceControl?.publisherProviders()).toEqual(['github']);
	});

	it('does not include invalid private-key material in configuration errors', () => {
		const secret = 'not-a-key-secret-value';
		let thrown: unknown;
		try {
			makeSourceControl({
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
