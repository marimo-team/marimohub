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
	SessionRetirer,
} from '@marimo-hub/core';
import {
	ACTOR,
	makeLocalSource,
	makeSession,
	makeFakeSandbox,
	fakeComputeFrom,
} from '@marimo-hub/core/testing';
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
						maxVisitsPerSession: 4,
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

describe('POST /admin/runtime/projects/{pid}/sessions/{sid}/reclaim', () => {
	async function setup(
		status: 'expired' | 'running' | 'starting' | 'terminating' = 'expired',
		superAdmin = true,
	) {
		const bucket = await createInitializedBucket();
		const session = makeSession({
			status,
			sandbox_id: createSandboxId(),
			started_at: new Date(Date.now() - 3_600_000).toISOString(),
			last_heartbeat: new Date(Date.now() - 3_600_000).toISOString(),
			editor_sandbox_sharing: 'exclusive',
		});
		await bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify(session),
		);
		const { instance: sandbox } = makeFakeSandbox();
		vi.spyOn(sandbox, 'destroy');
		vi.spyOn(sandbox, 'exec');
		const api = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				compute: fakeComputeFrom(sandbox),
				policy: { superAdmins: superAdmin ? [ACTOR] : [] },
			},
		});
		await api.deps.services.sessions.claimEditor(
			session.project_id,
			session.notebook_id,
			session.session_id,
			'exclusive',
		);
		const path = `/admin/runtime/projects/${session.project_id}/sessions/${session.session_id}/reclaim`;
		return { ...api, bucket, session, sandbox, path };
	}

	it('discards one expired sandbox, releases its claim, refreshes inspection, and audits the action', async () => {
		const { request, deps, session, sandbox, path } = await setup();
		await expectOk(await request('GET', '/admin/runtime'));
		const append = vi.spyOn(deps.services.events, 'append');
		await expectOk(await request('POST', path, { save: false }));
		expect(sandbox.destroy).toHaveBeenCalledOnce();
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(
			await deps.services.sessions.getEditorClaim(session.project_id, session.notebook_id),
		).toMatchObject({ session_id: null });
		expect(
			await deps.services.sessions.getSession(session.project_id, session.session_id),
		).toHaveProperty('sandbox_reclaimed_at');
		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'session.reclaim',
				actor: ACTOR,
				session_id: session.session_id,
				save_requested: false,
				reclaimed: true,
			}),
		);
		expect(await expectOk(await request('GET', '/admin/runtime'))).toMatchObject({ editors: [] });
		await expectOk(await request('POST', path, { save: false }));
		expect(sandbox.destroy).toHaveBeenCalledOnce();
	});

	it.each([undefined, {}])('defaults to saving with body %j', async (body) => {
		const { request, path, session } = await setup();
		const reclaim = vi.spyOn(SessionRetirer.prototype, 'reclaim').mockResolvedValueOnce(true);
		try {
			await expectOk(await request('POST', path, body));
			expect(reclaim).toHaveBeenCalledWith(
				expect.objectContaining({ session_id: session.session_id }),
				{ save: true },
			);
		} finally {
			reclaim.mockRestore();
		}
	});

	it.each(['project', 'session'] as const)(
		'rejects a malformed %s ID before session lookup',
		async (field) => {
			const { request, deps, session, sandbox } = await setup();
			const read = vi.spyOn(deps.services.sessions, 'getSession');
			const pid = field === 'project' ? 'invalid-project' : session.project_id;
			const sid = field === 'session' ? 'invalid-session' : session.session_id;
			await expectError(
				await request('POST', `/admin/runtime/projects/${pid}/sessions/${sid}/reclaim`, {
					save: false,
				}),
				422,
				'VALIDATION_ERROR',
			);
			expect(read).not.toHaveBeenCalled();
			expect(sandbox.destroy).not.toHaveBeenCalled();
		},
	);

	it.each([null, 'true', 1])('rejects a non-boolean save choice: %j', async (save) => {
		const { request, path, sandbox } = await setup();
		await expectError(await request('POST', path, { save }), 422, 'VALIDATION_ERROR');
		expect(sandbox.destroy).not.toHaveBeenCalled();
	});

	it('directs unsupported safe attachment to explicit discard while retaining the claim', async () => {
		const { request, deps, bucket, path, session, sandbox } = await setup();
		delete deps.compute.connectExisting;
		await bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify({ ...session, sandbox_url: 'https://sandbox.example.com' }),
		);
		const error = await expectError(await request('POST', path), 503, 'SERVICE_UNAVAILABLE');
		expect(error.message).toContain('reclaim without saving to discard unsaved edits');
		expect(sandbox.destroy).not.toHaveBeenCalled();
		expect(
			await deps.services.sessions.getEditorClaim(session.project_id, session.notebook_id),
		).toMatchObject({ session_id: session.session_id });
		await expectOk(await request('POST', path, { save: false }));
		expect(sandbox.destroy).toHaveBeenCalledOnce();
	});

	it('retains the claim and reports a retryable failure when destruction fails', async () => {
		const { request, deps, session, sandbox, path } = await setup();
		vi.mocked(sandbox.destroy).mockRejectedValueOnce(new Error('compute unavailable'));
		const append = vi.spyOn(deps.services.events, 'append');
		const response = await request('POST', path, { save: false });
		expect(response.headers.get('retry-after')).toBe('2');
		await expectError(response, 503, 'SERVICE_UNAVAILABLE');
		expect(
			await deps.services.sessions.getEditorClaim(session.project_id, session.notebook_id),
		).toMatchObject({ session_id: session.session_id });
		expect(append).toHaveBeenCalledWith(expect.objectContaining({ reclaimed: false }));
		await expectOk(await request('POST', path, { save: false }));
	});

	it.each(['running', 'starting'] as const)(
		'rejects a %s session without touching compute',
		async (status) => {
			const { request, sandbox, path } = await setup(status);
			await expectError(await request('POST', path, { save: false }), 409, 'CONFLICT');
			expect(sandbox.destroy).not.toHaveBeenCalled();
		},
	);

	it('rejects a fresh teardown without racing its sandbox destruction', async () => {
		const { request, bucket, session, sandbox, path } = await setup('terminating');
		await bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify({ ...session, terminating_at: new Date().toISOString() }),
		);
		await expectError(await request('POST', path, { save: false }), 503, 'SERVICE_UNAVAILABLE');
		expect(sandbox.destroy).not.toHaveBeenCalled();
	});

	it('does not reclaim a session through another project', async () => {
		const { request, session, sandbox } = await setup();
		await expectError(
			await request(
				'POST',
				`/admin/runtime/projects/${createProjectId()}/sessions/${session.session_id}/reclaim`,
				{ save: false },
			),
			404,
			'NOT_FOUND',
		);
		expect(sandbox.destroy).not.toHaveBeenCalled();
	});

	it('authorizes before reading the session or touching compute', async () => {
		const { request, deps, sandbox, path } = await setup('expired', false);
		const read = vi.spyOn(deps.services.sessions, 'getSession');
		await expectError(await request('POST', path, { save: false }), 403, 'FORBIDDEN');
		expect(read).not.toHaveBeenCalled();
		expect(sandbox.destroy).not.toHaveBeenCalled();
	});
});
