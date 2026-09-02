import type { Authenticator } from '@marimo-hub/core';
import { basePathFromUrl } from '@marimo-hub/core/url';
import { createOidcAuth } from '@marimo-hub/auth-oidc';
import type {
	EmailVerificationPolicy,
	OidcGroupPolicy,
	OidcLoginPolicySettings,
} from '@marimo-hub/auth-oidc';
import { DevAuthenticator } from '@marimo-hub/auth-dev';
import { ProxyHeaderAuthenticator } from '@marimo-hub/auth-proxy-header';
import type { Hono } from 'hono';
import { parseEnum, parseEnumOr, parseList, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import type { LoadedAdapterLibraries } from './library';
import { CONFIG_SPEC } from './spec';

const AUTH_BACKEND_VALUES = (
	CONFIG_SPEC.find((g) => g.selector === 'MARIMOHUB_AUTH_BACKEND')?.backends ?? []
)
	.map((b) => b.selectorValue)
	.filter((v): v is string => Boolean(v));

export function authBackend(env: Env): string | undefined {
	return parseEnum(env, 'MARIMOHUB_AUTH_BACKEND', {
		allowed: AUTH_BACKEND_VALUES,
		remediation:
			'Set it to oidc or proxy-header (production), cloudflare-access (Workers), or dev (local only).',
		docs: 'docs/configuration.md#auth',
	});
}

/**
 * Comma-separated email-domain allowlist for production authentication.
 *
 * REQUIRED for OIDC and proxy-header: marimohub is an internal tool, so an unset
 * allowlist would silently admit every account the IdP can authenticate. Fail
 * closed unless the operator either names the allowed domains or explicitly sets
 * `*` to opt into allowing all domains (a conscious choice, like the
 * `MARIMOHUB_ALLOW_EPHEMERAL_STORAGE` gate).
 */
function parseEmailDomains(raw: string | undefined): string[] | undefined {
	const value = raw?.trim();
	if (!value) {
		throw new ConfigError(
			'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS must be set for production authentication, so an ' +
				'internal deployment cannot silently admit every authenticated account.',
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

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseProxyHeaders(
	raw: string | undefined,
	mode: 'headers' | 'jwt',
): readonly [string, string?] | undefined {
	if (raw === undefined || raw.trim() === '') return undefined;
	const headers = raw.split(',').map((header) => header.trim());
	const maximum = mode === 'jwt' ? 1 : 2;
	if (headers.length > maximum || headers.some((header) => !HEADER_NAME.test(header))) {
		throw new ConfigError(
			mode === 'jwt'
				? 'MARIMOHUB_AUTH_PROXY_HEADER must contain one valid JWT assertion header name.'
				: 'MARIMOHUB_AUTH_PROXY_HEADER must contain one or two valid header names.',
			{
				variable: 'MARIMOHUB_AUTH_PROXY_HEADER',
				remediation:
					mode === 'jwt'
						? 'Set one header name, such as X-Goog-IAP-JWT-Assertion.'
						: 'Set an email header and optional user-id header, separated by a comma.',
				docs: 'docs/configuration.md#auth',
			},
		);
	}
	return headers.length === 1 ? [headers[0]] : [headers[0], headers[1]];
}

function proxyJwtConfigured(env: Env): boolean {
	return [
		env.MARIMOHUB_AUTH_PROXY_JWT_ISSUER,
		env.MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE,
		env.MARIMOHUB_AUTH_PROXY_JWKS_URL,
	].some((value) => Boolean(value?.trim()));
}

function proxyJwtAudience(env: Env): string {
	const value = env.MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE?.trim();
	if (value) return value;
	throw new ConfigError(
		'MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE is required when proxy JWT verification is configured.',
		{
			variable: 'MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE',
			remediation: 'Set the signed-header JWT audience for the protected resource.',
			docs: 'docs/configuration.md#auth',
		},
	);
}

function proxyJwksUrl(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol === 'https:' && !url.username && !url.password) return url.toString();
	} catch {
		// Report the same configuration error for invalid and unsafe URLs.
	}
	throw new ConfigError('MARIMOHUB_AUTH_PROXY_JWKS_URL must be an HTTPS URL without credentials.', {
		variable: 'MARIMOHUB_AUTH_PROXY_JWKS_URL',
		docs: 'docs/configuration.md#auth',
	});
}

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
/** Default lifetime for sessions carrying group- or policy-derived authorization. */
const DEFAULT_DERIVED_SESSION_TTL_SECONDS = 60 * 60;
const DEFAULT_LOGIN_POLICY_TIMEOUT_SECONDS = 5;

const LOGIN_POLICY_VARS = [
	'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND',
	'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY',
	'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS',
	'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS',
] as const;

/** True when the OIDC login-policy library backend is explicitly selected (`none` = unset). */
export function oidcLoginPolicySelected(env: Env): boolean {
	return (
		parseEnum(env, 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND', {
			allowed: ['library'],
			offValues: ['none'],
			remediation: 'Set it to library, or none (or unset) to disable the external login policy.',
			docs: 'docs/configuration.md#auth',
		}) === 'library'
	);
}

/**
 * Login-policy variables outside an OIDC deployment are copied or stale
 * configuration; fail closed instead of silently ignoring an access policy.
 */
function assertNoLoginPolicyVars(env: Env, backend: string): void {
	const configured = LOGIN_POLICY_VARS.find((key) =>
		key === 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND'
			? oidcLoginPolicySelected(env)
			: env[key]?.trim(),
	);
	if (!configured) return;
	throw new ConfigError(
		`${configured} is only valid with MARIMOHUB_AUTH_BACKEND=oidc (got ${backend}).`,
		{
			variable: configured,
			remediation: 'Remove the login-policy variables or use the oidc backend.',
			docs: 'docs/configuration.md#auth',
		},
	);
}

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

export function oidcLoginPolicyTimeoutSeconds(env: Env): number {
	return parseSeconds(
		env,
		'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS',
		DEFAULT_LOGIN_POLICY_TIMEOUT_SECONDS,
		1,
		30,
	);
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

function appRedirectPath(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		return basePathFromUrl(value);
	} catch {
		return undefined;
	}
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

const GROUP_POLICY_VARS = [
	'MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM',
	'MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS',
	'MARIMOHUB_AUTH_OIDC_SUPER_ADMIN_GROUPS',
	'MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS',
	'MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS',
	'MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS',
	'MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS',
	'MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS',
] as const;

/**
 * Resolve the login-policy settings, enforcing mutual exclusion with the group
 * variables: two identity-mapping rules would make the login decision an
 * unclear AND/OR composite, so exactly one mechanism may be configured. A
 * policy module can reproduce any group rule in code.
 */
function parseLoginPolicy(
	env: Env,
	libraries: LoadedAdapterLibraries | undefined,
): OidcLoginPolicySettings | undefined {
	if (!oidcLoginPolicySelected(env)) {
		const orphaned = LOGIN_POLICY_VARS.find(
			(key) => key !== 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND' && env[key]?.trim(),
		);
		if (orphaned) {
			throw new ConfigError(
				`${orphaned} is set without MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library; ` +
					'refusing to silently ignore login-policy configuration.',
				{
					variable: orphaned,
					remediation:
						'Set MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library, or unset the variable.',
					docs: 'docs/configuration.md#auth',
				},
			);
		}
		return undefined;
	}
	// Required even when an instance is preloaded, so the sync and async paths
	// accept the same configuration and preflight can name the module.
	requiredVar(env, 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY', {
		remediation:
			'Set it to an npm package installed in the image, or a path to a mounted ESM module.',
		docs: 'docs/configuration.md#auth',
	});
	const conflicting = GROUP_POLICY_VARS.find((key) => env[key]?.trim());
	if (conflicting) {
		throw new ConfigError(
			`MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library cannot be combined with ${conflicting}; ` +
				'a login policy replaces the group mapping (and can reproduce it in code).',
			{
				variable: 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND',
				remediation: 'Remove the group variables or the login policy.',
				docs: 'docs/configuration.md#auth',
			},
		);
	}
	const policy = libraries?.oidcLoginPolicy;
	if (!policy) {
		throw new ConfigError(
			'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library requires the preloaded login-policy ' +
				'module; compose with createFromEnvAsync() (or pass a loaded instance).',
			{
				variable: 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND',
				docs: 'docs/configuration.md#auth',
			},
		);
	}
	return {
		policy,
		timeoutSeconds: oidcLoginPolicyTimeoutSeconds(env),
	};
}

function parseGroupPolicy(env: Env): OidcGroupPolicy | undefined {
	const claim = env.MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM?.trim();
	const allowed = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS');
	const superAdmin = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_SUPER_ADMIN_GROUPS');
	const projectCreation = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS');
	const viewer = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS');
	const editor = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS');
	const manager = checkedGroups(env, 'MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS');
	const mappedPolicy = Boolean(
		allowed || superAdmin || projectCreation || viewer || editor || manager,
	);
	if (!claim && !mappedPolicy) return undefined;
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
	if (!mappedPolicy) {
		throw new ConfigError('An OIDC groups claim requires at least one group policy.', {
			variable: 'MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM',
		});
	}
	return {
		claim,
		...(allowed ? { allowed } : {}),
		...(superAdmin ? { superAdmin } : {}),
		...(projectCreation ? { projectCreation } : {}),
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

/**
 * Whether project creation is limited to super admins and `project-creator`
 * entitlement holders. `MARIMOHUB_PROJECT_CREATION=restricted` works on every
 * auth backend (a login-policy module or proxy deployment can then restrict
 * creation too); the OIDC groups variable keeps implying it.
 */
export function projectCreationRestricted(env: Env): boolean {
	const mode = parseEnum(env, 'MARIMOHUB_PROJECT_CREATION', {
		allowed: ['open', 'restricted'],
		fallback: 'open',
		remediation: 'Set it to open (default) or restricted.',
		docs: 'docs/configuration.md#server--api',
	});
	// Raw presence is intentional: checkedGroups collapses empty and omitted values,
	// but this policy needs that distinction. createFromEnv calls makeAuth first to validate it.
	const groupsConfigured = env.MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS !== undefined;
	if (mode === 'open' && groupsConfigured && env.MARIMOHUB_PROJECT_CREATION?.trim()) {
		throw new ConfigError(
			'MARIMOHUB_PROJECT_CREATION=open contradicts MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS, ' +
				'which restricts project creation.',
			{
				variable: 'MARIMOHUB_PROJECT_CREATION',
				remediation:
					'Set MARIMOHUB_PROJECT_CREATION=restricted, or unset one of the two variables.',
				docs: 'docs/configuration.md#server--api',
			},
		);
	}
	return mode === 'restricted' || (authBackend(env) === 'oidc' && groupsConfigured);
}

export function makeAuth(
	env: Env,
	libraries?: LoadedAdapterLibraries,
): { authenticator: Authenticator; authRoutes?: Hono } {
	const backend = authBackend(env);
	if (!backend) {
		throw new ConfigError(
			'MARIMOHUB_AUTH_BACKEND must be set explicitly. Refusing to start: an unset auth backend ' +
				'previously defaulted to the insecure dev bypass.',
			{
				variable: 'MARIMOHUB_AUTH_BACKEND',
				remediation:
					'Set it to oidc or proxy-header (production), cloudflare-access (Workers), or dev (local only).',
				docs: 'docs/configuration.md#auth',
			},
		);
	}
	const oidc = (key: string) =>
		requiredVar(env, key, {
			remediation: 'Required for the oidc backend.',
			docs: 'docs/configuration.md#auth',
		});
	if (backend !== 'oidc') assertNoLoginPolicyVars(env, backend);
	switch (backend) {
		case 'oidc': {
			const loginPolicy = parseLoginPolicy(env, libraries);
			const groups = loginPolicy ? undefined : parseGroupPolicy(env);
			const sessionTtlSeconds = parseSeconds(
				env,
				'MARIMOHUB_AUTH_SESSION_TTL_SECONDS',
				DEFAULT_SESSION_TTL_SECONDS,
				300,
				86_400,
			);
			// Group- and policy-derived sessions share the 1h deprovisioning bound;
			// the mechanisms are mutually exclusive, so at most one TTL var applies.
			const derivedTtlVar = groups
				? 'MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS'
				: loginPolicy
					? 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS'
					: undefined;
			const derivedSessionTtlSeconds = derivedTtlVar
				? parseSeconds(env, derivedTtlVar, DEFAULT_DERIVED_SESSION_TTL_SECONDS, 300, 3600)
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
				sessionTtlSeconds: Math.min(sessionTtlSeconds, derivedSessionTtlSeconds),
				allowedEmailDomains: parseEmailDomains(env.MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS),
				prompt: env.MARIMOHUB_AUTH_OIDC_PROMPT?.trim() || undefined,
				postLoginRedirect: appRedirectPath(env.MARIMOHUB_APP_BASE_URL),
				...(groups ? { groups } : {}),
				...(loginPolicy ? { loginPolicy } : {}),
			});
			return { authenticator, authRoutes: routes };
		}
		case 'proxy-header': {
			const allowedEmailDomains = parseEmailDomains(env.MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS);
			if (proxyJwtConfigured(env)) {
				const headers = parseProxyHeaders(env.MARIMOHUB_AUTH_PROXY_HEADER, 'jwt');
				const issuer = env.MARIMOHUB_AUTH_PROXY_JWT_ISSUER?.trim();
				const jwksUrl = proxyJwksUrl(env.MARIMOHUB_AUTH_PROXY_JWKS_URL);
				return {
					authenticator: new ProxyHeaderAuthenticator({
						mode: 'jwt',
						audience: proxyJwtAudience(env),
						allowedEmailDomains,
						...(headers ? { header: headers[0] } : {}),
						...(issuer ? { issuer } : {}),
						...(jwksUrl ? { jwksUrl } : {}),
					}),
				};
			}
			const headers = parseProxyHeaders(env.MARIMOHUB_AUTH_PROXY_HEADER, 'headers');
			return {
				authenticator: new ProxyHeaderAuthenticator({
					mode: 'headers',
					allowedEmailDomains,
					...(headers ? { headers } : {}),
				}),
			};
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
				remediation: 'Supported backends: oidc, proxy-header, cloudflare-access, dev.',
				docs: 'docs/configuration.md#auth',
			});
	}
}
