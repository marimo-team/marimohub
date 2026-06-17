import type { Authenticator } from '@marimo-hub/core';
import { createOidcAuth } from '@marimo-hub/auth-oidc';
import { DevAuthenticator } from '@marimo-hub/auth-dev';
import type { Hono } from 'hono';
import { parseList, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

/**
 * Comma-separated email-domain allowlist for OIDC login (e.g. `marimo.io`).
 *
 * REQUIRED for the oidc backend: MarimoHub is an internal tool, so an unset
 * allowlist would silently admit every account the IdP can authenticate. Fail
 * closed unless the operator either names the allowed domains or explicitly sets
 * `*` to opt into allowing all domains (a conscious choice, like the
 * `MARIMOHUB_ALLOW_EPHEMERAL_STORAGE` gate).
 */
function parseEmailDomains(raw: string | undefined): string[] | undefined {
	const value = raw?.trim();
	if (!value) {
		throw new ConfigError(
			'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS must be set for the oidc backend, so an internal ' +
				'deployment cannot silently admit every account the identity provider authenticates.',
			{
				variable: 'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS',
				remediation:
					'List the allowed domains (e.g. "marimo.io,example.com"), or "*" to allow all.',
				docs: 'docs/configuration.md#auth',
			},
		);
	}
	if (value === '*') return undefined; // explicit, deliberate allow-all
	const domains = parseList(value);
	if (!domains) {
		throw new ConfigError('MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS is set but lists no domains.', {
			variable: 'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS',
			remediation: 'Provide at least one domain (e.g. "marimo.io"), or "*" to allow all.',
			docs: 'docs/configuration.md#auth',
		});
	}
	return domains;
}

export function makeAuth(env: Env): { authenticator: Authenticator; authRoutes?: Hono } {
	const backend = env.MARIMOHUB_AUTH_BACKEND;
	if (!backend) {
		throw new ConfigError(
			'MARIMOHUB_AUTH_BACKEND must be set explicitly. Refusing to start: an unset auth backend ' +
				'previously defaulted to the insecure dev bypass.',
			{
				variable: 'MARIMOHUB_AUTH_BACKEND',
				remediation:
					'Set it to oidc (production), cloudflare-access (Workers), or dev (local only).',
				docs: 'docs/configuration.md#auth',
			},
		);
	}
	const oidc = (key: string) =>
		requiredVar(env, key, {
			remediation: 'Required for the oidc backend.',
			docs: 'docs/configuration.md#auth',
		});
	switch (backend) {
		case 'oidc': {
			const { authenticator, routes } = createOidcAuth({
				issuer: oidc('MARIMOHUB_AUTH_OIDC_ISSUER'),
				clientId: oidc('MARIMOHUB_AUTH_OIDC_CLIENT_ID'),
				clientSecret: oidc('MARIMOHUB_AUTH_OIDC_CLIENT_SECRET'),
				redirectUri: oidc('MARIMOHUB_AUTH_OIDC_REDIRECT_URI'),
				audience: env.MARIMOHUB_AUTH_OIDC_AUDIENCE,
				sessionSecret: oidc('MARIMOHUB_AUTH_SESSION_SECRET'),
				allowedEmailDomains: parseEmailDomains(env.MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS),
			});
			return { authenticator, authRoutes: routes };
		}
		case 'dev':
			return {
				authenticator: new DevAuthenticator({
					userId: env.MARIMOHUB_AUTH_DEV_USER_ID,
					email: env.MARIMOHUB_AUTH_DEV_EMAIL,
					name: env.MARIMOHUB_AUTH_DEV_NAME,
				}),
			};
		case 'cloudflare-access':
			throw new ConfigError(
				'MARIMOHUB_AUTH_BACKEND=cloudflare-access is wired in examples/cloudflare-worker.',
				{ variable: 'MARIMOHUB_AUTH_BACKEND' },
			);
		default:
			throw new ConfigError(`Unknown MARIMOHUB_AUTH_BACKEND: ${backend}`, {
				variable: 'MARIMOHUB_AUTH_BACKEND',
				remediation: 'Supported backends: oidc, cloudflare-access, dev.',
				docs: 'docs/configuration.md#auth',
			});
	}
}
