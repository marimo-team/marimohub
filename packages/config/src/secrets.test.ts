import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAwsSecretsManagerResolver } from '@marimo-hub/secrets-aws';
import { createKubernetesSecretResolver } from '@marimo-hub/secrets-kubernetes';
import type * as KubernetesSecretsModule from '@marimo-hub/secrets-kubernetes';
import { makeManagedSecretCodec, makeSecretSources } from './secrets';
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

vi.mock('@marimo-hub/secrets-kubernetes', async (importOriginal) => ({
	...(await importOriginal<typeof KubernetesSecretsModule>()),
	createKubernetesSecretResolver: vi.fn(() => ({
		backend: 'k8s',
		title: 'Kubernetes Secret',
		locatorPlaceholder: 'namespace/secret-name#data-key',
		locatorHelp: 'Use namespace/secret-name#data-key.',
		resolve: async () => '',
	})),
}));

const PROJECT = 'proj-0000000000000000';
const KEK = '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100';
const ALLOWED_SECRETS = JSON.stringify([
	{ namespace: 'connections-a', name: 'provider-a', projects: '*' },
	{ namespace: 'connections-b', name: 'provider-b', projects: [PROJECT] },
]);

beforeEach(() => {
	vi.mocked(createAwsSecretsManagerResolver).mockClear();
	vi.mocked(createKubernetesSecretResolver).mockClear();
});

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

	it('registers Kubernetes and AWS resolvers together', () => {
		const env = {
			MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1',
			MARIMOHUB_SECRETS_KUBERNETES: 'true',
			MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: ALLOWED_SECRETS,
		};
		const sources = makeSecretSources(env);
		expect(sources.resolvers.map(({ backend }) => backend)).toEqual(['aws-sm', 'k8s']);
		expect(createKubernetesSecretResolver).toHaveBeenCalledWith({
			allowedSecrets: [
				{ namespace: 'connections-a', name: 'provider-a', projects: '*' },
				{ namespace: 'connections-b', name: 'provider-b', projects: [PROJECT] },
			],
			cacheTtlMs: 0,
			env,
		});
		expect(vi.mocked(createKubernetesSecretResolver).mock.calls[0]?.[0].env).toBe(env);
	});

	it('constructs the managed codec without parsing or loading resolvers', () => {
		const codec = makeManagedSecretCodec({
			MARIMOHUB_SECRETS_KEK: KEK,
			MARIMOHUB_SECRETS_KUBERNETES: 'true',
			MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: 'not-json',
		});
		expect(codec).toBeDefined();
		expect(createKubernetesSecretResolver).not.toHaveBeenCalled();
	});

	it('requires a policy when Kubernetes is enabled', () => {
		expect(() => makeSecretSources({ MARIMOHUB_SECRETS_KUBERNETES: 'true' })).toThrow(
			/MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS/,
		);
	});

	it('rejects Kubernetes settings unless the resolver is enabled', () => {
		expect(() =>
			makeSecretSources({
				MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: ALLOWED_SECRETS,
			}),
		).toThrow(/MARIMOHUB_SECRETS_KUBERNETES=true/);
	});

	it.each(['not-json', '{}', '[]', 'null'])(
		'rejects invalid Kubernetes policy JSON %j',
		(policy) => {
			expect(() =>
				makeSecretSources({
					MARIMOHUB_SECRETS_KUBERNETES: 'true',
					MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: policy,
				}),
			).toThrow(ConfigError);
		},
	);

	it.each([
		{ namespace: 'Connections', name: 'provider', projects: '*' },
		{ namespace: 'connections', name: 'Provider', projects: '*' },
		{ namespace: 'connections', name: 'provider', projects: [] },
		{ namespace: 'connections', name: 'provider', projects: ['not-a-project'] },
		{ namespace: 'connections', name: 'provider', projects: [PROJECT, PROJECT] },
		{ namespace: 'connections', name: 'provider', projects: 'all' },
		{ namespace: 'connections', name: 'provider', projects: '*', unknown: true },
	])('rejects invalid Kubernetes policy rule %#', (rule) => {
		expect(() =>
			makeSecretSources({
				MARIMOHUB_SECRETS_KUBERNETES: 'true',
				MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: JSON.stringify([rule]),
			}),
		).toThrow(ConfigError);
	});

	it('rejects duplicate Secret policy entries', () => {
		const rule = { namespace: 'connections', name: 'provider', projects: '*' };
		expect(() =>
			makeSecretSources({
				MARIMOHUB_SECRETS_KUBERNETES: 'true',
				MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: JSON.stringify([rule, rule]),
			}),
		).toThrow(/duplicates an earlier Secret/);
	});

	it.each(['-1', '1.5', '9007199254740992'])('rejects invalid Kubernetes cache TTL %j', (ttl) => {
		expect(() =>
			makeSecretSources({
				MARIMOHUB_SECRETS_KUBERNETES: 'true',
				MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: ALLOWED_SECRETS,
				MARIMOHUB_SECRETS_KUBERNETES_CACHE_TTL_SECONDS: ttl,
			}),
		).toThrow(/MARIMOHUB_SECRETS_KUBERNETES_CACHE_TTL_SECONDS/);
	});

	it('wraps kubeconfig loading failures in a config error', () => {
		vi.mocked(createKubernetesSecretResolver).mockImplementationOnce(() => {
			throw new Error('no kubeconfig');
		});
		expect(() =>
			makeSecretSources({
				MARIMOHUB_SECRETS_KUBERNETES: 'true',
				MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: ALLOWED_SECRETS,
			}),
		).toThrow(ConfigError);
	});
});
