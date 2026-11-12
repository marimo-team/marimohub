import { describe, expect, it, vi } from 'vitest';
import { SourceControlAccountService, AesGcmSecretCodec } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import type { SourceControlAccountProvider } from '@marimo-hub/core/ports/source-control-account';
import { createInitializedBucket, createTestApi, expectOk } from '../testing';

async function setup(mode: 'app' | 'user' = 'user') {
	const bucket = await createInitializedBucket();
	const provider: SourceControlAccountProvider = {
		provider: 'github',
		origin: 'https://github.com',
		clientId: 'test',
		authorizationUrl: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
		exchange: vi.fn(async () => ({
			accessToken: 'secret-access',
			refreshToken: 'secret-refresh',
			expiresAt: Date.now() + 3600000,
			refreshExpiresAt: Date.now() + 86400000,
		})),
		refresh: vi.fn(),
		identity: vi.fn(async () => ({ id: '123', login: 'alice' })),
		revoke: vi.fn(async () => {}),
	};
	const accounts = new SourceControlAccountService(
		bucket,
		new AesGcmSecretCodec({
			kek: '0123456789abcdef1032547698badcfeffeeddccbbaa99887766554433221100',
		}),
		provider,
		'https://hub.example/api/v1/me/github/callback',
	);
	const api = createTestApi({
		bucket,
		deps: { githubPublishActor: mode, githubAccounts: accounts },
	});
	const startConnection = async () => {
		const response = await api.request('POST', '/me/github/connect');
		const { url } = await expectOk<{ url: string }>(response);
		const cookie = response.headers.get('set-cookie')!;
		return {
			response,
			cookie,
			headers: { Cookie: cookie.split(';')[0] },
			callbackPath: `/me/github/callback?code=secret-code&state=${new URL(url).searchParams.get('state')}`,
		};
	};
	return { ...api, accounts, provider, startConnection };
}
describe('GitHub account routes', () => {
	it('binds OAuth to a secure browser cookie and returns only public status', async () => {
		const f = await setup();
		const { response, cookie, callbackPath, headers } = await f.startConnection();
		expect(cookie).toContain('__Host-marimohub_github_link=');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Lax');
		expect(response.headers.get('cache-control')).toBe('no-store');
		const callback = await f.request('GET', callbackPath, undefined, headers);
		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe('/account/github');
		expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
		const status = await expectOk(await f.request('GET', '/me/github'));
		expect(status).toEqual({
			enabled: true,
			account: { login: 'alice', account_id: '123', connected: true },
		});
		expect(JSON.stringify(status)).not.toContain('secret');
	});
	it('cleans denied, missing-cookie, and failed callbacks without exposing query parameters', async () => {
		const f = await setup();
		for (const suffix of ['error=access_denied', 'code=secret&state=secret']) {
			const response = await f.request('GET', `/me/github/callback?${suffix}`);
			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe('/account/github?connection=failed');
		}
		expect(f.provider.exchange).not.toHaveBeenCalled();
	});
	it('keeps disconnect available in App mode but disables new connections', async () => {
		const f = await setup('app');
		const state = new URL(await f.accounts.begin(ACTOR, 'browser')).searchParams.get('state')!;
		await f.accounts.complete(ACTOR, 'browser', state, 'code');
		expect((await expectOk(await f.request('GET', '/me/github'))).enabled).toBe(false);
		expect((await f.request('POST', '/me/github/connect')).status).toBe(404);
		expect(await expectOk(await f.request('DELETE', '/me/github'))).toEqual({
			remote_revocation_confirmed: true,
		});
		expect(await f.accounts.status(ACTOR)).toBeNull();
	});
});

it.each(['personal-access-token', 'service-account', 'external-access-token'] as const)(
	'does not let %s manage account connections',
	async (kind) => {
		const f = await setup();
		const api = createTestApi({
			bucket: f.bucket,
			deps: { githubPublishActor: 'user', githubAccounts: f.accounts },
			subject: { credential: { kind } },
		});
		for (const [method, path] of [
			['GET', '/me/github'],
			['POST', '/me/github/connect'],
			['DELETE', '/me/github'],
		])
			expect((await api.request(method, path)).status).toBe(403);
		expect(f.provider.exchange).not.toHaveBeenCalled();
	},
);
it('rejects a cross-origin account mutation', async () => {
	const f = await setup();
	expect(
		(
			await f.request('POST', '/me/github/connect', undefined, {
				Origin: 'https://evil.example',
				'Sec-Fetch-Site': 'cross-site',
			})
		).status,
	).toBe(403);
});

it('does not link or disconnect another hub user through a shared browser cookie', async () => {
	const f = await setup();
	const { callbackPath, headers } = await f.startConnection();
	const other = createTestApi({
		bucket: f.bucket,
		userId: uid('other-user'),
		deps: { githubPublishActor: 'user', githubAccounts: f.accounts },
	});
	expect(
		(await other.request('GET', callbackPath, undefined, headers)).headers.get('location'),
	).toBe('/account/github?connection=failed');
	expect(f.provider.exchange).not.toHaveBeenCalled();
	expect((await f.request('GET', callbackPath, undefined, headers)).headers.get('location')).toBe(
		'/account/github',
	);
	expect(await expectOk(await other.request('GET', '/me/github'))).toEqual({
		enabled: true,
		account: null,
	});
	await expectOk(await other.request('DELETE', '/me/github'));
	expect(f.provider.revoke).not.toHaveBeenCalled();
	expect(await f.accounts.status(ACTOR)).toMatchObject({ login: 'alice', connected: true });
});

it('redacts a failed token exchange and consumes its callback state', async () => {
	const f = await setup();
	const { callbackPath, headers } = await f.startConnection();
	vi.mocked(f.provider.exchange).mockRejectedValue(
		new Error('SECRET_PROVIDER_PAYLOAD', { cause: new Error('SECRET_TOKEN') }),
	);
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await f.request('GET', callbackPath, undefined, headers);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/account/github?connection=failed');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('set-cookie')).toContain('Secure');
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
		expect(await response.text()).not.toMatch(/SECRET|secret-code/);
	}
	expect(f.provider.exchange).toHaveBeenCalledOnce();
	expect(await f.accounts.status(ACTOR)).toBeNull();
});

it('blocks account actions after the hub user is suspended', async () => {
	const f = await setup();
	await f.request('GET', '/me');
	await f.deps.services.identities.setSuspension(ACTOR, true);
	for (const [method, path] of [
		['POST', '/me/github/connect'],
		['DELETE', '/me/github'],
		['GET', '/me/github/callback?code=secret&state=secret'],
		['GET', '/me/github'],
	]) {
		expect((await f.request(method, path)).status).toBe(403);
	}
	expect(f.provider.exchange).not.toHaveBeenCalled();
	expect(f.provider.revoke).not.toHaveBeenCalled();
});
