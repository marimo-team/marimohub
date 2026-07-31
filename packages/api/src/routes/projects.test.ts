import { describe, it, expect, beforeEach } from 'vitest';
import { createProjectId } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
} from '../testing';

describe('Project routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket }).request;
	});

	it('GET /projects returns empty list initially', async () => {
		const res = await request('GET', '/projects');
		expect(await expectPage(res)).toEqual([]);
	});

	it('POST /projects creates a project', async () => {
		const res = await request('POST', '/projects', {
			name: 'ML Pipeline',
			description: 'ML notebooks',
		});
		const data = await expectOk<any>(res, 201);
		expect(data.name).toBe('ML Pipeline');
		expect(data.id).toMatch(/^proj-/);
	});

	it('POST /projects validates body — name required', async () => {
		const res = await request('POST', '/projects', { description: 'no name' });
		await expectError(res, 422);
	});

	it('GET /projects/{pid} returns the project', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'P1', description: 'd' }),
			201,
		);

		const data = await expectOk<any>(await request('GET', `/projects/${created.id}`));
		expect(data.name).toBe('P1');
	});

	it('PUT /projects/{pid} updates the project', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'Old', description: 'd' }),
			201,
		);

		const data = await expectOk<any>(
			await request('PATCH', `/projects/${created.id}`, { name: 'New' }),
		);
		expect(data.name).toBe('New');
	});

	it('PUT /projects/{pid} sets the federation opt-in and returns it', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'P', description: 'd' }),
			201,
		);
		expect(created.federation).toBeUndefined();

		const data = await expectOk<any>(
			await request('PATCH', `/projects/${created.id}`, {
				federation: { enabled: true, target: 'data' },
			}),
		);
		expect(data.federation).toEqual({ enabled: true, target: 'data' });

		// Persisted: a re-read carries it.
		const reread = await expectOk<any>(await request('GET', `/projects/${created.id}`));
		expect(reread.federation).toEqual({ enabled: true, target: 'data' });
	});

	it('DELETE /projects/{pid} deletes the project', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'Doomed', description: 'd' }),
			201,
		);

		await expectOk(await request('DELETE', `/projects/${created.id}`));

		expect(await expectPage(await request('GET', '/projects'))).toHaveLength(0);
	});

	it('GET /projects/{pid} 404s for a soft-deleted project', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'Doomed', description: 'd' }),
			201,
		);
		await expectOk(await request('DELETE', `/projects/${created.id}`));

		// The bytes linger until GC, but a soft-deleted project reads as gone.
		await expectError(await request('GET', `/projects/${created.id}`), 404, 'NOT_FOUND');
	});

	it('PUT/DELETE return 403 for a non-member', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'Owned', description: 'd' }),
			201,
		);

		// A different authenticated user who is not a member of the project.
		const stranger = createTestApi({ bucket, userId: uid('user_stranger') }).request;

		await expectError(
			await stranger('PATCH', `/projects/${created.id}`, { name: 'Hijacked' }),
			403,
		);
		await expectError(await stranger('DELETE', `/projects/${created.id}`), 403);

		// The project is untouched.
		const data = await expectOk<any>(await request('GET', `/projects/${created.id}`));
		expect(data.name).toBe('Owned');
	});

	it('GET /projects/{pid} returns 404 for non-existent project', async () => {
		await expectError(await request('GET', `/projects/${createProjectId()}`), 404);
	});

	it('GET /projects/{pid} returns 422 for invalid id format', async () => {
		await expectError(await request('GET', '/projects/invalid-id'), 422);
	});
});

