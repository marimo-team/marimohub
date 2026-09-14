import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload, JWK } from 'jose';
import { expandTokenGrantPreset } from '@marimo-hub/core/token-grants';
import { createOidcAccessTokenAuthenticator } from './accessTokens';
import type { OidcAccessTokenConfig } from './accessTokens';
import { createOidcAuth } from './index';

const issuer = 'https://issuer.example.com';
const audience = 'https://hub.example.com/mcp';
const jwksUrl = `${issuer}/jwks`;
const config: OidcAccessTokenConfig = {
	issuer,
	audience,
	clientId: 'browser',
	allowedEmailDomains: ['example.com'],
};
let signingKey: CryptoKey;
let nextKey: CryptoKey;
let publicKeys: JWK[];
let initialKey: JWK;
let rotatedKey: JWK;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const now = () => Math.floor(Date.now() / 1000);

function claims(overrides: JWTPayload = {}): JWTPayload {
	return {
		iss: issuer,
		aud: audience,
		sub: 'user-one',
		email: 'user@example.com',
		email_verified: true,
		client_id: 'mcp-client',
		iat: now(),
		exp: now() + 300,
		scope: 'mcp:tools marimohub:read',
		...overrides,
	};
}
function sign(payload: JWTPayload = claims(), key = signingKey, kid = 'first') {
	return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' }).sign(key);
}
const request = (token: string) =>
	new Request(audience, { headers: { Authorization: `Bearer ${token}` } });

