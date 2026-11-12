import { SourceControlAccountService } from '@marimo-hub/core';
import type { Bucket } from '@marimo-hub/core/ports/bucket';
import { GitHubAccountProvider } from '@marimo-hub/source-control-github';
import { parseEnumOr } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import { makeManagedSecretCodec } from './secrets';

export function makeSourceControlAccounts(env: Env, bucket: Bucket) {
	const actor = parseEnumOr(
		env,
		'MARIMOHUB_SOURCE_CONTROL_GITHUB_PUBLISH_ACTOR',
		['app', 'user'] as const,
		'app',
	);
	const clientId = env.MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_ID?.trim();
	const clientSecret = env.MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_SECRET?.trim();
	if (!clientId && !clientSecret && actor === 'app') return { githubPublishActor: actor };
	for (const [name, value] of Object.entries({
		MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_ID: clientId,
		MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_SECRET: clientSecret,
		MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: env.MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID,
		MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY:
			env.MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY,
		MARIMOHUB_APP_BASE_URL: env.MARIMOHUB_APP_BASE_URL,
	})) {
		if (!value)
			throw new ConfigError(`${name} is required for personal GitHub authorization`, {
				variable: name,
			});
	}
	if (
		env.MARIMOHUB_SOURCE_CONTROL_GITHUB_SERVER_URL?.trim() &&
		env.MARIMOHUB_SOURCE_CONTROL_GITHUB_SERVER_URL.trim() !== 'https://github.com'
	)
		throw new ConfigError('Personal GitHub authorization currently requires github.com');
	let base: URL;
	try {
		base = new URL(env.MARIMOHUB_APP_BASE_URL!);
	} catch {
		throw new ConfigError('MARIMOHUB_APP_BASE_URL must be an HTTPS origin');
	}
	if (
		(base.protocol !== 'https:' &&
			!(
				base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
			)) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.pathname !== '/'
	)
		throw new ConfigError(
			'MARIMOHUB_APP_BASE_URL must be an HTTPS origin (HTTP is allowed on loopback for development)',
		);
	const codec = makeManagedSecretCodec(env);
	if (!codec)
		throw new ConfigError('MARIMOHUB_SECRETS_KEK is required for personal GitHub authorization', {
			variable: 'MARIMOHUB_SECRETS_KEK',
		});
	return {
		githubPublishActor: actor,
		githubAccounts: new SourceControlAccountService(
			bucket,
			codec,
			new GitHubAccountProvider(clientId!, clientSecret!),
			new URL('/api/v1/me/github/callback', base).href,
		),
	};
}
