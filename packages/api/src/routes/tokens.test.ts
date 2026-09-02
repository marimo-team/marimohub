import { describe, it, expect, beforeEach } from 'vitest';
import { composeAuthenticators } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createApi, generateOpenApiDocument } from '../createApi';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
	makeTestDeps,
} from '../testing';

interface TokenMeta {
	id: string;
	name: string;
	created_at: string;
	expires_at?: string;
	last_used_at?: string;
	grant?: { actions: string[] | '*'; projects: string[] | '*' };
}

const FULL_GRANT = { actions: '*' as const, projects: '*' as const };

describe('Token routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket, userId: ACTOR }).request;
		// Record ACTOR in the identity directory (the auth middleware upserts it),
		// so a minted PAT can resolve back to a user.
		await request('GET', '/me');
	});

	it('POST /me/tokens returns the plaintext exactly once, with metadata', async () => {
		const data = await expectOk<TokenMeta & { token: string }>(
			await request('POST', '/me/tokens', { name: 'ci' }),
			201,
		);

		// The one-time plaintext contract: exactly these fields, never a hash.
		expect(Object.keys(data).sort()).toEqual(['created_at', 'id', 'name', 'token']);
		expect(data.token).toMatch(/^mhub_pat_[0-9A-Z]{26}_[0-9a-z]{32}$/);

		// The list never carries the token or hash again.
		const listed = await expectOk<TokenMeta[]>(await request('GET', '/me/tokens'));
		expect(listed).toHaveLength(1);
		expect(Object.keys(listed[0]).sort()).toEqual(['created_at', 'id', 'name']);
	});

	it('POST /me/tokens stamps expires_at from expires_in_days', async () => {
		const data = await expectOk<TokenMeta>(
			await request('POST', '/me/tokens', { name: 'short', expires_in_days: 30 }),
			201,
		);
		expect(data.expires_at).toBeTruthy();
	});

	it('keeps the legacy creation body strict', async () => {
		await expectError(
			await request('POST', '/me/tokens', {
				name: 'legacy',
				grant: { actions: '*', projects: '*' },
			}),
			422,
		);
	});

	it('creates and lists a v2 token with an explicit grant', async () => {
		const project = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'Scoped', description: 'd' }),
			201,
		);
		const grant = { actions: ['project.read'], projects: [project.id] };
		const created = await expectOk<TokenMeta & { token: string }>(
			await request('POST', '/me/tokens/scoped', { name: 'read-only', grant }),
			201,
		);
		expect(created.grant).toEqual(grant);
		expect((await expectOk<TokenMeta[]>(await request('GET', '/me/tokens')))[0].grant).toEqual(
			grant,
		);
	});

	it.each([
		['an unknown action', { actions: ['project.fly'], projects: '*' }],
		['duplicate actions', { actions: ['project.read', 'project.read'], projects: '*' }],
		['an empty project list', { actions: '*', projects: [] }],
		['an invalid project id', { actions: '*', projects: ['project-one'] }],
		['an unexpected grant field', { actions: '*', projects: '*', future: true }],
		[
			'101 selected projects',
			{
				actions: '*',
				projects: Array.from(
					{ length: 101 },
					(_, index) => `proj-${String(index).padStart(16, '0')}`,
				),
			},
		],
	])('rejects a scoped token grant with %s', async (_label, grant) => {
		await expectError(
			await request('POST', '/me/tokens/scoped', { name: 'invalid', grant }),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('keeps the scoped creation body strict', async () => {
		await expectError(
			await request('POST', '/me/tokens/scoped', {
				name: 'strict',
				grant: FULL_GRANT,
				unexpected: true,
			}),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('does not disclose an inaccessible selected project', async () => {
		const other = createTestApi({ bucket, userId: uid('sub-other') });
		await other.request('GET', '/me');
		const project = await expectOk<{ id: string }>(
			await other.request('POST', '/projects', { name: 'Other', description: 'd' }),
			201,
		);
		await expectError(
			await request('POST', '/me/tokens/scoped', {
				name: 'probe',
				grant: { actions: '*', projects: [project.id] },
			}),
			404,
			'NOT_FOUND',
		);
	});

	it('rejects a blank name (422)', async () => {
		await expectError(await request('POST', '/me/tokens', { name: '' }), 422);
	});

	it('rejects an over-long name (422)', async () => {
		await expectError(await request('POST', '/me/tokens', { name: 'x'.repeat(101) }), 422);
	});

	it('rejects a whitespace-only name (422)', async () => {
		await expectError(await request('POST', '/me/tokens', { name: '   ' }), 422);
	});

	it('trims surrounding whitespace from the name', async () => {
		const data = await expectOk<TokenMeta>(
			await request('POST', '/me/tokens', { name: '  ci-deploy  ' }),
			201,
		);
		expect(data.name).toBe('ci-deploy');
	});

	it.each([
		['zero days', { name: 'ci', expires_in_days: 0 }],
		['negative days', { name: 'ci', expires_in_days: -5 }],
		['too many days', { name: 'ci', expires_in_days: 4000 }],
		['fractional days', { name: 'ci', expires_in_days: 1.5 }],
	])('rejects %s (422)', async (_label, body) => {
		await expectError(await request('POST', '/me/tokens', body), 422);
	});

	it('accepts the max expiry (3650 days)', async () => {
		const data = await expectOk<TokenMeta>(
			await request('POST', '/me/tokens', { name: 'long', expires_in_days: 3650 }),
			201,
		);
		expect(data.expires_at).toBeTruthy();
	});

	it('rejects a malformed token id on DELETE (422)', async () => {
		await expectError(await request('DELETE', '/me/tokens/not-a-valid-ulid'), 422);
	});

	it('rejects unauthenticated callers on every token route (401)', async () => {
		// A fresh app with the default deny-all authenticator.
		const app = createApi(makeTestDeps(bucket));
		await expectError(
			await app.request('/api/v1/me/tokens', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'x' }),
			}),
			401,
			'UNAUTHORIZED',
		);
		await expectError(
			await app.request('/api/v1/me/tokens/scoped', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'x', grant: FULL_GRANT }),
			}),
			401,
			'UNAUTHORIZED',
		);
		await expectError(await app.request('/api/v1/me/tokens'), 401, 'UNAUTHORIZED');
		await expectError(
			await app.request(`/api/v1/me/tokens/${'0'.repeat(26)}`, { method: 'DELETE' }),
			401,
			'UNAUTHORIZED',
		);
	});

	it('GET /me/tokens lists only the caller’s tokens', async () => {
		await request('POST', '/me/tokens', { name: 'mine' });
		const other = createTestApi({ bucket, userId: uid('sub-other') }).request;
		await other('GET', '/me');
		await other('POST', '/me/tokens', { name: 'theirs' });

		const mine = await expectOk<TokenMeta[]>(await request('GET', '/me/tokens'));
		expect(mine.map((t) => t.name)).toEqual(['mine']);
	});

	it('DELETE /me/tokens/{tokenId} revokes own tokens; 404 for others', async () => {
		const created = await expectOk<TokenMeta>(
			await request('POST', '/me/tokens', { name: 'doomed' }),
			201,
		);

		const other = createTestApi({ bucket, userId: uid('sub-other') }).request;
		await expectError(await other('DELETE', `/me/tokens/${created.id}`), 404, 'NOT_FOUND');

		expect((await request('DELETE', `/me/tokens/${created.id}`)).status).toBe(200);
		expect(await expectOk<TokenMeta[]>(await request('GET', '/me/tokens'))).toEqual([]);
	});

	it('enforces one per-user cap across legacy and scoped tokens', async () => {
		for (let i = 0; i < 19; i++) {
			await request('POST', '/me/tokens', { name: `t${i}` });
		}
		await request('POST', '/me/tokens/scoped', { name: 'scoped', grant: FULL_GRANT });
		await expectError(
			await request('POST', '/me/tokens/scoped', { name: 'over', grant: FULL_GRANT }),
			429,
			'RESOURCE_EXHAUSTED',
		);
	});

	it('advertises only cookieAuth (not bearerAuth) for the token-management routes', () => {
		// A PAT is rejected on these routes (403), so a generated client must never
		// offer bearerAuth here — the operation-level override enforces that.
		const doc = generateOpenApiDocument() as {
			paths: Record<string, Record<string, { security?: unknown }>>;
		};
		const collection = doc.paths['/api/v1/me/tokens'];
		expect(collection.post.security).toEqual([{ cookieAuth: [] }]);
		expect(collection.get.security).toEqual([{ cookieAuth: [] }]);
		expect(doc.paths['/api/v1/me/tokens/{tokenId}'].delete.security).toEqual([{ cookieAuth: [] }]);
	});

	it('emits token.create / token.revoke audit events', async () => {
		const { deps, request: req } = createTestApi({ bucket, userId: ACTOR });
		await req('GET', '/me');
		const created = await expectOk<TokenMeta>(
			await req('POST', '/me/tokens', { name: 'audited' }),
			201,
		);
		await req('DELETE', `/me/tokens/${created.id}`);

		const day = new Date().toISOString().slice(0, 10);
		const events = await deps.services.events.getEvents(day);
		const tokenEvents = events.filter((e) => e.event.startsWith('token.'));
		expect(tokenEvents.map((e) => e.event)).toEqual(['token.create', 'token.revoke']);
		expect(tokenEvents[0]).toMatchObject({ actor: ACTOR, token_id: created.id });
	});

	it('records a scoped grant in token.create audit metadata', async () => {
		const { deps, request: req } = createTestApi({ bucket, userId: ACTOR });
		await req('GET', '/me');
		const grant = { actions: ['project.read'], projects: '*' as const };
		await expectOk(await req('POST', '/me/tokens/scoped', { name: 'audited-scope', grant }), 201);

		const day = new Date().toISOString().slice(0, 10);
		const events = await deps.services.events.getEvents(day);
		expect(events.find((event) => event.event === 'token.create')).toMatchObject({ grant });
	});

	describe('with the composed (PAT-aware) authenticator', () => {
		let patRequest: (method: string, path: string, body?: unknown) => Promise<Response>;
		let patRequestWith: (
			scheme: string,
		) => (method: string, path: string, body?: unknown) => Promise<Response>;
		let token: string;

		beforeEach(async () => {
			// Wire the production composition: PAT bearer → TokenService, else stub SSO.
			const session = createTestApi({ bucket, userId: ACTOR });
			const composed = createApi({
				...session.deps,
				authenticator: composeAuthenticators(session.deps.services.tokens, {
					authenticate: async () => null,
				}),
			});
			await session.request('GET', '/me');
			({ token } = await expectOk<{ token: string }>(
				await session.request('POST', '/me/tokens', { name: 'ci' }),
				201,
			));
			patRequestWith = (scheme) => async (method, path, body) =>
				composed.request(`/api/v1${path}`, {
					method,
					headers: {
						authorization: `${scheme} ${token}`,
						...(body ? { 'content-type': 'application/json' } : {}),
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				});
			patRequest = patRequestWith('Bearer');
		});

		it('a PAT authenticates as the issuing user', async () => {
			const me = await expectOk<{ id: string; email: string }>(await patRequest('GET', '/me'));
			expect(me.id).toBe(ACTOR);
			expect(me.email).toBe(`${ACTOR}@example.com`);
		});

		it('a PAT may not create, list, or revoke tokens', async () => {
			await expectError(await patRequest('POST', '/me/tokens', { name: 'sneaky' }), 403);
			await expectError(
				await patRequest('POST', '/me/tokens/scoped', {
					name: 'sneaky',
					grant: FULL_GRANT,
				}),
				403,
				'FORBIDDEN',
			);
			await expectError(await patRequest('GET', '/me/tokens'), 403);
			await expectError(
				await patRequest('DELETE', `/me/tokens/${'0'.repeat(26)}`),
				403,
				'FORBIDDEN',
			);
		});

		// Regression: the guard must not re-parse the Authorization header with a
		// stricter case rule than the authenticator. A differently-cased scheme
		// (`BEARER`) still authenticates as the PAT, so it must still be barred from
		// managing tokens — otherwise a leaked PAT escalates to minting/revoking.
		it.each(['BEARER', 'bearer'])(
			'a PAT presented with the %s scheme still cannot manage tokens',
			async (scheme) => {
				const req = patRequestWith(scheme);
				// It authenticates (proving the case reaches the token path)...
				expect((await req('GET', '/me')).status).toBe(200);
				// ...yet is barred from every token-management route.
				await expectError(await req('POST', '/me/tokens', { name: 'sneaky' }), 403, 'FORBIDDEN');
				await expectError(await req('GET', '/me/tokens'), 403, 'FORBIDDEN');
				await expectError(await req('DELETE', `/me/tokens/${'0'.repeat(26)}`), 403, 'FORBIDDEN');
			},
		);

		it('an invalid PAT is 401, not a fall-through to SSO', async () => {
			const composed = createApi({
				...createTestApi({ bucket, userId: ACTOR }).deps,
				authenticator: composeAuthenticators(
					createTestApi({ bucket }).deps.services.tokens,
					// An SSO adapter that would happily authenticate — must not be reached.
					{
						authenticate: async () => ({
							id: ACTOR,
							email: 'sso@example.com',
							credential: { kind: 'sso' },
						}),
					},
				),
			});
			const res = await composed.request('/api/v1/me', {
				headers: { authorization: `Bearer mhub_pat_${'0'.repeat(26)}_${'a'.repeat(32)}` },
			});
			await expectError(res, 401, 'UNAUTHORIZED');
		});

		it('a revoked PAT stops working', async () => {
			const session = createTestApi({ bucket, userId: ACTOR }).request;
			const [{ id }] = await expectOk<TokenMeta[]>(await session('GET', '/me/tokens'));
			await session('DELETE', `/me/tokens/${id}`);
			await expectError(await patRequest('GET', '/me'), 401, 'UNAUTHORIZED');
		});

		// The PAT resolves to its issuing user, so a token minted by a super admin
		// carries super-admin power. Documented behavior — scope such tokens tightly.
		it('a PAT minted by a super admin inherits admin on a foreign project', async () => {
			// A project owned by a different user; the PAT holder (ACTOR) is not a member.
			const foreign = await createTestApi({ bucket }).deps.services.projects.createProject(
				{ name: 'Foreign', description: 'd' },
				uid('user_other'),
			);
			// Compose the PAT-aware app with ACTOR configured as a super admin.
			const composedGod = createApi({
				...createTestApi({ bucket, userId: ACTOR, deps: { policy: { superAdmins: [ACTOR] } } })
					.deps,
				authenticator: composeAuthenticators(createTestApi({ bucket }).deps.services.tokens, {
					authenticate: async () => null,
				}),
			});
			const res = await composedGod.request(`/api/v1/projects/${foreign.id}`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect((await expectOk<{ your_role: string }>(res)).your_role).toBe('admin');
		});

		it('a scoped PAT filters projects before pagination and limits a super admin', async () => {
			const session = createTestApi({
				bucket,
				userId: ACTOR,
				deps: { policy: { superAdmins: [ACTOR] } },
			});
			const allowed = await expectOk<{ id: string }>(
				await session.request('POST', '/projects', { name: 'Allowed', description: 'd' }),
				201,
			);
			const hidden = await expectOk<{ id: string }>(
				await session.request('POST', '/projects', { name: 'Hidden', description: 'd' }),
				201,
			);
			const scoped = await expectOk<{ token: string }>(
				await session.request('POST', '/me/tokens/scoped', {
					name: 'one-project-reader',
					grant: { actions: ['project.read'], projects: [allowed.id] },
				}),
				201,
			);
			const app = createApi({
				...session.deps,
				authenticator: composeAuthenticators(session.deps.services.tokens, {
					authenticate: async () => null,
				}),
			});
			const scopedRequest = (method: string, path: string, body?: unknown) =>
				app.request(`/api/v1${path}`, {
					method,
					headers: {
						authorization: `Bearer ${scoped.token}`,
						...(body ? { 'content-type': 'application/json' } : {}),
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				});

			expect(
				(await expectPage<{ id: string }>(await scopedRequest('GET', '/projects?limit=1'))).map(
					(project) => project.id,
				),
			).toEqual([allowed.id]);
			await expectOk(await scopedRequest('GET', `/projects/${allowed.id}`));
			await expectError(await scopedRequest('GET', `/projects/${hidden.id}`), 404, 'NOT_FOUND');
			await expectError(await scopedRequest('DELETE', `/projects/${allowed.id}`), 403, 'FORBIDDEN');
			await expectError(
				await scopedRequest('POST', '/projects', { name: 'Denied', description: 'd' }),
				404,
				'NOT_FOUND',
			);
		});

		it('a scoped PAT without project.read cannot list projects', async () => {
			const session = createTestApi({ bucket, userId: ACTOR });
			const scoped = await expectOk<{ token: string }>(
				await session.request('POST', '/me/tokens/scoped', {
					name: 'no-read',
					grant: { actions: [], projects: '*' },
				}),
				201,
			);
			const app = createApi({
				...session.deps,
				authenticator: composeAuthenticators(session.deps.services.tokens, {
					authenticate: async () => null,
				}),
			});
			await expectError(
				await app.request('/api/v1/projects', {
					headers: { authorization: `Bearer ${scoped.token}` },
				}),
				403,
				'FORBIDDEN',
			);
		});
	});
});
