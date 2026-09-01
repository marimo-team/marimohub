import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Cloudflare Access adapter tests.
 *
 * Mock `jose` entirely. The constructor calls
 * `createRemoteJWKSet` (which would otherwise build a remote key set bound to a
 * URL) and `authenticate()` calls `jwtVerify` (which would otherwise hit the
 * team's JWKS endpoint over the network). We replace both with `vi.fn()` so the
 * adapter's branching logic — header presence, claim validation, verify-throw —
 * is exercised hermetically with no network. `jwtVerify` is driven per-test via
 * `mockResolvedValue` / `mockRejectedValue`.
 */
const jwtVerify = vi.fn();
const createRemoteJWKSet = vi.fn((_url?: unknown) => ({ __mockJwks: true }));

vi.mock('jose', () => ({
	jwtVerify: (...args: unknown[]) => (jwtVerify as (...a: unknown[]) => unknown)(...args),
	createRemoteJWKSet: (...args: unknown[]) =>
		(createRemoteJWKSet as (...a: unknown[]) => unknown)(...args),
}));

const { CloudflareAccessAuthenticator } = await import('./index');

function makeAuth() {
	return new CloudflareAccessAuthenticator({ team: 'myteam', aud: 'my-aud' });
}

function requestWithJwt(jwt: string | null): Request {
	const headers: Record<string, string> = {};
	if (jwt !== null) headers['CF-Access-JWT-Assertion'] = jwt;
	return new Request('http://x', { headers });
}

describe('CloudflareAccessAuthenticator', () => {
	beforeEach(() => {
		jwtVerify.mockReset();
		createRemoteJWKSet.mockClear();
	});

	it('builds the team JWKS URL at construction time', () => {
		makeAuth();
		expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
		const url = createRemoteJWKSet.mock.calls[0][0] as URL;
		expect(url.toString()).toBe('https://myteam.cloudflareaccess.com/cdn-cgi/access/certs');
	});

	it('returns null when the CF-Access-JWT-Assertion header is missing', async () => {
		const auth = makeAuth();
		expect(await auth.authenticate(requestWithJwt(null))).toBeNull();
		// Header missing means we never even attempt verification.
		expect(jwtVerify).not.toHaveBeenCalled();
	});

	it('returns a user when the JWT verifies with sub + email', async () => {
		const auth = makeAuth();
		jwtVerify.mockResolvedValue({ payload: { sub: 'user-1', email: 'user@example.com' } });
		const user = await auth.authenticate(requestWithJwt('a.b.c'));
		expect(user).toEqual({
			id: 'user-1',
			email: 'user@example.com',
			credential: { kind: 'sso' },
		});
		// Verification is performed with the configured audience.
		expect(jwtVerify).toHaveBeenCalledWith('a.b.c', { __mockJwks: true }, { audience: 'my-aud' });
	});

	it('returns null when the verified payload is missing sub', async () => {
		const auth = makeAuth();
		jwtVerify.mockResolvedValue({ payload: { email: 'user@example.com' } });
		expect(await auth.authenticate(requestWithJwt('a.b.c'))).toBeNull();
	});

	it('returns null when the verified payload is missing email', async () => {
		const auth = makeAuth();
		jwtVerify.mockResolvedValue({ payload: { sub: 'user-1' } });
		expect(await auth.authenticate(requestWithJwt('a.b.c'))).toBeNull();
	});

	it('returns null when verification throws', async () => {
		const auth = makeAuth();
		jwtVerify.mockRejectedValue(new Error('signature verification failed'));
		expect(await auth.authenticate(requestWithJwt('a.b.c'))).toBeNull();
	});

	it('exposes a logout URL for the team', () => {
		expect(makeAuth().logoutUrl()).toBe(
			'https://myteam.cloudflareaccess.com/cdn-cgi/access/logout',
		);
	});

	// The audience boundary is enforced by jose: assert the configured aud is passed,
	// and that a token jose rejects for a mismatched audience yields no user.
	it('rejects a token whose audience does not match (aud enforced by jose)', async () => {
		const auth = makeAuth();
		// Real jose throws JWTClaimValidationFailed when `aud` != the expected audience.
		jwtVerify.mockRejectedValue(new Error('unexpected "aud" claim value'));
		expect(await auth.authenticate(requestWithJwt('a.b.c'))).toBeNull();
		expect(jwtVerify).toHaveBeenCalledWith('a.b.c', { __mockJwks: true }, { audience: 'my-aud' });
	});

	// Can't be driven hermetically (jose is fully mocked). Latent gap worth pinning:
	// the adapter passes neither an `algorithms` nor an `issuer` pin to jwtVerify,
	// leaning entirely on jose's key-derived defaults and the team JWKS URL.
	it.skip('does not accept a token signed with an unexpected algorithm (no algorithms/issuer pin)', () => {});
});
