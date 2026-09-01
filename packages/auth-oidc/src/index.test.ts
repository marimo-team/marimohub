import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
	claimAtPointer,
	createOidcAuth,
	normalizeEmailDomains,
	emailDomainAllowed,
	pictureUrlClaim,
	sanitizeReturnTo,
} from './index';
import type { OidcLoginPolicy } from './index';

const oauthMock = vi.hoisted(() => ({
	ClientSecretPost: vi.fn(),
	checkProtocol: vi.fn(),
	authorizationCodeGrantRequest: vi.fn(),
	calculatePKCECodeChallenge: vi.fn(),
	discoveryRequest: vi.fn(),
	generateRandomCodeVerifier: vi.fn(),
	generateRandomNonce: vi.fn(),
	generateRandomState: vi.fn(),
	getValidatedIdTokenClaims: vi.fn(),
	processAuthorizationCodeResponse: vi.fn(),
	processDiscoveryResponse: vi.fn(),
	processUserInfoResponse: vi.fn(),
	userInfoRequest: vi.fn(),
	validateAuthResponse: vi.fn(),
}));

vi.mock('oauth4webapi', () => oauthMock);

/**
 * Cookie-session verification tests for the OIDC adapter.
 *
 * The OIDC discovery/JWKS network is only touched by the login/callback routes,
 * never by `authenticate()` (which verifies the `mh_session` HS256 cookie with
 * the shared `sessionSecret`). So we exercise the verification path with no
 * network by minting session tokens exactly the way the adapter's internal
 * `signSession` does — `SignJWT` HS256 with the same secret.
 */

const SESSION_SECRET = 'test-session-secret-at-least-32-bytes-long';
const SESSION_COOKIE = 'mh_session';
const TXN_COOKIE = 'mh_oidc_txn';
const BASE_CONFIG = {
	issuer: 'https://issuer.example.com',
	clientId: 'client-id',
	clientSecret: 'client-secret',
	redirectUri: 'https://hub.example.com/api/auth/callback',
	sessionSecret: SESSION_SECRET,
};

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

beforeEach(() => {
	vi.clearAllMocks();
	oauthMock.ClientSecretPost.mockImplementation((secret: string) => ({ secret }));
	oauthMock.checkProtocol.mockImplementation((url: URL, enforceHttps: boolean) => {
		if (enforceHttps && url.protocol !== 'https:') throw new Error('HTTPS required');
		if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('HTTP required');
	});
	oauthMock.discoveryRequest.mockResolvedValue(new Response('{}'));
	oauthMock.processDiscoveryResponse.mockReturnValue({
		issuer: 'https://issuer.example.com',
		authorization_endpoint: 'https://issuer.example.com/authorize',
		token_endpoint: 'https://issuer.example.com/token',
		jwks_uri: 'https://issuer.example.com/jwks',
		end_session_endpoint: 'https://issuer.example.com/logout',
	});
	oauthMock.generateRandomCodeVerifier.mockReturnValue('verifier-1');
	oauthMock.calculatePKCECodeChallenge.mockResolvedValue('challenge-1');
	oauthMock.generateRandomState.mockReturnValue('state-1');
	oauthMock.generateRandomNonce.mockReturnValue('nonce-1');
	oauthMock.validateAuthResponse.mockReturnValue(new URLSearchParams('code=abc&state=state-1'));
	oauthMock.authorizationCodeGrantRequest.mockResolvedValue(new Response('{}'));
	oauthMock.processAuthorizationCodeResponse.mockResolvedValue({
		access_token: 'access-token',
		token_type: 'bearer',
		id_token: 'id-token',
	});
	oauthMock.userInfoRequest.mockResolvedValue(new Response('{}'));
	oauthMock.processUserInfoResponse.mockResolvedValue({
		sub: 'user-1',
		email: 'user@example.com',
		email_verified: true,
		name: 'Ada Lovelace',
	});
	oauthMock.getValidatedIdTokenClaims.mockReturnValue({
		sub: 'user-1',
		email: 'user@example.com',
		email_verified: true,
		name: 'Ada Lovelace',
	});
});

function makeAuthenticator(sessionSecret: string = SESSION_SECRET) {
	return createOidcAuth({
		...BASE_CONFIG,
		sessionSecret,
	}).authenticator;
}

function makeOidc(overrides: Partial<Parameters<typeof createOidcAuth>[0]> = {}) {
	return createOidcAuth({ ...BASE_CONFIG, ...overrides });
}

/** Mint a session token the same way `signSession` does. */
async function signSession(
	opts: {
		secret?: string;
		sub?: string;
		email?: unknown;
		name?: unknown;
		pictureUrl?: unknown;
		entitlements?: unknown;
		issuer?: string;
		audience?: string;
		typ?: string;
		expirationTime?: string | number;
	} = {},
): Promise<string> {
	const secret = new TextEncoder().encode(opts.secret ?? SESSION_SECRET);
	const payload: Record<string, unknown> = {};
	if (opts.email !== undefined) payload.email = opts.email;
	if (opts.name !== undefined) payload.name = opts.name;
	if (opts.pictureUrl !== undefined) payload.picture_url = opts.pictureUrl;
	if (opts.entitlements !== undefined) payload.entitlements = opts.entitlements;
	let jwt = new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256', typ: opts.typ ?? 'mh-session+jwt' })
		.setIssuer(opts.issuer ?? 'https://issuer.example.com/')
		.setAudience(opts.audience ?? 'client-id')
		.setIssuedAt()
		.setExpirationTime(opts.expirationTime ?? '8h');
	if (opts.sub !== undefined) jwt = jwt.setSubject(opts.sub);
	return jwt.sign(secret);
}

function requestWithCookie(token: string): Request {
	return new Request('http://x', {
		headers: { cookie: `${SESSION_COOKIE}=${token}` },
	});
}

function cookiePair(res: Response, name: string): string {
	const setCookie = res.headers.get('set-cookie') ?? '';
	const match = setCookie.match(new RegExp(`${name}=[^;,]+`));
	if (!match) throw new Error(`Missing ${name} cookie in: ${setCookie}`);
	return match[0];
}

async function beginOidcTransaction(
	routes: ReturnType<typeof createOidcAuth>['routes'],
	loginPath = '/api/auth/login',
): Promise<string> {
	const login = await routes.request(loginPath);
	expect(login.status).toBe(302);
	return cookiePair(login, TXN_COOKIE);
}

