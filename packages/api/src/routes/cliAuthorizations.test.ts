import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { composeAuthenticators, createCliAuthorizationId } from '@marimo-hub/core';
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
const FULL_GRANT = { actions: '*' as const, projects: '*' as const };

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

	async function requestDevice() {
		return expectOk<{
			device_code: string;
			user_code: string;
			verification_uri: string;
			verification_uri_complete: string;
			expires_in: number;
			interval: number;
		}>(
			await app.request('/api/cli/v1/device-authorizations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code_challenge: CHALLENGE }),
			}),
		);
	}

	it('approves in the browser and exchanges through the public PKCE endpoint', async () => {
		const approved = await approve();
		const redirect = new URL(approved.redirect_uri);
		expect(redirect.origin + redirect.pathname).toBe(CALLBACK);
		expect(redirect.searchParams.get('state')).toBe(STATE);
		const code = redirect.searchParams.get('code')!;

		const exchangeResponse = await app.request('/api/cli/v1/token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code, code_verifier: VERIFIER }),
		});
		const exchanged = await expectOk<{ token: string }>(exchangeResponse);
		expect(exchanged.token).toMatch(/^mhub_pat_/);
		expect(exchangeResponse.headers.get('Cache-Control')).toBe('no-store');
		expect(exchangeResponse.headers.get('Pragma')).toBe('no-cache');

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

	it('carries a narrowed grant through scoped loopback approval', async () => {
		const project = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'Scoped', description: 'd' }),
			201,
		);
		const grant = { actions: ['project.read'], projects: [project.id] };
		const approved = await expectOk<{ redirect_uri: string }>(
			await request('POST', '/me/cli-authorizations/scoped', {
				callback_uri: CALLBACK,
				state: STATE,
				code_challenge: CHALLENGE,
				token_name: 'scoped CLI',
				expires_in_days: 30,
				requested_grant: FULL_GRANT,
				grant,
			}),
			201,
		);
		const code = new URL(approved.redirect_uri).searchParams.get('code')!;
		await expectOk(
			await app.request('/api/cli/v1/token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code, code_verifier: VERIFIER }),
			}),
		);
		const [listed] = await expectOk<{ grant?: unknown }[]>(await request('GET', '/me/tokens'));
		expect(listed.grant).toEqual(grant);
	});

	it('rejects grants on the legacy loopback endpoint', async () => {
		await expectError(
			await request('POST', '/me/cli-authorizations', {
				callback_uri: CALLBACK,
				state: STATE,
				code_challenge: CHALLENGE,
				token_name: 'legacy CLI',
				expires_in_days: 30,
				grant: FULL_GRANT,
			}),
			422,
		);
	});

	it('approves a device login from any browser and returns the PAT through polling', async () => {
		const device = await requestDevice();
		expect(device.device_code).toMatch(/^mhub_cli_/);
		expect(device.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		expect(device.verification_uri).toBe('http://localhost/cli/device');
		expect(new URL(device.verification_uri_complete).searchParams.get('user_code')).toBe(
			device.user_code,
		);
		expect(device).toMatchObject({ expires_in: 600, interval: 5 });

		const pendingResponse = await app.request('/api/cli/v1/device-token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ device_code: device.device_code, code_verifier: VERIFIER }),
		});
		expect(await expectOk<{ status: string }>(pendingResponse, 202)).toEqual({
			status: 'authorization_pending',
		});
		expect(pendingResponse.headers.get('Cache-Control')).toBe('no-store');

		const approvalResponse = await request('POST', '/me/cli-device-authorizations', {
			user_code: device.user_code.toLowerCase(),
			token_name: 'remote mohub CLI',
			expires_in_days: 7,
		});
		await expectOk(approvalResponse);
		expect(approvalResponse.headers.get('Cache-Control')).toBe('no-store');

		const tokenResponse = await app.request('/api/cli/v1/device-token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ device_code: device.device_code, code_verifier: VERIFIER }),
		});
		const exchanged = await expectOk<{ token: string }>(tokenResponse);
		expect(exchanged.token).toMatch(/^mhub_pat_/);
		expect(tokenResponse.headers.get('Cache-Control')).toBe('no-store');

		await expectError(
			await app.request('/api/cli/v1/device-token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ device_code: device.device_code, code_verifier: VERIFIER }),
			}),
			400,
			'BAD_REQUEST',
		);
	});

	it('previews and narrows a scoped device grant', async () => {
		const device = await expectOk<{ device_code: string; user_code: string }>(
			await app.request('/api/cli/v1/device-authorizations/scoped', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code_challenge: CHALLENGE, grant: FULL_GRANT }),
			}),
		);
		const previewResponse = await request(
			'GET',
			`/me/cli-device-authorizations/${device.user_code}`,
		);
		const preview = await expectOk<{ requested_grant: unknown }>(previewResponse);
		expect(preview.requested_grant).toEqual(FULL_GRANT);
		expect(previewResponse.headers.get('Cache-Control')).toBe('no-store');

		const grant = { actions: ['project.read'], projects: '*' };
		await expectOk(
			await request('POST', '/me/cli-device-authorizations/scoped', {
				user_code: device.user_code,
				token_name: 'scoped device CLI',
				expires_in_days: 7,
				grant,
			}),
		);
		await expectOk(
			await app.request('/api/cli/v1/device-token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ device_code: device.device_code, code_verifier: VERIFIER }),
			}),
		);
		const [listed] = await expectOk<{ grant?: unknown }[]>(await request('GET', '/me/tokens'));
		expect(listed.grant).toEqual(grant);
	});

	it('does not disclose inaccessible projects during device approval', async () => {
		const other = createTestApi({ bucket, userId: uid('other-user') }).request;
		const project = await expectOk<{ id: string }>(
			await other('POST', '/projects', { name: 'Private', description: 'd' }),
			201,
		);
		const device = await expectOk<{ user_code: string }>(
			await app.request('/api/cli/v1/device-authorizations/scoped', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					code_challenge: CHALLENGE,
					grant: { actions: '*', projects: [project.id] },
				}),
			}),
		);

		await expectError(
			await request('GET', `/me/cli-device-authorizations/${device.user_code}`),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await request('POST', '/me/cli-device-authorizations/scoped', {
				user_code: device.user_code,
				token_name: 'probe',
				expires_in_days: 7,
				grant: { actions: '*', projects: '*' },
			}),
			404,
			'NOT_FOUND',
		);
	});

	it('marks device authorization instructions as non-cacheable', async () => {
		const response = await app.request('/api/cli/v1/device-authorizations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code_challenge: CHALLENGE }),
		});

		await expectOk(response);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Pragma')).toBe('no-cache');
	});

	it('uses the configured public app URL for device verification links', async () => {
		const deps = makeTestDeps(bucket);
		deps.sandbox.appBaseUrl = 'https://hub.example.com/marimohub';
		const publicApp = createApi(deps);

		const device = await expectOk<{
			user_code: string;
			verification_uri: string;
			verification_uri_complete: string;
		}>(
			await publicApp.request('http://api.internal/api/cli/v1/device-authorizations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code_challenge: CHALLENGE }),
			}),
		);

		expect(device.verification_uri).toBe('https://hub.example.com/marimohub/cli/device');
		expect(device.verification_uri_complete).toBe(
			`https://hub.example.com/marimohub/cli/device?user_code=${device.user_code}`,
		);
	});

	it('does not disclose device grant state without its PKCE verifier', async () => {
		const device = await requestDevice();

		await expectError(
			await app.request('/api/cli/v1/device-token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					device_code: device.device_code,
					code_verifier: 'x'.repeat(64),
				}),
			}),
			400,
			'BAD_REQUEST',
		);
	});

	it('bounds device polling and user-code guesses independently', async () => {
		const device = await requestDevice();
		const poll = () =>
			app.request('/api/cli/v1/device-token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ device_code: device.device_code, code_verifier: VERIFIER }),
			});
		for (let attempt = 0; attempt < 15; attempt += 1) {
			await expectOk(await poll(), 202);
		}
		await expectError(await poll(), 429, 'RESOURCE_EXHAUSTED');

		const guesser = createTestApi({ bucket, userId: uid('device-code-guesser') });
		await guesser.request('GET', '/me');
		for (let attempt = 0; attempt < 5; attempt += 1) {
			await expectError(
				await guesser.request('POST', '/me/cli-device-authorizations', {
					user_code: 'BBBB-BBBB',
					token_name: 'remote CLI',
					expires_in_days: 30,
				}),
				400,
				'BAD_REQUEST',
			);
		}
		await expectError(
			await guesser.request('POST', '/me/cli-device-authorizations', {
				user_code: 'BBBB-BBBB',
				token_name: 'remote CLI',
				expires_in_days: 30,
			}),
			429,
			'RESOURCE_EXHAUSTED',
		);
	});

	it('marks approval redirects as non-cacheable', async () => {
		const response = await request('POST', '/me/cli-authorizations', {
			callback_uri: CALLBACK,
			state: STATE,
			code_challenge: CHALLENGE,
			token_name: 'mohub CLI',
			expires_in_days: 30,
		});
		await expectOk(response, 201);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Pragma')).toBe('no-cache');
	});

	it.each([
		{ state: 'short' },
		{ code_challenge: 'short' },
		{ token_name: ' ' },
		{ expires_in_days: 0 },
		{ expires_in_days: 3651 },
	])('rejects invalid approval input: %#', async (overrides) => {
		await expectError(
			await request('POST', '/me/cli-authorizations', {
				callback_uri: CALLBACK,
				state: STATE,
				code_challenge: CHALLENGE,
				token_name: 'mohub CLI',
				expires_in_days: 30,
				...overrides,
			}),
			422,
			'VALIDATION_ERROR',
		);
	});

	it.each([
		{
			path: '/api/cli/v1/device-authorizations',
			body: { code_challenge: 'short' },
		},
		{
			path: '/api/cli/v1/device-token',
			body: { device_code: '', code_verifier: VERIFIER },
		},
		{
			path: '/api/cli/v1/device-token',
			body: { device_code: 'mhub_cli_invalid', code_verifier: 'short' },
		},
	])('rejects invalid public device input: %#', async ({ path, body }) => {
		await expectError(
			await app.request(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			422,
			'VALIDATION_ERROR',
		);
	});

	it.each([
		{ user_code: 'short' },
		{ token_name: ' ' },
		{ expires_in_days: 0 },
		{ expires_in_days: 3651 },
	])('rejects invalid device approval input: %#', async (overrides) => {
		await expectError(
			await request('POST', '/me/cli-device-authorizations', {
				user_code: 'BBBB-BBBB',
				token_name: 'remote CLI',
				expires_in_days: 30,
				...overrides,
			}),
			422,
			'VALIDATION_ERROR',
		);
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
		await expectError(
			await deny.request('/api/v1/me/cli-device-authorizations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					user_code: 'BBBB-BBBB',
					token_name: 'remote CLI',
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

		const device = await requestDevice();
		await expectError(
			await patApp.request('/api/v1/me/cli-device-authorizations', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${created.token}`,
				},
				body: JSON.stringify({
					user_code: device.user_code,
					token_name: 'remote CLI',
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
		expect(paths['/api/v1/me/cli-device-authorizations'].post.security).toEqual([
			{ cookieAuth: [] },
		]);
		expect(paths['/api/cli/v1/device-authorizations'].post.security).toEqual([]);
		expect(paths['/api/cli/v1/device-token'].post.security).toEqual([]);
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

	it('limits public device authorization creation', async () => {
		const realNow = Date.now();
		vi.useFakeTimers({ now: realNow + 61_000 });
		try {
			const start = () =>
				app.request('/api/cli/v1/device-authorizations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ code_challenge: CHALLENGE }),
				});
			for (let attempt = 0; attempt < 30; attempt += 1) {
				await expectOk(await start());
			}
			const limited = await start();
			await expectError(limited, 429, 'RESOURCE_EXHAUSTED');
			expect(limited.headers.get('Retry-After')).toBe('5');
		} finally {
			vi.setSystemTime(realNow);
			vi.useRealTimers();
		}
	});

	it('isolates authorization attempts while retaining a global storage cap', async () => {
		const realNow = Date.now();
		vi.useFakeTimers({ now: realNow + 61_000 });
		try {
			const approved = await approve();
			const validCode = new URL(approved.redirect_uri).searchParams.get('code')!;
			const deps = makeTestDeps(bucket);
			const exchange = vi.spyOn(deps.services.cliAuthorizations, 'exchange');
			const limitedApi = createApi(deps);
			const exchangeRequest = (code: string) =>
				limitedApi.request('/api/cli/v1/token', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ code, code_verifier: VERIFIER }),
				});
			const randomCode = () => `mhub_cli_${createCliAuthorizationId()}_${'x'.repeat(32)}`;
			const targetedId = createCliAuthorizationId();

			for (let attempt = 0; attempt < 5; attempt += 1) {
				const secret = String(attempt).padStart(32, 'x');
				await expectError(
					await exchangeRequest(`mhub_cli_${targetedId}_${secret}`),
					400,
					'BAD_REQUEST',
				);
			}
			const targetedResponse = await exchangeRequest(`mhub_cli_${targetedId}_${'y'.repeat(32)}`);
			await expectError(targetedResponse, 429, 'RESOURCE_EXHAUSTED');
			expect(targetedResponse.headers.get('Retry-After')).toBe('5');
			expect(exchange).toHaveBeenCalledTimes(5);

			for (let attempt = 0; attempt < 60; attempt += 1) {
				await expectError(await exchangeRequest(randomCode()), 400, 'BAD_REQUEST');
			}
			await expectOk(await exchangeRequest(validCode));

			for (let attempt = 67; attempt < 600; attempt += 1) {
				await expectError(await exchangeRequest(randomCode()), 400, 'BAD_REQUEST');
			}
			const globalResponse = await exchangeRequest(randomCode());
			await expectError(globalResponse, 429, 'RESOURCE_EXHAUSTED');
			expect(globalResponse.headers.get('Retry-After')).toBe('5');
			expect(exchange).toHaveBeenCalledTimes(599);
		} finally {
			vi.setSystemTime(realNow);
			vi.useRealTimers();
		}
	});

	// 6k sequential requests; needs headroom when the whole suite shares the CPU.
	it(
		'charges malformed device codes against the global poll budget',
		{ timeout: 15_000 },
		async () => {
			const realNow = Date.now();
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.useFakeTimers({ now: realNow + 61_000 });
			try {
				const poll = () =>
					app.request('/api/cli/v1/device-token', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ device_code: 'malformed', code_verifier: VERIFIER }),
					});

				for (let attempt = 0; attempt < 6_000; attempt += 1) {
					expect((await poll()).status).toBe(400);
				}
				await expectError(await poll(), 429, 'RESOURCE_EXHAUSTED');
			} finally {
				log.mockRestore();
				vi.setSystemTime(realNow);
				vi.useRealTimers();
			}
		},
	);
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
