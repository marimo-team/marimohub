import { describe, expect, it } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing';
import type { ApiDeps } from './context';
import { createApi } from './createApi';
import { makeTestDeps } from './testing';

/** A minimal WIF config stub — only the issuer's `jwks()` is exercised here. */
const stubWif = {
	issuerUrl: 'https://hub.example.com',
	targets: {},
	issuer: {
		mint: async () => 'jwt',
		jwks: async () => ({
			keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'kid-1', n: 'AAA', e: 'AQAB' }],
		}),
	},
} as unknown as ApiDeps['wif'];

describe('OIDC discovery routes', () => {
	it('serves discovery + JWKS (raw JSON) when WIF is configured', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { wif: stubWif });
		const app = createApi(deps);

		const disc = await app.request('/.well-known/openid-configuration');
		expect(disc.status).toBe(200);
		const discBody = (await disc.json()) as Record<string, unknown>;
		expect(discBody).toMatchObject({
			issuer: 'https://hub.example.com',
			jwks_uri: 'https://hub.example.com/.well-known/jwks.json',
			id_token_signing_alg_values_supported: ['RS256'],
		});
		// Raw OIDC JSON, NOT the { success, data } API envelope.
		expect(discBody).not.toHaveProperty('success');

		const jwks = await app.request('/.well-known/jwks.json');
		expect(jwks.status).toBe(200);
		const jwksBody = (await jwks.json()) as { keys: { kid: string }[] };
		expect(jwksBody.keys[0].kid).toBe('kid-1');
	});

	it('404s both routes when WIF is not configured', async () => {
		const app = createApi(makeTestDeps(new MemoryBucket()));
		expect((await app.request('/.well-known/openid-configuration')).status).toBe(404);
		expect((await app.request('/.well-known/jwks.json')).status).toBe(404);
	});
});
