import { beforeEach, describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
	createOidcAuth,
	normalizeEmailDomains,
	emailDomainAllowed,
	sanitizeReturnTo,
} from './index';

const oauthMock = vi.hoisted(() => ({
	ClientSecretPost: vi.fn(),
	authorizationCodeGrantRequest: vi.fn(),
	calculatePKCECodeChallenge: vi.fn(),
	discoveryRequest: vi.fn(),
	generateRandomCodeVerifier: vi.fn(),
	generateRandomNonce: vi.fn(),
	generateRandomState: vi.fn(),
	getValidatedIdTokenClaims: vi.fn(),
	processAuthorizationCodeResponse: vi.fn(),
	processDiscoveryResponse: vi.fn(),
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

beforeEach(() => {
	vi.clearAllMocks();
	oauthMock.ClientSecretPost.mockImplementation((secret: string) => ({ secret }));
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
	oauthMock.processAuthorizationCodeResponse.mockResolvedValue({ id_token: 'id-token' });
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
		expirationTime?: string | number;
	} = {},
): Promise<string> {
	const secret = new TextEncoder().encode(opts.secret ?? SESSION_SECRET);
	const payload: Record<string, unknown> = {};
	if (opts.email !== undefined) payload.email = opts.email;
	if (opts.name !== undefined) payload.name = opts.name;
	let jwt = new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256' })
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

describe('createOidcAuth session-secret strength check', () => {
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

	it('tolerates a provider that omits email_verified (no allowlist)', async () => {
		oauthMock.getValidatedIdTokenClaims.mockReturnValue({
			sub: 'user-1',
			email: 'user@example.com',
		});
		const { routes } = makeOidc();
		const txn = await beginOidcTransaction(routes);

		const res = await routes.request('/api/auth/callback?code=abc&state=state-1', {
			headers: { cookie: txn },
		});

		expect(res.status).toBe(302);
		expect(res.headers.get('set-cookie') ?? '').toMatch(/mh_session=[^;,]+/);
	});

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

	it('leaves name undefined when the cookie carries no (or a non-string) name', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 'user@example.com', name: 42 });
		const user = await auth.authenticate(requestWithCookie(token));
		expect(user?.name).toBeUndefined();
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
		const mangledSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
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

	it('rejects a cookie missing the sub claim', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ email: 'user@example.com' });
		expect(await auth.authenticate(requestWithCookie(token))).toBeNull();
	});

	it('returns null when no cookie header is present', async () => {
		const auth = makeAuthenticator();
		expect(await auth.authenticate(new Request('http://x'))).toBeNull();
	});

	// An unsigned alg:none token must never authenticate. The adapter passes no
	// `algorithms` pin, so this relies on jose restricting a symmetric key to HS*.
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
		verifier?: string;
		state?: string;
		returnTo?: string;
	}) {
		const secret = new TextEncoder().encode(opts.secret);
		return new SignJWT({
			verifier: opts.verifier ?? 'verifier-1',
			state: opts.state ?? 'state-1',
			nonce: 'nonce-1',
			returnTo: opts.returnTo ?? null,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuedAt()
			.setExpirationTime('10m')
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
});
