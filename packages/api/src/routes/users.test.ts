import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectId } from '@marimo-hub/core';
import type { Authenticator } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createApi } from '../createApi';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	makeTestDeps,
} from '../testing';

describe('User routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		// Each authenticated request upserts the caller's identity into the
		// directory (auth middleware), so ACTOR is resolvable after the first call.
		request = createTestApi({ bucket, userId: ACTOR }).request;
		await request('GET', '/me');
	});

	it('GET /users resolves a known id to its display identity', async () => {
		const data = await expectOk<
			Record<string, { id: string; email: string; name: string; picture_url: string | null }>
		>(await request('GET', `/users?ids=${ACTOR}`));
		expect(data[ACTOR]).toEqual({
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			name: ACTOR, // email local-part fallback (stub auth supplies no name)
			picture_url: null,
		});
	});

	it('GET /users returns a persisted profile picture', async () => {
		const authenticator: Authenticator = {
			authenticate: async () => ({
				credential: { kind: 'development' },
				id: ACTOR,
				email: `${ACTOR}@example.com`,
				pictureUrl: 'https://images.example.com/ada.png',
			}),
		};
		const pictured = createTestApi({ bucket, deps: { authenticator } }).request;
		await pictured('GET', '/me');
		const data = await expectOk<Record<string, { picture_url: string | null }>>(
			await pictured('GET', `/users?ids=${ACTOR}`),
		);
		expect(data[ACTOR]?.picture_url).toBe('https://images.example.com/ada.png');
	});

	it('GET /users omits ids with no recorded identity', async () => {
		const data = await expectOk<Record<string, unknown>>(
			await request('GET', `/users?ids=${ACTOR},sub-unknown`),
		);
		expect(Object.keys(data)).toEqual([ACTOR]);
		expect(data['sub-unknown']).toBeUndefined();
	});

	it('GET /users with no ids returns an empty map', async () => {
		expect(await expectOk(await request('GET', '/users'))).toEqual({});
	});

	it('GET /users is rejected for unauthenticated callers (401)', async () => {
		// A fresh app with the default deny-all authenticator.
		const app = createApi(makeTestDeps(bucket));
		await expectError(await app.request(`/api/v1/users?ids=${ACTOR}`), 401, 'UNAUTHORIZED');
	});

	describe('GET /users/search', () => {
		beforeEach(async () => {
			// Seed the directory with a couple more logged-in users.
			await createTestApi({ bucket, userId: uid('ada') }).request('GET', '/me');
			await createTestApi({ bucket, userId: uid('adam') }).request('GET', '/me');
			// Search requires project involvement under members-only; ACTOR owns one.
			await request('POST', '/projects', { name: 'Standing', description: 'd' });
		});

		it('matches email/name/id substrings case-insensitively', async () => {
			const data = await expectOk<{ id: string }[]>(await request('GET', '/users/search?q=ADA'));
			expect(data.map((u) => u.id).sort()).toEqual(['ada', 'adam']);
		});

		it('respects the limit', async () => {
			const data = await expectOk<unknown[]>(await request('GET', '/users/search?q=ada&limit=1'));
			expect(data).toHaveLength(1);
		});

		it('returns an empty list when nothing matches', async () => {
			expect(await expectOk(await request('GET', '/users/search?q=zzz-nope'))).toEqual([]);
		});

		it('rejects an empty query (422)', async () => {
			await expectError(await request('GET', '/users/search?q='), 422);
		});

		it('is rejected for unauthenticated callers (401)', async () => {
			const app = createApi(makeTestDeps(bucket));
			await expectError(await app.request('/api/v1/users/search?q=ada'), 401, 'UNAUTHORIZED');
		});

		it('under members-only, a caller with no project involvement gets 403', async () => {
			// `ada` signed in (beforeEach) but owns/belongs to nothing; the harness
			// leaves MARIMOHUB_DEFAULT_ROLE unset (`none`), so the directory must not
			// be enumerable by a drive-by account.
			const ada = createTestApi({ bucket, userId: uid('ada') }).request;
			await expectError(await ada('GET', '/users/search?q=adam'), 403);
		});

		it('a project member may search under members-only', async () => {
			const project = await expectOk<any>(
				await request('POST', '/projects', { name: 'P', description: 'd' }),
				201,
			);
			await expectOk(
				await request('POST', `/projects/${project.id}/members`, {
					user_id: uid('ada'),
					role: 'viewer',
				}),
				201,
			);
			const ada = createTestApi({ bucket, userId: uid('ada') }).request;
			expect(await expectOk(await ada('GET', '/users/search?q=adam'))).toHaveLength(1);
		});

		it('does not let project involvement bypass a PAT action grant', async () => {
			const authenticator: Authenticator = {
				authenticate: async () => ({
					credential: {
						kind: 'personal-access-token',
						grant: { actions: ['project.read'], projects: '*' },
					},
					id: ACTOR,
					email: `${ACTOR}@example.com`,
				}),
			};
			const pat = createTestApi({ bucket, deps: { authenticator } }).request;
			await expectError(await pat('GET', '/users/search?q=adam'), 403, 'FORBIDDEN');
		});

		it('does not require project.read when a PAT can search under a default role', async () => {
			const authenticator: Authenticator = {
				authenticate: async () => ({
					credential: {
						kind: 'personal-access-token',
						grant: { actions: ['directory.search'], projects: '*' },
					},
					id: uid('ada'),
					email: 'ada@example.com',
				}),
			};
			const pat = createTestApi({
				bucket,
				deps: { authenticator, policy: { defaultRole: 'viewer' } },
			}).request;

			expect(await expectOk(await pat('GET', '/users/search?q=adam'))).toHaveLength(1);
		});

		it('masks deployment search from a selected-project PAT', async () => {
			const project = await expectOk<{ id: string }>(
				await request('POST', '/projects', { name: 'Selected', description: 'd' }),
				201,
			);
			const authenticator: Authenticator = {
				authenticate: async () => ({
					credential: {
						kind: 'personal-access-token',
						grant: { actions: '*', projects: [ProjectId.parse(project.id)] },
					},
					id: ACTOR,
					email: `${ACTOR}@example.com`,
				}),
			};
			const pat = createTestApi({ bucket, deps: { authenticator } }).request;
			await expectError(await pat('GET', '/users/search?q=adam'), 404, 'NOT_FOUND');
		});

		it('anyone may search when a default role opens the deployment', async () => {
			const anyone = createTestApi({
				bucket,
				userId: uid('ada'),
				deps: { policy: { defaultRole: 'viewer' } },
			}).request;
			expect(await expectOk(await anyone('GET', '/users/search?q=adam'))).toHaveLength(1);
		});

		it('a group-derived default role opens directory search under members-only', async () => {
			const authenticator: Authenticator = {
				authenticate: async () => ({
					credential: { kind: 'development' },
					id: uid('ada'),
					email: 'ada@example.com',
					entitlements: ['default-role:viewer'],
				}),
			};
			const entitled = createTestApi({ bucket, deps: { authenticator } }).request;

			expect(await expectOk(await entitled('GET', '/users/search?q=adam'))).toHaveLength(1);
		});

		it('a super admin with no project involvement may search under members-only', async () => {
			const god = createTestApi({
				bucket,
				userId: uid('ada'),
				deps: { policy: { superAdmins: [uid('ada')] } },
			}).request;
			expect(await expectOk(await god('GET', '/users/search?q=adam'))).toHaveLength(1);
		});

		it('a group-derived super admin may search under members-only', async () => {
			const authenticator: Authenticator = {
				authenticate: async () => ({
					credential: { kind: 'development' },
					id: uid('ada'),
					email: 'ada@example.com',
					entitlements: ['super-admin'],
				}),
			};
			const god = createTestApi({ bucket, deps: { authenticator } }).request;

			expect(await expectOk(await god('GET', '/users/search?q=adam'))).toHaveLength(1);
		});
	});
});
