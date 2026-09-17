import { describe, expect, it, vi } from 'vitest';
import {
	createNotebookId,
	createProjectId,
	createSandboxId,
	createSessionId,
	createVersionId,
	paths,
	AppPoolStore,
	RuntimeInspectionSchema,
} from '@marimo-hub/core';
import { ACTOR, makeLocalSource, makeSession } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk, expectError } from '../testing';

async function runtimeApi(superAdmin = true) {
	const bucket = await createInitializedBucket();
	return createTestApi({
		bucket,
		userId: ACTOR,
		deps: { policy: { superAdmins: superAdmin ? [ACTOR] : [] } },
	});
}

describe('GET /admin/runtime', () => {
	it('projects safe runtime fields, reports policy, and shares cached reads', async () => {
		const bucket = await createInitializedBucket();
		const pid = createProjectId();
		const nid = createNotebookId();
		const sid = createSessionId();
		const sandboxId = createSandboxId();
		const version = createVersionId();
		const now = Date.now();
		await bucket.put(
			paths.project(pid).notebook(nid).source,
			JSON.stringify(makeLocalSource(version)),
		);
		await bucket.put(
			paths.session(pid, sid),
			JSON.stringify(
				makeSession({
					project_id: pid,
					notebook_id: nid,
					session_id: sid,
					sandbox_id: sandboxId,
					mode: 'app',
					app_pool: true,
					source_version_id: version,
					sandbox_url: 'https://secret-client-url',
					sandbox_origin_url: 'https://secret-origin',
					kernel_auth_token: `mhub_kernel_${'a'.repeat(43)}`,
				}),
			),
		);
		await new AppPoolStore(bucket).mutate(pid, nid, (pool) => ({
			pool: {
				...pool,
				members: [
					{
						session_id: sid,
						sandbox_id: sandboxId,
						source_version_id: version,
						user_id: ACTOR,
						state: 'ready',
						created_at: now,
						operation_token: 'secret-operation',
						operation_expires_at: now + 60_000,
					},
				],
				assignments: [
					{
						user_id: ACTOR,
						session_id: sid,
						generation: 'secret-generation',
						visits: [{ visit_id: 'secret-visit', expires_at: now + 60_000 }],
					},
				],
			},
			value: undefined,
		}));
		const { request, deps } = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				policy: {
					superAdmins: [ACTOR],
					appPool: {
						maxUsersPerSession: 4,
						maxSessionsPerVersion: 3,
						userLeaseMs: 120_000,
						reconnectGraceMs: 15_000,
						idleMs: 1_800_000,
					},
				},
			},
		});
		const compute = vi.spyOn(deps.compute, 'create');
		const res = await request('GET', '/admin/runtime');
		expect(res.headers.get('cache-control')).toBe('no-store');
		const data = await expectOk(res);
		const snapshot = RuntimeInspectionSchema.parse(data);
		expect(data).toMatchObject({
			limits: { max_users_per_session: 4, max_sessions_per_version: 3 },
		});
		expect(snapshot.apps[0].sandboxes[0]).toMatchObject({
			session_id: sid,
			users: 1,
			version_status: 'current',
		});
		expect(JSON.stringify(data)).not.toMatch(
			/secret-|kernel_auth_token|operation_token|generation|visit_id|sandbox_url|sandbox_origin_url/,
		);
		const list = vi.spyOn(bucket, 'list');
		await expectOk(await request('GET', '/admin/runtime'));
		expect(list).not.toHaveBeenCalled();
		expect(compute).not.toHaveBeenCalled();
	});

	it('uses null for unlimited limits and returns empty arrays for an idle deployment', async () => {
		const bucket = await createInitializedBucket();
		const { request } = createTestApi({
			bucket,
			userId: ACTOR,
			deps: { policy: { superAdmins: [ACTOR] } },
		});
		expect(await expectOk(await request('GET', '/admin/runtime'))).toMatchObject({
			apps: [],
			editors: [],
			incomplete: false,
			limits: { max_users_per_session: null, max_sessions_per_version: null },
		});
	});
	it('authorizes before attempting an expensive runtime scan', async () => {
		const { request, deps } = await runtimeApi(false);
		const inspect = vi.spyOn(deps.services.runtimeInspection, 'inspect');
		await expectError(await request('GET', '/admin/runtime'), 403, 'FORBIDDEN');
		expect(inspect).not.toHaveBeenCalled();
	});

	it('returns a sanitized, non-cacheable error for a failed scan and recovers on retry', async () => {
		const { request, deps } = await runtimeApi();
		vi.spyOn(deps.services.runtimeInspection, 'inspect').mockRejectedValueOnce(
			new Error('secret-storage-credentials'),
		);
		const failed = await request('GET', '/admin/runtime');
		expect(failed.headers.get('cache-control')).toBe('no-store');
		const error = await expectError(failed, 500, 'INTERNAL_ERROR');
		expect(JSON.stringify(error)).not.toContain('secret-storage-credentials');
		expect(await expectOk(await request('GET', '/admin/runtime'))).toMatchObject({
			apps: [],
			editors: [],
			incomplete: false,
		});
	});

	it('returns partial data as a successful snapshot when optional catalog labels fail', async () => {
		const { request, deps } = await runtimeApi();
		vi.spyOn(deps.services.catalog, 'getCurrentSnapshot').mockRejectedValueOnce(
			new Error('catalog unavailable'),
		);
		const data = await expectOk(await request('GET', '/admin/runtime'));
		expect(data).toMatchObject({ apps: [], editors: [], incomplete: true });
	});
});