describe('createOidcAuth configuration validation', () => {
	it('throws when sessionSecret is shorter than 32 bytes', () => {
		expect(() => createOidcAuth({ ...BASE_CONFIG, sessionSecret: 'short' })).toThrow(
			/MARIMOHUB_AUTH_SESSION_SECRET/,
		);
	});

	it('throws with a message mentioning 32 bytes', () => {
		expect(() => createOidcAuth({ ...BASE_CONFIG, sessionSecret: 'tooshort' })).toThrow(/32 bytes/);
	});

	it('does not throw when sessionSecret is exactly 32 bytes', () => {
		expect(() => createOidcAuth({ ...BASE_CONFIG, sessionSecret: 'a'.repeat(32) })).not.toThrow();
	});

	it('does not throw when sessionSecret is longer than 32 bytes', () => {
		expect(() => createOidcAuth({ ...BASE_CONFIG, sessionSecret: SESSION_SECRET })).not.toThrow();
	});

	it('returns authenticator and routes when sessionSecret is valid', () => {
		const result = createOidcAuth(BASE_CONFIG);
		expect(result).toHaveProperty('authenticator');
		expect(result).toHaveProperty('routes');
	});

	it('requires HTTPS issuer and redirect URLs', () => {
		expect(() => makeOidc({ issuer: 'http://issuer.example.com' })).toThrow(
			/OIDC issuer must be an HTTPS URL/,
		);
		expect(() => makeOidc({ redirectUri: 'http://hub.example.com/api/auth/callback' })).toThrow(
			/OIDC redirect URI must be an HTTPS URL/,
		);
	});

	it('rejects issuer URL components that are not part of an issuer identifier', () => {
		expect(() => makeOidc({ issuer: 'https://issuer.example.com?tenant=one' })).toThrow(
			/OIDC issuer must be an HTTPS URL/,
		);
		expect(() => makeOidc({ issuer: 'https://user@issuer.example.com' })).toThrow(
			/OIDC issuer must be an HTTPS URL/,
		);
	});

	it.each([
		['issuer', { issuer: 'not a URL' }, /OIDC issuer must be a valid HTTPS URL/],
		['redirect URI', { redirectUri: 'not a URL' }, /OIDC redirect URI must be a valid HTTPS URL/],
	])('labels a malformed %s in its startup error', (_name, overrides, expected) => {
		expect(() => makeOidc(overrides)).toThrow(expected);
	});

	it.each([
		['issuer fragment', { issuer: 'https://issuer.example.com#fragment' }, /OIDC issuer/],
		['issuer password', { issuer: 'https://user:password@issuer.example.com' }, /OIDC issuer/],
		[
			'redirect fragment',
			{ redirectUri: 'https://hub.example.com/api/auth/callback#fragment' },
			/OIDC redirect URI/,
		],
		[
			'redirect credentials',
			{ redirectUri: 'https://user@hub.example.com/api/auth/callback' },
			/OIDC redirect URI/,
		],
	])('rejects unsafe URL configuration: %s', (_name, overrides, expected) => {
		expect(() => makeOidc(overrides)).toThrow(expected);
	});

	it.each(['https://evil.example.com', '//evil.example.com', 'relative'])(
		'rejects an unsafe post-login redirect: %s',
		(postLoginRedirect) => {
			expect(() => makeOidc({ postLoginRedirect })).toThrow(/same-origin application path/);
		},
	);

	it.each(['/api', '/api/marimohub'])(
		'allows a configured post-login redirect under /api: %s',
		(postLoginRedirect) => {
			expect(() => makeOidc({ postLoginRedirect })).not.toThrow();
		},
	);

	it('rejects malformed group claim pointers at startup', () => {
		expect(() =>
			makeOidc({ groups: { claim: '/realm~2access/roles', allowed: ['hub-users'] } }),
		).toThrow(/RFC 6901 JSON Pointer/);
	});

	it('bounds direct adapter session and group settings', () => {
		expect(() => makeOidc({ sessionTtlSeconds: 299 })).toThrow(/session TTL/);
		expect(() =>
			makeOidc({
				sessionTtlSeconds: 3601,
				groups: { claim: '/groups', superAdmin: ['admins'] },
			}),
		).toThrow(/group- or policy-derived access/);
		expect(() =>
			makeOidc({ groups: { claim: '/groups', maxGroups: 1.5, allowed: ['hub-users'] } }),
		).toThrow(/maxGroups/);
	});

	it.each([299, 300.5, 86_401, Number.NaN])('rejects invalid direct session TTL %s', (ttl) => {
		expect(() => makeOidc({ sessionTtlSeconds: ttl })).toThrow(/session TTL/);
	});

	it('accepts direct session and group-count boundaries', () => {
		expect(() => makeOidc({ sessionTtlSeconds: 300 })).not.toThrow();
		expect(() => makeOidc({ sessionTtlSeconds: 86_400 })).not.toThrow();
		expect(() =>
			makeOidc({
				sessionTtlSeconds: 3600,
				groups: { claim: '/groups', maxGroups: 1, allowed: ['hub-users'] },
			}),
		).not.toThrow();
		expect(() =>
			makeOidc({ groups: { claim: '/groups', maxGroups: 200, allowed: ['hub-users'] } }),
		).not.toThrow();
	});

	it.each([0, 201, Number.NaN])('rejects invalid direct maxGroups %s', (maxGroups) => {
		expect(() =>
			makeOidc({ groups: { claim: '/groups', maxGroups, allowed: ['hub-users'] } }),
		).toThrow(/maxGroups/);
	});

	it('rejects unknown direct email-verification policies', () => {
		expect(() => makeOidc({ emailVerification: 'optional' as never })).toThrow(
			/Invalid OIDC email verification policy/,
		);
	});

	it.each([
		['missing openid', 'email profile', /must include openid/],
		['missing email', 'openid profile', /must include email/],
		[
			'too many scopes',
			['openid', 'email', ...Array.from({ length: 19 }, (_, i) => `s${i}`)].join(' '),
			/invalid scope value/,
		],
		['oversized scope', `openid email ${'s'.repeat(201)}`, /invalid scope value/],
		['control character', 'openid email bad\u007fscope', /invalid scope value/],
	])('rejects invalid direct scopes: %s', (_name, scopes, expected) => {
		expect(() => makeOidc({ scopes })).toThrow(expected);
	});

	it('does not allow direct adapter configuration to request refresh-token access', () => {
		expect(() => makeOidc({ scopes: 'openid email offline_access' })).toThrow(/offline_access/);
	});

	it('requires at least one non-empty direct group policy', () => {
		expect(() => makeOidc({ groups: { claim: '/groups' } })).toThrow(
			/requires at least one group policy/,
		);
		expect(() => makeOidc({ groups: { claim: '/groups', allowed: [] } })).toThrow(
			/1 to 200 valid group ids/,
		);
	});

	it.each([
		['oversized group list', Array.from({ length: 201 }, (_, i) => `group-${i}`)],
		['empty group id', ['']],
		['oversized group id', ['g'.repeat(257)]],
		['control character', ['admin\u007fgroup']],
		['non-string runtime value', [42] as unknown as string[]],
	])('rejects invalid direct group policies: %s', (_name, allowed) => {
		expect(() => makeOidc({ groups: { claim: '/groups', allowed } })).toThrow(
			/1 to 200 valid group ids/,
		);
	});
});

describe('normalizeEmailDomains', () => {
	it('lowercases, trims, and strips a leading @', () => {
		expect(normalizeEmailDomains(['  EXAMPLE.COM ', '@Example.ORG'])).toEqual([
			'example.com',
			'example.org',
		]);
	});

	it('drops blank entries', () => {
		expect(normalizeEmailDomains(['example.com', '', '   ', '@'])).toEqual(['example.com']);
	});

	it('returns an empty array for undefined', () => {
		expect(normalizeEmailDomains(undefined)).toEqual([]);
	});
});

describe('claimAtPointer', () => {
	it('resolves nested keys and RFC 6901 escape sequences', () => {
		expect(
			claimAtPointer(
				{ realm: { 'access/roles': { '~admins': ['admin'] } } },
				'/realm/access~1roles/~0admins',
			),
		).toEqual(['admin']);
	});

	it.each(['', 'groups', '/bad~2escape'])('rejects an invalid pointer: %s', (pointer) => {
		expect(claimAtPointer({ groups: ['admin'] }, pointer)).toBeUndefined();
	});

	it('does not traverse arrays, nulls, missing keys, or inherited properties', () => {
		expect(claimAtPointer({ groups: ['admin'] }, '/groups/0')).toBeUndefined();
		expect(claimAtPointer({ realm: null }, '/realm/groups')).toBeUndefined();
		expect(claimAtPointer({ realm: {} }, '/realm/groups')).toBeUndefined();
		const inherited = Object.create({ groups: ['admin'] }) as Record<string, unknown>;
		expect(claimAtPointer(inherited, '/groups')).toBeUndefined();
	});
});

describe('pictureUrlClaim', () => {
	it('accepts and normalizes an HTTPS URL', () => {
		expect(pictureUrlClaim('https://images.example.com/avatar.png?size=64')).toBe(
			'https://images.example.com/avatar.png?size=64',
		);
	});

	it('accepts a normalized URL at the 2048-byte boundary', () => {
		const prefix = 'https://images.example.com/';
		const value = `${prefix}${'a'.repeat(2048 - utf8ByteLength(prefix))}`;

		expect(utf8ByteLength(new URL(value).toString())).toBe(2048);
		expect(pictureUrlClaim(value)).toBe(value);
	});

	it('rejects a short Unicode input whose normalized URL exceeds the byte limit', () => {
		const value = `https://images.example.com/${'💥'.repeat(200)}`;
		const normalized = new URL(value).toString();

		expect(value.length).toBeLessThan(2048);
		expect(utf8ByteLength(normalized)).toBeGreaterThan(2048);
		expect(pictureUrlClaim(value)).toBeUndefined();
	});

	it.each([
		['HTTP', 'http://images.example.com/avatar.png'],
		['credentials', 'https://user:password@images.example.com/avatar.png'],
		['data URL', 'data:image/png;base64,AAAA'],
		['relative URL', '/avatar.png'],
		['malformed URL', 'not a URL'],
		['oversized URL', `https://images.example.com/${'a'.repeat(2049)}`],
		['non-string value', 42],
	])('rejects an unsafe or malformed picture value: %s', (_name, value) => {
		expect(pictureUrlClaim(value)).toBeUndefined();
	});
});

