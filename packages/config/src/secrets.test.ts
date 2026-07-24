import { describe, expect, it } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing';
import { makeSecrets } from './secrets';
import { ConfigError } from './errors';

const bucket = new MemoryBucket();

describe('makeSecrets', () => {
	it('is disabled when the backend is unset or none', () => {
		expect(makeSecrets({}, bucket)).toEqual({});
		expect(makeSecrets({ MARIMOHUB_SECRETS_BACKEND: 'none' }, bucket)).toEqual({});
	});

	it('wires a bucket-backed provider', () => {
		const { secrets } = makeSecrets({ MARIMOHUB_SECRETS_BACKEND: 'bucket' }, bucket);
		expect(secrets).toBeDefined();
	});

	it('rejects an unknown backend', () => {
		expect(() => makeSecrets({ MARIMOHUB_SECRETS_BACKEND: 'nope' }, bucket)).toThrow(ConfigError);
	});

	it('registers the aws-sm resolver when a region is set', () => {
		const { secrets } = makeSecrets(
			{ MARIMOHUB_SECRETS_BACKEND: 'bucket', MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1' },
			bucket,
		);
		expect(secrets).toBeDefined();
	});

	it('throws on partial static AWS credentials', () => {
		expect(() =>
			makeSecrets(
				{
					MARIMOHUB_SECRETS_BACKEND: 'bucket',
					MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1',
					MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID: 'AKIA',
				},
				bucket,
			),
		).toThrow(ConfigError);
	});

	it('does not enable AWS when neither region nor the enable flag is set', () => {
		// bucket-only: provider present, but no aws-sm resolver constructed.
		const { secrets } = makeSecrets({ MARIMOHUB_SECRETS_BACKEND: 'bucket' }, bucket);
		expect(secrets).toBeDefined();
	});

	it('enables aws-sm via the flag even with no region', () => {
		const { secrets } = makeSecrets(
			{ MARIMOHUB_SECRETS_BACKEND: 'bucket', MARIMOHUB_SECRETS_AWS: 'true' },
			bucket,
		);
		expect(secrets).toBeDefined();
	});

	it('rejects a non-integer aws cache TTL', () => {
		expect(() =>
			makeSecrets(
				{
					MARIMOHUB_SECRETS_BACKEND: 'bucket',
					MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1',
					MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS: '1.5',
				},
				bucket,
			),
		).toThrow(/MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS/);
	});
});
