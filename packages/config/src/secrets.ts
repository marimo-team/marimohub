/**
 * Wire the project-secrets provider from `MARIMOHUB_SECRETS_BACKEND`. Unset →
 * disabled (the routes 404, nothing is injected). `bucket` builds a
 * `ProjectSecretsStore` over the deployment bucket; external-manager resolvers
 * (AWS Secrets Manager, …) are registered here from their own secrets env vars.
 * Managed (encrypted-in-bucket) entries attach a codec when configured; the store
 * works reference-only without one.
 */
import { ProjectSecretsStore } from '@marimo-hub/core';
import type { Bucket, SecretResolver } from '@marimo-hub/core';
import { createAwsSecretsManagerResolver } from '@marimo-hub/secrets-aws';
import type { ApiDeps } from '@marimo-hub/api';
import { parseIntEnv } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const DOCS = 'docs/secrets.md';

export function makeSecrets(env: Env, bucket: Bucket): Pick<ApiDeps, 'secrets'> {
	const backend = env.MARIMOHUB_SECRETS_BACKEND?.trim().toLowerCase();
	if (backend === undefined || backend === '' || backend === 'none') return {};
	if (backend !== 'bucket') {
		throw new ConfigError(
			`Unknown MARIMOHUB_SECRETS_BACKEND: ${env.MARIMOHUB_SECRETS_BACKEND} (supported: bucket, none).`,
			{ variable: 'MARIMOHUB_SECRETS_BACKEND', docs: DOCS },
		);
	}

	const resolvers: SecretResolver[] = [];
	const aws = makeAwsResolver(env);
	if (aws) resolvers.push(aws);

	return { secrets: new ProjectSecretsStore({ bucket, resolvers }) };
}

/**
 * Register the AWS Secrets Manager resolver when configured. Enabled by a region
 * (or an explicit `MARIMOHUB_SECRETS_AWS=true`). Credentials default to the AWS
 * provider chain (IRSA / role / ambient); a static override is all-or-nothing.
 * `MARIMOHUB_SECRETS_AWS_ROLE_ARN` is reserved for future OIDC federation.
 */
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