describe('sanitizeReturnTo', () => {
	it('accepts a same-origin absolute path', () => {
		expect(sanitizeReturnTo('/p/proj-1/notebooks/nb-1')).toBe('/p/proj-1/notebooks/nb-1');
	});

	it('keeps the query string and hash', () => {
		expect(sanitizeReturnTo('/p/proj-1?tab=files#cell-3')).toBe('/p/proj-1?tab=files#cell-3');
	});

	it('accepts the root path', () => {
		expect(sanitizeReturnTo('/')).toBe('/');
	});

	it('rejects empty, null, and undefined', () => {
		expect(sanitizeReturnTo('')).toBeNull();
		expect(sanitizeReturnTo(null)).toBeNull();
		expect(sanitizeReturnTo(undefined)).toBeNull();
	});

	it('rejects absolute URLs and bare hostnames', () => {
		expect(sanitizeReturnTo('https://evil.com/phish')).toBeNull();
		expect(sanitizeReturnTo('http://evil.com')).toBeNull();
		expect(sanitizeReturnTo('evil.com/phish')).toBeNull();
	});

	it('rejects dangerous schemes', () => {
		expect(sanitizeReturnTo('javascript:alert(1)')).toBeNull();
		expect(sanitizeReturnTo('data:text/html,x')).toBeNull();
	});

	it('rejects scheme-relative //host redirects', () => {
		expect(sanitizeReturnTo('//evil.com')).toBeNull();
		expect(sanitizeReturnTo('//evil.com/phish')).toBeNull();
	});

	it('rejects backslash variants browsers normalize to //', () => {
		expect(sanitizeReturnTo('/\\evil.com')).toBeNull();
		expect(sanitizeReturnTo('\\\\evil.com')).toBeNull();
		expect(sanitizeReturnTo('/p\\x')).toBeNull();
	});

	it('rejects paths whose dot-segment normalization escapes the origin', () => {
		expect(sanitizeReturnTo('/..//evil.com')).toBeNull();
		expect(sanitizeReturnTo('/a/..//evil.com')).toBeNull();
	});

	it('normalizes benign dot segments', () => {
		expect(sanitizeReturnTo('/a/../b')).toBe('/b');
	});

	it('rejects control characters', () => {
		expect(sanitizeReturnTo('/p\u0000x')).toBeNull();
		expect(sanitizeReturnTo('/p\nx')).toBeNull();
		expect(sanitizeReturnTo('/p\u007fx')).toBeNull();
	});

	it('rejects API paths (would loop back into the auth routes)', () => {
		expect(sanitizeReturnTo('/api/auth/login')).toBeNull();
		expect(sanitizeReturnTo('/api')).toBeNull();
		// ...but only the /api segment itself, not a lookalike prefix.
		expect(sanitizeReturnTo('/apifoo')).toBe('/apifoo');
	});

	it('rejects over-length values instead of truncating', () => {
		expect(sanitizeReturnTo(`/${'a'.repeat(600)}`)).toBeNull();
	});
});

describe('emailDomainAllowed', () => {
	const allowed = ['example.com'];

	it('accepts an email under an allowed domain (case-insensitive)', () => {
		expect(emailDomainAllowed('user@example.com', allowed)).toBe(true);
		expect(emailDomainAllowed('User@Example.COM', allowed)).toBe(true);
	});

	it('rejects an email under a different domain', () => {
		expect(emailDomainAllowed('attacker@evil.com', allowed)).toBe(false);
	});

	it('rejects a lookalike subdomain that is not an exact match', () => {
		expect(emailDomainAllowed('user@example.com.evil.com', allowed)).toBe(false);
		expect(emailDomainAllowed('user@notexample.com', allowed)).toBe(false);
	});

	it('uses the last @ so embedded @ cannot smuggle a domain', () => {
		expect(emailDomainAllowed('example.com@evil.com', allowed)).toBe(false);
		expect(emailDomainAllowed('foo@bar@example.com', allowed)).toBe(true);
	});

	it('rejects a string with no @', () => {
		expect(emailDomainAllowed('not-an-email', allowed)).toBe(false);
	});

	it('rejects everything when the allowlist is empty', () => {
		expect(emailDomainAllowed('user@example.com', [])).toBe(false);
	});
});

describe('OIDC callback error handling', () => {
	it('redirects into the SPA (not raw JSON) when the transaction cookie is missing', async () => {
		const { routes } = createOidcAuth(BASE_CONFIG);
		const res = await routes.request('/api/auth/callback?code=abc&state=xyz');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=session_expired');
	});

	it('appends auth_error with & when the post-login redirect already has a query', async () => {
		const { routes } = createOidcAuth({ ...BASE_CONFIG, postLoginRedirect: '/app?tab=home' });
		const res = await routes.request('/api/auth/callback');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/app?tab=home&auth_error=session_expired');
	});

	it('clears the in-flight transaction cookie on a callback error', async () => {
		const { routes } = createOidcAuth(BASE_CONFIG);
		const res = await routes.request('/api/auth/callback');
		const setCookie = res.headers.get('set-cookie') ?? '';
		expect(setCookie).toContain('mh_oidc_txn=');
	});
});