describe('Project member routes', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let pid: string;
	const bob = uid('user_bob');

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		owner = createTestApi({ bucket }).request; // authed as ACTOR, the project owner
		const created = await expectOk<any>(
			await owner('POST', '/projects', { name: 'Team', description: 'd' }),
			201,
		);
		pid = created.id;
	});

	it('owner is admin and the sole initial member', async () => {
		const project = await expectOk<any>(await owner('GET', `/projects/${pid}`));
		expect(project.your_role).toBe('admin');
		const members = await expectOk<any[]>(await owner('GET', `/projects/${pid}/members`));
		expect(members).toEqual([{ user_id: ACTOR, role: 'admin' }]);
	});

	it('admin adds, lists, promotes, and removes a member', async () => {
		const added = await expectOk<any>(
			await owner('POST', `/projects/${pid}/members`, { user_id: bob, role: 'editor' }),
			201,
		);
		expect(added.members).toEqual(expect.arrayContaining([{ user_id: bob, role: 'editor' }]));

		// Bob now sees his effective role on the project he can read.
		const bobReq = createTestApi({ bucket, userId: bob }).request;
		expect((await expectOk<any>(await bobReq('GET', `/projects/${pid}`))).your_role).toBe('editor');

		const promoted = await expectOk<any>(
			await owner('PUT', `/projects/${pid}/members/${bob}`, { role: 'admin' }),
		);
		expect(promoted.members).toEqual(expect.arrayContaining([{ user_id: bob, role: 'admin' }]));

		await expectOk(await owner('DELETE', `/projects/${pid}/members/${bob}`));
		const members = await expectOk<any[]>(await owner('GET', `/projects/${pid}/members`));
		expect(members.map((m) => m.user_id)).not.toContain(bob);
	});

	it('rejects a duplicate member (409)', async () => {
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, { user_id: bob, role: 'viewer' }),
			201,
		);
		await expectError(
			await owner('POST', `/projects/${pid}/members`, { user_id: bob, role: 'editor' }),
			409,
		);
	});

	it('404 when updating/removing a non-member', async () => {
		await expectError(
			await owner('PUT', `/projects/${pid}/members/${bob}`, { role: 'admin' }),
			404,
		);
		await expectError(await owner('DELETE', `/projects/${pid}/members/${bob}`), 404);
	});

	it('the owner membership is immutable (409)', async () => {
		await expectError(
			await owner('PUT', `/projects/${pid}/members/${ACTOR}`, { role: 'viewer' }),
			409,
		);
		await expectError(await owner('DELETE', `/projects/${pid}/members/${ACTOR}`), 409);
	});

	it('non-admin cannot manage members (403)', async () => {
		const stranger = createTestApi({ bucket, userId: uid('user_x') }).request;
		await expectError(
			await stranger('POST', `/projects/${pid}/members`, { user_id: bob, role: 'editor' }),
			403,
		);
	});

	it('a non-member cannot see the project under the members-only default (404)', async () => {
		// The test harness leaves MARIMOHUB_DEFAULT_ROLE unset (`none`), so a
		// non-member gets 404 — the project is hidden, not merely read-only.
		const stranger = createTestApi({ bucket, userId: uid('user_y') }).request;
		await expectError(await stranger('GET', `/projects/${pid}`), 404);
	});

	it('validates the member role enum (422)', async () => {
		await expectError(
			await owner('POST', `/projects/${pid}/members`, { user_id: bob, role: 'superuser' }),
			422,
		);
	});

	it('requires exactly one of user_id and email (422)', async () => {
		await expectError(await owner('POST', `/projects/${pid}/members`, { role: 'editor' }), 422);
		await expectError(
			await owner('POST', `/projects/${pid}/members`, {
				user_id: bob,
				email: 'bob@example.com',
				role: 'editor',
			}),
			422,
		);
	});

	it('adding a known email stores the membership by user id', async () => {
		// Bob logs in once, so his email is in the identity directory.
		await createTestApi({ bucket, userId: bob }).request('GET', '/me');

		const added = await expectOk<any>(
			await owner('POST', `/projects/${pid}/members`, {
				email: `${bob}@example.com`,
				role: 'editor',
			}),
			201,
		);
		expect(added.members).toEqual(expect.arrayContaining([{ user_id: bob, role: 'editor' }]));
		expect(added.members.some((m: any) => m.email)).toBe(false);
	});

	it('adding an unknown email stores a pending invite that works on first login', async () => {
		const added = await expectOk<any>(
			await owner('POST', `/projects/${pid}/members`, {
				email: 'Newbie@Example.com',
				role: 'editor',
			}),
			201,
		);
		// Stored lowercased, as an email row.
		expect(added.members).toEqual(
			expect.arrayContaining([{ email: 'newbie@example.com', role: 'editor' }]),
		);

		// The invitee signs in (stub auth email is `${userId}@example.com`) and is
		// recognized by email: role gates and members-only visibility both pass.
		const newbie = createTestApi({ bucket, userId: uid('newbie') }).request;
		expect((await expectOk<any>(await newbie('GET', `/projects/${pid}`))).your_role).toBe('editor');
		const listed = await expectPage(await newbie('GET', '/projects'));
		expect(listed.map((p: any) => p.id)).toContain(pid);
	});

	it('updates and removes a pending invite by its URL-encoded email', async () => {
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, {
				email: 'invitee@example.com',
				role: 'viewer',
			}),
			201,
		);
		const selector = encodeURIComponent('invitee@example.com');

		const promoted = await expectOk<any>(
			await owner('PUT', `/projects/${pid}/members/${selector}`, { role: 'editor' }),
		);
		expect(promoted.members).toEqual(
			expect.arrayContaining([{ email: 'invitee@example.com', role: 'editor' }]),
		);

		await expectOk(await owner('DELETE', `/projects/${pid}/members/${selector}`));
		const members = await expectOk<any[]>(await owner('GET', `/projects/${pid}/members`));
		expect(members.some((m) => m.email === 'invitee@example.com')).toBe(false);
	});

	it('rejects a duplicate pending invite (409)', async () => {
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, {
				email: 'dup@example.com',
				role: 'viewer',
			}),
			201,
		);
		await expectError(
			await owner('POST', `/projects/${pid}/members`, {
				email: 'DUP@example.com',
				role: 'editor',
			}),
			409,
		);
	});

	it('rejects adding a user by id when their email already holds a pending invite (409)', async () => {
		// One person must never end up with both an invite row and an id row —
		// revoking one would silently leave the other granting access.
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, {
				email: `${bob}@example.com`,
				role: 'editor',
			}),
			201,
		);
		// Bob signs in, so his id resolves to that email in the directory.
		await createTestApi({ bucket, userId: bob }).request('GET', '/me');

		await expectError(
			await owner('POST', `/projects/${pid}/members`, { user_id: bob, role: 'viewer' }),
			409,
		);
		// Re-adding the same email (now resolvable to Bob's id) is also a duplicate.
		await expectError(
			await owner('POST', `/projects/${pid}/members`, {
				email: `${bob}@example.com`,
				role: 'viewer',
			}),
			409,
		);
	});

	it('hides pending-invite emails from non-admin members, except the invitee themself', async () => {
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, { user_id: bob, role: 'editor' }),
			201,
		);
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, {
				email: 'secret-invitee@example.com',
				role: 'viewer',
			}),
			201,
		);

		// Admin (owner) sees the invite row.
		const adminView = await expectOk<any[]>(await owner('GET', `/projects/${pid}/members`));
		expect(adminView.some((m) => m.email === 'secret-invitee@example.com')).toBe(true);

		// A non-admin member sees only id rows — on the members list AND the detail.
		const bobReq = createTestApi({ bucket, userId: bob }).request;
		const bobView = await expectOk<any[]>(await bobReq('GET', `/projects/${pid}/members`));
		expect(bobView.some((m) => m.email !== undefined)).toBe(false);
		const detail = await expectOk<any>(await bobReq('GET', `/projects/${pid}`));
		expect(detail.members.some((m: any) => m.email !== undefined)).toBe(false);

		// The invitee finds their own row (stub auth email matches the invite).
		const invitee = createTestApi({ bucket, userId: uid('secret-invitee') }).request;
		const inviteeView = await expectOk<any[]>(await invitee('GET', `/projects/${pid}/members`));
		expect(inviteeView.map((m) => m.email)).toContain('secret-invitee@example.com');
	});
});

