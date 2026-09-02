import { describe, expect, it } from 'vitest';
import { makeAuth, projectCreationRestricted } from './auth';
import { ConfigError } from './errors';

/**
 * `makeAuth` selector tests. The oidc backend requires a full set of vars; each
 * must fail closed when missing rather than construct a half-configured
 * authenticator.
 */
const oidcEnv = {
	MARIMOHUB_AUTH_BACKEND: 'oidc',
	MARIMOHUB_AUTH_OIDC_ISSUER: 'https://accounts.example.com',
	MARIMOHUB_AUTH_OIDC_CLIENT_ID: 'client',
	MARIMOHUB_AUTH_OIDC_CLIENT_SECRET: 'secret',
	MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
	MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
	MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
};

const proxyHeaderEnv = {
	MARIMOHUB_AUTH_BACKEND: 'proxy-header',
	MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
};

function getConfigError(run: () => unknown): ConfigError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return error as ConfigError;
	}
	throw new Error('Expected configuration to fail');
}

describe('makeAuth selector errors', () => {
	it('fails closed when the backend is unset and provides actionable metadata', () => {
		const error = getConfigError(() => makeAuth({}));

		expect(error.opts).toEqual({
			variable: 'MARIMOHUB_AUTH_BACKEND',
			remediation:
				'Set it to oidc or proxy-header (production), cloudflare-access (Workers), or dev (local only).',
			docs: 'docs/configuration.md#auth',
		});
		expect(error.format()).toContain('Refusing to start');
		expect(error.format()).toContain('MARIMOHUB_AUTH_BACKEND');
	});

	it('still requires an explicit backend when the selector is empty', () => {
		expect(() => makeAuth({ MARIMOHUB_AUTH_BACKEND: '' })).toThrow(/must be set explicitly/);
	});

	it('rejects an unknown backend and lists the supported values', () => {
		const error = getConfigError(() => makeAuth({ MARIMOHUB_AUTH_BACKEND: 'basic' }));

		expect(error.message).toMatch(/Invalid MARIMOHUB_AUTH_BACKEND: basic/);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_BACKEND');
		expect(error.message).toContain('expected oidc, proxy-header, dev, cloudflare-access');
	});

	it('still supports the explicit local-development backend', async () => {
		const { authenticator, authRoutes } = makeAuth({
			MARIMOHUB_AUTH_BACKEND: 'DEV',
			MARIMOHUB_AUTH_DEV_USER_ID: 'local-user',
			MARIMOHUB_AUTH_DEV_EMAIL: 'local@example.com',
			MARIMOHUB_AUTH_DEV_NAME: 'Local User',
		});

		expect(authRoutes).toBeUndefined();
		await expect(authenticator.authenticate(new Request('http://localhost'))).resolves.toEqual({
			id: 'local-user',
			email: 'local@example.com',
			name: 'Local User',
			credential: { kind: 'development' },
		});
	});
});