describe('OIDC routes', () => {
	it('redirects login with PKCE, nonce, state, and a signed transaction cookie', async () => {
		const { routes } = makeOidc({ allowedEmailDomains: ['Example.COM'] });

		const res = await routes.request('/api/auth/login');
		const location = new URL(res.headers.get('location') ?? '');
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(location.origin + location.pathname).toBe('https://issuer.example.com/authorize');
		expect(location.searchParams.get('response_type')).toBe('code');
		expect(location.searchParams.get('client_id')).toBe('client-id');
		expect(location.searchParams.get('redirect_uri')).toBe(
			'https://hub.example.com/api/auth/callback',
		);
		expect(location.searchParams.get('scope')).toBe('openid email profile');
		expect(location.searchParams.get('state')).toBe('state-1');
		expect(location.searchParams.get('nonce')).toBe('nonce-1');
		expect(location.searchParams.get('code_challenge')).toBe('challenge-1');
		expect(location.searchParams.get('code_challenge_method')).toBe('S256');
		expect(location.searchParams.get('hd')).toBe('example.com');
		expect(location.searchParams.get('prompt')).toBe('select_account');
		expect(setCookie).toContain(`${TXN_COOKIE}=`);
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
	});

	it('re-discovers after a failed discovery instead of caching the rejection', async () => {
		oauthMock.discoveryRequest.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND issuer'));
		const { routes } = makeOidc();

		const first = await routes.request('/api/auth/login');
		expect(first.status).toBe(500);

		// Same adapter instance: the retry must re-discover, not replay the rejection.
		const second = await routes.request('/api/auth/login');
		expect(second.status).toBe(302);
		expect(oauthMock.discoveryRequest).toHaveBeenCalledTimes(2);
	});

	it('defaults prompt to select_account, forcing the account chooser', async () => {
		const { routes } = makeOidc({});

		const res = await routes.request('/api/auth/login');
		const location = new URL(res.headers.get('location') ?? '');

		expect(location.searchParams.get('prompt')).toBe('select_account');
	});

	it('lets the configured prompt override the default', async () => {
		const { routes } = makeOidc({ prompt: 'consent' });

		const res = await routes.request('/api/auth/login');
		const location = new URL(res.headers.get('location') ?? '');

		expect(location.searchParams.get('prompt')).toBe('consent');
	});

	it('does not include an hd hint when multiple domains are allowed', async () => {
		const { routes } = makeOidc({ allowedEmailDomains: ['example.com', 'example.org'] });

		const res = await routes.request('/api/auth/login');
		const location = new URL(res.headers.get('location') ?? '');

		expect(location.searchParams.has('hd')).toBe(false);
	});

	it('sets a session cookie after a successful callback', async () => {
		const { authenticator, routes } = makeOidc({ postLoginRedirect: '/app' });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/app');
		expect(oauthMock.validateAuthResponse).toHaveBeenCalledWith(
			expect.any(Object),
			{ client_id: 'client-id' },
			expect.any(URL),
			'state-1',
		);
		expect(oauthMock.authorizationCodeGrantRequest).toHaveBeenCalledWith(
			expect.any(Object),
			{ client_id: 'client-id' },
			expect.any(Object),
			expect.any(URLSearchParams),
			BASE_CONFIG.redirectUri,
			'verifier-1',
		);
		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		await expect(
			authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1])),
		).resolves.toEqual({
			id: 'user-1',
			email: 'user@example.com',
			name: 'Ada Lovelace',
		});
		expect(res.headers.get('set-cookie') ?? '').toContain(`${TXN_COOKIE}=`);
	});

	it('sets the complete browser-cookie security policy and configured lifetime', async () => {
		const { routes } = makeOidc({ sessionTtlSeconds: 900 });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(setCookie).toContain(`${SESSION_COOKIE}=`);
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
		expect(setCookie).toContain('SameSite=Lax');
		expect(setCookie).toContain('Path=/');
		expect(setCookie).toContain('Max-Age=900');
	});

	it('defaults group-derived sessions to a one-hour deprovisioning bound', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: ['hub-users'],
		});
		const { routes } = makeOidc({ groups: { claim: '/groups', allowed: ['hub-users'] } });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=3600');
	});

	it('returns to the redirect_url deep link after a successful callback', async () => {
		const { routes } = makeOidc({ postLoginRedirect: '/app' });
		const deepLink = '/p/proj-1/notebooks/nb-1?tab=files#cell-3';
		const txn = await beginOidcTransaction(
			routes,
			`/api/auth/login?redirect_url=${encodeURIComponent(deepLink)}`,
		);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe(deepLink);
		expect(res.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);
	});

	it('rejects a client redirect_url under /api and uses the configured redirect', async () => {
		const { routes } = makeOidc({ postLoginRedirect: '/api/marimohub' });
		const txn = await beginOidcTransaction(
			routes,
			`/api/auth/login?redirect_url=${encodeURIComponent('/api/auth/login')}`,
		);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/api/marimohub');
	});

	it.each(['https://evil.com/phish', '//evil.com', '/\\evil.com', '/..//evil.com'])(
		'ignores a hostile redirect_url (%s) and falls back to the post-login redirect',
		async (hostile) => {
			const { routes } = makeOidc();
			const txn = await beginOidcTransaction(
				routes,
				`/api/auth/login?redirect_url=${encodeURIComponent(hostile)}`,
			);

			const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
				headers: { cookie: txn },
			});

			expect(res.status).toBe(302);
			expect(res.headers.get('location')).toBe('/');
		},
	);

	it('does not leak redirect_url to the identity provider', async () => {
		const { routes } = makeOidc();

		const res = await routes.request('/api/auth/login?redirect_url=%2Fp%2Fproj-1');
		const location = new URL(res.headers.get('location') ?? '');

		expect(location.origin + location.pathname).toBe('https://issuer.example.com/authorize');
		expect(location.searchParams.has('redirect_url')).toBe(false);
		expect(location.searchParams.get('state')).toBe('state-1');
	});

	it('carries auth_error back to the deep link when the callback rejects the user', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.org',
			email_verified: true,
		});
		const { routes } = makeOidc({ allowedEmailDomains: ['example.com'] });
		const txn = await beginOidcTransaction(routes, '/api/auth/login?redirect_url=%2Fp%2Fproj-1');

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/p/proj-1?auth_error=domain_not_allowed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('appends auth_error with & when the deep link already has a query', async () => {
		oauthMock.validateAuthResponse.mockImplementation(() => {
			throw new Error('provider rejected the callback');
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(
			routes,
			`/api/auth/login?redirect_url=${encodeURIComponent('/p/proj-1?tab=files')}`,
		);

		const res = await routes.request('/api/auth/callback?error=access_denied&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/p/proj-1?tab=files&auth_error=auth_failed');
	});

	it.each([
		['/p/proj-1#cell-3', '/p/proj-1?auth_error=auth_failed#cell-3'],
		['/p/proj-1?tab=files#cell-3', '/p/proj-1?tab=files&auth_error=auth_failed#cell-3'],
	])('inserts auth_error into the query, before the fragment (%s)', async (deepLink, expected) => {
		oauthMock.validateAuthResponse.mockImplementation(() => {
			throw new Error('provider rejected the callback');
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(
			routes,
			`/api/auth/login?redirect_url=${encodeURIComponent(deepLink)}`,
		);

		const res = await routes.request('/api/auth/callback?error=access_denied&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe(expected);
	});

	it('rejects a restricted-domain callback when the email is unverified', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: false,
		});
		const { routes } = makeOidc({ allowedEmailDomains: ['example.com'] });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('rejects an unverified email even without a domain allowlist', async () => {
		// Email-invite membership matches on the login email, so a provider-declared
		// unverified (attacker-chosen) address must never mint a session.
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'victim@corp.com',
			email_verified: false,
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('rejects a provider that omits email_verified by default', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('allows missing email_verified only with the trusted-issuer policy', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
		});
		const { routes } = makeOidc({ emailVerification: 'trusted-issuer' });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);
	});

	it('allows an omitted ID-token email_verified with a domain allowlist under trusted-issuer', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
		});
		const { routes } = makeOidc({
			emailVerification: 'trusted-issuer',
			allowedEmailDomains: ['example.com'],
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);
	});

	it('rejects an omitted email_verified when the email domain is not allowed', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.org',
		});
		const { routes } = makeOidc({
			emailVerification: 'trusted-issuer',
			allowedEmailDomains: ['example.com'],
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=domain_not_allowed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('allows an omitted UserInfo email_verified with a domain allowlist under trusted-issuer', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'user-1',
			email: 'user@example.com',
		});
		const { routes } = makeOidc({
			emailVerification: 'trusted-issuer',
			allowedEmailDomains: ['example.com'],
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);
	});

	it('rejects ID-token email_verified false when UserInfo omits the claim', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: false,
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'user-1',
			email: 'user@example.com',
		});
		const { routes } = makeOidc({
			emailVerification: 'trusted-issuer',
			allowedEmailDomains: ['example.com'],
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('rejects explicit false with a domain allowlist under trusted-issuer', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: false,
		});
		const { routes } = makeOidc({
			emailVerification: 'trusted-issuer',
			allowedEmailDomains: ['example.com'],
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it.each([
		['string false', 'false'],
		['null', null],
		['zero', 0],
		['positive number', 1],
		['fractional number', 0.5],
		['object', {}],
	])(
		'rejects a present malformed ID-token email_verified under trusted-issuer: %s',
		async (_label, emailVerified) => {
			oauthMock.getValidatedIdTokenClaims.mockReturnValue({
				sub: 'user-1',
				email: 'user@example.com',
				email_verified: emailVerified,
			});
			const { routes } = makeOidc({ emailVerification: 'trusted-issuer' });
			const txn = await beginOidcTransaction(routes);

			const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
				headers: { cookie: txn },
			});

			expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
			expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
		},
	);

	it.each([
		['string false', 'false'],
		['null', null],
		['zero', 0],
		['positive number', 1],
		['fractional number', 0.5],
		['object', {}],
	])(
		'rejects a present malformed UserInfo email_verified under trusted-issuer: %s',
		async (_label, emailVerified) => {
			oauthMock.processDiscoveryResponse.mockReturnValue({
				issuer: 'https://issuer.example.com',
				authorization_endpoint: 'https://issuer.example.com/authorize',
				token_endpoint: 'https://issuer.example.com/token',
				jwks_uri: 'https://issuer.example.com/jwks',
				userinfo_endpoint: 'https://issuer.example.com/userinfo',
			});
			oauthMock.processUserInfoResponse.mockResolvedValue({
				sub: 'user-1',
				email: 'user@example.com',
				email_verified: emailVerified,
			});
			const { routes } = makeOidc({ emailVerification: 'trusted-issuer' });
			const txn = await beginOidcTransaction(routes);

			const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
				headers: { cookie: txn },
			});

			expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
			expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
		},
	);

	it('rejects a restricted-domain callback when the email domain is not allowed', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.org',
			email_verified: true,
		});
		const { routes } = makeOidc({ allowedEmailDomains: ['example.com'] });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=domain_not_allowed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('redirects auth failures back to the app', async () => {
		oauthMock.validateAuthResponse.mockImplementation(() => {
			throw new Error('provider rejected the callback');
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?error=access_denied&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('uses validated UserInfo claims and binds them to the ID-token subject', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'user-1',
			email: 'fresh@example.com',
			email_verified: true,
			name: 'Fresh Name',
			picture: 'https://images.example.com/ada.png',
		});
		const { authenticator, routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(oauthMock.userInfoRequest).toHaveBeenCalledWith(
			expect.any(Object),
			{ client_id: 'client-id' },
			'access-token',
		);
		expect(oauthMock.processUserInfoResponse).toHaveBeenCalledWith(
			expect.any(Object),
			{ client_id: 'client-id' },
			'user-1',
			expect.any(Response),
		);
		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		await expect(
			authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1])),
		).resolves.toEqual({
			id: 'user-1',
			email: 'fresh@example.com',
			name: 'Fresh Name',
			pictureUrl: 'https://images.example.com/ada.png',
		});
	});

	it('rejects a UserInfo response for a different subject', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'attacker',
			email: 'attacker@example.com',
			email_verified: true,
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('fails closed when the advertised UserInfo endpoint cannot be validated', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.processUserInfoResponse.mockRejectedValue(new Error('invalid UserInfo signature'));
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('does not combine a UserInfo email with ID-token verification', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'verified@example.com',
			email_verified: true,
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'user-1',
			email: 'unverified@example.com',
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('uses the coherent ID-token email pair when UserInfo omits email', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'user-1',
			name: 'UserInfo Name',
		});
		const { authenticator, routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});
		const sessionCookie = cookiePair(res, SESSION_COOKIE);

		await expect(
			authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1])),
		).resolves.toMatchObject({
			email: 'user@example.com',
			name: 'UserInfo Name',
		});
	});

	it('maps exact nested provider groups to bounded internal entitlements', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			realm_access: { roles: ['hub-users', 'hub-admins'] },
		});
		const { authenticator, routes } = makeOidc({
			groups: {
				claim: '/realm_access/roles',
				allowed: ['hub-users'],
				superAdmin: ['hub-admins'],
				defaultRoles: { editor: ['hub-editors'], manager: ['hub-admins'] },
			},
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		await expect(
			authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1])),
		).resolves.toMatchObject({
			entitlements: ['super-admin', 'default-role:manager'],
		});
	});

	it('maps a manager-only group without granting super-admin', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: ['hub-users', 'hub-managers'],
		});
		const { authenticator, routes } = makeOidc({
			groups: {
				claim: '/groups',
				allowed: ['hub-users'],
				defaultRoles: { manager: ['hub-managers'] },
			},
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});
		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		const user = await authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1]));

		expect(user?.entitlements).toEqual(['default-role:manager']);
	});

	it('retains the group-authorization expiry when the policy maps no role', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: ['hub-users'],
		});
		const { authenticator, routes } = makeOidc({
			groups: { claim: '/groups', allowed: ['hub-users'] },
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});
		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		const user = await authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1]));

		expect(user).not.toHaveProperty('entitlements');
		expect(Date.parse(user!.entitlementsExpiresAt!)).toBeGreaterThan(Date.now() + 3500_000);
	});

	it('fails closed when no configured login group matches', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: ['other'],
		});
		const { routes } = makeOidc({ groups: { claim: '/groups', allowed: ['hub-users'] } });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=group_not_allowed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('fails closed when a required login-group claim is missing', async () => {
		const { routes } = makeOidc({ groups: { claim: '/groups', allowed: ['hub-users'] } });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=group_not_allowed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it.each([
		{ groups: 'admins' },
		{ groups: Array.from({ length: 201 }, (_, i) => `group-${i}`) },
		{ groups: ['ok', 42] },
		{ groups: [''] },
		{ groups: ['g'.repeat(257)] },
		{ groups: ['admin\u007fgroup'] },
	])('rejects malformed or oversized group claims', async (extraClaims) => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			...extraClaims,
		});
		const { routes } = makeOidc({ groups: { claim: '/groups', superAdmin: ['admins'] } });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
	});

	it('honors a lower configured group-count limit at its exact boundary', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: ['hub-users', 'hub-editors'],
		});
		const accepted = makeOidc({
			groups: { claim: '/groups', maxGroups: 2, allowed: ['hub-users'] },
		});
		const acceptedTxn = await beginOidcTransaction(accepted.routes);
		const acceptedResponse = await accepted.routes.request(
			'/api/auth/callback?code=abc&state=state-1',
			{ headers: { cookie: acceptedTxn } },
		);
		expect(acceptedResponse.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);

		const rejected = makeOidc({
			groups: { claim: '/groups', maxGroups: 1, allowed: ['hub-users'] },
		});
		const rejectedTxn = await beginOidcTransaction(rejected.routes);
		const rejectedResponse = await rejected.routes.request(
			'/api/auth/callback?code=abc&state=state-1',
			{ headers: { cookie: rejectedTxn } },
		);
		expect(rejectedResponse.headers.get('location')).toBe('/?auth_error=auth_failed');
	});

	it('does not fall back to ID-token groups when UserInfo contains malformed groups', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: ['hub-users'],
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: 'hub-users',
		});
		const { routes } = makeOidc({ groups: { claim: '/groups', allowed: ['hub-users'] } });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('drops unsafe profile-picture URLs instead of persisting them', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			picture: 'http://attacker.example/avatar.png',
		});
		const { authenticator, routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);
		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		const user = await authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1]));
		expect(user).not.toHaveProperty('pictureUrl');
	});

	it('keeps a maximum-claims cookie below browser limits by dropping the picture', async () => {
		const picturePrefix = 'https://images.example.com/';
		const picture = `${picturePrefix}${'a'.repeat(2048 - utf8ByteLength(picturePrefix))}`;
		const subject = 's'.repeat(512);
		const email = `${'e'.repeat(308)}@example.com`;
		const name = 'N'.repeat(200);
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: subject,
			email,
			email_verified: true,
			name,
			picture,
			groups: ['hub-users'],
		});
		const { authenticator, routes } = makeOidc({
			groups: {
				claim: '/groups',
				allowed: ['hub-users'],
				superAdmin: ['hub-users'],
				defaultRoles: { manager: ['hub-users'] },
			},
		});
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		const token = sessionCookie.slice(`${SESSION_COOKIE}=`.length);
		const sessionSetCookie = res.headers
			.getSetCookie()
			.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
		expect(utf8ByteLength(token)).toBeLessThanOrEqual(3800);
		expect(utf8ByteLength(sessionCookie)).toBeLessThan(4096);
		expect(utf8ByteLength(sessionSetCookie!)).toBeLessThan(4096);
		await expect(authenticator.authenticate(requestWithCookie(token))).resolves.toMatchObject({
			id: subject,
			email,
			name,
			entitlements: ['super-admin', 'default-role:manager'],
		});
		expect(await authenticator.authenticate(requestWithCookie(token))).not.toHaveProperty(
			'pictureUrl',
		);
	});

	it('drops the name after the picture when the picture-only fallback is still too large', async () => {
		const subject = 's'.repeat(512);
		const email = `${'e'.repeat(308)}@example.com`;
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: subject,
			email,
			email_verified: true,
			name: 'N'.repeat(200),
			picture: 'https://images.example.com/avatar.png',
		});
		const { authenticator, routes } = makeOidc({ clientId: 'c'.repeat(1800) });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		const token = sessionCookie.slice(`${SESSION_COOKIE}=`.length);
		expect(utf8ByteLength(token)).toBeLessThanOrEqual(3800);
		const user = await authenticator.authenticate(requestWithCookie(token));
		expect(user).not.toHaveProperty('pictureUrl');
		expect(user).not.toHaveProperty('name');
	});

	it.each([
		['without optional profile claims', {}],
		[
			'after removing optional profile claims',
			{ name: 'N'.repeat(200), picture: 'https://images.example.com/avatar.png' },
		],
	])('fails closed when required claims exceed the JWT budget %s', async (_label, profile) => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 's'.repeat(512),
			email: `${'e'.repeat(308)}@example.com`,
			email_verified: true,
			...profile,
		});
		const { routes } = makeOidc({ clientId: 'c'.repeat(1900) });
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('logs out through the issuer end-session endpoint when one is discovered', async () => {
		const { routes } = makeOidc();

		const res = await routes.request('/api/auth/logout');
		const location = new URL(res.headers.get('location') ?? '');

		expect(res.status).toBe(302);
		expect(location.origin + location.pathname).toBe('https://issuer.example.com/logout');
		expect(location.searchParams.get('client_id')).toBe('client-id');
		expect(res.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);
	});

	it('falls back to the post-login redirect when no end-session endpoint exists', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
		});
		const { routes } = makeOidc({ postLoginRedirect: '/signed-out' });

		const res = await routes.request('/api/auth/logout');

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/signed-out');
	});
});

