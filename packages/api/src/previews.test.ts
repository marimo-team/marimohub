import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	createSandboxId,
	createSessionId,
	Millis,
	paths,
	StoredObjectError,
	WarmPoolService,
	WarmPoolStore,
} from '@marimo-hub/core';
import type { NotebookId, NotebookPreview, ProjectId, SourceControlReader } from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFakeSandbox } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk, stubSourceControl } from './testing';
import { cleanupPreview, sweepPreviews } from './previews';
import { sweepAppPools } from './appPools';

let api: ReturnType<typeof createTestApi>;
let pid: ProjectId;
let nid: NotebookId;
let preview: NotebookPreview;
let fake: ReturnType<typeof makeFakeSandbox>;
let reader: SourceControlReader;

beforeEach(async () => {
	const bucket = await createInitializedBucket();
	fake = makeFakeSandbox();
	reader = {
		provider: 'github',
		previews: true,
		supportsRepository: () => true,
		getBranchHead: vi.fn(async () => ({ commit: 'a'.repeat(40) })),
		resolveCommit: vi.fn(async (_repo, commit) => ({ commit })),
		fetchWorkspace: vi.fn(async () => [
			{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo') },
		]),
	};
	api = createTestApi({
		bucket,
		compute: fakeComputeFrom(fake.instance),
		deps: { sourceControl: stubSourceControl({ reader }) },
	});
	const services = api.deps.services;
	pid = (await services.projects.createProject({ name: 'Maintenance', description: '' }, ACTOR)).id;
	nid = (
		await services.notebooks.synced.create(
			pid,
			{
				title: 'Notebook',
				description: '',
				repo: 'owner/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'notebook.py',
				sync_mode: 'push',
			},
			ACTOR,
		)
	).meta.id;
	preview = await services.previews.create(
		pid,
		nid,
		{
			name: 'Review',
			source: { type: 'branch', branch: 'prototype' },
		},
		ACTOR,
		api.deps.sourceControl,
	);
	preview = await services.previews.prepare(preview, api.deps.sourceControl);
	expect(preview.preparation).toBe('ready');
});

afterEach(() => vi.restoreAllMocks());

async function runningSession(notebookId = preview.current!.notebook_id) {
	const sessions = api.deps.services.sessions;
	const session = await sessions.createSession({
		project_id: pid,
		notebook_id: notebookId,
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
		mode: 'app',
	});
	return sessions.setRunning(pid, session.session_id, 'https://sandbox.example');
}

describe('preview maintenance', () => {
	it('cleans preview execution namespaces without touching the parent app', async () => {
		const sessions = api.deps.services.sessions;
		const parent = await runningSession(nid);
		const child = await sessions.createSession({
			project_id: pid,
			notebook_id: preview.current!.notebook_id,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			mode: 'app',
			origin: {
				type: 'preview',
				notebook_id: nid,
				preview_id: preview.id,
				revision_id: preview.current!.version_id,
				commit: preview.current!.commit,
			},
		});
		await sessions.setRunning(pid, child.session_id, 'https://sandbox.example');
		await cleanupPreview(api.deps, await api.deps.services.previews.retire(preview));
		expect((await sessions.getSession(pid, child.session_id)).sandbox_reclaimed_at).toBeTruthy();
		expect((await sessions.getSession(pid, parent.session_id)).status).toBe('running');
		expect(fake.calls.destroy).toBe(1);
	});

	it.each(['starting', 'retiring'] as const)(
		'bounds %s app startup protection by its admission lease',
		async (state) => {
			const sessions = api.deps.services.sessions;
			const child = preview.current!.notebook_id;
			const pool = new AppPoolService(api.bucket, sessions);
			const admitted = await pool.admit({
				projectId: pid,
				notebookId: child,
				userId: ACTOR,
				versionId: preview.current!.version_id,
				startupMs: 60_000,
			});
			await sessions.createSession({
				project_id: pid,
				notebook_id: child,
				user_id: ACTOR,
				mode: 'app',
				session_id: admitted.member.session_id,
				sandbox_id: admitted.member.sandbox_id,
			});
			if (state === 'retiring') await pool.store.retireForDeletion(pid, child);
			const retired = await api.deps.services.previews.retire(preview);
			const clock = vi.spyOn(Date, 'now').mockReturnValue(admitted.member.operation_expires_at - 1);
			await cleanupPreview(api.deps, retired);
			expect(fake.calls.destroy).toBe(0);
			clock.mockReturnValue(admitted.member.operation_expires_at);
			await cleanupPreview(api.deps, retired);
			expect(fake.calls.destroy).toBe(1);
			expect(
				(await sessions.getSession(pid, admitted.member.session_id)).sandbox_reclaimed_at,
			).toBeTruthy();
		},
	);

	it('reaps committed admissions after session retention without dropping in-flight reservations', async () => {
		const { sessions, previews } = api.deps.services;
		const session = await runningSession();
		await previews.reserveAdmission(preview, session.notebook_id, session.session_id, 10);
		await previews.commitAdmission(preview, session.session_id);
		await sessions.markTerminated(pid, session.session_id);
		await sessions.markSandboxReclaimed(pid, session.session_id, new Date().toISOString());
		const pending = createSessionId();
		await previews.reserveAdmission(preview, session.notebook_id, pending, 10);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1);
		expect(await sessions.reapTerminated(Millis.seconds(0))).toBe(1);

		await sweepPreviews(api.deps);

		expect((await previews.get(pid, nid, preview.id)).admissions).toEqual([
			expect.objectContaining({ session_id: pending, committed: false }),
		]);
	});

	it('releases preview capacity when a warm app claim fails before session creation', async () => {
		const compute = { ...api.deps.compute, connectExisting: () => fake.instance };
		const warmPool = new WarmPoolService(
			new WarmPoolStore(api.bucket, 'kubernetes'),
			compute,
			api.deps.services.sessions,
			{
				enabled: true,
				size: 1,
				profiles: [{ key: 'default', resources: {} }],
				creationTimeoutMs: 300_000,
				minimumRemainingMs: 60_000,
			},
		);
		const warmApi = createTestApi({
			bucket: api.bucket,
			compute,
			deps: { ...api.deps, compute, warmPool },
		});
		await warmPool.sweep();
		vi.spyOn(AppPoolService.prototype, 'bindWarmSandbox').mockRejectedValue(
			new Error('reservation expired'),
		);
		const response = await warmApi.request(
			'POST',
			`/projects/${pid}/notebooks/${nid}/previews/${preview.id}/sessions`,
			{ mode: 'app' },
		);

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(fake.calls.destroy).toBeGreaterThan(0);
		expect(await api.deps.services.sessions.listByProject(pid)).toEqual([]);
		expect((await api.deps.services.previews.get(pid, nid, preview.id)).admissions).toEqual([]);
	});

	it('defers recently expired preview editors until the startup grace period ends', async () => {
		const sessions = api.deps.services.sessions;
		const session = await sessions.createSession({
			project_id: pid,
			notebook_id: preview.current!.notebook_id,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			mode: 'edit',
			ephemeral: true,
		});
		const started = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(started + 6 * 60_000);
		expect(await sessions.expireStale()).toBe(1);
		const retiring = await api.deps.services.previews.retire(preview);

		await cleanupPreview(api.deps, retiring);
		expect(fake.calls.destroy).toBe(0);
		expect((await sessions.getSession(pid, session.session_id)).status).toBe('expired');

		clock.mockReturnValue(started + 16 * 60_000);
		await cleanupPreview(api.deps, retiring);
		expect(fake.calls.destroy).toBe(1);
	});

	it.each([
		{ scope: 'project', failure: 'list' },
		{ scope: 'project', failure: 'retire' },
		{ scope: 'notebook', failure: 'list' },
		{ scope: 'notebook', failure: 'retire' },
	] as const)(
		'continues $scope deletion after preview $failure fails',
		async ({ scope, failure }) => {
			const { sessions, previews, jobs, jobRuns } = api.deps.services;
			const app = await runningSession(nid);
			const job = await jobs.createJob(pid, nid, { name: 'Scheduled' }, ACTOR);
			const run = await jobRuns.enqueue({
				job,
				trigger: 'manual',
				triggeredBy: ACTOR,
				timeoutSeconds: 60,
			});
			const error = new Error('preview storage unavailable');
			if (failure === 'retire') vi.spyOn(previews, 'retire').mockRejectedValue(error);
			else vi.spyOn(previews, 'projectRecords').mockRejectedValue(error);

			await expectOk(
				await api.request(
					'DELETE',
					scope === 'project' ? `/projects/${pid}` : `/projects/${pid}/notebooks/${nid}`,
				),
			);

			expect(await sessions.getSession(pid, app.session_id)).toMatchObject({
				status: 'terminated',
				sandbox_reclaimed_at: expect.any(String),
			});
			expect(fake.calls.destroy).toBe(1);
			expect((await jobRuns.getRun(pid, nid, job.id, run.run_id)).status).toBe('cancelled');
		},
	);

	it('leaves teardown to the winner of the terminating transition', async () => {
		const session = await runningSession();
		const sessions = api.deps.services.sessions;
		await sessions.beginTerminating(pid, session.session_id);
		const retiring = await api.deps.services.previews.retire(preview);

		await cleanupPreview(api.deps, retiring);

		expect(fake.calls.destroy).toBe(0);
		expect((await sessions.getSession(pid, session.session_id)).status).toBe('terminating');
		expect((await api.deps.services.previews.get(pid, nid, preview.id)).state).toBe('deleting');
	});

	it('retires the fresh session returned by the transition instead of the scanned snapshot', async () => {
		const sessions = api.deps.services.sessions;
		const oldId = createSandboxId();
		const currentId = createSandboxId();
		const stale = await sessions.createSession({
			project_id: pid,
			notebook_id: preview.current!.notebook_id,
			user_id: ACTOR,
			sandbox_id: oldId,
			mode: 'app',
		});
		await sessions.replaceStartingSandbox(pid, stale.session_id, oldId, currentId);
		await sessions.setRunning(pid, stale.session_id, 'https://sandbox.example');
		vi.spyOn(sessions, 'listByProject').mockResolvedValue([{ ...stale, status: 'running' }]);
		const create = vi.spyOn(api.deps.compute, 'create');
		const retiring = await api.deps.services.previews.retire(preview);

		await cleanupPreview(api.deps, retiring);

		expect(create.mock.calls.map(([id]) => id)).toContain(currentId);
		expect(create.mock.calls.map(([id]) => id)).not.toContain(oldId);
		expect(fake.calls.destroy).toBe(1);
		expect((await sessions.getSession(pid, stale.session_id)).sandbox_reclaimed_at).toBeTruthy();
	});

	it.each(['healthy', 'expired', 'deleted notebook', 'deleted project'] as const)(
		'handles a %s preview without a source-control registry',
		async (state) => {
			if (state === 'expired')
				vi.spyOn(Date, 'now').mockReturnValue(Date.parse(preview.expires_at) + 1);
			if (state === 'deleted notebook')
				await api.deps.services.notebooks.deleteNotebook(pid, nid, ACTOR);
			if (state === 'deleted project') await api.deps.services.projects.deleteProject(pid, ACTOR);

			await sweepPreviews({ ...api.deps, sourceControl: undefined });

			const current = await api.deps.services.previews.get(pid, nid, preview.id);
			expect(current.state).toBe(state === 'healthy' ? 'active' : 'deleted');
			if (state === 'healthy') {
				expect(current.preparation).toBe('ready');
				expect(current.current).toEqual(preview.current);
				expect(current.error).toBeUndefined();
			}
		},
	);

	it.each([
		{ expired: false, corrupt: undefined },
		{ expired: true, corrupt: undefined },
		{ expired: false, corrupt: 'json' },
		{ expired: true, corrupt: 'json' },
		{ expired: false, corrupt: 'ownership' },
		{ expired: true, corrupt: 'ownership' },
	])(
		'reclaims starting app allocations only after their lease expires: $expired, corrupt metadata: $corrupt',
		async ({ expired, corrupt }) => {
			const sessions = api.deps.services.sessions;
			const child = preview.current!.notebook_id;
			const pool = new AppPoolService(api.bucket, sessions);
			const admitted = await pool.admit({
				projectId: pid,
				notebookId: child,
				userId: ACTOR,
				versionId: preview.current!.version_id,
				startupMs: 60_000,
			});
			const session = await sessions.createSession({
				project_id: pid,
				notebook_id: child,
				user_id: ACTOR,
				mode: 'app',
				session_id: admitted.member.session_id,
				sandbox_id: admitted.member.sandbox_id,
				source_version_id: preview.current!.version_id,
			});
			if (expired)
				vi.spyOn(Date, 'now').mockReturnValue(admitted.member.operation_expires_at + 6 * 60_000);
			else await pool.store.retireForDeletion(pid, child);

			if (corrupt) await api.bucket.put(paths.project(pid).notebook(child).previewMeta, '{broken');
			expect(await sessions.expireStale()).toBe(0);
			await sweepAppPools(api.deps);

			const current = await sessions.getSession(pid, session.session_id);
			expect(fake.calls.destroy).toBe(expired ? 1 : 0);
			expect(current.status).toBe(expired ? 'terminated' : 'starting');
			expect(!!current.sandbox_reclaimed_at).toBe(expired);
			expect((await pool.store.read(pid, child))!.members).toHaveLength(expired ? 0 : 1);
		},
	);

	it.each(['normal', 'preview'] as const)(
		'reclaims retired pools despite corrupt %s metadata',
		async (kind) => {
			const notebookId = kind === 'preview' ? preview.current!.notebook_id : nid;
			if (kind === 'normal') {
				const source = await api.deps.services.notebooks.getNotebookSource(pid, nid);
				await api.bucket.put(
					paths.project(pid).notebook(nid).source,
					JSON.stringify({ ...source, current_version_id: preview.current!.version_id }),
				);
			}
			const pool = new AppPoolService(api.bucket, api.deps.services.sessions);
			const admitted = await pool.admit({
				projectId: pid,
				notebookId,
				userId: ACTOR,
				versionId: preview.current!.version_id,
				startupMs: 60_000,
			});
			const session = await api.deps.services.sessions.createSession({
				project_id: pid,
				notebook_id: notebookId,
				user_id: ACTOR,
				mode: 'app',
				session_id: admitted.member.session_id,
				sandbox_id: admitted.member.sandbox_id,
				source_version_id: preview.current!.version_id,
			});
			await api.deps.services.sessions.setRunning(
				pid,
				session.session_id,
				'https://sandbox.example',
			);
			await pool.store.retireForDeletion(pid, notebookId);
			const notebook = paths.project(pid).notebook(notebookId);
			await api.bucket.put(kind === 'preview' ? notebook.previewMeta : notebook.meta, '{broken');

			await sweepAppPools(api.deps);

			expect(fake.calls.destroy).toBe(1);
			expect((await pool.store.read(pid, notebookId))!.members).toHaveLength(0);
			expect(
				(await api.deps.services.sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at,
			).toBeTruthy();
		},
	);

	it('keeps a preview deleting until an unreadable session is repaired and reclaimed', async () => {
		const session = await runningSession();
		const key = paths.session(pid, session.session_id);
		await api.bucket.put(key, JSON.stringify({ ...session, status: 'corrupt' }));
		const retiring = await api.deps.services.previews.retire(preview);
		const runtimeMeta = paths.project(pid).notebook(session.notebook_id).previewMeta;

		await expect(cleanupPreview(api.deps, retiring)).rejects.toThrow(StoredObjectError);

		expect(fake.calls.destroy).toBe(0);
		expect((await api.deps.services.previews.get(pid, nid, preview.id)).state).toBe('deleting');
		expect(await api.bucket.get(runtimeMeta)).not.toBeNull();
		await api.bucket.put(key, JSON.stringify(session));
		await cleanupPreview(api.deps, retiring);
		expect(fake.calls.destroy).toBe(1);
		expect((await api.deps.services.previews.get(pid, nid, preview.id)).state).toBe('deleted');
		expect(await api.bucket.get(runtimeMeta)).not.toBeNull();
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await sweepPreviews(api.deps);
		expect(await api.bucket.get(runtimeMeta)).toBeNull();
	});
});