describe('makeAuth oidc required vars', () => {
	it.each([
		['https://hub.example.com/marimohub', '/marimohub?auth_error=session_expired'],
		['https://hub.example.com/marimohub/', '/marimohub?auth_error=session_expired'],
		['https://hub.example.com/api', '/api?auth_error=session_expired'],
		['https://hub.example.com/api/marimohub/', '/api/marimohub?auth_error=session_expired'],
		[
			'https://hub.example.com/marimohub///?ignored=1#ignored',
			'/marimohub?auth_error=session_expired',
		],
		['https://hub.example.com', '/?auth_error=session_expired'],
	] as const)(
		'uses the path from app base URL %s for fallback redirects',
		async (url, expected) => {
			const { authRoutes } = makeAuth({
				...oidcEnv,
				MARIMOHUB_APP_BASE_URL: url,
			});

			const response = await authRoutes!.request('/api/auth/callback');

			expect(response.headers.get('location')).toBe(expected);
		},
	);

	it('throws when MARIMOHUB_AUTH_SESSION_SECRET is missing', () => {
		const { MARIMOHUB_AUTH_SESSION_SECRET: _omit, ...env } = oidcEnv;
		expect(() => makeAuth(env)).toThrow(/MARIMOHUB_AUTH_SESSION_SECRET/);
	});

	it.each([
		'MARIMOHUB_AUTH_OIDC_ISSUER',
		'MARIMOHUB_AUTH_OIDC_CLIENT_ID',
		'MARIMOHUB_AUTH_OIDC_CLIENT_SECRET',
		'MARIMOHUB_AUTH_OIDC_REDIRECT_URI',
	])('throws when %s is missing', (key) => {
		const env: Record<string, string | undefined> = { ...oidcEnv };
		delete env[key];
		expect(() => makeAuth(env)).toThrow(new RegExp(key));
	});

	it.each([undefined, '', '   ', ',,,'])('requires a deliberate email allowlist (%j)', (value) => {
		const error = getConfigError(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: value }),
		);

		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS');
		expect(error.opts.remediation).toContain('"*" to allow all');
		expect(error.opts.docs).toBe('docs/configuration.md#auth');
	});

	it('accepts only an explicit wildcard as the allow-all choice', () => {
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: '  *  ' }),
		).not.toThrow();
	});

	it('requires openid and email scopes and rejects unused offline access', () => {
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_SCOPES: 'openid profile' })).toThrow(
			/MARIMOHUB_AUTH_OIDC_SCOPES must include openid and email/,
		);
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_SCOPES: 'openid email offline_access',
			}),
		).toThrow(/must not request offline_access/);
	});

	it.each([
		[
			'too many values',
			['openid', 'email', ...Array.from({ length: 19 }, (_, i) => `s${i}`)].join(' '),
		],
		['oversized value', `openid email ${'s'.repeat(201)}`],
		['NUL in value', 'openid email bad\0scope'],
		['DEL in value', 'openid email bad\u007fscope'],
	])('rejects invalid scope configuration: %s', (_name, scopes) => {
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_SCOPES: scopes })).toThrow(
			/MARIMOHUB_AUTH_OIDC_SCOPES contains an invalid scope value/,
		);
	});

	it('deduplicates scopes and accepts the supported boundary count', () => {
		const twentyScopes = [
			'openid',
			'email',
			...Array.from({ length: 18 }, (_, i) => `scope-${i}`),
		].join(' ');

		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_SCOPES: 'openid email email profile' }),
		).not.toThrow();
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_SCOPES: twentyScopes })).not.toThrow();
	});

	it('requires a claim pointer and policy for group authorization', () => {
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users' })).toThrow(
			/GROUPS_CLAIM/,
		);
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups' })).toThrow(
			/requires at least one group policy/,
		);
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
			}),
		).not.toThrow();
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/realm~2access/roles',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
			}),
		).toThrow(/RFC 6901 JSON Pointer/);
	});

	it.each(['', '   ', ',,,'])('accepts an empty project-creation group policy (%j)', (value) => {
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: value }),
		).not.toThrow();
	});

	it.each(['', '   ', ',,,'])(
		'rejects an unused groups claim with an empty project-creation policy (%j)',
		(value) => {
			expect(() =>
				makeAuth({
					...oidcEnv,
					MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
					MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: value,
				}),
			).toThrow(/requires at least one group policy/);
		},
	);

	it('requires a claim pointer for non-empty project-creation groups', () => {
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: 'project-creators',
			}),
		).toThrow(/GROUPS_CLAIM/);
	});

	it('restricts project creation only when the OIDC variable is present', () => {
		expect(projectCreationRestricted(oidcEnv)).toBe(false);
		expect(
			projectCreationRestricted({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: '',
			}),
		).toBe(true);
		expect(
			projectCreationRestricted({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: 'project-creators',
			}),
		).toBe(true);
		expect(
			projectCreationRestricted({
				...proxyHeaderEnv,
				MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: 'project-creators',
			}),
		).toBe(false);
	});

	it.each([
		['missing leading slash', 'groups'],
		['invalid tilde escape', '/realm~2access/roles'],
		['oversized pointer', `/${'a'.repeat(512)}`],
	])('rejects an invalid group claim pointer: %s', (_name, claim) => {
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: claim,
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
			}),
		).toThrow(/RFC 6901 JSON Pointer/);
	});

	it.each([
		'MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS',
		'MARIMOHUB_AUTH_OIDC_SUPER_ADMIN_GROUPS',
		'MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS',
		'MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS',
		'MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS',
		'MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS',
	])('accepts %s as an independent group policy', (key) => {
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/realm~1access/~0roles',
				[key]: 'group-1, group-2',
			}),
		).not.toThrow();
	});

	it.each([
		['too many groups', Array.from({ length: 201 }, (_, i) => `group-${i}`).join(',')],
		['oversized group id', 'g'.repeat(257)],
		['control character', 'hub-users,admin\u007fgroup'],
	])('rejects invalid group lists: %s', (_name, groups) => {
		const error = getConfigError(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: groups,
			}),
		);

		expect(error.message).toContain('expected at most 200 group ids');
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS');
	});

	it.each([
		['too many groups', Array.from({ length: 201 }, (_, i) => `group-${i}`).join(',')],
		['oversized group id', 'g'.repeat(257)],
		['control character', 'project-creators,bad\u007fgroup'],
	])('rejects invalid project-creation group lists: %s', (_name, groups) => {
		const error = getConfigError(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: groups,
			}),
		);

		expect(error.message).toContain('expected at most 200 group ids');
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS');
	});

	it('requires HTTPS issuer and redirect URLs', () => {
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_ISSUER: 'http://accounts.example.com' }),
		).toThrow(/OIDC issuer must be an HTTPS URL/);
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'http://hub.example.com/api/auth/callback',
			}),
		).toThrow(/OIDC redirect URI must be an HTTPS URL/);
	});

	it('bounds both ordinary and group-derived session lifetimes', () => {
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_SESSION_TTL_SECONDS: '299' })).toThrow(
			/AUTH_SESSION_TTL_SECONDS/,
		);
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
				MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS: '3601',
			}),
		).toThrow(/GROUP_SESSION_TTL_SECONDS/);
	});

	it.each(['300.5', 'abc', 'NaN', '299', '86401'])('rejects invalid session TTL %s', (ttl) => {
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_SESSION_TTL_SECONDS: ttl })).toThrow(
			/expected an integer from 300 to 86400/,
		);
	});

	it.each(['299', '3601', '1.5', 'forever'])('rejects invalid group session TTL %s', (ttl) => {
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
				MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS: ttl,
			}),
		).toThrow(/expected an integer from 300 to 3600/);
	});

	it('accepts inclusive TTL boundaries and ignores group TTL without a group policy', () => {
		expect(() => makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_SESSION_TTL_SECONDS: '300' })).not.toThrow();
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_SESSION_TTL_SECONDS: '86400' }),
		).not.toThrow();
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
				MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS: '300',
			}),
		).not.toThrow();
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
				MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS: '3600',
			}),
		).not.toThrow();
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS: 'not-used' }),
		).not.toThrow();
	});

	it('accepts only the explicit email-verification policies', () => {
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION: 'optional' }),
		).toThrow(/AUTH_OIDC_EMAIL_VERIFICATION/);
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION: 'trusted-issuer' }),
		).not.toThrow();
	});
});