describe('OIDC authenticate (cookie session)', () => {
	it('accepts a valid signed session cookie', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 'user@example.com' });
		const user = await auth.authenticate(requestWithCookie(token));
		expect(user).toEqual({ id: 'user-1', email: 'user@example.com' });
	});

	it('surfaces the display name from the session cookie when present', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 'user@example.com', name: 'Ada L.' });
		const user = await auth.authenticate(requestWithCookie(token));
		expect(user).toEqual({ id: 'user-1', email: 'user@example.com', name: 'Ada L.' });
	});

	it('trims the display name and drops control characters', async () => {
		const auth = makeAuthenticator();
		const trimmed = await signSession({
			sub: 'user-1',
			email: 'user@example.com',
			name: '  Ada L.  ',
		});
		const controlled = await signSession({
			sub: 'user-1',
			email: 'user@example.com',
			name: 'Ada\nAdmin',
		});

		expect(await auth.authenticate(requestWithCookie(trimmed))).toMatchObject({ name: 'Ada L.' });
		expect(await auth.authenticate(requestWithCookie(controlled))).not.toHaveProperty('name');
	});

	it('accepts only safe profile pictures from a session payload', async () => {
		const auth = makeAuthenticator();
		const safe = await signSession({
			sub: 'user-1',
			email: 'user@example.com',
			pictureUrl: 'https://images.example.com/ada.png',
		});
		const unsafe = await signSession({
			sub: 'user-1',
			email: 'user@example.com',
			pictureUrl: 'http://images.example.com/ada.png',
		});

		expect(await auth.authenticate(requestWithCookie(safe))).toMatchObject({
			pictureUrl: 'https://images.example.com/ada.png',
		});
		expect(await auth.authenticate(requestWithCookie(unsafe))).not.toHaveProperty('pictureUrl');
	});

	it('retains only recognized authorization entitlements from a session payload', async () => {
		const auth = makeAuthenticator();
		const expiration = Math.floor(Date.now() / 1000) + 3600;
		const token = await signSession({
			sub: 'user-1',
			email: 'user@example.com',
			entitlements: ['super-admin', 'default-role:editor', 'provider-admin', 42],
			expirationTime: expiration,
		});

		expect(await auth.authenticate(requestWithCookie(token))).toMatchObject({
			entitlements: ['super-admin', 'default-role:editor'],
			entitlementsExpiresAt: new Date(expiration * 1000).toISOString(),
		});
	});

	it.each([undefined, 'super-admin', { role: 'super-admin' }])(
		'does not accept a non-array entitlement payload: %j',
		async (entitlements) => {
			const auth = makeAuthenticator();
			const token = await signSession({
				sub: 'user-1',
				email: 'user@example.com',
				entitlements,
			});

			expect(await auth.authenticate(requestWithCookie(token))).not.toHaveProperty('entitlements');
		},
	);

	it('leaves name undefined when the cookie carries no (or a non-string) name', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 'user@example.com', name: 42 });
		const user = await auth.authenticate(requestWithCookie(token));
		expect(user?.name).toBeUndefined();
	});

	it('drops an oversized display name from a valid session', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({
			sub: 'user-1',
			email: 'user@example.com',
			name: 'a'.repeat(201),
		});
		expect(await auth.authenticate(requestWithCookie(token))).toEqual({
			id: 'user-1',
			email: 'user@example.com',
		});
	});

	it('rejects a cookie signed with the wrong secret (tampered)', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({
			secret: 'a-different-secret-also-32-bytes-long!!',
			sub: 'user-1',
			email: 'user@example.com',
		});
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it('rejects a cookie whose signature was mangled', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 'user@example.com' });
		// Flip the FIRST character of the signature segment. (The final base64url
		// char only encodes the high 4 bits of the last byte, so flipping it between
		// 'A'/'B' can decode to identical bytes and leave the signature valid — a
		// flaky check. The first char carries all 6 bits, so this is deterministic.)
		const [header, payload, sig] = token.split('.');
		const mangledSig = (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1);
		const mangled = `${header}.${payload}.${mangledSig}`;
		expect(await auth.authenticate(requestWithCookie(mangled))).toBeNull();
	});

	it('rejects an expired cookie', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({
			sub: 'user-1',
			email: 'user@example.com',
			expirationTime: Math.floor(Date.now() / 1000) - 60,
		});
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it.each([
		{ issuer: 'https://other-issuer.example.com/' },
		{ audience: 'other-client' },
		{ typ: 'mh-oidc-txn+jwt' },
	])('rejects a session outside its issuer, audience, or token type', async (claims) => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 'user@example.com', ...claims });
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it('rejects a cookie missing the email claim', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1' });
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it('rejects a cookie with a non-string email claim', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 12345 });
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it.each([
		'',
		'user',
		'@example.com',
		'user@',
		'user @example.com',
		'user@example.com\nadmin@example.com',
		`${'a'.repeat(310)}@example.com`,
	])('rejects a malformed session email: %j', async (email) => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email });
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it('rejects a cookie missing the sub claim', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ email: 'user@example.com' });
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it.each(['', 'user\nadmin', 'u'.repeat(513)])(
		'rejects a malformed session subject: %j',
		async (sub) => {
			const auth = makeAuthenticator();
			const token = await signSession({ sub, email: 'user@example.com' });
			expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
		},
	);

	it('returns null when no cookie header is present', async () => {
		const auth = makeAuthenticator();
		expect(await auth.authenticate(new Request('http://x'))).toBeNull();
	});

	it('returns null for a malformed percent-encoded cookie', async () => {
		const auth = makeAuthenticator();
		expect(
			await auth.authenticate(
				new Request('http://x', { headers: { cookie: `${SESSION_COOKIE}=%not-encoded` } }),
			),
		).toBeNull();
	});

	it('exposes the local logout route so the HTTP-only cookie can be cleared', () => {
		expect(makeAuthenticator().logoutUrl?.()).toBe('/api/auth/logout');
	});

	it('rejects an unsigned alg:none session cookie', async () => {
		const auth = makeAuthenticator();
		const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
		const header = b64url({ alg: 'none', typ: 'JWT' });
		const payload = b64url({
			sub: 'user-1',
			email: 'attacker@example.com',
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		// alg:none carries an empty signature segment.
		const unsigned = `${header}.${payload}.`;
		expect(await auth.authenticate(requestWithCookie(unsigned))).toBeNull();
	});
});

