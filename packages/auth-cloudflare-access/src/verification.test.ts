import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import type * as Jose from 'jose';
import { CloudflareAccessAuthenticator } from './index';

const keys = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
	const jose = await importOriginal<typeof Jose>();
	return { ...jose, createRemoteJWKSet: () => jose.createLocalJWKSet(keys) };
});
let signingKey: CryptoKey;
beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	signingKey = pair.privateKey;
	keys.keys.push({ ...(await exportJWK(pair.publicKey)), kid: 'access', alg: 'RS256' });
});
afterEach(() => vi.restoreAllMocks());
const claims = (): JWTPayload => ({
	sub: 'access-user',
	email: 'user@example.com',
	iss: 'https://team.cloudflareaccess.com',
	aud: ['app'],
	exp: Math.floor(Date.now() / 1000) + 3600,
});
async function authenticate(payload: JWTPayload, algorithm = 'RS256') {
	const jwt = await new SignJWT(payload)
		.setProtectedHeader({ alg: algorithm, kid: 'access' })
		.sign(algorithm === 'HS256' ? new Uint8Array(32) : signingKey);
	return new CloudflareAccessAuthenticator({ team: 'team', aud: 'app' }).authenticate(
		new Request('https://hub.example.com', { headers: { 'CF-Access-JWT-Assertion': jwt } }),
	);
}
describe('Access JWT verification', () => {
	it('accepts a signed application token with the expected issuer and audience', async () => {
		expect(await authenticate(claims())).toMatchObject({
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
		expect(await authenticate({ ...claims(), ...override })).toBeNull();
	});
	it('rejects an unexpected signing algorithm', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await authenticate(claims(), 'HS256')).toBeNull();
	});
});
