import { AesGcmSecretCodec } from '@marimo-hub/core';
import type { ManagedSecretCodec, SecretResolver } from '@marimo-hub/core';
import { createAwsSecretsManagerResolver } from '@marimo-hub/secrets-aws';
import { parseIntEnv } from './env';
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
	return { codec: makeManagedCodec(env), resolvers };
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
