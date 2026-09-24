import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import type * as Jose from 'jose';
import { CloudflareAccessAuthenticator } from './index';

const keys = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
	const jose = await importOriginal<typeof Jose>();
	return { ...jose, createRemoteJWKSet: () => jose.createLocalJWKSet(keys) };
});
const signingKeys = new Map<string, CryptoKey>();
beforeAll(async () => {
	for (const algorithm of ['RS256', 'ES256']) {
		const pair = await generateKeyPair(algorithm);
		signingKeys.set(algorithm, pair.privateKey);
		keys.keys.push({ ...(await exportJWK(pair.publicKey)), kid: 'access', alg: algorithm });
	}
});
afterEach(() => vi.restoreAllMocks());
const claims = (): JWTPayload => ({
	sub: 'access-user',
	email: 'user@example.com',
	iss: 'https://team.cloudflareaccess.com',
	aud: ['app'],
	exp: Math.floor(Date.now() / 1000) + 3600,
});
async function signToken(payload: JWTPayload, algorithm = 'RS256') {
	return new SignJWT(payload)
		.setProtectedHeader({ alg: algorithm, kid: 'access' })
		.sign(algorithm === 'HS256' ? new Uint8Array(32) : signingKeys.get(algorithm)!);
}
async function authenticate(jwt: string) {
	return new CloudflareAccessAuthenticator({ team: 'team', aud: 'app' }).authenticate(
		new Request('https://hub.example.com', { headers: { 'CF-Access-JWT-Assertion': jwt } }),
	);
}
describe('Access JWT verification', () => {
	it('accepts a signed application token with the expected issuer and audience', async () => {
		expect(await authenticate(await signToken(claims()))).toMatchObject({
			id: 'access-user',
			email: 'user@example.com',
			credential: { kind: 'sso' },
		});
	});
	it.each([
		{ iss: 'https://other.cloudflareaccess.com' },
		{ iss: undefined },
		{ aud: 'another-app' },
		{ aud: undefined },
		{ exp: 1 },
		{ nbf: Math.floor(Date.now() / 1000) + 3600 },
	])('rejects a correctly signed token with invalid claims %j', async (override) => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await authenticate(await signToken({ ...claims(), ...override }))).toBeNull();
	});
	it('rejects a valid JWKS signature using an algorithm outside the allow-list', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const payload = claims();
		const jwt = await signToken(payload, 'ES256');
		expect(
			await jwtVerify(jwt, createLocalJWKSet(keys), {
				audience: 'app',
				issuer: 'https://team.cloudflareaccess.com',
			}),
		).toMatchObject({ payload });
		expect(await authenticate(jwt)).toBeNull();
	});
	it('rejects symmetric signatures', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await authenticate(await signToken(claims(), 'HS256'))).toBeNull();
	});
});
