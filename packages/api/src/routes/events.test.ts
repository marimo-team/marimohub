import { describe, it, expect, beforeEach } from 'vitest';
import { composeAuthenticators } from '@marimo-hub/core';
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

describe('Event routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket, userId: ACTOR }).request;
	});

	async function createProject(name = 'Audited') {
		const data = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name, description: 'd' }),
			201,
		);
		return data.id;
	}

	function superAdminApi() {
		return createTestApi({
			bucket,
			userId: ACTOR,
			deps: { policy: { superAdmins: [ACTOR] } },
		});
	}

	it('lists deployment events for super admins, newest first with opaque metadata', async () => {
		const { request: adminRequest, deps } = superAdminApi();
		await deps.services.events.append({
			event: 'token.create',
			actor: ACTOR,
			token_id: 'token-1',
			payload: { nested: ['value'] },
		});
		await deps.services.events.append({
			event: 'project.update',
			actor: ACTOR,
			project_id: 'proj-one',
		});

		const page = await expectOk<{
			items: Record<string, any>[];
			next_cursor: string | null;
		}>(await adminRequest('GET', '/events?limit=10'));
		expect(page.next_cursor).toBeNull();
		expect(page.items.map((event) => event.event)).toEqual(['project.update', 'token.create']);
		expect(page.items[1]).toMatchObject({
			id: expect.any(String),
			schema_version: 1,
			actor: ACTOR,
			metadata: { token_id: 'token-1', payload: { nested: ['value'] } },
		});
		expect(page.items[1].metadata.id).toBeUndefined();
	});

	it('paginates and combines exact deployment-event filters', async () => {
		const { request: adminRequest, deps } = superAdminApi();
		await deps.services.events.append({
			event: 'notebook.update',
			actor: ACTOR,
			project_id: 'proj-one',
		});
		await deps.services.events.append({
			event: 'notebook.update',
			actor: uid('someone-else'),
			project_id: 'proj-one',
		});
		await deps.services.events.append({
			event: 'notebook.create',
			actor: ACTOR,
			project_id: 'proj-one',
		});
		await deps.services.events.append({
			event: 'notebook.update',
			actor: ACTOR,
			project_id: 'proj-two',
		});

		const filtered = await expectOk<{ items: any[]; next_cursor: string | null }>(
			await adminRequest(
				'GET',
				`/events?event=notebook.update&actor=${ACTOR}&project_id=proj-one&limit=1`,
			),
		);
		expect(filtered.items).toHaveLength(1);
		expect(filtered.items[0].metadata.project_id).toBe('proj-one');
		expect(filtered.next_cursor).toBeNull();

		const first = await expectOk<{ items: any[]; next_cursor: string | null }>(
			await adminRequest('GET', '/events?limit=2'),
		);
		expect(first.items).toHaveLength(2);
		expect(first.next_cursor).toBeTruthy();
		const second = await expectOk<{ items: any[]; next_cursor: string | null }>(
			await adminRequest('GET', `/events?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`),
		);
		expect(second.items).toHaveLength(2);
		expect(new Set([...first.items, ...second.items].map((event) => event.id)).size).toBe(4);
	});

	it('requires deployment super-admin access for the global stream', async () => {
		await expectError(await request('GET', '/events'), 403, 'FORBIDDEN');

		const app = createApi(makeTestDeps(bucket));
		await expectError(await app.request('/api/v1/events'), 401, 'UNAUTHORIZED');
	});

	it('accepts a PAT issued by a super admin', async () => {
		const session = superAdminApi();
		await session.request('GET', '/me');
		const { token } = await expectOk<{ token: string }>(
			await session.request('POST', '/me/tokens', { name: 'audit-reader' }),
			201,
		);
		const app = createApi({
			...session.deps,
			authenticator: composeAuthenticators(session.deps.services.tokens, {
				authenticate: async () => null,
			}),
		});
		const page = await expectOk<{ items: any[] }>(
			await app.request('/api/v1/events', {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(page.items.some((event) => event.event === 'token.create')).toBe(true);
	});

	it('does not copy session-only group super-admin entitlement into a PAT', async () => {
		const deps = makeTestDeps(bucket, {
			authenticator: {
				authenticate: async () => ({
					credential: { kind: 'development' },
					id: ACTOR,
					email: `${ACTOR}@example.com`,
					entitlements: ['super-admin'],
					entitlementsExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				}),
			},
		});
		const sessionApp = createApi(deps);
		expect((await sessionApp.request('/api/v1/events')).status).toBe(200);
		const { token } = await expectOk<{ token: string }>(
			await sessionApp.request('/api/v1/me/tokens', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'must-not-escalate' }),
			}),
			201,
		);
		const patApp = createApi({
			...deps,
			authenticator: composeAuthenticators(deps.services.tokens, {
				authenticate: async () => null,
			}),
		});

		await expectError(
			await patApp.request('/api/v1/events', {
				headers: { authorization: `Bearer ${token}` },
			}),
			403,
			'FORBIDDEN',
		);
	});

	it('validates the global date range and cursor', async () => {
		const { request: adminRequest } = superAdminApi();
		await expectError(await adminRequest('GET', '/events?from=2026-01-01'), 422);
		await expectError(await adminRequest('GET', '/events?from=2026-02-01&to=2026-01-01'), 422);
		await expectError(await adminRequest('GET', '/events?from=2026-01-01&to=2026-01-31'), 422);
		await expectError(await adminRequest('GET', '/events?from=2026-02-30&to=2026-03-01'), 422);
		await expectError(await adminRequest('GET', '/events?cursor=not-base64'), 400, 'BAD_REQUEST');
	});

	it('returns the project’s events for today, in append order', async () => {
		const pid = await createProject();
		await expectOk(await request('PATCH', `/projects/${pid}`, { name: 'Renamed' }));

		const events = await expectOk<any[]>(await request('GET', `/projects/${pid}/events`));
		expect(events.map((e) => e.event)).toEqual(['project.create', 'project.update']);
		for (const e of events) {
			expect(e.project_id).toBe(pid);
			expect(e.actor).toBe(ACTOR);
			expect(e.ts).toBeTruthy();
		}
	});

	it('does not include events from other projects', async () => {
		const pid = await createProject('Mine');
		const other = await createProject('Other');
		await expectOk(await request('PATCH', `/projects/${other}`, { name: 'Elsewhere' }));

		const events = await expectOk<any[]>(await request('GET', `/projects/${pid}/events`));
		expect(events.map((e) => e.event)).toEqual(['project.create']);
		expect(events[0].project_id).toBe(pid);
	});

	it('allows a manager and rejects a lower-role member', async () => {
		const pid = await createProject();
		const manager = uid('user_manager');
		const viewer = uid('user_viewer');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: manager, role: 'manager' }),
			201,
		);
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: viewer, role: 'viewer' }),
			201,
		);

		const managerRequest = createTestApi({ bucket, userId: manager }).request;
		await expectOk(await managerRequest('GET', `/projects/${pid}/events`));
		const viewerRequest = createTestApi({ bucket, userId: viewer }).request;
		await expectError(await viewerRequest('GET', `/projects/${pid}/events`), 403);
	});

	it('a non-member super admin may read the audit trail', async () => {
		const pid = await createProject();
		const god = uid('user_god');
		const godRequest = createTestApi({
			bucket,
			userId: god,
			deps: { policy: { superAdmins: [god] } },
		}).request;
		const events = await expectOk<any[]>(await godRequest('GET', `/projects/${pid}/events`));
		expect(events.map((e) => e.event)).toEqual(['project.create']);
	});

	it('rejects unauthenticated callers (401)', async () => {
		const pid = await createProject();
		// A fresh app with the default deny-all authenticator.
		const app = createApi(makeTestDeps(bucket));
		await expectError(await app.request(`/api/v1/projects/${pid}/events`), 401, 'UNAUTHORIZED');
	});

	it('404s a soft-deleted project (lifecycle guard in assertProjectRole)', async () => {
		const pid = await createProject();
		await expectOk(await request('DELETE', `/projects/${pid}`));
		await expectError(await request('GET', `/projects/${pid}/events`), 404);
	});

	it('validates the date query and returns empty for an event-free day', async () => {
		const pid = await createProject();

		await expectError(await request('GET', `/projects/${pid}/events?date=yesterday`), 422);
		await expectError(await request('GET', `/projects/${pid}/events?date=2025-02-30`), 422);
		expect(await expectOk(await request('GET', `/projects/${pid}/events?date=2001-01-01`))).toEqual(
			[],
		);
	});
});