describe('Read visibility (MARIMOHUB_DEFAULT_ROLE)', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let pid: string;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		owner = createTestApi({ bucket }).request; // ACTOR owns the project
		const created = await expectOk<any>(
			await owner('POST', '/projects', { name: 'Private', description: 'd' }),
			201,
		);
		pid = created.id;
	});

	it('none: a non-member cannot see or list the project, but the owner still can', async () => {
		const stranger = createTestApi({ bucket, userId: uid('user_out') }).request;
		await expectError(await stranger('GET', `/projects/${pid}`), 404);
		await expectError(await stranger('GET', `/projects/${pid}/notebooks`), 404);
		expect(await expectPage(await stranger('GET', '/projects'))).toEqual([]);
		expect(await expectPage(await owner('GET', '/projects'))).toHaveLength(1);
	});

	it('none: once added, the member can see and list the project', async () => {
		const bob = uid('user_bob');
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, { user_id: bob, role: 'viewer' }),
			201,
		);
		const bobReq = createTestApi({ bucket, userId: bob }).request;
		expect((await expectOk<any>(await bobReq('GET', `/projects/${pid}`))).your_role).toBe('viewer');
		expect(await expectPage(await bobReq('GET', '/projects'))).toHaveLength(1);
	});

	it('viewer default: every logged-in user can see and list the project read-only', async () => {
		const anyone = createTestApi({
			bucket,
			userId: uid('user_any'),
			deps: { policy: { defaultRole: 'viewer' } },
		}).request;
		expect((await expectOk<any>(await anyone('GET', `/projects/${pid}`))).your_role).toBe('viewer');
		expect(await expectPage(await anyone('GET', '/projects'))).toHaveLength(1);
	});
});

