import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jwtVerify = vi.fn();
const createRemoteJWKSet = vi.fn((_url?: unknown) => ({ mockJwks: true }));

vi.mock('jose', () => ({
	jwtVerify: (...args: unknown[]) => (jwtVerify as (...values: unknown[]) => unknown)(...args),
	createRemoteJWKSet: (...args: unknown[]) =>
		(createRemoteJWKSet as (...values: unknown[]) => unknown)(...args),
}));

const { ProxyHeaderAuthenticator } = await import('./index');

afterEach(() => {
	vi.restoreAllMocks();
});

function request(headers: Record<string, string> = {}): Request {
	return new Request('https://hub.example.com/api/v1/me', { headers });
}

describe('ProxyHeaderAuthenticator header mode', () => {
	it('reads the default email and user-id headers', async () => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'headers' });
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@example.com',
					'X-Forwarded-User': 'provider-user-1',
				}),
			),
		).resolves.toEqual({ id: 'provider-user-1', email: 'user@example.com' });
	});

	it('supports a custom pair of identity headers', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'headers',
			headers: ['X-Auth-Email', 'X-Auth-Subject'],
		});
		await expect(
			auth.authenticate(
				request({ 'X-Auth-Email': 'user@example.com', 'X-Auth-Subject': 'subject-1' }),
			),
		).resolves.toEqual({ id: 'subject-1', email: 'user@example.com' });
	});

	it('uses a single header as both the email and user id', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'headers',
			headers: ['Tailscale-User-Login'],
		});
		await expect(
			auth.authenticate(request({ 'Tailscale-User-Login': 'user@example.com' })),
		).resolves.toEqual({ id: 'user@example.com', email: 'user@example.com' });
	});

	it('trims identity values and preserves the user-id case', async () => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'headers' });
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': '  user@example.com  ',
					'X-Forwarded-User': '  Provider-User-ABC  ',
				}),
			),
		).resolves.toEqual({ id: 'Provider-User-ABC', email: 'user@example.com' });
	});

	it('returns null when either configured identity header is missing', async () => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'headers' });
		await expect(auth.authenticate(request())).resolves.toBeNull();
		await expect(
			auth.authenticate(request({ 'X-Forwarded-Email': 'user@example.com' })),
		).resolves.toBeNull();
		await expect(
			auth.authenticate(request({ 'X-Forwarded-User': 'provider-user-1' })),
		).resolves.toBeNull();
	});

	it.each([
		['an empty email', { 'X-Forwarded-Email': ' ', 'X-Forwarded-User': 'user-1' }],
		['a malformed email', { 'X-Forwarded-Email': 'not-an-email', 'X-Forwarded-User': 'user-1' }],
		[
			'an email without a local part',
			{ 'X-Forwarded-Email': '@example.com', 'X-Forwarded-User': 'user-1' },
		],
		['an email without a domain', { 'X-Forwarded-Email': 'user@', 'X-Forwarded-User': 'user-1' }],
		[
			'an email with multiple at signs',
			{ 'X-Forwarded-Email': 'user@@example.com', 'X-Forwarded-User': 'user-1' },
		],
		[
			'an email containing whitespace',
			{ 'X-Forwarded-Email': 'user name@example.com', 'X-Forwarded-User': 'user-1' },
		],
		[
			'an email containing a control character',
			{ 'X-Forwarded-Email': 'user@example.com\u007f', 'X-Forwarded-User': 'user-1' },
		],
		[
			'an oversized email',
			{ 'X-Forwarded-Email': `${'u'.repeat(309)}@example.com`, 'X-Forwarded-User': 'user-1' },
		],
		['an empty user id', { 'X-Forwarded-Email': 'user@example.com', 'X-Forwarded-User': ' ' }],
		[
			'a user id containing a control character',
			{ 'X-Forwarded-Email': 'user@example.com', 'X-Forwarded-User': 'user\u0001' },
		],
		[
			'an oversized user id',
			{ 'X-Forwarded-Email': 'user@example.com', 'X-Forwarded-User': 'u'.repeat(513) },
		],
	])('returns null for %s', async (_name, headers) => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'headers' });
		await expect(auth.authenticate(request(headers))).resolves.toBeNull();
	});

	it('enforces the email-domain allowlist case-insensitively', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'headers',
			allowedEmailDomains: ['Example.COM'],
		});
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@example.com',
					'X-Forwarded-User': 'user-1',
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@example.com' });
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@outside.example',
					'X-Forwarded-User': 'user-2',
				}),
			),
		).resolves.toBeNull();
	});

	it('matches an allowed domain exactly instead of by suffix', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'headers',
			allowedEmailDomains: ['example.com'],
		});
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@notexample.com',
					'X-Forwarded-User': 'user-1',
				}),
			),
		).resolves.toBeNull();
	});

	it('normalizes leading at signs and blank domain entries', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'headers',
			allowedEmailDomains: [' ', '@Example.COM'],
		});
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@example.com',
					'X-Forwarded-User': 'user-1',
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@example.com' });
	});

	it('allows all valid emails when the allowlist is omitted', async () => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'headers' });
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@outside.example',
					'X-Forwarded-User': 'user-1',
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@outside.example' });
	});

	it('allows all valid emails for the wildcard policy', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'headers',
			allowedEmailDomains: ['*'],
		});
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@outside.example',
					'X-Forwarded-User': 'user-1',
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@outside.example' });
	});

	it('treats a wildcard as allow-all only when it is the sole entry', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'headers',
			allowedEmailDomains: ['example.com', '*'],
		});
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@example.com',
					'X-Forwarded-User': 'user-1',
				}),
			),
		).resolves.toEqual({ id: 'user-1', email: 'user@example.com' });
		await expect(
			auth.authenticate(
				request({
					'X-Forwarded-Email': 'user@outside.example',
					'X-Forwarded-User': 'user-2',
				}),
			),
		).resolves.toBeNull();
	});
});

