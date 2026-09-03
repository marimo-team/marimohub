import { AesGcmSecretCodec } from '@marimo-hub/core';
import type { ManagedSecretCodec, SecretResolver } from '@marimo-hub/core';
import { createAwsSecretsManagerResolver } from '@marimo-hub/secrets-aws';
import {
	createKubernetesSecretResolver,
	parseKubernetesSecretPolicies,
} from '@marimo-hub/secrets-kubernetes';
import { parseBool, parseIntEnv, parseSecondsEnv } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const DOCS = 'docs/integration-secrets.md';

export interface IntegrationSecretSources {
	codec?: ManagedSecretCodec;
	resolvers: SecretResolver[];
}

export function makeSecretSources(env: Env): IntegrationSecretSources {
	const resolvers: SecretResolver[] = [];
	const aws = makeAwsResolver(env);
	if (aws) resolvers.push(aws);
	const kubernetes = makeKubernetesResolver(env);
	if (kubernetes) resolvers.push(kubernetes);
	return { codec: makeManagedCodec(env), resolvers };
}

function makeKubernetesResolver(env: Env): SecretResolver | undefined {
	const enabled = parseBool(env, 'MARIMOHUB_SECRETS_KUBERNETES');
	const allowedSecretsRaw = env.MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS;
	const ttlRaw = env.MARIMOHUB_SECRETS_KUBERNETES_CACHE_TTL_SECONDS;
	if (!enabled) {
		if (allowedSecretsRaw?.trim() || ttlRaw?.trim()) {
			throw new ConfigError(
				'Kubernetes Secret resolver settings require MARIMOHUB_SECRETS_KUBERNETES=true.',
				{ variable: 'MARIMOHUB_SECRETS_KUBERNETES', docs: DOCS },
			);
		}
		return undefined;
	}

	if (!allowedSecretsRaw?.trim()) {
		throw new ConfigError(
			'MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS must contain a JSON policy array.',
			{ variable: 'MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS', docs: DOCS },
		);
	}
	let rawPolicy: unknown;
	try {
		rawPolicy = JSON.parse(allowedSecretsRaw);
	} catch {
		throw new ConfigError('MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS must be valid JSON.', {
			variable: 'MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS',
			docs: DOCS,
		});
	}
	let allowedSecrets;
	try {
		allowedSecrets = parseKubernetesSecretPolicies(rawPolicy);
	} catch (error) {
		throw new ConfigError(error instanceof Error ? error.message : String(error), {
			variable: 'MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS',
			docs: DOCS,
		});
	}
	const cacheTtlMs = parseSecondsEnv(env, 'MARIMOHUB_SECRETS_KUBERNETES_CACHE_TTL_SECONDS', {
		dflt: 0,
		allowZero: true,
	});
	try {
		return createKubernetesSecretResolver({
			allowedSecrets,
			cacheTtlMs,
		});
	} catch (error) {
		throw new ConfigError(
			`Cannot load Kubernetes client configuration: ${error instanceof Error ? error.message : String(error)}`,
			{ variable: 'MARIMOHUB_SECRETS_KUBERNETES', docs: DOCS },
		);
	}
}

function makeManagedCodec(env: Env): ManagedSecretCodec | undefined {
	const kek = env.MARIMOHUB_SECRETS_KEK?.trim();
	if (!kek) return undefined;
	try {
		return new AesGcmSecretCodec({ kek, kekId: env.MARIMOHUB_SECRETS_KEK_ID?.trim() });
	} catch (err) {
		throw new ConfigError(err instanceof Error ? err.message : String(err), {
			variable: 'MARIMOHUB_SECRETS_KEK',
			docs: DOCS,
		});
	}
}

function makeAwsResolver(env: Env): SecretResolver | undefined {
	const region = env.MARIMOHUB_SECRETS_AWS_REGION?.trim();
	const enabled = env.MARIMOHUB_SECRETS_AWS?.trim().toLowerCase() === 'true';
	if (!region && !enabled) return undefined;

	const accessKeyId = env.MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.MARIMOHUB_SECRETS_AWS_SECRET_ACCESS_KEY?.trim();
	if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
		throw new ConfigError(
			'AWS Secrets Manager static credentials are partially configured; set both ' +
				'MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID and MARIMOHUB_SECRETS_AWS_SECRET_ACCESS_KEY, or neither.',
			{ variable: 'MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID', docs: DOCS },
		);
	}

	const ttlSeconds = parseIntEnv(env, 'MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS');
	return createAwsSecretsManagerResolver({
		region,
		credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
		cacheTtlMs: ttlSeconds === undefined ? undefined : ttlSeconds * 1000,
	});
}
