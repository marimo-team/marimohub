import type { Authenticator } from '@marimo-hub/core';
import { createOidcAuth } from '@marimo-hub/auth-oidc';
import type { EmailVerificationPolicy, OidcGroupPolicy } from '@marimo-hub/auth-oidc';
import { DevAuthenticator } from '@marimo-hub/auth-dev';
import type { Hono } from 'hono';
import { parseEnum, parseEnumOr, parseList, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import { CONFIG_SPEC } from './spec';

const AUTH_BACKEND_VALUES = (
	CONFIG_SPEC.find((g) => g.selector === 'MARIMOHUB_AUTH_BACKEND')?.backends ?? []
)
	.map((b) => b.selectorValue)
	.filter((v): v is string => Boolean(v));

export function authBackend(env: Env): string | undefined {
	return parseEnum(env, 'MARIMOHUB_AUTH_BACKEND', {
		allowed: AUTH_BACKEND_VALUES,
		remediation: 'Set it to oidc (production), cloudflare-access (Workers), or dev (local only).',
		docs: 'docs/configuration.md#auth',
	});
}

/**
 * Comma-separated email-domain allowlist for OIDC login (e.g. `marimo.io`).
 *
 * REQUIRED for the oidc backend: marimohub is an internal tool, so an unset
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

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_GROUP_SESSION_TTL_SECONDS = 60 * 60;

function hasAsciiAtOrBelow(value: string, limit: number): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= limit || code === 0x7f) return true;
	}
	return false;
}

function parseSeconds(env: Env, key: string, fallback: number, min: number, max: number): number {
	const raw = env[key]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new ConfigError(`Invalid ${key}: ${raw} (expected an integer from ${min} to ${max})`, {
			variable: key,
		});
	}
	return value;
}

function parseScopes(raw: string | undefined): string {
	const scopes = [...new Set((raw?.trim() || 'openid email profile').split(/\s+/).filter(Boolean))];
	if (!scopes.includes('openid') || !scopes.includes('email')) {
		throw new ConfigError('MARIMOHUB_AUTH_OIDC_SCOPES must include openid and email.', {
			variable: 'MARIMOHUB_AUTH_OIDC_SCOPES',
		});
	}
	if (scopes.includes('offline_access')) {
		throw new ConfigError(
			'MARIMOHUB_AUTH_OIDC_SCOPES must not request offline_access; marimohub does not retain refresh tokens.',
			{ variable: 'MARIMOHUB_AUTH_OIDC_SCOPES' },
		);
	}
	if (
		scopes.length > 20 ||
		scopes.some((scope) => scope.length > 200 || hasAsciiAtOrBelow(scope, 0x20))
	) {
		throw new ConfigError('MARIMOHUB_AUTH_OIDC_SCOPES contains an invalid scope value.', {
			variable: 'MARIMOHUB_AUTH_OIDC_SCOPES',
		});
	}
	return scopes.join(' ');
}

function checkedGroups(env: Env, key: string): string[] | undefined {
	const groups = parseList(env[key]);
	if (
		groups &&
		(groups.length > 200 ||
			groups.some((group) => group.length > 256 || hasAsciiAtOrBelow(group, 0x1f)))
	) {
		throw new ConfigError(
			`Invalid ${key}: expected at most 200 group ids of at most 256 characters.`,
			{
				variable: key,
			},
		);
	}
	return groups;
}

function parseGroupPolicy(env: Env): OidcGroupPolicy | undefined {
	const claim = env.MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM?.trim();
	const allowed = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS');
	const superAdmin = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_SUPER_ADMIN_GROUPS');
	const viewer = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS');
	const editor = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS');
	const manager = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS');
	const configured = Boolean(claim || allowed || superAdmin || viewer || editor || manager);
	if (!configured) return undefined;
	if (
		!claim ||
		!claim.startsWith('/') ||
		claim.length > 512 ||
		!claim
			.slice(1)
			.split('/')
			.every((segment) => /^(?:[^~]|~[01])*$/.test(segment))
	) {
		throw new ConfigError(
			'MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM must be an RFC 6901 JSON Pointer such as /groups.',
			{
				variable: 'MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM',
			},
		);
	}
	if (!allowed && !superAdmin && !viewer && !editor && !manager) {
		throw new ConfigError('An OIDC groups claim requires at least one group policy.', {
			variable: 'MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM',
		});
	}
	return {
		claim,
		...(allowed ? { allowed } : {}),
		...(superAdmin ? { superAdmin } : {}),
		...(viewer || editor || manager
			? {
					defaultRoles: {
						...(viewer ? { viewer } : {}),
						...(editor ? { editor } : {}),
						...(manager ? { manager } : {}),
					},
				}
			: {}),
	};
}

export function makeAuth(env: Env): { authenticator: Authenticator; authRoutes?: Hono } {
	const backend = authBackend(env);
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
			const groups = parseGroupPolicy(env);
			const sessionTtlSeconds = parseSeconds(
				env,
				'MARIMOHUB_AUTH_SESSION_TTL_SECONDS',
				DEFAULT_SESSION_TTL_SECONDS,
				300,
				86_400,
			);
			const groupSessionTtlSeconds = groups
				? parseSeconds(
						env,
						'MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS',
						DEFAULT_GROUP_SESSION_TTL_SECONDS,
						300,
						3600,
					)
				: sessionTtlSeconds;
			const { authenticator, routes } = createOidcAuth({
				issuer: oidc('MARIMOHUB_AUTH_OIDC_ISSUER'),
				clientId: oidc('MARIMOHUB_AUTH_OIDC_CLIENT_ID'),
				clientSecret: oidc('MARIMOHUB_AUTH_OIDC_CLIENT_SECRET'),
				redirectUri: oidc('MARIMOHUB_AUTH_OIDC_REDIRECT_URI'),
				audience: env.MARIMOHUB_AUTH_OIDC_AUDIENCE,
				scopes: parseScopes(env.MARIMOHUB_AUTH_OIDC_SCOPES),
				emailVerification: parseEnumOr<EmailVerificationPolicy>(
					env,
					'MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION',
					['required', 'trusted-issuer'],
					'required',
				),
				sessionSecret: oidc('MARIMOHUB_AUTH_SESSION_SECRET'),
				sessionTtlSeconds: Math.min(sessionTtlSeconds, groupSessionTtlSeconds),
				allowedEmailDomains: parseEmailDomains(env.MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS),
				prompt: env.MARIMOHUB_AUTH_OIDC_PROMPT?.trim() || undefined,
				...(groups ? { groups } : {}),
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