describe('ProxyHeaderAuthenticator JWT mode', () => {
	beforeEach(() => {
		jwtVerify.mockReset();
		createRemoteJWKSet.mockClear();
	});

	it('uses the Google IAP defaults', async () => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'jwt', audience: '/projects/1/apps/hub' });
		jwtVerify.mockResolvedValue({
			payload: { sub: 'iap-user-1', email: 'user@example.com', exp: 2_000_000_000, iat: 1 },
		});

		await expect(
			auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
		).resolves.toEqual({ id: 'iap-user-1', email: 'user@example.com' });
		expect(createRemoteJWKSet).toHaveBeenCalledWith(
			new URL('https://www.gstatic.com/iap/verify/public_key-jwk'),
		);
		expect(jwtVerify).toHaveBeenCalledWith(
			'signed.jwt.value',
			{ mockJwks: true },
			{
				algorithms: ['ES256'],
				issuer: 'https://cloud.google.com/iap',
				audience: '/projects/1/apps/hub',
				clockTolerance: 30,
				maxTokenAge: '10 minutes',
			},
		);
	});

	it('supports custom assertion settings', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'jwt',
			audience: 'custom-audience',
			header: 'X-Verified-Assertion',
			issuer: 'https://issuer.example.com',
			jwksUrl: 'https://issuer.example.com/.well-known/jwks.json',
		});
		jwtVerify.mockResolvedValue({
			payload: { sub: 'user-1', email: 'user@example.com', exp: 2_000_000_000, iat: 1 },
		});

		await auth.authenticate(request({ 'X-Verified-Assertion': 'signed.jwt.value' }));
		expect(createRemoteJWKSet).toHaveBeenCalledWith(
			new URL('https://issuer.example.com/.well-known/jwks.json'),
		);
		expect(jwtVerify).toHaveBeenCalledWith(
			'signed.jwt.value',
			{ mockJwks: true },
			expect.objectContaining({
				issuer: 'https://issuer.example.com',
				audience: 'custom-audience',
			}),
		);
	});

	it('returns null without an assertion', async () => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'jwt', audience: 'audience' });
		await expect(auth.authenticate(request())).resolves.toBeNull();
		expect(jwtVerify).not.toHaveBeenCalled();
	});

	it('does not fall back to the default assertion header when a custom header is configured', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'jwt',
			audience: 'audience',
			header: 'X-Custom-Assertion',
		});
		await expect(
			auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
		).resolves.toBeNull();
		expect(jwtVerify).not.toHaveBeenCalled();
	});

	it.each(['sub', 'email', 'exp', 'iat'] as const)(
		'returns null without the %s claim',
		async (claim) => {
			const auth = new ProxyHeaderAuthenticator({ mode: 'jwt', audience: 'audience' });
			const payload: Record<string, string | number> = {
				sub: 'user-1',
				email: 'user@example.com',
				exp: 2_000_000_000,
				iat: 1,
			};
			delete payload[claim];
			jwtVerify.mockResolvedValue({ payload });
			await expect(
				auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
			).resolves.toBeNull();
		},
	);

	it.each([
		['sub', 123],
		['email', true],
		['exp', '2000000000'],
		['iat', '1'],
	] as const)('returns null when the %s claim has the wrong type', async (claim, value) => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'jwt', audience: 'audience' });
		jwtVerify.mockResolvedValue({
			payload: {
				sub: 'user-1',
				email: 'user@example.com',
				exp: 2_000_000_000,
				iat: 1,
				[claim]: value,
			},
		});
		await expect(
			auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
		).resolves.toBeNull();
	});

	it.each([
		['a blank subject', { sub: ' ', email: 'user@example.com' }],
		['a malformed email', { sub: 'user-1', email: 'user@@example.com' }],
		['an oversized subject', { sub: 'u'.repeat(513), email: 'user@example.com' }],
	])('returns null for verified claims with %s', async (_name, claims) => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'jwt', audience: 'audience' });
		jwtVerify.mockResolvedValue({ payload: { ...claims, exp: 2_000_000_000, iat: 1 } });
		await expect(
			auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
		).resolves.toBeNull();
	});

	it.each([
		'issuer mismatch',
		'audience mismatch',
		'unexpected algorithm',
		'expired assertion',
		'assertion issued in the future',
		'JWKS request failed',
	])('returns null when jose rejects the assertion: %s', async (message) => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'jwt', audience: 'audience' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		jwtVerify.mockRejectedValue(new Error(message));
		await expect(
			auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
		).resolves.toBeNull();
		expect(errorSpy).toHaveBeenCalledWith('Proxy JWT verification failed', message);
	});

	it('fails closed when jose rejects with a non-Error value', async () => {
		const auth = new ProxyHeaderAuthenticator({ mode: 'jwt', audience: 'audience' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		jwtVerify.mockRejectedValue('JWKS unavailable');
		await expect(
			auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
		).resolves.toBeNull();
		expect(errorSpy).toHaveBeenCalledWith('Proxy JWT verification failed', 'JWKS unavailable');
	});

	it('applies the email allowlist to verified claims', async () => {
		const auth = new ProxyHeaderAuthenticator({
			mode: 'jwt',
			audience: 'audience',
			allowedEmailDomains: ['example.com'],
		});
		jwtVerify.mockResolvedValue({
			payload: { sub: 'user-1', email: 'user@outside.example', exp: 2_000_000_000, iat: 1 },
		});
		await expect(
			auth.authenticate(request({ 'X-Goog-IAP-JWT-Assertion': 'signed.jwt.value' })),
		).resolves.toBeNull();
	});

	it.each([
		'not-a-url',
		'http://issuer.example.com/jwks.json',
		'ftp://issuer.example.com/jwks.json',
		'https://user:password@issuer.example.com/jwks.json',
	])('rejects an unsafe JWKS URL: %s', (jwksUrl) => {
		expect(
			() => new ProxyHeaderAuthenticator({ mode: 'jwt', audience: 'audience', jwksUrl }),
		).toThrow(/HTTPS URL without credentials/);
	});
});