describe('makeAuth cloudflare-access', () => {
	it('refuses the cloudflare-access backend outside Workers', () => {
		expect(() => makeAuth({ MARIMOHUB_AUTH_BACKEND: 'cloudflare-access' })).toThrow(ConfigError);
		expect(() => makeAuth({ MARIMOHUB_AUTH_BACKEND: 'cloudflare-access' })).toThrow(
			/cloudflare-worker/,
		);
	});
});

describe('makeAuth proxy-header', () => {
	it('uses the default email and user-id headers without auth routes', async () => {
		const { authenticator, authRoutes } = makeAuth(proxyHeaderEnv);
		expect(authRoutes).toBeUndefined();
		await expect(
			authenticator.authenticate(
				new Request('https://hub.example.com', {
					headers: {
						'X-Forwarded-Email': 'user@example.com',
						'X-Forwarded-User': 'user-1',
					},
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@example.com', credential: { kind: 'sso' } });
	});

	it('supports one custom header for both identity fields', async () => {
		const { authenticator } = makeAuth({
			...proxyHeaderEnv,
			MARIMOHUB_AUTH_PROXY_HEADER: 'Tailscale-User-Login',
		});
		await expect(
			authenticator.authenticate(
				new Request('https://hub.example.com', {
					headers: { 'Tailscale-User-Login': 'user@example.com' },
				}),
			),
		).resolves.toEqual({
			id: 'user@example.com',
			email: 'user@example.com',
			credential: { kind: 'sso' },
		});
	});

	it('requires a deliberate email-domain allowlist', () => {
		const error = getConfigError(() =>
			makeAuth({ ...proxyHeaderEnv, MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: undefined }),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS');
		expect(error.opts.remediation).toContain('"*" to allow all');
	});

	it.each(['', '   ', ',,,'])('rejects an empty email-domain allowlist: %j', (domains) => {
		const error = getConfigError(() =>
			makeAuth({ ...proxyHeaderEnv, MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: domains }),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS');
	});

	it('accepts an explicit wildcard email policy', async () => {
		const { authenticator } = makeAuth({
			...proxyHeaderEnv,
			MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: '*',
		});
		await expect(
			authenticator.authenticate(
				new Request('https://hub.example.com', {
					headers: {
						'X-Forwarded-Email': 'user@outside.example',
						'X-Forwarded-User': 'user-1',
					},
				}),
			),
		).resolves.toEqual({
			id: 'user-1',
			email: 'user@outside.example',
			credential: { kind: 'sso' },
		});
	});

	it('does not treat a wildcard mixed with a domain as allow-all', async () => {
		const { authenticator } = makeAuth({
			...proxyHeaderEnv,
			MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com,*',
		});
		await expect(
			authenticator.authenticate(
				new Request('https://hub.example.com', {
					headers: {
						'X-Forwarded-Email': 'user@example.com',
						'X-Forwarded-User': 'user-1',
					},
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@example.com', credential: { kind: 'sso' } });
		await expect(
			authenticator.authenticate(
				new Request('https://hub.example.com', {
					headers: {
						'X-Forwarded-Email': 'user@outside.example',
						'X-Forwarded-User': 'user-2',
					},
				}),
			),
		).resolves.toBeNull();
	});

	it.each([
		',,,',
		'X-Email,',
		',X-User',
		'X-Email,,X-User',
		'X-Email,X-User,X-Extra',
		'X Email',
		'X-Email:X-User',
	])('rejects an invalid header-mode mapping: %s', (headers) => {
		const error = getConfigError(() =>
			makeAuth({ ...proxyHeaderEnv, MARIMOHUB_AUTH_PROXY_HEADER: headers }),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_PROXY_HEADER');
	});

	it.each([
		['issuer', { MARIMOHUB_AUTH_PROXY_JWT_ISSUER: 'https://cloud.google.com/iap' }],
		['JWKS URL', { MARIMOHUB_AUTH_PROXY_JWKS_URL: 'https://issuer.example.com/jwks.json' }],
	])('requires the audience when the %s selects JWT mode', (_name, jwtSetting) => {
		const error = getConfigError(() =>
			makeAuth({
				...proxyHeaderEnv,
				...jwtSetting,
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE');
	});

	it('treats blank JWT settings as unset', async () => {
		const { authenticator } = makeAuth({
			...proxyHeaderEnv,
			MARIMOHUB_AUTH_PROXY_JWT_ISSUER: ' ',
			MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: ' ',
			MARIMOHUB_AUTH_PROXY_JWKS_URL: ' ',
		});
		await expect(
			authenticator.authenticate(
				new Request('https://hub.example.com', {
					headers: {
						'X-Forwarded-Email': 'user@example.com',
						'X-Forwarded-User': 'user-1',
					},
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@example.com', credential: { kind: 'sso' } });
	});

	it('accepts an audience-only IAP configuration without auth routes', async () => {
		const { authenticator, authRoutes } = makeAuth({
			...proxyHeaderEnv,
			MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: '/projects/123/apps/hub',
		});
		expect(authRoutes).toBeUndefined();
		await expect(
			authenticator.authenticate(new Request('https://hub.example.com')),
		).resolves.toBeNull();
	});

	it('requires one assertion header in JWT mode', () => {
		const error = getConfigError(() =>
			makeAuth({
				...proxyHeaderEnv,
				MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: 'audience',
				MARIMOHUB_AUTH_PROXY_HEADER: 'X-Assertion,X-Other',
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_PROXY_HEADER');
	});

	it('rejects an assertion header with an empty trailing item', () => {
		const error = getConfigError(() =>
			makeAuth({
				...proxyHeaderEnv,
				MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: 'audience',
				MARIMOHUB_AUTH_PROXY_HEADER: 'X-Assertion,',
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_PROXY_HEADER');
	});

	it.each([
		'not-a-url',
		'http://issuer.example.com/jwks.json',
		'ftp://issuer.example.com/jwks.json',
		'https://user:password@issuer.example.com/jwks.json',
	])('rejects an unsafe JWKS URL: %s', (jwksUrl) => {
		const error = getConfigError(() =>
			makeAuth({
				...proxyHeaderEnv,
				MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: 'audience',
				MARIMOHUB_AUTH_PROXY_JWKS_URL: jwksUrl,
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_PROXY_JWKS_URL');
	});
});

describe('makeAuth oidc login policy', () => {
	const policy = { evaluate: () => ({ decision: 'deny' as const }) };
	const loginPolicyEnv = {
		...oidcEnv,
		MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
		MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY: '/etc/marimohub/agency-login-policy.mjs',
	};
	const libraries = { oidcLoginPolicy: policy };

	it('accepts a preloaded login policy', () => {
		const { authenticator, authRoutes } = makeAuth(loginPolicyEnv, libraries);
		expect(authenticator).toBeDefined();
		expect(authRoutes).toBeDefined();
	});

	it('rejects an unknown login-policy backend', () => {
		const error = getConfigError(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'external' }, libraries),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND');
		expect(error.message).toMatch(/expected library/);
	});

	it.each([
		['MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY', '/etc/marimohub/agency-login-policy.mjs'],
		['MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS', '5'],
		['MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS', '900'],
	])('rejects %s without the library selector', (key, value) => {
		const error = getConfigError(() => makeAuth({ ...oidcEnv, [key]: value }, libraries));
		expect(error.opts.variable).toBe(key);
		expect(error.message).toMatch(/LOGIN_POLICY_BACKEND=library/);
	});

	it('requires the module path even when an instance is preloaded', () => {
		const error = getConfigError(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library' }, libraries),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY');
		expect(error.message).toMatch(/Missing required env var/);
	});

	it('requires the module to be preloaded (createFromEnvAsync)', () => {
		const error = getConfigError(() => makeAuth(loginPolicyEnv));
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND');
		expect(error.message).toMatch(/createFromEnvAsync/);
	});

	it.each([
		'MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM',
		'MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS',
		'MARIMOHUB_AUTH_OIDC_SUPER_ADMIN_GROUPS',
		'MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS',
		'MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS',
		'MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS',
		'MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS',
		'MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS',
	])('rejects a login policy combined with %s', (groupVar) => {
		const error = getConfigError(() =>
			makeAuth(
				{ ...loginPolicyEnv, [groupVar]: groupVar.endsWith('SECONDS') ? '900' : '/g' },
				libraries,
			),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND');
		expect(error.message).toMatch(new RegExp(groupVar));
	});

	it.each(['0', '31', 'abc', '2.5'])('rejects login-policy timeout %s', (value) => {
		expect(() =>
			makeAuth(
				{ ...loginPolicyEnv, MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS: value },
				libraries,
			),
		).toThrow(/LOGIN_POLICY_TIMEOUT_SECONDS/);
	});

	it('accepts login-policy timeouts at the bounds', () => {
		for (const value of ['1', '30']) {
			expect(() =>
				makeAuth(
					{ ...loginPolicyEnv, MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS: value },
					libraries,
				),
			).not.toThrow();
		}
	});

	it.each(['299', '3601'])('rejects login-policy session lifetime %s', (value) => {
		expect(() =>
			makeAuth(
				{ ...loginPolicyEnv, MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS: value },
				libraries,
			),
		).toThrow(/LOGIN_POLICY_SESSION_TTL_SECONDS/);
	});

	it('bounds a login-policy session even when the general lifetime is longer', () => {
		// The general 8h default would exceed the adapter's 1h cap for
		// policy-derived sessions; composition must clamp instead of throwing.
		expect(() =>
			makeAuth({ ...loginPolicyEnv, MARIMOHUB_AUTH_SESSION_TTL_SECONDS: '86400' }, libraries),
		).not.toThrow();
	});

	it.each([
		['MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND', 'library'],
		['MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY', '/etc/marimohub/policy.mjs'],
		['MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS', '5'],
		['MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS', '900'],
	])('rejects %s under a non-oidc auth backend', (key, value) => {
		const error = getConfigError(() => makeAuth({ ...proxyHeaderEnv, [key]: value }, libraries));
		expect(error.opts.variable).toBe(key);
		expect(error.message).toMatch(/only valid with MARIMOHUB_AUTH_BACKEND=oidc/);
	});

	it('treats MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=none as unset', () => {
		expect(() =>
			makeAuth({ ...oidcEnv, MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'None' }),
		).not.toThrow();
		expect(() =>
			makeAuth({ ...proxyHeaderEnv, MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'none' }),
		).not.toThrow();
		// Group mapping stays available: `none` is not a selected policy.
		expect(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'none',
				MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
				MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'hub-users',
			}),
		).not.toThrow();
	});

	it('still rejects orphaned login-policy variables next to backend=none', () => {
		const error = getConfigError(() =>
			makeAuth({
				...oidcEnv,
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'none',
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY: '/etc/marimohub/policy.mjs',
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY');
		expect(error.message).toMatch(/LOGIN_POLICY_BACKEND=library/);
	});
});

describe('projectCreationRestricted (MARIMOHUB_PROJECT_CREATION)', () => {
	const policy = { evaluate: () => ({ decision: 'deny' as const }) };
	const libraryEnv = {
		...oidcEnv,
		MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
		MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY: '/etc/marimohub/policy.mjs',
	};

	it('restricts creation under the login-policy backend, where the groups var is forbidden', () => {
		const env = { ...libraryEnv, MARIMOHUB_PROJECT_CREATION: 'restricted' };
		expect(() => makeAuth(env, { oidcLoginPolicy: policy })).not.toThrow();
		expect(projectCreationRestricted(env)).toBe(true);
		expect(projectCreationRestricted(libraryEnv)).toBe(false);
	});

	it('restricts creation on non-OIDC backends (super admins only)', () => {
		for (const backend of [
			proxyHeaderEnv,
			{ MARIMOHUB_AUTH_BACKEND: 'dev' },
			{ MARIMOHUB_AUTH_BACKEND: 'cloudflare-access' },
		]) {
			const restricted = { ...backend, MARIMOHUB_PROJECT_CREATION: 'restricted' };
			expect(projectCreationRestricted(restricted)).toBe(true);
			expect(projectCreationRestricted({ ...backend, MARIMOHUB_PROJECT_CREATION: 'open' })).toBe(
				false,
			);
			expect(projectCreationRestricted(backend)).toBe(false);
		}
	});

	it('is case-insensitive and ignores blank values', () => {
		const padded = { ...oidcEnv, MARIMOHUB_PROJECT_CREATION: ' Restricted ' };
		expect(projectCreationRestricted(padded)).toBe(true);
		expect(projectCreationRestricted({ ...oidcEnv, MARIMOHUB_PROJECT_CREATION: '  ' })).toBe(false);
	});

	it('rejects open combined with the OIDC groups var as a contradiction', () => {
		const error = getConfigError(() =>
			projectCreationRestricted({
				...oidcEnv,
				MARIMOHUB_PROJECT_CREATION: 'open',
				MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: '',
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_PROJECT_CREATION');
		expect(error.message).toMatch(/contradicts MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS/);
		// Explicit `restricted` next to the groups var is consistent, not a contradiction.
		expect(
			projectCreationRestricted({
				...oidcEnv,
				MARIMOHUB_PROJECT_CREATION: 'restricted',
				MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS: 'project-creators',
			}),
		).toBe(true);
	});

	it('rejects an unknown value', () => {
		const error = getConfigError(() =>
			projectCreationRestricted({ ...oidcEnv, MARIMOHUB_PROJECT_CREATION: 'admins' }),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_PROJECT_CREATION');
		expect(error.message).toMatch(/expected open, restricted/);
	});
});
