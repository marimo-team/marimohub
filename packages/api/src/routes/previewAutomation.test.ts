import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createServices,
	PreviewId,
	PreviewReconcileSchema,
	NotFoundError,
	paths,
} from '@marimo-hub/core';
import type {
	NotebookId,
	ProjectId,
	SourceControlReader,
	AuthorizationAction,
} from '@marimo-hub/core';
import { ACTOR, makeFakeCompute, uid } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	stubSourceControl,
} from '../testing';
import { sweepPreviews } from '../previews';

let api: ReturnType<typeof createTestApi>;
let pid: ProjectId;
let nid: NotebookId;
let base: string;
let head: string;
let state: 'open' | 'closed';
let reader: SourceControlReader;
const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const THIRD = 'c'.repeat(40);
const FOURTH = 'd'.repeat(40);
type Result = {
	state: string;
	pending: boolean;
	items: {
		id: string;
		name: string;
		target_commit: string;
		eager: boolean;
		expires_at: string | null;
		preparation: string;
		commit?: string;
	}[];
};

beforeEach(async () => {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	pid = (await services.projects.createProject({ name: 'Previews', description: '' }, ACTOR)).id;
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
	head = SHA;
	state = 'open';
	reader = {
		provider: 'github',
		previews: true,
		supportsRepository: () => true,
		getBranchHead: vi.fn(async () => ({ commit: head })),
		resolveCommit: vi.fn(async (_repo, commit) => ({ commit })),
		fetchWorkspace: vi.fn(async () => [
			{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo\napp = marimo.App()') },
		]),
		getPullRequest: vi.fn(async () => ({
			number: 1,
			state,
			branch: 'feature/chart',
			commit: head,
			sameRepository: true,
		})),
	};
	api = createTestApi({
		bucket,
		compute: makeFakeCompute(),
		deps: { sourceControl: stubSourceControl({ reader }) },
	});
	base = `/projects/${pid}/notebooks/${nid}/previews`;
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function event(
	order: number,
	commit = SHA,
	policy = {},
	action: 'opened' | 'synchronize' | 'reopened' | 'closed' = 'synchronize',
) {
	return {
		repository: 'owner/repo',
		pull_request: 1,
		event: action,
		commit,
		workflow_id: '10',
		run_id: String(order),
		run_number: order,
		event_at: new Date(Date.now()).toISOString(),
		policy: { mode: 'sticky', keep: 5, eager: true, ...policy },
	};
}
async function reconcile(
	order: number,
	commit = SHA,
	policy = {},
	action: 'opened' | 'synchronize' | 'reopened' | 'closed' = 'synchronize',
) {
	return expectOk<Result>(
		await api.request('POST', `${base}/reconcile`, event(order, commit, policy, action)),
		202,
	);
}
async function record(id: string) {
	return api.deps.services.previews.get(pid, nid, PreviewId.parse(id));
}
async function prepare(id: string) {
	return api.deps.services.previews.prepare(await record(id), api.deps.sourceControl, true);
}

async function createLazyBranch() {
	return expectOk<{ id: string }>(
		await api.request('POST', base, {
			name: 'Lazy branch',
			source: { type: 'branch', branch: 'feature/chart' },
			eager: false,
		}),
		202,
	);
}

describe('PR preview automation', () => {
	it('reuses the sticky ID across commits and retries, with no finite expiry', async () => {
		const first = await reconcile(1);
		expect(first.items[0]).toMatchObject({ name: 'feature/chart', expires_at: null, eager: true });
		await prepare(first.items[0].id);
		head = NEXT;
		const second = await reconcile(2, NEXT);
		expect(second.items[0].id).toBe(first.items[0].id);
		expect((await reconcile(2, NEXT)).items).toEqual(second.items);
		await prepare(first.items[0].id);
		expect((await record(first.items[0].id)).current?.commit).toBe(NEXT);
	});

	it('retains heads by event order, deduplicates retries, and fences evicted jobs', async () => {
		const policy = { mode: 'commits', keep: 2 };
		const first = await reconcile(1, SHA, policy);
		await reconcile(3, THIRD, policy);
		const result = await reconcile(2, NEXT, policy);
		expect(result.items.map((item) => item.target_commit).sort()).toEqual([NEXT, THIRD]);
		expect((await record(first.items[0].id)).state).toBe('deleting');
		expect(
			(await reconcile(1, SHA, policy)).items.map((item) => item.target_commit).sort(),
		).toEqual([NEXT, THIRD]);
		expect((await reconcile(2, NEXT, policy)).items).toHaveLength(2);
	});

	it('does not apply settings from an older job', async () => {
		await reconcile(3, THIRD, { mode: 'commits', keep: 2, eager: false });
		const result = await reconcile(2, NEXT, { mode: 'sticky', eager: true });
		expect(result.items).toHaveLength(2);
		expect(result.items.map((item) => ({ name: item.name, eager: item.eager }))).toEqual(
			expect.arrayContaining([
				{ name: `feature/chart-${NEXT.slice(0, 12)}`, eager: false },
				{ name: `feature/chart-${THIRD.slice(0, 12)}`, eager: false },
			]),
		);
	});

	it('preserves commit identities on force pushes and repeated retained SHAs', async () => {
		const policy = { mode: 'commits', keep: 3 };
		const first = await reconcile(1, SHA, policy);
		await reconcile(2, NEXT, policy);
		const again = await reconcile(3, SHA, policy);
		expect(again.items).toHaveLength(2);
		expect(again.items.find((item) => item.target_commit === SHA)?.id).toBe(first.items[0].id);
	});

	it('serializes concurrent identical deliveries', async () => {
		const results = await Promise.all([reconcile(1), reconcile(1)]);
		expect(results[0].items[0].id).toBe(results[1].items[0].id);
		expect((await api.deps.services.previews.store.project(pid)).entries).toHaveLength(1);
	});

	it('recovers an interrupted materialization on the maintenance pass', async () => {
		const plan = vi
			.spyOn(api.deps.services.previews, 'projectRecords')
			.mockRejectedValueOnce(new Error('interrupted'));
		await expectError(await api.request('POST', `${base}/reconcile`, event(1)), 500);
		plan.mockRestore();
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		const records = await api.deps.services.previews.list(pid, nid);
		expect(records).toHaveLength(1);
		expect(records[0].current?.commit).toBe(SHA);
	});

	it('keeps lazy previews unprepared until requested, then defers each new head', async () => {
		const first = (await reconcile(1, SHA, { eager: false })).items[0];
		await prepare(first.id);
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		await prepare(first.id);
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(1);
		head = NEXT;
		await reconcile(2, NEXT, { eager: false });
		await prepare(first.id);
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(1);
		expect((await record(first.id)).preparation).toBe('deferred');
		expect((await record(first.id)).current?.commit).toBe(SHA);
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		await prepare(first.id);
		expect((await record(first.id)).current?.commit).toBe(NEXT);
	});

	it('does not prepare lazy code from list/get polling', async () => {
		const first = (await reconcile(1, SHA, { eager: false })).items[0];
		const write = vi.spyOn(api.bucket, 'put');
		await expectOk(await api.request('GET', base));
		await expectOk(await api.request('GET', `${base}/${first.id}`));
		expect(write).not.toHaveBeenCalled();
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
	});

	it('keeps the previous revision after a preparation failure', async () => {
		const first = (await reconcile(1)).items[0];
		await prepare(first.id);
		head = NEXT;
		await reconcile(2, NEXT);
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('network'));
		await prepare(first.id);
		expect(await record(first.id)).toMatchObject({
			preparation: 'failed',
			current: { commit: SHA },
		});
	});

	it('retires lazy previews when maintenance observes a closed PR', async () => {
		const first = (await reconcile(1, SHA, { eager: false })).items[0];
		state = 'closed';
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		expect((await record(first.id)).state).toBe('deleting');
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
	});

	it('closes all previews and only accepts a new reopen lifecycle', async () => {
		const first = (await reconcile(1)).items[0];
		state = 'closed';
		expect((await reconcile(2, SHA, {}, 'closed')).items).toEqual([]);
		state = 'open';
		expect((await reconcile(1)).items).toEqual([]);
		const reopened = await reconcile(3, SHA, {}, 'reopened');
		expect(reopened.items[0].id).not.toBe(first.id);
		await expectError(
			await api.request('POST', `${base}/reconcile`, event(2, SHA, {}, 'closed')),
			409,
		);
		expect((await record(reopened.items[0].id)).state).toBe('active');
	});

	it('renews inactivity only for a new head and expires all retained previews together', async () => {
		const now = Date.now();
		const time = vi.spyOn(Date, 'now').mockReturnValue(now);
		const policy = { mode: 'commits', keep: 3, idle_days: 1 };
		const first = (await reconcile(1, SHA, policy)).items[0];
		time.mockReturnValue(now + 3600000);
		expect((await reconcile(1, SHA, policy)).items[0].expires_at).toBe(first.expires_at);
		const second = await reconcile(2, NEXT, policy);
		expect(new Set(second.items.map((item) => item.expires_at)).size).toBe(1);
		expect(second.items[0].expires_at).toBe(new Date(now + 3600000 + 86400000).toISOString());
		time.mockReturnValue(now + 3600000 + 86400001);
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		expect(await api.deps.services.previews.list(pid, nid)).toEqual([]);
	});

	it('switches policy without touching manual previews', async () => {
		const manual = await expectOk<{ id: string }>(
			await api.request('POST', base, { name: 'manual', source: { type: 'commit', commit: SHA } }),
			202,
		);
		const sticky = (await reconcile(1)).items[0];
		const commits = await reconcile(2, NEXT, { mode: 'commits' });
		expect(commits.items[0].name).toBe(`feature/chart-${NEXT.slice(0, 12)}`);
		expect((await record(sticky.id)).state).toBe('deleting');
		const next = await reconcile(3, THIRD);
		expect(next.items[0].name).toBe('feature/chart');
		expect((await record(commits.items[0].id)).state).toBe('deleting');
		expect((await record(manual.id)).state).toBe('active');
	});

	it('retries pending capacity after cleanup without another event', async () => {
		for (let i = 0; i < 25; i++)
			await api.deps.services.previews.create(
				pid,
				nid,
				{ name: `manual ${i}`, source: { type: 'commit', commit: SHA } },
				ACTOR,
				api.deps.sourceControl,
			);
		const result = await reconcile(1);
		expect(result).toMatchObject({ pending: true, items: [] });
		const manual = (await api.deps.services.previews.list(pid, nid))[0];
		await api.deps.services.previews.retire(manual);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
		await sweepPreviews(api.deps);
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		const records = await api.deps.services.previews.list(pid, nid);
		expect(records.filter((item) => item.automation)).toHaveLength(1);
	});

	it('rejects another repository, workflow, and unauthorized managers', async () => {
		await expectError(
			await api.request('POST', `${base}/reconcile`, { ...event(1), repository: 'other/repo' }),
			400,
		);
		await reconcile(1);
		await expectError(
			await api.request('POST', `${base}/reconcile`, { ...event(2), workflow_id: '20' }),
			409,
		);
		await api.deps.services.projects.addMember(pid, { user_id: uid('editor') }, 'editor', ACTOR);
		const editor = createTestApi({
			bucket: api.bucket,
			userId: uid('editor'),
			deps: { sourceControl: api.deps.sourceControl },
		});
		await expectError(await editor.request('POST', `${base}/reconcile`, event(3)), 403);
	});

	it('permits a scoped preview manager token but rejects a read-only token', async () => {
		const tokenApi = (actions: AuthorizationAction[]) =>
			createTestApi({
				bucket: api.bucket,
				deps: {
					sourceControl: api.deps.sourceControl,
					authenticator: {
						authenticate: async () => ({
							id: ACTOR,
							email: 'actor@example.com',
							credential: { kind: 'personal-access-token', grant: { actions, projects: [pid] } },
						}),
					},
				},
			});
		await expectError(
			await tokenApi(['project.read']).request('POST', `${base}/reconcile`, event(1)),
			403,
		);
		expect(reader.getPullRequest).not.toHaveBeenCalled();
		await expectOk(
			await tokenApi(['preview.manage']).request('POST', `${base}/reconcile`, event(1)),
			202,
		);
	});

	it('accepts a new push after a verified reopen even if its reopen job arrives later', async () => {
		await reconcile(1);
		state = 'closed';
		await reconcile(2, SHA, {}, 'closed');
		state = 'open';
		const pushed = await reconcile(4, NEXT);
		expect(pushed.items).toHaveLength(1);
		expect((await reconcile(3, SHA, {}, 'reopened')).items[0].id).toBe(pushed.items[0].id);
		expect((await record(pushed.items[0].id)).automation?.commit).toBe(NEXT);
	});

	it('does not retire a prepared preview when GitHub access temporarily fails', async () => {
		const first = (await reconcile(1)).items[0];
		await prepare(first.id);
		vi.mocked(reader.getPullRequest!).mockRejectedValue(new Error('GitHub unavailable'));
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		expect(await record(first.id)).toMatchObject({ state: 'active', current: { commit: SHA } });
	});

	it('reclaims a preview retired before its initial record was materialized', async () => {
		const materialize = vi
			.spyOn(api.deps.services.previews, 'projectRecords')
			.mockRejectedValueOnce(new Error('interrupted before publication'));
		await expectError(await api.request('POST', `${base}/reconcile`, event(1)), 500);
		materialize.mockRestore();
		state = 'closed';
		await reconcile(2, SHA, {}, 'closed');
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.store.project(pid)).entries).toEqual([]);
	});

	it('matches GitHub Enterprise repository paths without losing host validation', async () => {
		const notebook = await api.deps.services.notebooks.synced.create(
			pid,
			{
				title: 'Enterprise',
				description: '',
				repo: 'https://git.example.test/Owner/Repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'notebook.py',
				sync_mode: 'push',
			},
			ACTOR,
		);
		const endpoint = `/projects/${pid}/notebooks/${notebook.meta.id}/previews/reconcile`;
		await expectOk(await api.request('POST', endpoint, event(1)), 202);
		await expectError(
			await api.request('POST', endpoint, {
				...event(2),
				repository: 'https://other.example.test/Owner/Repo',
			}),
			400,
		);
	});

	it('rejects reusing a historical event order for another commit', async () => {
		await reconcile(1, SHA, { mode: 'commits' });
		await reconcile(2, NEXT, { mode: 'commits' });
		await expectError(
			await api.request('POST', `${base}/reconcile`, event(1, THIRD, { mode: 'commits' })),
			409,
		);
	});

	it('validates the retention and inactivity bounds', () => {
		expect(PreviewReconcileSchema.safeParse(event(1, FOURTH, { keep: 26 })).success).toBe(false);
		expect(PreviewReconcileSchema.safeParse(event(1, FOURTH, { idle_days: 31 })).success).toBe(
			false,
		);
	});
	it.each(['fork', 'missing-app', 'github-error'] as const)(
		'does not persist intent when source verification fails: %s',
		async (failure) => {
			if (failure === 'fork')
				vi.mocked(reader.getPullRequest!).mockResolvedValue({
					number: 1,
					state: 'open',
					branch: 'feature/chart',
					commit: SHA,
					sameRepository: false,
				});
			if (failure === 'missing-app')
				vi.spyOn(api.deps.sourceControl!, 'getReader').mockReturnValue(undefined);
			if (failure === 'github-error')
				vi.mocked(reader.getPullRequest!).mockRejectedValue(new Error('GitHub unavailable'));
			await expectError(
				await api.request('POST', `${base}/reconcile`, event(1)),
				failure === 'github-error' ? 500 : 400,
			);
			const project = await api.deps.services.previews.store.project(pid);
			expect(project.entries).toEqual([]);
			expect(project.automations ?? []).toEqual([]);
			expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		},
	);

	it('rejects future event timestamps without consuming the run number', async () => {
		await expectError(
			await api.request('POST', `${base}/reconcile`, {
				...event(1),
				event_at: new Date(Date.now() + 120000).toISOString(),
			}),
			400,
		);
		expect((await reconcile(1)).items).toHaveLength(1);
	});

	it('retries a lazy preparation failure without requiring another visit', async () => {
		const first = (await reconcile(1, SHA, { eager: false })).items[0];
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('archive interrupted'));
		expect((await prepare(first.id)).preparation).toBe('failed');
		expect((await prepare(first.id)).current?.commit).toBe(SHA);
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(2);
		expect(await api.deps.services.sessions.listByProject(pid)).toEqual([]);
	});

	it.each(['update', 'close'] as const)(
		'fences a download when a PR %s arrives during preparation',
		async (change) => {
			const first = (await reconcile(1)).items[0];
			const started = Promise.withResolvers<void>();
			const download = Promise.withResolvers<{ path: string; bytes: Uint8Array }[]>();
			vi.mocked(reader.fetchWorkspace).mockImplementationOnce(() => {
				started.resolve();
				return download.promise;
			});
			const preparing = prepare(first.id);
			try {
				await started.promise;
				if (change === 'close') state = 'closed';
				else head = NEXT;
				await reconcile(
					2,
					change === 'close' ? SHA : NEXT,
					{},
					change === 'close' ? 'closed' : 'synchronize',
				);
			} finally {
				download.resolve([{ path: 'notebook.py', bytes: new TextEncoder().encode('old code') }]);
				await preparing;
			}
			expect((await record(first.id)).current).toBeUndefined();
			if (change === 'update') expect((await prepare(first.id)).current?.commit).toBe(NEXT);
			else expect((await record(first.id)).state).toBe('deleting');
		},
	);

	it.each(['expired', 'deleted'] as const)(
		'rejects preparation and launch for a %s preview',
		async (reason) => {
			const first = (await reconcile(1, SHA, { eager: false, idle_days: 1 })).items[0];
			if (reason === 'expired')
				vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.expires_at!) + 1);
			else await expectOk(await api.request('DELETE', `${base}/${first.id}`), 202);
			await expectError(await api.request('POST', `${base}/${first.id}/prepare`), 404);
			await expectError(
				await api.request('POST', `${base}/${first.id}/sessions`, { mode: 'app' }),
				404,
			);
			expect(reader.fetchWorkspace).not.toHaveBeenCalled();
			expect(await api.deps.services.sessions.listByProject(pid)).toEqual([]);
		},
	);

	it('keeps previews when GitHub temporarily hides the PR with a 404', async () => {
		const first = (await reconcile(1)).items[0];
		await prepare(first.id);
		vi.mocked(reader.getPullRequest!).mockRejectedValue(new NotFoundError('PR unavailable'));
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		expect(await record(first.id)).toMatchObject({ state: 'active', current: { commit: SHA } });
	});

	it('resumes failed cleanup without recreating the retired preview', async () => {
		const first = (await reconcile(1)).items[0];
		state = 'closed';
		await reconcile(2, SHA, {}, 'closed');
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
		const remove = api.bucket.delete.bind(api.bucket);
		const deletion = vi.spyOn(api.bucket, 'delete').mockImplementation(async (key) => {
			if (key === paths.preview(pid, nid, PreviewId.parse(first.id)))
				throw new Error('storage unavailable');
			await remove(key);
		});
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.store.project(pid)).entries).toHaveLength(1);
		deletion.mockRestore();
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.store.project(pid)).entries).toEqual([]);
		expect((await reconcile(2, SHA, {}, 'closed')).items).toEqual([]);
	});

	it('does not expire a sticky preview renewed while cleanup reads its parent', async () => {
		const first = (await reconcile(1, SHA, { idle_days: 1 })).items[0];
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.expires_at!) + 1);
		const getProject = api.deps.services.projects.getProject.bind(api.deps.services.projects);
		vi.spyOn(api.deps.services.projects, 'getProject').mockImplementationOnce(async (...args) => {
			head = NEXT;
			await reconcile(2, NEXT, { idle_days: 1 });
			return getProject(...args);
		});
		await sweepPreviews(api.deps);
		expect(await record(first.id)).toMatchObject({ state: 'active', automation: { commit: NEXT } });
		expect((await reconcile(2, NEXT, { idle_days: 1 })).items[0].id).toBe(first.id);
	});
	it('honors lazy demand that arrives while maintenance probes the branch', async () => {
		const first = await createLazyBranch();
		const started = Promise.withResolvers<void>();
		const lookup = Promise.withResolvers<{ commit: string }>();
		vi.mocked(reader.getBranchHead).mockImplementationOnce(() => {
			started.resolve();
			return lookup.promise;
		});
		const preparing = prepare(first.id);
		try {
			await started.promise;
			expect((await record(first.id)).preparation).toBe('preparing');
			await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		} finally {
			lookup.resolve({ commit: SHA });
			await preparing;
		}
		expect((await record(first.id)).current?.commit).toBe(SHA);
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(1);
		await prepare(first.id);
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(1);
	});

	it('reads project membership once per list and rechecks once per materialization batch', async () => {
		await reconcile(1, SHA, { mode: 'commits' });
		await reconcile(2, NEXT, { mode: 'commits' });
		await reconcile(3, THIRD, { mode: 'commits' });
		const project = vi.spyOn(api.deps.services.previews.store, 'project');
		expect(await api.deps.services.previews.list(pid, nid)).toHaveLength(3);
		expect(project).toHaveBeenCalledTimes(1);
		project.mockClear();
		expect(await api.deps.services.previews.projectRecords(pid, nid)).toHaveLength(3);
		expect(project).toHaveBeenCalledTimes(2);
	});

	it('prepares new commit previews without repointing an already published commit', async () => {
		const first = (await reconcile(1, SHA, { mode: 'commits' })).items[0];
		await prepare(first.id);
		head = NEXT;
		const next = (await reconcile(2, NEXT, { mode: 'commits' })).items.find(
			(item) => item.target_commit === NEXT,
		)!;
		expect(next.id).not.toBe(first.id);
		await prepare(next.id);
		await prepare(first.id);
		expect(await record(first.id)).toMatchObject({
			source: { type: 'commit', commit: SHA },
			current: { commit: SHA },
		});
		expect(await record(next.id)).toMatchObject({
			source: { type: 'commit', commit: NEXT },
			current: { commit: NEXT },
		});
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(2);
	});
	it('omits membership removed by cleanup during a materialization batch', async () => {
		const first = (await reconcile(1)).items[0];
		const retired = await api.deps.services.previews.retire(await record(first.id));
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
		const get = api.bucket.get.bind(api.bucket);
		let cleaned = false;
		vi.spyOn(api.bucket, 'get').mockImplementation(async (...args) => {
			const object = await get(...args);
			if (!cleaned && args[0] === paths.preview(pid, nid, retired.id)) {
				cleaned = true;
				await api.deps.services.previews.cleanup(retired, async () => true);
			}
			return object;
		});
		expect(await api.deps.services.previews.projectRecords(pid, nid)).toEqual([]);
		expect(cleaned).toBe(true);
		expect((await api.deps.services.previews.store.project(pid)).entries).toEqual([]);
	});

	it('does not carry duplicate demand from an active download into the next branch head', async () => {
		const first = await expectOk<{ id: string }>(
			await api.request('POST', base, {
				name: 'Lazy branch',
				source: { type: 'branch', branch: 'feature/chart' },
				eager: false,
			}),
			202,
		);
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		const started = Promise.withResolvers<void>();
		const download = Promise.withResolvers<{ path: string; bytes: Uint8Array }[]>();
		vi.mocked(reader.fetchWorkspace).mockImplementationOnce(() => {
			started.resolve();
			return download.promise;
		});
		const preparing = prepare(first.id);
		try {
			await started.promise;
			await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		} finally {
			download.resolve([{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo') }]);
			await preparing;
		}
		head = NEXT;
		await prepare(first.id);
		expect(await record(first.id)).toMatchObject({
			preparation: 'deferred',
			current: { commit: SHA },
		});
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(1);
	});
	it('persists a closure observed during the final membership check before cleanup', async () => {
		const first = (await reconcile(1)).items[0];
		const service = api.deps.services.previews;
		const initial = await record(first.id);
		const project = service.store.project.bind(service.store);
		vi.spyOn(service.store, 'project')
			.mockImplementationOnce(project)
			.mockImplementationOnce(async (projectId) => {
				await service.store.closeAutomation(
					projectId,
					initial.automation!.key,
					initial.automation!.revision,
				);
				await service.store.planAutomations(projectId);
				return project(projectId);
			});
		const [retired] = await service.projectRecords(pid, nid);
		expect(retired.state).toBe('deleting');
		const persisted = await api.bucket.get(paths.preview(pid, nid, retired.id));
		expect(await persisted!.json()).toMatchObject({
			state: 'deleting',
			cleanup_after: retired.cleanup_after,
		});
		await service.cleanup(retired, async () => true);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
		await sweepPreviews(api.deps);
		expect((await project(pid)).entries).toEqual([]);
	});
	it('accepts fresh demand during the retry probe after a failed lazy download', async () => {
		const first = await createLazyBranch();
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('archive interrupted'));
		expect(await prepare(first.id)).toMatchObject({ preparation: 'failed', requested_commit: SHA });
		const started = Promise.withResolvers<void>();
		const lookup = Promise.withResolvers<{ commit: string }>();
		vi.mocked(reader.getBranchHead).mockImplementationOnce(() => {
			started.resolve();
			return lookup.promise;
		});
		const preparing = prepare(first.id);
		try {
			await started.promise;
			await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		} finally {
			lookup.resolve({ commit: NEXT });
			await preparing;
		}
		expect(await record(first.id)).toMatchObject({
			preparation: 'ready',
			current: { commit: NEXT },
		});
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(2);
	});
	it('preserves accepted lazy demand after reconciliation stops before materialization', async () => {
		const first = (await reconcile(1, SHA, { eager: false })).items[0];
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		await prepare(first.id);
		head = NEXT;
		vi.spyOn(api.deps.services.previews, 'projectRecords').mockRejectedValueOnce(
			new Error('interrupted'),
		);
		await expectError(
			await api.request('POST', `${base}/reconcile`, event(2, NEXT, { eager: false })),
			500,
		);
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		await prepare(first.id);
		expect((await record(first.id)).current?.commit).toBe(NEXT);
	});
	it('does not retire a newer reopen event after an old coordinator probe returns closed', async () => {
		const first = (await reconcile(1)).items[0];
		vi.mocked(reader.getPullRequest!).mockImplementationOnce(async () => {
			head = NEXT;
			await reconcile(2, NEXT, {}, 'reopened');
			return {
				number: 1,
				state: 'closed',
				branch: 'feature/chart',
				commit: SHA,
				sameRepository: true,
			};
		});
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		expect(await record(first.id)).toMatchObject({ state: 'active', automation: { commit: NEXT } });
		expect(
			(await api.deps.services.previews.store.project(pid)).automations?.[0].heads,
		).toHaveLength(1);
	});

	it('prepares managed previews from accepted targets without probing PR state or branch HEAD', async () => {
		const first = (await reconcile(1, SHA, { eager: false })).items[0];
		vi.mocked(reader.getPullRequest!).mockClear();
		head = NEXT;
		await prepare(first.id);
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		await prepare(first.id);
		expect((await record(first.id)).current?.commit).toBe(SHA);
		expect(reader.getPullRequest).not.toHaveBeenCalled();
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(reader.resolveCommit).not.toHaveBeenCalled();
	});

	it('keeps a delayed reopen behind the latest archived close event', async () => {
		const first = (await reconcile(1)).items[0];
		state = 'closed';
		await reconcile(2, SHA, {}, 'closed');
		await reconcile(4, NEXT, {}, 'closed');
		state = 'open';
		head = THIRD;
		expect(await reconcile(3, NEXT, {}, 'reopened')).toMatchObject({ state: 'closed', items: [] });
		const reopened = await reconcile(5, THIRD, {}, 'reopened');
		expect(reopened.items).toHaveLength(1);
		expect(reopened.items[0].id).not.toBe(first.id);
		expect(reopened.items[0].target_commit).toBe(THIRD);
	});

	it('preserves generation demand across retained-head and expiry policy updates', async () => {
		const first = (await reconcile(1, SHA, { eager: false, mode: 'commits' })).items[0];
		await expectOk(await api.request('POST', `${base}/${first.id}/prepare`), 202);
		const generation = (await record(first.id)).requested_generation;
		await reconcile(2, NEXT, { eager: false, mode: 'commits', idle_days: 3 });
		expect((await record(first.id)).requested_generation).toBe(generation);
		await prepare(first.id);
		expect((await record(first.id)).current?.commit).toBe(SHA);
	});

	it.each(['demand', 'requested_commit'] as const)(
		'migrates legacy managed %s without losing preparation authorization',
		async (field) => {
			const first = (await reconcile(1, SHA, { eager: false })).items[0];
			const legacy = await record(first.id);
			delete legacy.automation!.generation;
			if (field === 'demand') legacy.demand = true;
			else legacy.requested_commit = SHA;
			await api.bucket.put(paths.preview(pid, nid, legacy.id), JSON.stringify(legacy));
			const project = await api.deps.services.previews.store.project(pid);
			project.entries[0].intent = legacy;
			project.automations![0].heads[0].intent = legacy;
			await api.bucket.put(paths.previewProject(pid), JSON.stringify(project));

			await reconcile(2, SHA, { eager: false, idle_days: 2 });
			const prepared = await prepare(first.id);
			expect(prepared.current?.commit).toBe(SHA);
			expect(prepared.requested_generation).toBe(legacy.automation!.revision);
			expect(prepared.demand).toBeUndefined();
			expect(prepared.requested_commit).toBeUndefined();
		},
	);
});
