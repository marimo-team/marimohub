import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR } from '@marimo-hub/core/testing';
import { composeAuthenticators } from '@marimo-hub/core';
import { createApi, generateOpenApiDocument } from '../createApi';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	makeTestDeps,
} from '../testing';

const CALLBACK = 'http://127.0.0.1:49152/callback';
const STATE = 's'.repeat(32);
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

describe('CLI authorization routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];
	let app: ReturnType<typeof createApi>;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const testApi = createTestApi({ bucket, userId: ACTOR });
		request = testApi.request;
		app = testApi.app;
		await request('GET', '/me');
	});

	async function approve(overrides: Record<string, unknown> = {}) {
		return expectOk<{ redirect_uri: string; expires_at: string }>(
			await request('POST', '/me/cli-authorizations', {
				callback_uri: CALLBACK,
				state: STATE,
				code_challenge: CHALLENGE,
				token_name: 'mohub CLI',
				expires_in_days: 30,
				...overrides,
			}),
			201,
		);
	}

	it('approves in the browser and exchanges through the public PKCE endpoint', async () => {
		const approved = await approve();
		const redirect = new URL(approved.redirect_uri);
		expect(redirect.origin + redirect.pathname).toBe(CALLBACK);
		expect(redirect.searchParams.get('state')).toBe(STATE);
		const code = redirect.searchParams.get('code')!;

		const exchanged = await expectOk<{ token: string }>(
			await app.request('/api/cli/v1/token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code, code_verifier: VERIFIER }),
			}),
		);
		expect(exchanged.token).toMatch(/^mhub_pat_/);

		const patApp = createApi({
			...makeTestDeps(bucket),
			authenticator: testApiAuthenticator(bucket),
		});
		const me = await expectOk<{ id: string }>(
			await patApp.request('/api/v1/me', {
				headers: { authorization: `Bearer ${exchanged.token}` },
			}),
		);
		expect(me.id).toBe(ACTOR);
	});

	it('rejects non-loopback and decorated callback URLs', async () => {
		for (const callback_uri of [
			'https://evil.example/callback',
			'http://localhost:49152/callback',
			'http://127.0.0.1:49152/other',
			'http://127.0.0.1:49152/callback?next=evil',
		]) {
			await expectError(
				await request('POST', '/me/cli-authorizations', {
					callback_uri,
					state: STATE,
					code_challenge: CHALLENGE,
					token_name: 'mohub CLI',
					expires_in_days: 30,
				}),
				400,
				'BAD_REQUEST',
			);
		}
	});

	it('does not consume a code when the PKCE verifier is wrong', async () => {
		const code = new URL((await approve()).redirect_uri).searchParams.get('code')!;
		await expectError(
			await app.request('/api/cli/v1/token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code, code_verifier: 'x'.repeat(64) }),
			}),
			400,
			'BAD_REQUEST',
		);
		expect(
			await app.request('/api/cli/v1/token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code, code_verifier: VERIFIER }),
			}),
		).toHaveProperty('status', 200);
	});

	it('rate-limits exchanges before reading authorization storage', async () => {
		const realNow = Date.now();
		vi.useFakeTimers({ now: realNow + 61_000 });
		try {
			const deps = makeTestDeps(bucket);
			const exchange = vi.spyOn(deps.services.cliAuthorizations, 'exchange');
			const limitedApi = createApi(deps);
			const exchangeRequest = () =>
				limitedApi.request('/api/cli/v1/token', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ code: 'missing', code_verifier: VERIFIER }),
				});

			for (let attempt = 0; attempt < 60; attempt += 1) {
				await expectError(await exchangeRequest(), 400, 'BAD_REQUEST');
			}
			const response = await exchangeRequest();
			await expectError(response, 429, 'RESOURCE_EXHAUSTED');
			expect(response.headers.get('Retry-After')).toBe('5');
			expect(exchange).toHaveBeenCalledTimes(60);
		} finally {
			vi.setSystemTime(realNow);
			vi.useRealTimers();
		}
	});

	it('requires a session to approve and never accepts a PAT there', async () => {
		const deny = createApi(makeTestDeps(bucket));
		await expectError(
			await deny.request('/api/v1/me/cli-authorizations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					callback_uri: CALLBACK,
					state: STATE,
					code_challenge: CHALLENGE,
					token_name: 'mohub CLI',
					expires_in_days: 30,
				}),
			}),
			401,
			'UNAUTHORIZED',
		);

		const created = await expectOk<{ token: string }>(
			await request('POST', '/me/tokens', { name: 'existing' }),
			201,
		);
		const deps = makeTestDeps(bucket);
		const patApp = createApi({
			...deps,
			authenticator: composeAuthenticators(deps.services.tokens, {
				authenticate: async () => null,
			}),
		});
		await expectError(
			await patApp.request('/api/v1/me/cli-authorizations', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${created.token}`,
				},
				body: JSON.stringify({
					callback_uri: CALLBACK,
					state: STATE,
					code_challenge: CHALLENGE,
					token_name: 'mohub CLI',
					expires_in_days: 30,
				}),
			}),
			403,
			'FORBIDDEN',
		);
	});

	it('documents browser approval as session-only and PKCE exchange as public', () => {
		const paths = (
			generateOpenApiDocument() as {
				paths: Record<string, Record<string, { security?: unknown }>>;
			}
		).paths;
		expect(paths['/api/v1/me/cli-authorizations'].post.security).toEqual([{ cookieAuth: [] }]);
		expect(paths['/api/cli/v1/token'].post.security).toEqual([]);
	});

	it('records the exchanged PAT in the token list and audit log', async () => {
		const code = new URL((await approve()).redirect_uri).searchParams.get('code')!;
		await app.request('/api/cli/v1/token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code, code_verifier: VERIFIER }),
		});

		const listed = await expectOk<{ name: string; expires_at?: string }[]>(
			await request('GET', '/me/tokens'),
		);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ name: 'mohub CLI' });
		expect(listed[0].expires_at).toBeTruthy();
		const events = await createTestApi({ bucket }).deps.services.events.getEvents(
			new Date().toISOString().slice(0, 10),
		);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: 'token.create', actor: ACTOR, token_name: 'mohub CLI' }),
			]),
		);
	});
});

function testApiAuthenticator(bucket: MemoryBucket) {
	const deps = makeTestDeps(bucket);
	return {
		authenticate: (request: Request) => {
			const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
			return deps.services.tokens.verify(token);
		},
	};
}