describe('OIDC callback integrity (security)', () => {
	/** Mint a transaction cookie the way `/api/auth/login` does, with a chosen secret. */
	async function signTxn(opts: {
		secret: string;
		verifier?: unknown;
		includeVerifier?: boolean;
		state?: string;
		returnTo?: string;
		issuer?: string;
		audience?: string;
		typ?: string;
		expirationTime?: string | number;
	}) {
		const secret = new TextEncoder().encode(opts.secret);
		const payload: Record<string, unknown> = {
			state: opts.state ?? 'state-1',
			nonce: 'nonce-1',
			returnTo: opts.returnTo ?? null,
		};
		if (opts.includeVerifier !== false) payload.verifier = opts.verifier ?? 'verifier-1';
		return new SignJWT(payload)
			.setProtectedHeader({ alg: 'HS256', typ: opts.typ ?? 'mh-oidc-txn+jwt' })
			.setIssuer(opts.issuer ?? 'https://issuer.example.com/')
			.setAudience(opts.audience ?? 'client-id')
			.setIssuedAt()
			.setExpirationTime(opts.expirationTime ?? '10m')
			.sign(secret);
	}

	// CSRF/PKCE integrity: a txn cookie forged/signed with a foreign secret must not
	// be trusted — its verifier+state would let an attacker complete another user's
	// authorization-code exchange.
	it('redirects session_expired when the txn cookie is signed with a different secret', async () => {
		const { routes } = makeOidc();
		const forgedTxn = await signTxn({ secret: 'a-totally-different-secret-32-bytes!!' });

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: `${TXN_COOKIE}=${forgedTxn}` },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=session_expired');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it.each([
		['wrong issuer', { issuer: 'https://other-issuer.example.com/' }],
		['wrong audience', { audience: 'other-client' }],
		['wrong token type', { typ: 'mh-session+jwt' }],
		['expired token', { expirationTime: Math.floor(Date.now() / 1000) - 60 }],
		['missing verifier', { includeVerifier: false }],
		['non-string verifier', { verifier: 42 }],
	])('rejects an invalid transaction cookie: %s', async (_name, overrides) => {
		const { routes } = makeOidc();
		const txn = await signTxn({ secret: SESSION_SECRET, ...overrides });

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: `${TXN_COOKIE}=${txn}` },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=session_expired');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	// Defense in depth: the login route already sanitizes before signing, but a
	// hostile returnTo inside a validly-signed txn cookie (e.g. minted before a
	// sanitizer fix) must still be re-sanitized at redirect time.
	it('re-sanitizes returnTo from the transaction cookie before redirecting', async () => {
		const { routes } = makeOidc();
		const txn = await signTxn({ secret: SESSION_SECRET, returnTo: 'https://evil.com/phish' });

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: `${TXN_COOKIE}=${txn}` },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/');
	});

	it.each([undefined, null, 42, '', 'user\nadmin', 'u'.repeat(513)])(
		'fails auth_failed for an invalid ID-token subject: %j',
		async (sub) => {
			oauthMock.getValidatedIdTokenClaims.mockReturnValue({
				sub,
				email: 'user@example.com',
				email_verified: true,
			});
			const { routes } = makeOidc();
			const txn = await beginOidcTransaction(routes);

			const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
				headers: { cookie: txn },
			});

			expect(res.status).toBe(302);
			expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
			expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
		},
	);

	it('fails auth_failed when the validated token has no claims', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue(undefined);
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('fails auth_failed when the ID token has a sub but no email', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({ sub: 'user-1', email_verified: true });
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it('fails auth_failed when the ID token email is a non-string', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 12345,
			email_verified: true,
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it.each([
		'',
		'user',
		'@example.com',
		'user@',
		'user @example.com',
		'user@example.com\nadmin@example.com',
		`${'a'.repeat(310)}@example.com`,
	])('fails auth_failed for a malformed ID-token email: %j', async (email) => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email,
			email_verified: true,
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
	});

	it.each(['true', 1, null])(
		'rejects a non-boolean email_verified claim under strict policy: %j',
		async (emailVerified) => {
			oauthMock.getValidatedIdTokenClaims.mockReturnValue({
				sub: 'user-1',
				email: 'user@example.com',
				email_verified: emailVerified,
			});
			const { routes } = makeOidc();
			const txn = await beginOidcTransaction(routes);

			const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
				headers: { cookie: txn },
			});

			expect(res.headers.get('location')).toBe('/?auth_error=email_not_verified');
			expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
		},
	);
});