describe('Super admin (MARIMOHUB_SUPER_ADMINS)', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let pid: string;
	const godId = uid('user_god');

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		owner = createTestApi({ bucket }).request; // ACTOR owns the project
		const created = await expectOk<any>(
			await owner('POST', '/projects', { name: 'Private', description: 'd' }),
			201,
		);
		pid = created.id;
	});

	function god(superAdmins: string[]) {
		return createTestApi({ bucket, userId: godId, deps: { policy: { superAdmins } } }).request;
	}

	it('a non-member super admin sees, lists, and administers the project', async () => {
		const req = god([godId]);
		expect(await expectPage(await req('GET', '/projects'))).toHaveLength(1);
		expect((await expectOk<any>(await req('GET', `/projects/${pid}`))).your_role).toBe('admin');
		expect(
			(await expectOk<any>(await req('PATCH', `/projects/${pid}`, { name: 'Renamed' }))).name,
		).toBe('Renamed');
		await expectOk(
			await req('POST', `/projects/${pid}/members`, { user_id: uid('user_new'), role: 'editor' }),
			201,
		);
	});

	it('matches by email case-insensitively', async () => {
		// The stub authenticator's email is `${userId}@example.com`.
		const req = god(['USER_GOD@example.com']);
		expect((await expectOk<any>(await req('GET', `/projects/${pid}`))).your_role).toBe('admin');
	});

	it('still cannot demote or remove the project owner (409)', async () => {
		const req = god([godId]);
		await expectError(
			await req('PUT', `/projects/${pid}/members/${ACTOR}`, { role: 'viewer' }),
			409,
		);
		await expectError(await req('DELETE', `/projects/${pid}/members/${ACTOR}`), 409);
	});

	it('a soft-deleted project stays 404 even for a super admin', async () => {
		const etag = (await owner('GET', `/projects/${pid}`)).headers.get('ETag') ?? '';
		await expectOk(await owner('DELETE', `/projects/${pid}`, undefined, { 'If-Match': etag }));
		await expectError(await god([godId])('GET', `/projects/${pid}`), 404);
	});

	it('an unlisted user gets no elevation', async () => {
		const req = god(['someone-else@example.com']);
		await expectError(await req('GET', `/projects/${pid}`), 404);
	});

	// A caller whose id and login email diverge — the shape a namespace-collision
	// attack needs (the stub authenticator couples them, so build one by hand).
	function reqAs(id: string, email: string, superAdmins: string[]) {
		return createTestApi({
			bucket,
			deps: {
				authenticator: { authenticate: async () => ({ id: uid(id), email }) },
				policy: { superAdmins },
			},
		}).request;
	}

	it('an email entry never elevates a caller whose ID merely equals it', async () => {
		// superAdmins holds an email; the attacker sets their opaque IdP `sub` to
		// that exact string while their real (verified) email is their own.
		const attacker = reqAs('admin@example.com', 'attacker@evil.example', ['admin@example.com']);
		await expectError(await attacker('GET', `/projects/${pid}`), 404);
	});

	it('an id entry never elevates a caller whose email merely echoes it', async () => {
		// superAdmins holds an @-free id; a caller whose email local-part matches it
		// (but whose id does not) gains nothing.
		const attacker = reqAs('stranger_sub', 'user_admin@example.com', ['user_admin']);
		await expectError(await attacker('GET', `/projects/${pid}`), 404);
	});
});

