import { vi, describe, it, expect, beforeEach } from 'vitest';

import { paths, ProjectId } from '@marimo-hub/core';
import type { Authenticator, TokenGrant } from '@marimo-hub/core';
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
		await request('POST', '/projects', { name: 'Standing', description: '' });
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

	it('denies arbitrary resolution by an uninvolved account, but permits self-resolution', async () => {
		const other = createTestApi({ bucket, userId: uid('other') }).request;
		await expectError(await other('GET', `/users?ids=${ACTOR}`), 403);
		expect(await expectOk(await other('GET', '/users?ids=other'))).toHaveProperty('other');
	});

	function withGrant(
		grant: TokenGrant,
		kind: 'personal-access-token' | 'service-account' = 'personal-access-token',
	) {
		const authenticator: Authenticator = {
			authenticate: async () => ({
				id: ACTOR,
				email: `${ACTOR}@example.com`,
				credential: { kind, grant },
			}),
		};
		return createTestApi({ bucket, deps: { authenticator } }).request;
	}

	it.each(['lookup,other', 'other,lookup', ' lookup,, other,lookup '])(
		'denies the entire mixed batch before reading directory records: %s',
		async (ids) => {
			const api = createTestApi({ bucket, userId: uid('lookup') });
			const lookup = vi.spyOn(api.deps.services.identities, 'getMany');
			await expectError(await api.request('GET', `/users?ids=${encodeURIComponent(ids)}`), 403);
			expect(lookup).not.toHaveBeenCalled();
		},
	);

	it.each(['personal-access-token', 'service-account'] as const)(
		'permits only self-resolution with a restricted %s',
		async (kind) => {
			const restricted = withGrant({ actions: ['org-integration.manage'], projects: '*' }, kind);
			expect(
				await expectOk(await restricted('GET', `/users?ids=${ACTOR},${ACTOR}`)),
			).toHaveProperty(ACTOR);
			expect(await expectOk(await restricted('GET', '/users?ids=,,%20'))).toEqual({});
			await expectError(await restricted('GET', `/users?ids=${ACTOR},other`), 403);
		},
	);

	it('reuses the current membership index for repeated denied directory requests', async () => {
		const other = createTestApi({ bucket, userId: uid('outsider') }).request;
		await other('GET', '/me');
		const get = vi.spyOn(bucket, 'get');
		for (const url of ['/users?ids=other', '/users/search?q=other', '/users?ids=other']) {
			await expectError(await other('GET', url), 403);
		}
		expect(get.mock.calls.filter(([key]) => key === paths.catalog)).toHaveLength(3);
		expect(get.mock.calls.filter(([key]) => key.startsWith('_system/snapshots/'))).toHaveLength(1);
	});

	it('revokes directory lookup after the only project membership is deleted', async () => {
		const member = uid('member');
		const other = createTestApi({ bucket, userId: member }).request;
		await other('GET', '/me');
		const project = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'Standing', description: '' }),
			201,
		);
		await expectOk(
			await request('POST', `/projects/${project.id}/members`, { user_id: member, role: 'viewer' }),
			201,
		);
		expect(await expectOk(await other('GET', `/users?ids=${ACTOR}`))).toHaveProperty(ACTOR);
		await expectOk(await request('DELETE', `/projects/${project.id}`));
		await expectError(await other('GET', `/users?ids=${ACTOR}`), 403);
	});

	it.each(['personal-access-token', 'service-account'] as const)(
		'denies arbitrary resolution with an integration-only %s',
		async (kind) => {
			await request('POST', '/projects', { name: 'Standing', description: '' });
			const restricted = withGrant({ actions: ['org-integration.manage'], projects: '*' }, kind);
			await expectError(await restricted('GET', '/users?ids=other'), 403);
		},
	);

	it('masks arbitrary lookup with a selected-project token', async () => {
		const project = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'P', description: '' }),
			201,
		);
		const restricted = withGrant({ actions: '*', projects: [ProjectId.parse(project.id)] });
		await expectError(await restricted('GET', '/users?ids=unrelated'), 404);
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

describe('GET /users batch size', () => {
	it.each([100, 101])('counts normalized ids at the batch boundary (%i ids)', async (count) => {
		const { request } = createTestApi();
		const ids = Array.from({ length: count }, (_, index) =>
			index === 0 ? ACTOR : `user-${index}`,
		);
		const query = encodeURIComponent(` , ${ids.join(', , ')}, `);
		const response = await request('GET', `/users?ids=${query}`);
		if (count > 100) {
			await expectError(response, 422, 'VALIDATION_ERROR');
		} else {
			const data = await expectOk<Record<string, unknown>>(response);
			expect(Object.keys(data)).toEqual([ACTOR]);
		}
	});

	it('rejects an unbounded ids list instead of fanning out to storage', async () => {
		const { app, bucket } = createTestApi();
		const reads = vi.spyOn(bucket, 'get');
		const ids = Array.from({ length: 1000 }, (_, index) => `user-${index}`).join(',');

		const res = await app.request(`/api/v1/users?ids=${ids}`);

		expect(res.status).toBe(422);
		expect(reads.mock.calls.length).toBeLessThan(200);
	});
});
