import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { createOidcAuth } from './index';

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
		expirationTime?: string | number;
	} = {},
): Promise<string> {
	const secret = new TextEncoder().encode(opts.secret ?? SESSION_SECRET);
	const payload: Record<string, unknown> = {};
	if (opts.email !== undefined) payload.email = opts.email;
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

describe('OIDC authenticate (cookie session)', () => {
	it('accepts a valid signed session cookie', async () => {
		const auth = makeAuthenticator();
		const token = await signSession({ sub: 'user-1', email: 'user@example.com' });
		const user = await auth.authenticate(requestWithCookie(token));
		expect(user).toEqual({ id: 'user-1', email: 'user@example.com' });
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
		// Flip the final character of the signature segment.
		const mangled = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
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
