import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAwsSecretsManagerResolver } from '@marimo-hub/secrets-aws';
import { makeSecretSources } from './secrets';
import { ConfigError } from './errors';

vi.mock('@marimo-hub/secrets-aws', () => ({
	createAwsSecretsManagerResolver: vi.fn(() => ({
		backend: 'aws-sm',
		title: 'AWS Secrets Manager',
		locatorPlaceholder: 'Secret ID or ARN, optionally followed by #json-key',
		locatorHelp: 'Use secret-id-or-arn[#json-key].',
		docsUrl: 'https://example.com/aws-secret-locators',
		resolve: async () => '',
	})),
}));

beforeEach(() => vi.mocked(createAwsSecretsManagerResolver).mockClear());

describe('makeSecretSources', () => {
	it('returns no sources when none are configured', () => {
		expect(makeSecretSources({})).toEqual({ codec: undefined, resolvers: [] });
	});

	it('registers the aws-sm resolver when a region is set', () => {
		const sources = makeSecretSources({ MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1' });
		expect(sources.resolvers).toHaveLength(1);
	});

	it('throws on partial static AWS credentials', () => {
		expect(() =>
			makeSecretSources({
				MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1',
				MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID: 'AKIA',
			}),
		).toThrow(ConfigError);
	});

	it('enables aws-sm via the flag even with no region', () => {
		makeSecretSources({ MARIMOHUB_SECRETS_AWS: 'true' });
		expect(createAwsSecretsManagerResolver).toHaveBeenCalledWith(
			expect.objectContaining({ region: undefined }),
		);
	});

	it('rejects a non-integer aws cache TTL', () => {
		expect(() =>
			makeSecretSources({
				MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1',
				MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS: '1.5',
			}),
		).toThrow(/MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS/);
	});
});