describe('OIDC login discovery failure', () => {
	it('returns 500 OIDC_ERROR when the discovered AS has no authorization_endpoint', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			// authorization_endpoint intentionally omitted
		});
		const { routes } = makeOidc();

		const res = await routes.request('/api/auth/login');

		expect(res.status).toBe(500);
		const body = (await res.json()) as { success: boolean; error: { code: string } };
		expect(body.success).toBe(false);
		expect(body.error.code).toBe('OIDC_ERROR');
	});

	it.each([
		['HTTP', 'http://issuer.example.com/authorize'],
		['credentials', 'https://user:password@issuer.example.com/authorize'],
		['non-HTTP(S)', 'javascript:alert(1)'],
	])('rejects a discovered %s authorization endpoint', async (_label, endpoint) => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: endpoint,
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
		});
		const { routes } = makeOidc();

		const res = await routes.request('/api/auth/login');

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({
			success: false,
			error: { code: 'OIDC_ERROR', message: 'Invalid authorization endpoint' },
		});
		expect(res.headers.get('location')).toBeNull();
	});

	it.each([
		['HTTP', 'http://issuer.example.com/logout'],
		['credentials', 'https://user:password@issuer.example.com/logout'],
		['non-HTTP(S)', 'data:text/plain,logout'],
	])('does not redirect to a discovered %s logout endpoint', async (_label, endpoint) => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			end_session_endpoint: endpoint,
		});
		const { routes } = makeOidc({ postLoginRedirect: '/signed-out' });

		const res = await routes.request('/api/auth/logout');

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/signed-out');
	});
});