describe('Project ETag / If-Match concurrency', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket }).request;
	});

	const makeProject = async () =>
		expectOk<any>(await request('POST', '/projects', { name: 'P', description: 'd' }), 201);

	it('GET returns a strong ETag of the resource version', async () => {
		const created = await makeProject();
		const res = await request('GET', `/projects/${created.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('ETag')).toBe(`"${created.updated_at}"`);
	});

	it('PUT with a matching If-Match succeeds; a stale one is rejected (412)', async () => {
		const created = await makeProject();
		const etag = (await request('GET', `/projects/${created.id}`)).headers.get('ETag')!;

		await expectError(
			await request('PATCH', `/projects/${created.id}`, { name: 'X' }, { 'If-Match': '"stale"' }),
			412,
			'PRECONDITION_FAILED',
		);

		const ok = await expectOk<any>(
			await request('PATCH', `/projects/${created.id}`, { name: 'New' }, { 'If-Match': etag }),
		);
		expect(ok.name).toBe('New');
	});

	it('DELETE rejects a stale If-Match (412) but works without a precondition', async () => {
		const created = await makeProject();
		await expectError(
			await request('DELETE', `/projects/${created.id}`, undefined, { 'If-Match': '"stale"' }),
			412,
			'PRECONDITION_FAILED',
		);
		await expectOk<any>(await request('DELETE', `/projects/${created.id}`));
	});
});

describe('Keyset pagination', () => {
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		request = createTestApi({ bucket: await createInitializedBucket() }).request;
	});

	it('pages through projects with a stable cursor and no overlap', async () => {
		for (let i = 0; i < 5; i++) {
			await request('POST', '/projects', { name: `P${i}`, description: 'd' });
		}

		const page1 = await expectOk<any>(await request('GET', '/projects?limit=2'));
		expect(page1.items).toHaveLength(2);
		expect(page1.next_cursor).toBeTruthy();

		const page2 = await expectOk<any>(
			await request('GET', `/projects?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`),
		);
		expect(page2.items).toHaveLength(2);

		const page3 = await expectOk<any>(
			await request('GET', `/projects?limit=2&cursor=${encodeURIComponent(page2.next_cursor)}`),
		);
		expect(page3.items).toHaveLength(1);
		expect(page3.next_cursor).toBeNull();

		// The three pages partition the five projects with no duplicates.
		const ids = [...page1.items, ...page2.items, ...page3.items].map((p: any) => p.id);
		expect(new Set(ids).size).toBe(5);
	});

	it('rejects a malformed cursor (400)', async () => {
		await expectError(await request('GET', '/projects?cursor=not~base64'), 400);
	});

	describe('Idempotency-Key', () => {
		let bucket: MemoryBucket;
		let request: ReturnType<typeof createTestApi>['request'];
		const body = { name: 'Idem', description: 'd' };

		beforeEach(async () => {
			bucket = await createInitializedBucket();
			request = createTestApi({ bucket }).request;
		});

		it('same key twice creates one project and replays the response', async () => {
			const first = await expectOk<any>(
				await request('POST', '/projects', body, { 'Idempotency-Key': 'key-1' }),
				201,
			);
			const second = await expectOk<any>(
				await request('POST', '/projects', body, { 'Idempotency-Key': 'key-1' }),
				201,
			);

			expect(second).toEqual(first);
			expect(await expectPage(await request('GET', '/projects'))).toHaveLength(1);
		});

		it('different keys create two projects', async () => {
			await request('POST', '/projects', body, { 'Idempotency-Key': 'key-a' });
			await request('POST', '/projects', body, { 'Idempotency-Key': 'key-b' });

			expect(await expectPage(await request('GET', '/projects'))).toHaveLength(2);
		});

		it('no key preserves today’s behavior (each request creates a project)', async () => {
			await request('POST', '/projects', body);
			await request('POST', '/projects', body);

			expect(await expectPage(await request('GET', '/projects'))).toHaveLength(2);
		});

		it('scopes the key per user: the same key for another user still creates', async () => {
			const mine = await expectOk<any>(
				await request('POST', '/projects', body, { 'Idempotency-Key': 'shared' }),
				201,
			);

			const other = createTestApi({ bucket, userId: uid('user_other') }).request;
			const theirs = await expectOk<any>(
				await other('POST', '/projects', body, { 'Idempotency-Key': 'shared' }),
				201,
			);

			// The shared key did not dedupe across users — two distinct projects exist,
			// each visible only to its own owner (harness default is members-only).
			expect(theirs.id).not.toBe(mine.id);
			expect(await expectPage(await request('GET', '/projects'))).toHaveLength(1);
			expect(await expectPage(await other('GET', '/projects'))).toHaveLength(1);
		});
	});
});