beforeAll(async () => {
	const first = await generateKeyPair('ES256');
	const second = await generateKeyPair('ES256');
	signingKey = first.privateKey;
	nextKey = second.privateKey;
	initialKey = { ...(await exportJWK(first.publicKey)), kid: 'first', alg: 'ES256' };
	rotatedKey = { ...(await exportJWK(second.publicKey)), kid: 'second', alg: 'ES256' };
});
beforeEach(() => {
	publicKeys = [initialKey];
	fetchMock = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url === `${issuer}/.well-known/openid-configuration`) {
			return Response.json({ issuer, jwks_uri: jwksUrl });
		}
		if (url === jwksUrl) return Response.json({ keys: publicKeys });
		throw new Error('Unexpected URL');
	});
	vi.stubGlobal('fetch', fetchMock);
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('external OIDC access tokens', () => {
	it('discovers keys, caches them, and authenticates a bounded principal', async () => {
		const auth = createOidcAccessTokenAuthenticator(config);
		const token = await sign(claims({ name: 'User One', picture: 'https://example.com/photo' }));
		const user = await auth.authenticate(request(token));
		expect(user).toMatchObject({
			id: 'user-one',
			email: 'user@example.com',
			name: 'User One',
			pictureUrl: 'https://example.com/photo',
			credential: {
				kind: 'external-access-token',
				expiresAt: expect.any(String),
				grant: { actions: expandTokenGrantPreset('read'), projects: '*' },
				oauth: {
					clientId: 'mcp-client',
					resource: audience,
					scopes: ['mcp:tools', 'marimohub:read'],
				},
			},
		});
		expect(await auth.authenticate(request(token))).toEqual(user);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('uses an explicit JWKS URL without discovery', async () => {
		const auth = createOidcAccessTokenAuthenticator({ ...config, jwksUrl });
		expect(await auth.authenticate(request(await sign()))).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe(jwksUrl);
	});

	it('uses the same subject as the browser session', async () => {
		const sessionSecret = 'x'.repeat(48);
		const browser = createOidcAuth({
			...config,
			sessionSecret,
			clientSecret: 'secret',
			redirectUri: 'https://hub.example.com/api/auth/callback',
		});
		const cookie = await new SignJWT({ sub: 'user-one', email: 'user@example.com' })
			.setProtectedHeader({ alg: 'HS256', typ: 'mh-session+jwt' })
			.setIssuer(`${issuer}/`)
			.setAudience(config.clientId)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(new TextEncoder().encode(sessionSecret));
		const session = await browser.authenticator.authenticate(
			new Request(audience, { headers: { Cookie: `mh_session=${cookie}` } }),
		);
		const external = await createOidcAccessTokenAuthenticator(config).authenticate(
			request(await sign()),
		);
		expect(session?.id).toBe('user-one');
		expect(external?.id).toBe(session?.id);
	});

	it.each(['sub', 'email', 'client_id', 'iat', 'exp', 'scope'])(
		'rejects missing %s',
		async (claim) => {
			const payload = claims();
			delete payload[claim];
			expect(
				await createOidcAccessTokenAuthenticator(config).authenticate(request(await sign(payload))),
			).toBeNull();
		},
	);

	it.each([
		['issuer', { iss: 'https://other.example.com' }],
		['audience', { aud: 'https://gateway.example.com' }],
		['ID-token audience', { aud: 'browser' }],
		['mixed client audience', { aud: [audience, 'browser'] }],
		['empty subject', { sub: '' }],
		['invalid email', { email: 'invalid' }],
		['invalid client', { client_id: 42 }],
		['unverified email', { email_verified: false }],
		['absent verification', { email_verified: undefined }],
		['foreign domain', { email: 'user@foreign.com' }],
		['proof binding', { cnf: { jkt: 'key' } }],
		['scope array', { scope: ['marimohub:read'] }],
		['scope tab', { scope: 'mcp:tools\tmarimohub:read' }],
		['no grant scope', { scope: 'mcp:tools openid' }],
	] as const)('rejects %s', async (_name, overrides) => {
		const token = await sign(claims(overrides as JWTPayload));
		expect(
			await createOidcAccessTokenAuthenticator(config).authenticate(request(token)),
		).toBeNull();
	});

	it.each(['expired', 'future', 'not-yet-valid', 'too-long', 'reversed', 'fractional'])(
		'rejects %s token times',
		async (mode) => {
			const times: Record<string, JWTPayload> = {
				expired: { iat: now() - 600, exp: now() - 1 },
				future: { iat: now() + 10 },
				'not-yet-valid': { nbf: now() + 10 },
				'too-long': { exp: now() + 3601 },
				reversed: { iat: now(), exp: now() },
				fractional: { iat: now() - 0.5 },
			};
			expect(
				await createOidcAccessTokenAuthenticator(config).authenticate(
					request(await sign(claims(times[mode]))),
				),
			).toBeNull();
		},
	);

	it('rejects signatures from untrusted keys and symmetric tokens', async () => {
		const auth = createOidcAccessTokenAuthenticator(config);
		expect(await auth.authenticate(request(await sign(claims(), nextKey)))).toBeNull();
		const token = await new SignJWT(claims())
			.setProtectedHeader({ alg: 'HS256' })
			.sign(new TextEncoder().encode('s'.repeat(32)));
		expect(await auth.authenticate(request(token))).toBeNull();
	});

	it.each(['', 'opaque', 'a.b.c', 'a'.repeat(32769)])(
		'rejects malformed tokens without exposing credentials',
		async (token) => {
			expect(
				await createOidcAccessTokenAuthenticator(config).authenticate(request(token)),
			).toBeNull();
			for (const [entry] of vi.mocked(console.log).mock.calls) {
				expect(JSON.parse(entry as string)).toMatchObject({ event: 'oidc_access_token_rejected' });
				expect(JSON.parse(entry as string)).not.toHaveProperty('token');
			}
		},
	);

	it('ignores token-supplied key URLs', async () => {
		const token = await new SignJWT(claims())
			.setProtectedHeader({ alg: 'ES256', kid: 'first', jku: 'https://attacker.example/jwks' })
			.sign(signingKey);
		expect(
			await createOidcAccessTokenAuthenticator(config).authenticate(request(token)),
		).not.toBeNull();
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			`${issuer}/.well-known/openid-configuration`,
			jwksUrl,
		]);
	});

	it('refreshes signing keys after rotation', async () => {
		vi.useFakeTimers();
		const auth = createOidcAccessTokenAuthenticator(config);
		expect(await auth.authenticate(request(await sign()))).not.toBeNull();
		publicKeys = [rotatedKey];
		vi.setSystemTime(Date.now() + 31000);
		expect(
			await auth.authenticate(request(await sign(claims(), nextKey, 'second'))),
		).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('recovers after a discovery failure', async () => {
		fetchMock.mockRejectedValueOnce(new Error('unavailable'));
		const auth = createOidcAccessTokenAuthenticator(config);
		const token = await sign();
		expect(await auth.authenticate(request(token))).toBeNull();
		expect(await auth.authenticate(request(token))).not.toBeNull();
	});

	it('denies authentication while JWKS is unavailable', async () => {
		fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }));
		const auth = createOidcAccessTokenAuthenticator({ ...config, jwksUrl });
		expect(await auth.authenticate(request(await sign()))).toBeNull();
	});

	it.each([
		{ issuer: 'https://wrong.example.com', jwks_uri: jwksUrl },
		{ issuer, jwks_uri: 'http://issuer.example.com/jwks' },
		{ issuer, jwks_uri: 'https://user:password@issuer.example.com/jwks' },
		{ issuer },
	])('rejects unsafe discovery metadata: %j', async (metadata) => {
		fetchMock.mockResolvedValueOnce(Response.json(metadata));
		expect(
			await createOidcAccessTokenAuthenticator(config).authenticate(request(await sign())),
		).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('allows missing email verification only with the trusted-issuer policy', async () => {
		const auth = createOidcAccessTokenAuthenticator({
			...config,
			emailVerification: 'trusted-issuer',
		});
		expect(
			await auth.authenticate(request(await sign(claims({ email_verified: undefined })))),
		).not.toBeNull();
		expect(
			await auth.authenticate(request(await sign(claims({ email_verified: false })))),
		).toBeNull();
	});

	it('maps groups, requires membership, and bounds entitlements by token expiry', async () => {
		const auth = createOidcAccessTokenAuthenticator({
			...config,
			maxLifetimeSeconds: 300,
			groups: { claim: '/org/groups', allowed: ['staff'], defaultRoles: { editor: ['staff'] } },
		});
		const payload = claims({ org: { groups: ['staff'] } });
		expect(await auth.authenticate(request(await sign(payload)))).toMatchObject({
			entitlements: ['default-role:editor'],
			entitlementsExpiresAt: new Date(payload.exp! * 1000).toISOString(),
		});
		for (const override of [
			{},
			{ org: { groups: ['guest'] } },
			{ org: { groups: 'staff' } },
			{ org: { groups: ['staff'] }, exp: now() + 301 },
		]) {
			expect(await auth.authenticate(request(await sign(claims(override))))).toBeNull();
		}
	});

	it('does not carry group entitlements from another request', async () => {
		const auth = createOidcAccessTokenAuthenticator({
			...config,
			groups: { claim: '/groups', superAdmin: ['admin'] },
		});
		expect(
			await auth.authenticate(request(await sign(claims({ groups: ['admin'] })))),
		).toMatchObject({ entitlements: ['super-admin'] });
		expect(await auth.authenticate(request(await sign()))).toMatchObject({ entitlements: [] });
	});

	it.each(['read', 'run', 'edit', 'full'] as const)(
		'maps the %s scope to the existing preset',
		async (preset) => {
			const token = await sign(claims({ scope: `openid marimohub:read marimohub:${preset}` }));
			expect(
				await createOidcAccessTokenAuthenticator(config).authenticate(request(token)),
			).toMatchObject({
				credential: { grant: { actions: expandTokenGrantPreset(preset), projects: '*' } },
			});
		},
	);
});

describe('external token verification failures', () => {
	it.each([undefined, 'Basic abc', 'Bearer', 'BEARER\tinvalid', 'Bearer a.b.c', 'Bearer a..c'])(
		'does not fetch keys for an absent or malformed JWT: %j',
		async (authorization) => {
			const req = new Request(audience, {
				headers: authorization === undefined ? {} : { Authorization: authorization },
			});
			expect(await createOidcAccessTokenAuthenticator(config).authenticate(req)).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it('rejects an unsupported algorithm before contacting the issuer', async () => {
		const token = await new SignJWT(claims())
			.setProtectedHeader({ alg: 'HS256' })
			.sign(new TextEncoder().encode('s'.repeat(32)));
		expect(
			await createOidcAccessTokenAuthenticator(config).authenticate(request(token)),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not accept an embedded attacker key', async () => {
		const token = await new SignJWT(claims())
			.setProtectedHeader({ alg: 'ES256', kid: 'first', jwk: rotatedKey })
			.sign(nextKey);
		expect(
			await createOidcAccessTokenAuthenticator(config).authenticate(request(token)),
		).toBeNull();
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			`${issuer}/.well-known/openid-configuration`,
			jwksUrl,
		]);
	});

	it('shares discovery and JWKS requests across concurrent verifications', async () => {
		const started = Promise.withResolvers<void>();
		const discovery = Promise.withResolvers<Response>();
		fetchMock.mockImplementationOnce(() => {
			started.resolve();
			return discovery.promise;
		});
		const auth = createOidcAccessTokenAuthenticator(config);
		const token = await sign();
		const requests = Array.from({ length: 5 }, () => auth.authenticate(request(token)));
		await started.promise;
		expect(fetchMock).toHaveBeenCalledTimes(1);
		discovery.resolve(Response.json({ issuer, jwks_uri: jwksUrl }));
		const users = await Promise.all(requests);
		expect(users.every((user) => user?.id === 'user-one')).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('clears a failed shared discovery so a subsequent request can retry', async () => {
		const started = Promise.withResolvers<void>();
		const discovery = Promise.withResolvers<Response>();
		fetchMock.mockImplementationOnce(() => {
			started.resolve();
			return discovery.promise;
		});
		const auth = createOidcAccessTokenAuthenticator(config);
		const token = await sign();
		const requests = [auth.authenticate(request(token)), auth.authenticate(request(token))];
		await started.promise;
		discovery.reject(new Error('issuer unavailable'));
		expect(await Promise.all(requests)).toEqual([null, null]);
		expect(await auth.authenticate(request(token))).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it.each(['discovery', 'jwks'] as const)(
		'fails closed and recovers after a %s timeout',
		async (stage) => {
			const controller = new AbortController();
			const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
			const started = Promise.withResolvers<AbortSignal | null | undefined>();
			fetchMock.mockImplementationOnce((_input, init) => {
				started.resolve(init?.signal);
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Timed out', 'TimeoutError')),
						{ once: true },
					);
				});
			});
			const auth = createOidcAccessTokenAuthenticator({
				...config,
				...(stage === 'jwks' ? { jwksUrl } : {}),
			});
			const token = await sign();
			const pending = auth.authenticate(request(token));
			expect(await started.promise).toBe(controller.signal);
			expect(timeout).toHaveBeenCalledWith(5000);
			controller.abort();
			expect(await pending).toBeNull();
			timeout.mockRestore();
			expect(await auth.authenticate(request(token))).not.toBeNull();
		},
	);

	it.each(['invalid-json', 'missing-uri', 'unsafe-uri', 'wrong-issuer', 'redirect'])(
		'retries after rejecting %s discovery metadata',
		async (failure) => {
			const responses: Record<string, Response> = {
				'invalid-json': new Response('{', { headers: { 'Content-Type': 'application/json' } }),
				'missing-uri': Response.json({ issuer }),
				'unsafe-uri': Response.json({ issuer, jwks_uri: 'http://issuer.example.com/keys' }),
				'wrong-issuer': Response.json({ issuer: 'https://other.example.com', jwks_uri: jwksUrl }),
				redirect: new Response(null, {
					status: 302,
					headers: { Location: 'https://attacker.example/keys' },
				}),
			};
			fetchMock.mockResolvedValueOnce(responses[failure]);
			const auth = createOidcAccessTokenAuthenticator(config);
			const token = await sign();
			expect(await auth.authenticate(request(token))).toBeNull();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(await auth.authenticate(request(token))).not.toBeNull();
			expect(fetchMock).toHaveBeenCalledTimes(3);
		},
	);

	it.each(['invalid-json', 'invalid-keys', 'http-error', 'redirect'])(
		'recovers from a %s JWKS response',
		async (failure) => {
			const responses: Record<string, Response> = {
				'invalid-json': new Response('{', { headers: { 'Content-Type': 'application/json' } }),
				'invalid-keys': Response.json({ keys: 'not-an-array' }),
				'http-error': new Response('unavailable', { status: 503 }),
				redirect: new Response(null, {
					status: 302,
					headers: { Location: 'http://attacker.example/keys' },
				}),
			};
			fetchMock.mockResolvedValueOnce(responses[failure]);
			const auth = createOidcAccessTokenAuthenticator({ ...config, jwksUrl });
			const token = await sign();
			expect(await auth.authenticate(request(token))).toBeNull();
			expect(await auth.authenticate(request(token))).not.toBeNull();
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it('denies unknown keys during cooldown without refetching on every token', async () => {
		vi.useFakeTimers();
		const auth = createOidcAccessTokenAuthenticator(config);
		const known = await sign();
		const unknown = await sign(claims(), nextKey, 'unknown');
		expect(await auth.authenticate(request(known))).not.toBeNull();
		for (let index = 0; index < 3; index++)
			expect(await auth.authenticate(request(unknown))).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		vi.setSystemTime(Date.now() + 31000);
		fetchMock.mockRejectedValueOnce(new Error('JWKS unavailable'));
		expect(await auth.authenticate(request(unknown))).toBeNull();
		expect(await auth.authenticate(request(known))).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does not log token contents, claims, or upstream exception details', async () => {
		const sensitive = 'private-sentinel';
		const token = await sign(claims({ email: `${sensitive}@example.com` }));
		fetchMock.mockRejectedValueOnce(new Error(`Failed ${sensitive}: ${token}`));
		expect(
			await createOidcAccessTokenAuthenticator(config).authenticate(request(token)),
		).toBeNull();
		const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain(sensitive);
		expect(lines[0]).not.toContain(token);
		expect(JSON.parse(lines[0])).toMatchObject({
			event: 'oidc_access_token_rejected',
			reason: 'verification_failed',
		});
	});

	it.each([
		{ issuer: 'not a URL' },
		{ issuer: 'https://issuer.example.com?query=1' },
		{ issuer: 'https://issuer.example.com#fragment' },
		{ audience: '   ' },
		{ jwksUrl: '' },
		{ jwksUrl: 'https://issuer.example.com/keys#fragment' },
		{ maxLifetimeSeconds: 0 },
		{ maxLifetimeSeconds: 3601 },
		{ maxLifetimeSeconds: Number.NaN },
		{ maxLifetimeSeconds: 300.5 },
	])('rejects invalid direct adapter configuration: %j', (override) => {
		expect(() => createOidcAccessTokenAuthenticator({ ...config, ...override })).toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