describe('operational logging for swallowed verification failures', () => {
	const makeSpy = () => vi.spyOn(console, 'error').mockImplementation(() => {});
	let spy: ReturnType<typeof makeSpy>;
	beforeEach(() => {
		spy = makeSpy();
	});
	// Guaranteed even when an assertion throws, so a silenced console.error can
	// never leak into later tests in this file.
	afterEach(() => {
		spy.mockRestore();
	});
	const loggedEvents = () =>
		spy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('oidc_'));

	it('logs a session cookie that fails verification, without echoing the token', async () => {
		const forged = await signSession({ sub: 'user-1', email: 'a@b.co', secret: 'x'.repeat(32) });

		await expect(makeAuthenticator().authenticate(requestWithCookie(forged))).resolves.toBeNull();

		const lines = loggedEvents();
		expect(lines.some((line) => line.includes('oidc_session_verify_failed'))).toBe(true);
		expect(lines.some((line) => line.includes(forged))).toBe(false);
	});

	it('does not log routine session expiry', async () => {
		const expired = await signSession({
			sub: 'user-1',
			email: 'a@b.co',
			expirationTime: Math.floor(Date.now() / 1000) - 60,
		});

		await expect(makeAuthenticator().authenticate(requestWithCookie(expired))).resolves.toBeNull();

		expect(loggedEvents()).toEqual([]);
	});

	it('logs an unverifiable transaction cookie on the callback path', async () => {
		const { routes } = createOidcAuth(BASE_CONFIG);

		const res = await routes.request('/api/auth/callback?code=abc&state=xyz', {
			headers: { cookie: `${TXN_COOKIE}=garbage` },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=session_expired');
		expect(loggedEvents().some((line) => line.includes('oidc_txn_cookie_invalid'))).toBe(true);
	});

	it('does not log an expired transaction cookie — a stale redirect is routine', async () => {
		const { routes } = createOidcAuth(BASE_CONFIG);
		const expiredTxn = await signSession({
			typ: 'mh-oidc-txn+jwt',
			expirationTime: Math.floor(Date.now() / 1000) - 60,
		});

		const res = await routes.request('/api/auth/callback?code=abc&state=xyz', {
			headers: { cookie: `${TXN_COOKIE}=${expiredTxn}` },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=session_expired');
		expect(loggedEvents()).toEqual([]);
	});

	it('does not log a merely missing transaction cookie', async () => {
		const { routes } = createOidcAuth(BASE_CONFIG);

		const res = await routes.request('/api/auth/callback?code=abc&state=xyz');

		expect(res.status).toBe(302);
		expect(loggedEvents()).toEqual([]);
	});

	it('does not log a user declining consent at the IdP', async () => {
		const { routes } = createOidcAuth(BASE_CONFIG);
		const txnCookie = await beginOidcTransaction(routes);
		oauthMock.validateAuthResponse.mockImplementation(() => {
			throw Object.assign(new Error('authorization response error'), {
				name: 'AuthorizationResponseError',
				error: 'access_denied',
			});
		});

		const res = await routes.request('/api/auth/callback?error=access_denied&state=state-1', {
			headers: { cookie: txnCookie },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toContain('auth_error=auth_failed');
		expect(loggedEvents()).toEqual([]);
	});

	it('still logs a genuine token-exchange failure', async () => {
		const { routes } = createOidcAuth(BASE_CONFIG);
		const txnCookie = await beginOidcTransaction(routes);
		oauthMock.validateAuthResponse.mockImplementation(() => {
			throw new Error('exchange blew up');
		});

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txnCookie },
		});

		expect(res.status).toBe(302);
		expect(loggedEvents().some((line) => line.includes('oidc_callback_exchange_failed'))).toBe(
			true,
		);
	});
});

describe('OIDC login policy', () => {
	const makeWarnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
	let warnSpy: ReturnType<typeof makeWarnSpy>;
	beforeEach(() => {
		warnSpy = makeWarnSpy();
	});
	afterEach(() => {
		warnSpy.mockRestore();
		vi.useRealTimers();
	});
	const warnedLines = () => warnSpy.mock.calls.map(([line]) => String(line));

	const allowEditor = () => ({
		policy: {
			evaluate: () => ({ decision: 'allow', entitlements: ['default-role:editor'] }) as const,
		},
	});

	async function callback(routes: ReturnType<typeof createOidcAuth>['routes']) {
		const txn = await beginOidcTransaction(routes);
		return routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});
	}

	function sessionPayload(res: Response): Record<string, unknown> {
		const token = cookiePair(res, SESSION_COOKIE).split('=')[1];
		return JSON.parse(
			Buffer.from(decodeURIComponent(token).split('.')[1], 'base64url').toString(),
		) as Record<string, unknown>;
	}

	it('rejects a login policy combined with a group policy', () => {
		expect(() =>
			makeOidc({
				groups: { claim: '/groups', allowed: ['hub-users'] },
				loginPolicy: allowEditor(),
			}),
		).toThrow(/mutually exclusive/);
	});

	it.each([0, 31, 2.5])('rejects login-policy timeout %s', (timeoutSeconds) => {
		expect(() => makeOidc({ loginPolicy: { ...allowEditor(), timeoutSeconds } })).toThrow(
			/login-policy timeout/,
		);
	});

	it('caps login-policy sessions at one hour', () => {
		expect(() => makeOidc({ loginPolicy: allowEditor(), sessionTtlSeconds: 3601 })).toThrow(
			/group- or policy-derived access/,
		);
	});

	it('passes the host identity and separate frozen claim objects to the policy', async () => {
		oauthMock.processDiscoveryResponse.mockReturnValue({
			issuer: 'https://issuer.example.com',
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
			jwks_uri: 'https://issuer.example.com/jwks',
			userinfo_endpoint: 'https://issuer.example.com/userinfo',
		});
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			user_attributes: { department: 'orgcode1' },
		});
		oauthMock.processUserInfoResponse.mockResolvedValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			groups: ['hub-users'],
		});
		let seen: Parameters<OidcLoginPolicy['evaluate']>[0] | undefined;
		const { routes } = makeOidc({
			loginPolicy: {
				policy: {
					evaluate(input) {
						seen = input;
						return { decision: 'allow' };
					},
				},
			},
		});

		const res = await callback(routes);

		expect(res.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);
		expect(seen?.identity).toEqual({ id: 'user-1', email: 'user@example.com' });
		expect(seen?.idTokenClaims).toMatchObject({
			user_attributes: { department: 'orgcode1' },
		});
		expect(seen?.userInfoClaims).toMatchObject({ groups: ['hub-users'] });
		// Separate objects: userinfo values are not merged into the ID-token claims.
		expect(seen?.idTokenClaims).not.toHaveProperty('groups');
		expect(Object.isFrozen(seen?.idTokenClaims)).toBe(true);
		expect(Object.isFrozen(seen?.userInfoClaims)).toBe(true);
	});

	it('omits userInfoClaims when the provider has no userinfo endpoint', async () => {
		let seen: Parameters<OidcLoginPolicy['evaluate']>[0] | undefined;
		const { routes } = makeOidc({
			loginPolicy: {
				policy: {
					evaluate(input) {
						seen = input;
						return { decision: 'allow' };
					},
				},
			},
		});

		await callback(routes);

		expect(seen && 'userInfoClaims' in seen).toBe(false);
	});

	it('signs recognized entitlements into a session bounded to one hour', async () => {
		const { authenticator, routes } = makeOidc({ loginPolicy: allowEditor() });

		const res = await callback(routes);
		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		const user = await authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1]));

		expect(user?.entitlements).toEqual(['default-role:editor']);
		expect(Date.parse(user!.entitlementsExpiresAt!)).toBeLessThanOrEqual(Date.now() + 3_600_000);
	});

	it('marks an allowed empty grant so the authorization expiry still applies', async () => {
		const { authenticator, routes } = makeOidc({
			loginPolicy: { policy: { evaluate: () => ({ decision: 'allow' }) } },
		});

		const res = await callback(routes);
		expect(sessionPayload(res).entitlements).toEqual([]);
		const sessionCookie = cookiePair(res, SESSION_COOKIE);
		const user = await authenticator.authenticate(requestWithCookie(sessionCookie.split('=')[1]));

		expect(user).not.toHaveProperty('entitlements');
		expect(user?.entitlementsExpiresAt).toBeDefined();
	});

	it('redirects an explicit denial with policy_denied and logs the bounded reason', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			user_attributes: { clearance: 'CUI' },
		});
		const { routes } = makeOidc({
			loginPolicy: {
				policy: { evaluate: () => ({ decision: 'deny', reason: 'agency_access_policy' }) },
			},
		});

		const res = await callback(routes);

		expect(res.headers.get('location')).toBe('/?auth_error=policy_denied');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
		const lines = warnedLines();
		expect(lines.some((line) => line.includes('oidc_login_policy_denied'))).toBe(true);
		expect(lines.some((line) => line.includes('agency_access_policy'))).toBe(true);
		expect(lines.some((line) => line.includes('CUI'))).toBe(false);
	});

	it('fails closed on a timeout when the policy ignores its abort signal', async () => {
		// Real timers: the callback pipeline crosses the crypto thread pool, which
		// fake timers cannot flush. The 1s minimum timeout keeps this test short.
		const { routes } = makeOidc({
			loginPolicy: {
				policy: { evaluate: () => new Promise(() => {}) },
				timeoutSeconds: 1,
			},
		});

		const res = await callback(routes);

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(warnedLines().some((line) => line.includes('oidc_login_policy_timeout'))).toBe(true);
	});

	it('fails closed when the policy throws, without logging the exception', async () => {
		const { routes } = makeOidc({
			loginPolicy: {
				policy: {
					evaluate: () => {
						throw new Error('leaked claim value SECRET//element-a');
					},
				},
			},
		});

		const res = await callback(routes);

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		const lines = warnedLines();
		expect(lines.some((line) => line.includes('oidc_login_policy_failed'))).toBe(true);
		expect(lines.some((line) => line.includes('SECRET//element-a'))).toBe(false);
	});

	it.each([
		[{ decision: 'allow', entitlements: ['owner'] }, 'unknown_entitlement'],
		[{ decision: 'allow', subjectSecurityContext: {} }, 'unknown_result_field'],
		[{ decision: 'yes' }, 'invalid_decision'],
	] as const)('fails closed on invalid result %j', async (result, problem) => {
		const { routes } = makeOidc({
			loginPolicy: { policy: { evaluate: () => result as never } },
		});

		const res = await callback(routes);

		expect(res.headers.get('location')).toBe('/?auth_error=auth_failed');
		expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
		const lines = warnedLines();
		expect(lines.some((line) => line.includes('oidc_login_policy_result_invalid'))).toBe(true);
		expect(lines.some((line) => line.includes(problem))).toBe(true);
	});

	it('keeps raw attributes out of the signed session and under the cookie limit', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
			email_verified: true,
			user_attributes: {
				department: 'orgcode1',
				classification: 'SECRET',
				compartments: Array.from({ length: 200 }, (_, i) => `element-${i}`),
			},
		});
		const { routes } = makeOidc({ loginPolicy: allowEditor() });

		const res = await callback(routes);
		const payload = sessionPayload(res);

		expect(payload).not.toHaveProperty('user_attributes');
		expect(JSON.stringify(payload)).not.toContain('orgcode1');
		expect(JSON.stringify(payload)).not.toContain('SECRET');
		expect(payload.entitlements).toEqual(['default-role:editor']);
		const token = cookiePair(res, SESSION_COOKIE).split('=')[1];
		expect(utf8ByteLength(decodeURIComponent(token))).toBeLessThanOrEqual(3800);
	});

	it('evaluates a compound department, clearance, and compartment rule end to end', async () => {
		const CLASSIFICATION_RANK: Record<string, number> = {
			UNCLASSIFIED: 0,
			CUI: 1,
			SECRET: 2,
			TOP_SECRET: 3,
		};
		const compound: OidcLoginPolicy = {
			evaluate(input) {
				const attributes = (input.idTokenClaims.user_attributes ?? {}) as Record<string, unknown>;
				const departmentAllowed = ['orgcode1', 'orgcode2'].includes(
					attributes.department as string,
				);
				const clearance =
					typeof attributes.classification === 'string'
						? (CLASSIFICATION_RANK[attributes.classification] ?? -1)
						: -1;
				const compartments = Array.isArray(attributes.compartments) ? attributes.compartments : [];
				const satisfied =
					departmentAllowed &&
					clearance >= CLASSIFICATION_RANK.SECRET &&
					['element-a', 'element-b'].every((element) => compartments.includes(element));
				return satisfied
					? { decision: 'allow', entitlements: ['default-role:editor'] }
					: { decision: 'deny', reason: 'agency_access_policy' };
			},
		};
		const satisfied = {
			department: 'orgcode1',
			classification: 'SECRET',
			compartments: ['element-a', 'element-b'],
		};
		const cases: [Record<string, unknown>, string][] = [
			[satisfied, 'allowed'],
			[{ ...satisfied, department: 'orgcode9' }, 'denied'],
			[{ ...satisfied, classification: 'CUI' }, 'denied'],
			[{ ...satisfied, compartments: ['element-a'] }, 'denied'],
			[{}, 'denied'],
		];
		for (const [attributes, expected] of cases) {
			oauthMock.getValidatedIdTokenClaims.mockReturnValue({
				sub: 'user-1',
				email: 'user@example.com',
				email_verified: true,
				user_attributes: attributes,
			});
			const { routes } = makeOidc({ loginPolicy: { policy: compound } });

			const res = await callback(routes);

			if (expected === 'allowed') {
				expect(res.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);
			} else {
				expect(res.headers.get('location')).toBe('/?auth_error=policy_denied');
				expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mh_session=[^;,]+/);
			}
		}
	});
});
