import { describe, it, expect, beforeEach } from 'vitest';
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

	it('rejects a non-admin member (403)', async () => {
		const pid = await createProject();
		const viewer = uid('user_viewer');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: viewer, role: 'viewer' }),
			201,
		);

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

	it('validates the date query and returns empty for an event-free day', async () => {
		const pid = await createProject();

		await expectError(await request('GET', `/projects/${pid}/events?date=yesterday`), 422);
		expect(await expectOk(await request('GET', `/projects/${pid}/events?date=2001-01-01`))).toEqual(
			[],
		);
	});
});
