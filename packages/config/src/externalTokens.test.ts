import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { createFromEnv } from './index';

const issuer = 'https://issuer.example.com';
const audience = 'https://hub.example.com/hub/mcp';
const sessionSecret = 's'.repeat(48);
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const env = {
	MARIMOHUB_STORAGE_BACKEND: 'memory',
	MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
	MARIMOHUB_COMPUTE_BACKEND: 'none',
	MARIMOHUB_AUTH_BACKEND: 'oidc',
	MARIMOHUB_AUTH_OIDC_ISSUER: issuer,
	MARIMOHUB_AUTH_OIDC_CLIENT_ID: 'browser',
	MARIMOHUB_AUTH_OIDC_CLIENT_SECRET: 'secret',
	MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
	MARIMOHUB_AUTH_SESSION_SECRET: sessionSecret,
	MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
	MARIMOHUB_AUTH_OIDC_ACCESS_TOKENS: 'on',
	MARIMOHUB_AUTH_OIDC_ACCESS_TOKEN_AUDIENCE: audience,
	MARIMOHUB_AUTH_OIDC_ACCESS_TOKEN_JWKS_URL: `${issuer}/jwks`,
	MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM: '/groups',
	MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS: 'staff',
	MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS: '300',
	MARIMOHUB_MCP: 'on',
	MARIMOHUB_APP_BASE_URL: 'https://hub.example.com/hub/',
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function accessToken(overrides: Record<string, unknown> = {}) {
	const now = Math.floor(Date.now() / 1000);
	const data = `${encode({ alg: 'ES256', kid: 'key', typ: 'at+jwt' })}.${encode({
		iss: issuer,
		aud: audience,
		sub: 'user-one',
		email: 'user@example.com',
		email_verified: true,
		client_id: 'external-client',
		scope: 'mcp:tools marimohub:read',
		groups: ['staff'],
		iat: now,
		exp: now + 300,
		...overrides,
	})}`;
	return `${data}.${sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
function sessionCookie() {
	const data = `${encode({ alg: 'HS256', typ: 'mh-session+jwt' })}.${encode({
		iss: `${issuer}/`,
		aud: 'browser',
		sub: 'user-one',
		email: 'user@example.com',
		exp: Math.floor(Date.now() / 1000) + 300,
	})}`;
	return `mh_session=${data}.${createHmac('sha256', sessionSecret).update(data).digest('base64url')}`;
}
beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (input) => {
			expect(String(input)).toBe(`${issuer}/jwks`);
			return Response.json({
				keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'ES256', kid: 'key' }],
			});
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('signed external tokens through the composition root', () => {
	it('authenticates API and MCP without issuing or verifying a Hub token', async () => {
		const deps = createFromEnv(env);
		const create = vi.spyOn(deps.services.tokens, 'create');
		const verify = vi.spyOn(deps.services.tokens, 'verify');
		const app = createApi(deps);
		const headers = { Authorization: `Bearer ${accessToken()}` };
		const response = await app.request('/api/v1/me', { headers });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true, data: { id: 'user-one' } });
		const mcp = await app.request('/mcp', {
			method: 'POST',
			headers: {
				...headers,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});
		expect(mcp.status).toBe(200);
		expect(create).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
	});

	it.each([
		{},
		{
			MARIMOHUB_AUTH_SESSION_TTL_SECONDS: '300',
			MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS: '3600',
		},
	])('applies the effective group lifetime without cookie fallback: %j', async (override) => {
		const app = createApi(createFromEnv({ ...env, ...override }));
		const cookie = sessionCookie();
		expect((await app.request('/api/v1/me', { headers: { Cookie: cookie } })).status).toBe(200);
		for (const token of [
			accessToken({ exp: Math.floor(Date.now() / 1000) + 301 }),
			accessToken({ groups: ['guest'] }),
			'malformed',
		]) {
			expect(
				(
					await app.request('/api/v1/me', {
						headers: { Cookie: cookie, Authorization: `Bearer ${token}` },
					})
				).status,
			).toBe(401);
		}
	});

	it('rejects a combined Authorization header even with a valid browser session', async () => {
		const app = createApi(createFromEnv(env));
		const cookie = sessionCookie();
		expect((await app.request('/api/v1/me', { headers: { Cookie: cookie } })).status).toBe(200);
		for (const token of ['malformed', accessToken()]) {
			const headers = new Headers({ Cookie: cookie, Authorization: 'Basic dXNlcjpwdw==' });
			headers.append('Authorization', `Bearer ${token}`);
			expect((await app.request('/api/v1/me', { headers })).status).toBe(401);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});
