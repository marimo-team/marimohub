import { beforeEach, describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createOidcAuth, normalizeEmailDomains, emailDomainAllowed } from './index';

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
): Promise<string> {
	const login = await routes.request('/api/auth/login');
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
		expect(setCookie).toContain(`${TXN_COOKIE}=`);
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
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
});
