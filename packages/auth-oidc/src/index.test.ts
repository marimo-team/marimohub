import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { createOidcAuth, normalizeEmailDomains, emailDomainAllowed } from './index';

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

function makeAuthenticator(sessionSecret: string = SESSION_SECRET) {
	return createOidcAuth({
		issuer: 'https://issuer.example.com',
		clientId: 'client-id',
		clientSecret: 'client-secret',
		redirectUri: 'https://hub.example.com/api/auth/callback',
		sessionSecret,
	}).authenticator;
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

describe('createOidcAuth session-secret strength check', () => {
	const baseConfig = {
		issuer: 'https://issuer.example.com',
		clientId: 'client-id',
		clientSecret: 'client-secret',
		redirectUri: 'https://hub.example.com/api/auth/callback',
	};

	it('throws when sessionSecret is shorter than 32 bytes', () => {
		expect(() => createOidcAuth({ ...baseConfig, sessionSecret: 'short' })).toThrow(
			/MARIMOHUB_AUTH_SESSION_SECRET/,
		);
	});

	it('throws with a message mentioning 32 bytes', () => {
		expect(() => createOidcAuth({ ...baseConfig, sessionSecret: 'tooshort' })).toThrow(/32 bytes/);
	});

	it('does not throw when sessionSecret is exactly 32 bytes', () => {
		// 32 ASCII characters = 32 bytes
		expect(() => createOidcAuth({ ...baseConfig, sessionSecret: 'a'.repeat(32) })).not.toThrow();
	});

	it('does not throw when sessionSecret is longer than 32 bytes', () => {
		expect(() => createOidcAuth({ ...baseConfig, sessionSecret: SESSION_SECRET })).not.toThrow();
	});

	it('returns authenticator and routes when sessionSecret is valid', () => {
		const result = createOidcAuth({ ...baseConfig, sessionSecret: SESSION_SECRET });
		expect(result).toHaveProperty('authenticator');
		expect(result).toHaveProperty('routes');
	});
});

describe('normalizeEmailDomains', () => {
	it('lowercases, trims, and strips a leading @', () => {
		expect(normalizeEmailDomains(['  MARIMO.IO ', '@Example.COM'])).toEqual([
			'marimo.io',
			'example.com',
		]);
	});

	it('drops blank entries', () => {
		expect(normalizeEmailDomains(['marimo.io', '', '   ', '@'])).toEqual(['marimo.io']);
	});

	it('returns an empty array for undefined', () => {
		expect(normalizeEmailDomains(undefined)).toEqual([]);
	});
});

describe('emailDomainAllowed', () => {
	const allowed = ['marimo.io'];

	it('accepts an email under an allowed domain (case-insensitive)', () => {
		expect(emailDomainAllowed('myles@marimo.io', allowed)).toBe(true);
		expect(emailDomainAllowed('Myles@Marimo.IO', allowed)).toBe(true);
	});

	it('rejects an email under a different domain', () => {
		expect(emailDomainAllowed('attacker@evil.com', allowed)).toBe(false);
	});

	it('rejects a lookalike subdomain that is not an exact match', () => {
		expect(emailDomainAllowed('user@marimo.io.evil.com', allowed)).toBe(false);
		expect(emailDomainAllowed('user@notmarimo.io', allowed)).toBe(false);
	});

	it('uses the last @ so embedded @ cannot smuggle a domain', () => {
		expect(emailDomainAllowed('marimo.io@evil.com', allowed)).toBe(false);
		expect(emailDomainAllowed('foo@bar@marimo.io', allowed)).toBe(true);
	});

	it('rejects a string with no @', () => {
		expect(emailDomainAllowed('not-an-email', allowed)).toBe(false);
	});

	it('rejects everything when the allowlist is empty', () => {
		expect(emailDomainAllowed('myles@marimo.io', [])).toBe(false);
	});
});

describe('OIDC callback error handling', () => {
	const baseConfig = {
		issuer: 'https://issuer.example.com',
		clientId: 'client-id',
		clientSecret: 'client-secret',
		redirectUri: 'https://hub.example.com/api/auth/callback',
		sessionSecret: SESSION_SECRET,
	};

	it('redirects into the SPA (not raw JSON) when the transaction cookie is missing', async () => {
		const { routes } = createOidcAuth(baseConfig);
		const res = await routes.request('/api/auth/callback?code=abc&state=xyz');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/?auth_error=session_expired');
	});

	it('appends auth_error with & when the post-login redirect already has a query', async () => {
		const { routes } = createOidcAuth({ ...baseConfig, postLoginRedirect: '/app?tab=home' });
		const res = await routes.request('/api/auth/callback');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/app?tab=home&auth_error=session_expired');
	});

	it('clears the in-flight transaction cookie on a callback error', async () => {
		const { routes } = createOidcAuth(baseConfig);
		const res = await routes.request('/api/auth/callback');
		// deleteCookie emits a Set-Cookie that expires mh_oidc_txn.
		const setCookie = res.headers.get('set-cookie') ?? '';
		expect(setCookie).toContain('mh_oidc_txn=');
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
			// Expiration in the past.
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
