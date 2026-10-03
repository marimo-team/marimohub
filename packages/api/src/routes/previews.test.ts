import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	defaultRegistry,
	ProjectIntegrationsStore,
	createServices,
	createSessionId,
	NotFoundError,
	ResourceExhaustedError,
	paths,
	PreviewCreateSchema,
	sessionPersistsEdits,
	NotebookMetaSchema,
	readStored,
	ValidationError,
	ProxyExposure,
} from '@marimo-hub/core';
import type {
	SourceControlReader,
	SourceReadOptions,
	NotebookId,
	ProjectId,
	Session,
	AuthorizationAction,
} from '@marimo-hub/core';
import {
	ACTOR,
	uid,
	makeFakeCompute,
	makeFakeSandbox,
	fakeComputeFrom,
} from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	stubSourceControl,
} from '../testing';
import { sweepPreviews } from '../previews';
import { authorizeProxyRequest } from '../sandboxProxy';

let api: ReturnType<typeof createTestApi>;
let pid: ProjectId;
let nid: NotebookId;
let base: string;
let head: string;
let reader: SourceControlReader;
const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const body = { name: 'Prototype', source: { type: 'branch' as const, branch: 'prototype' } };

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

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
	reader = {
		provider: 'github',
		previews: true,
		supportsRepository: () => true,
		getBranchHead: vi.fn(async () => ({ commit: head })),
		resolveCommit: vi.fn(async (_repo, commit) => ({ commit })),
		fetchWorkspace: vi.fn(async () => [
			{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo\napp = marimo.App()') },
		]),
		listBranches: vi.fn(async () => [{ value: 'prototype', commit: head, label: 'prototype' }]),
		listCommits: vi.fn(async () => [{ value: head, commit: head, label: 'Prototype' }]),
		getPullRequest: vi.fn(async () => ({
			number: 1,
			state: 'open' as const,
			branch: 'prototype',
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
async function create(input = body) {
	const result = await expectOk<{ id: string }>(await api.request('POST', base, input), 202);
	return api.deps.services.previews.prepare(
		await api.deps.services.previews.get(pid, nid, result.id),
		api.deps.sourceControl,
	);
}
async function userApi(role: 'app-user' | 'viewer' | 'editor' | 'manager', name: string = role) {
	await api.deps.services.projects.addMember(pid, { user_id: uid(name) }, role, ACTOR);
	return createTestApi({
		bucket: api.bucket,
		userId: uid(name),
		compute: api.deps.compute,
		deps: { sourceControl: api.deps.sourceControl, policy: { viewerMode: 'ephemeral-sandbox' } },
	});
}

describe('Notebook previews', () => {
	it.each(['branch', 'commit'] as const)(
		'reports unsupported %s suggestions while allowing manual resolution',
		async (type) => {
			delete reader.listBranches;
			delete reader.listCommits;
			const url = `/projects/${pid}/notebooks/${nid}/source/refs?type=${type}`;
			const error = await expectError(await api.request('GET', url), 422);
			expect(error.message).toBe(`Source provider does not support ${type} suggestions`);
			const query = type === 'branch' ? 'prototype' : SHA;
			expect(
				await expectOk(await api.request('GET', `${url}&resolve=true&query=${query}`)),
			).toEqual([{ value: query, label: query, commit: SHA }]);
		},
	);

	it.each(['branch', 'commit'] as const)('caps %s suggestions at 30', async (type) => {
		const suggestions = Array.from({ length: 45 }, (_, index) => ({
			value: `${index}`,
			label: `Suggestion ${index}`,
			commit: SHA,
		}));
		if (type === 'branch') reader.listBranches = vi.fn(async () => suggestions);
		else reader.listCommits = vi.fn(async () => suggestions);
		expect(
			await expectOk(
				await api.request('GET', `/projects/${pid}/notebooks/${nid}/source/refs?type=${type}`),
			),
		).toEqual(suggestions.slice(0, 30));
	});

	it('reads the live parent README for preview details', async () => {
		const record = await create();
		const parent = paths.project(pid).notebook(nid);
		const runtimeId = record.current!.notebook_id;
		await api.deps.services.notebooks.updateNotebook(pid, nid, { readme: '# Review notes' }, ACTOR);
		expect(await api.bucket.get(paths.project(pid).notebook(runtimeId).readme)).toBeNull();
		expect((await api.deps.services.notebooks.getNotebook(pid, runtimeId)).readme).toBe(
			'# Review notes',
		);
		await api.deps.services.notebooks.updateNotebook(
			pid,
			nid,
			{ readme: '# Updated notes' },
			ACTOR,
		);
		expect((await api.deps.services.notebooks.getNotebook(pid, runtimeId)).readme).toBe(
			'# Updated notes',
		);
		await api.bucket.delete(parent.readme);
		expect((await api.deps.services.notebooks.getNotebook(pid, runtimeId)).readme).toBeNull();
	});

	it.each(['https://hub.example.com/marimohub', 'https://hub.example.com/marimohub/'])(
		'preserves the configured public prefix in links and launches: %s',
		async (appBaseUrl) => {
			const { instance, calls } = makeFakeSandbox();
			api = createTestApi({
				bucket: api.bucket,
				compute: fakeComputeFrom(instance),
				deps: {
					sourceControl: api.deps.sourceControl,
					sandbox: {
						...api.deps.sandbox,
						appBaseUrl,
						exposure: new ProxyExposure('preview-test-secret'),
					},
				},
			});
			const record = await expectOk<{ id: string; url: string }>(
				await api.request('POST', base, body),
				202,
			);
			const url = `https://hub.example.com/marimohub/projects/${pid}/notebooks/${nid}/previews/${record.id}`;
			expect(record.url).toBe(url);
			expect(await expectOk(await api.request('GET', `${base}/${record.id}`))).toMatchObject({
				url,
			});
			expect(await expectOk(await api.request('GET', base))).toEqual({
				items: [expect.objectContaining({ url })],
				next_cursor: null,
			});
			await api.deps.services.previews.prepare(
				await api.deps.services.previews.get(pid, nid, record.id),
				api.deps.sourceControl,
			);
			const session = await expectOk<Session>(
				await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			);
			expect(session.sandbox_url).toMatch(/^https:\/\/hub\.example\.com\/marimohub\/proxy\//);
			expect(calls.startProcess.some(({ cmd }) => cmd.includes('/marimohub/proxy/'))).toBe(true);
		},
	);

	it('returns the launched revision to app-users without exposing editor session fields', async () => {
		const record = await create();
		const appUser = await userApi('app-user');
		const launch = () => appUser.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' });
		const first = await expectOk<Session>(await launch());
		expect(first.origin!.revision_id).toBe(record.current!.version_id);
		for (const field of ['source_version_id', 'user_id', 'integrations', 'compute_profile'])
			expect(first).not.toHaveProperty(field);

		head = NEXT;
		const latest = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		const publicPreview = await expectOk<{ version_id: string }>(
			await appUser.request('GET', `${base}/${record.id}`),
		);
		expect(publicPreview.version_id).toBe(latest.current!.version_id);
		expect(publicPreview.version_id).not.toBe(first.origin!.revision_id);
		const running = await api.deps.services.sessions.getSession(pid, first.session_id);
		expect(running.source_version_id).toBe(first.origin!.revision_id);
		const second = await expectOk<Session>(await launch());
		expect(second.origin!.revision_id).toBe(latest.current!.version_id);
	});

	it('isolates prepared source from the parent and never catalogs runtime identities', async () => {
		const original = await api.deps.services.notebooks.getNotebookSource(pid, nid);
		const record = await create();
		expect(record.preparation).toBe('ready');
		expect(record.current?.commit).toBe(SHA);
		expect(record.current?.notebook_id).not.toBe(nid);
		expect(await api.deps.services.notebooks.getNotebookSource(pid, nid)).toEqual(original);
		expect((await api.deps.services.notebooks.listNotebooks(pid)).map((item) => item.id)).toEqual([
			nid,
		]);
		const child = record.current!.notebook_id;
		// Older replicas only know meta.json, so they cannot read or rewrite this runtime.
		expect(await api.bucket.get(paths.project(pid).notebook(child).meta)).toBeNull();
		expect(await api.bucket.get(paths.project(pid).notebook(child).previewMeta)).not.toBeNull();
		for (const [method, suffix, input] of [
			['GET', '', undefined],
			['PATCH', '', { title: 'changed' }],
			['POST', '/sessions', { mode: 'edit' }],
			['POST', '/deep-links', { slug: 'unsafe' }],
			['POST', '/jobs', { name: 'unsafe' }],
		] as const) {
			const response = await api.request(
				method,
				`/projects/${pid}/notebooks/${child}${suffix}`,
				input,
			);
			expect(response.status).toBeGreaterThanOrEqual(400);
		}
		await expect(
			api.deps.services.notebooks.commitSession(pid, child, { code: 'changed' }, ACTOR),
		).rejects.toThrow('cannot persist');
	});

	it.each(['app-user', 'viewer', 'editor'] as const)(
		'denies management and source discovery to %s',
		async (role) => {
			const record = await create();
			const other = await userApi(role);
			await expectError(await other.request('POST', base, body), 403);
			await expectError(await other.request('DELETE', `${base}/${record.id}`), 403);
			await expectError(
				await other.request('GET', `/projects/${pid}/notebooks/${nid}/source/refs?type=branch`),
				403,
			);
			const publicRecord = await expectOk<Record<string, unknown>>(
				await other.request('GET', `${base}/${record.id}`),
			);
			expect(publicRecord).not.toHaveProperty('source');
			expect(publicRecord).not.toHaveProperty('repository');
			expect(publicRecord).not.toHaveProperty('revisions');
		},
	);

	it('keeps editors personal and discard-only, while app-users only start apps', async () => {
		const record = await create();
		const first = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		expect(first.ephemeral).toBe(true);
		expect(first.editor_sandbox_sharing).toBe('exclusive');
		expect(sessionPersistsEdits(first)).toBe(false);
		expect(await api.deps.services.sessions.getEditorClaim(pid, nid)).toBeUndefined();
		const editor = await userApi('editor');
		const second = await expectOk<Session>(
			await editor.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		expect(first.session_id).not.toBe(second.session_id);
		const appUser = await userApi('app-user');
		await expectError(
			await appUser.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
			403,
		);
		const app = await expectOk<Session>(
			await appUser.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		expect(app.ephemeral).toBeUndefined();
		expect(app.session_id).not.toBe(first.session_id);
		const other = await create();
		const otherApp = await expectOk<Session>(
			await appUser.request('POST', `${base}/${other.id}/sessions`, { mode: 'app' }),
		);
		expect(otherApp.notebook_id).toBe(app.notebook_id);
		expect(otherApp.origin!.preview_id).not.toBe(app.origin!.preview_id);
		await expectError(
			await appUser.request('POST', `${base}/${record.id}/sessions`, {
				mode: 'app',
				ref: 'secret',
			}),
			422,
		);
	});

	it.each([false, undefined])(
		'replaces credential-bearing preview editors after demotion (stored restriction: %s)',
		async (storedRestriction) => {
			const record = await create();
			await userApi('editor');
			const { instance, calls } = makeFakeSandbox();
			const integrations = new ProjectIntegrationsStore({
				bucket: api.bucket,
				registry: defaultRegistry(),
			});
			await integrations.create(
				pid,
				{
					kind: 'custom_env',
					name: 'flags',
					config: { vars: { EDITOR_ONLY: 'secret' } },
				},
				ACTOR,
			);
			const editor = createTestApi({
				bucket: api.bucket,
				userId: uid('editor'),
				compute: fakeComputeFrom(instance),
				deps: {
					sourceControl: api.deps.sourceControl,
					integrations,
					policy: { viewerMode: 'ephemeral-sandbox' },
					sandbox: { ...api.deps.sandbox, exposure: new ProxyExposure('preview-role-change') },
				},
			});
			const launch = () =>
				editor.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' });
			const first = await expectOk<Session>(await launch());
			expect(Object.assign({}, ...calls.setEnvVars).EDITOR_ONLY).toBe('secret');
			const stored = await editor.deps.services.sessions.getSession(pid, first.session_id);
			expect(stored.restricted_viewer_credentials).toBe(false);
			if (storedRestriction === undefined) {
				delete stored.restricted_viewer_credentials;
				await api.bucket.put(paths.session(pid, first.session_id), JSON.stringify(stored));
			}
			await api.deps.services.projects.updateMemberRole(pid, uid('editor'), 'viewer', ACTOR);
			const sessionPath = `/projects/${pid}/notebooks/${nid}/sessions/${first.session_id}`;
			await expectError(await editor.request('POST', `${sessionPath}/heartbeat`), 403);
			const detail = await expectOk<Session>(await editor.request('GET', sessionPath));
			expect(detail.sandbox_url).toBeUndefined();
			expect(
				await authorizeProxyRequest(new Request(first.sandbox_url!), editor.deps),
			).toMatchObject({
				kind: 'reject',
				status: 403,
			});
			calls.setEnvVars.length = 0;
			const restricted = await expectOk<Session & { reused: boolean }>(await launch());
			expect(restricted.session_id).not.toBe(first.session_id);
			expect(restricted.reused).toBe(false);
			expect(Object.assign({}, ...calls.setEnvVars).EDITOR_ONLY).toBeUndefined();
			expect(
				(await editor.deps.services.sessions.getSession(pid, restricted.session_id))
					.restricted_viewer_credentials,
			).toBe(true);
			expect(
				(await editor.deps.services.sessions.getSession(pid, first.session_id))
					.sandbox_reclaimed_at,
			).toBeDefined();
			expect((await expectOk<Session>(await launch())).session_id).toBe(restricted.session_id);
			await expectOk(
				await editor.request(
					'POST',
					`/projects/${pid}/notebooks/${nid}/sessions/${restricted.session_id}/heartbeat`,
				),
			);
			await api.deps.services.projects.updateMemberRole(pid, uid('editor'), 'editor', ACTOR);
			const promoted = await expectOk<Session>(await launch());
			expect(promoted.session_id).not.toBe(restricted.session_id);
			expect(Object.assign({}, ...calls.setEnvVars).EDITOR_ONLY).toBe('secret');
		},
	);

	it('compares preview app runtimes with the published revision in runtime inspection', async () => {
		const record = await create();
		const first = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		head = NEXT;
		const latest = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		const second = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		const data = await api.deps.services.runtimeInspection.inspect();
		const old = data.apps.find((app) =>
			app.sandboxes.some((s) => s.session_id === first.session_id),
		);
		const current = data.apps.find((app) =>
			app.sandboxes.some((s) => s.session_id === second.session_id),
		);
		expect(old).toMatchObject({
			current_version_id: latest.current!.version_id,
			current_version_members: 0,
		});
		expect(old!.sandboxes[0].version_status).toBe('old');
		expect(current).toMatchObject({
			current_version_id: latest.current!.version_id,
			current_version_members: 1,
		});
		expect(current!.sandboxes[0].version_status).toBe('current');

		await api.bucket.delete(`_system/previews/${pid}/${nid}/${record.id}.json`);
		const missing = await createServices(api.bucket).runtimeInspection.inspect();
		for (const app of missing.apps) {
			expect(app.current_version_id).toBeNull();
			expect(app.current_version_members).toBeNull();
			expect(app.incomplete).toBe(true);
			expect(app.sandboxes[0].version_status).toBe('unknown');
		}
	});

	it('tracks branches including force pushes and leaves pinned previews unchanged', async () => {
		const moving = await create();
		let pinned = await api.deps.services.previews.create(
			pid,
			nid,
			{ name: 'Pinned', source: { type: 'commit', commit: SHA } },
			ACTOR,
			api.deps.sourceControl,
		);
		pinned = await api.deps.services.previews.prepare(pinned, api.deps.sourceControl);
		head = NEXT;
		const updated = await api.deps.services.previews.prepare(moving, api.deps.sourceControl, true);
		expect(updated.id).toBe(moving.id);
		expect(updated.current?.commit).toBe(NEXT);
		expect(updated.current?.notebook_id).not.toBe(moving.current?.notebook_id);
		const unchanged = await api.deps.services.previews.prepare(
			pinned,
			api.deps.sourceControl,
			true,
		);
		expect(unchanged.current).toEqual(pinned.current);
		expect(reader.resolveCommit).toHaveBeenCalledTimes(1);
		head = SHA;
		expect(
			(await api.deps.services.previews.prepare(updated, api.deps.sourceControl, true)).current
				?.commit,
		).toBe(SHA);
		expect(
			PreviewCreateSchema.safeParse({ ...body, source: { type: 'branch', branch: SHA } }).success,
		).toBe(true);
		expect(
			PreviewCreateSchema.safeParse({
				...body,
				source: { type: 'commit', branch: 'main', commit: SHA },
			}).success,
		).toBe(false);
	});

	it('concurrent idempotent creates share one identity and a delete cannot be replayed', async () => {
		const service = api.deps.services.previews;
		const [a, b] = await Promise.all([
			service.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'one'),
			service.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'one'),
		]);
		expect(a.id).toBe(b.id);
		expect(await service.list(pid, nid)).toHaveLength(1);
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		await expect(
			service.create(
				pid,
				nid,
				{ ...body, name: 'Different' },
				ACTOR,
				api.deps.sourceControl,
				'one',
			),
		).rejects.toThrow('Idempotency');
		await service.retire(a);
		await expect(
			service.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'one'),
		).rejects.toThrow('deleted');
	});

	it('waits for the preparation grace period before deleting artifacts during an upload', async () => {
		const service = api.deps.services.previews;
		const record = await service.create(pid, nid, body, ACTOR, api.deps.sourceControl);
		const uploading = Promise.withResolvers<void>();
		const finishUpload = Promise.withResolvers<void>();
		const put = api.bucket.put.bind(api.bucket);
		vi.spyOn(api.bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key.endsWith('/workspace/notebook.py')) {
				uploading.resolve();
				await finishUpload.promise;
			}
			return put(key, value, options);
		});
		const preparation = service.prepare(record, api.deps.sourceControl);
		await uploading.promise;
		try {
			const retired = await service.retire(record);
			const runtime = retired.revisions[0].notebook_id;
			const prefix = paths.project(pid).notebook(runtime).base;
			await service.cleanup(retired, async () => true);
			expect(
				await api.bucket.head(paths.project(pid).notebook(runtime).previewMeta),
			).not.toBeNull();
			expect((await service.store.project(pid)).entries).toHaveLength(1);
			finishUpload.resolve();
			expect((await preparation).current).toBeUndefined();
			expect((await api.bucket.list({ prefix })).objects.length).toBeGreaterThan(0);
			vi.spyOn(Date, 'now').mockReturnValue(retired.cleanup_after! + 1);
			await service.cleanup(await service.get(pid, nid, record.id), async () => true);
			expect((await api.bucket.list({ prefix })).objects).toEqual([]);
			expect((await service.store.project(pid)).entries).toEqual([]);
		} finally {
			finishUpload.resolve();
			await preparation;
		}
	});

	it('fences deletion during preparation and cleans late artifacts', async () => {
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		reader.fetchWorkspace = async () => {
			started.resolve();
			await proceed.promise;
			return [{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo') }];
		};
		const pending = await api.deps.services.previews.create(
			pid,
			nid,
			body,
			ACTOR,
			api.deps.sourceControl,
		);
		const creating = api.deps.services.previews.prepare(pending, api.deps.sourceControl);
		await started.promise;
		const record = (await api.deps.services.previews.list(pid, nid))[0];
		await api.deps.services.previews.retire(record);
		proceed.resolve();
		expect((await creating).state).toBe('deleting');
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
		for (const child of record.revisions.map((revision) => revision.notebook_id))
			expect(await api.bucket.get(paths.project(pid).notebook(child).previewMeta)).toBeNull();
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			404,
		);
	});

	it('keeps the last revision when an update fails and retires on PR close', async () => {
		let record = await api.deps.services.previews.create(
			pid,
			nid,
			{ ...body, pull_request: 1 },
			ACTOR,
			api.deps.sourceControl,
		);
		record = await api.deps.services.previews.prepare(record, api.deps.sourceControl);
		head = NEXT;
		reader.fetchWorkspace = async () => {
			throw new Error('provider failure');
		};
		const failed = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		expect(failed.preparation).toBe('failed');
		expect(failed.current).toEqual(record.current);
		reader.getPullRequest = async () => ({
			number: 1,
			state: 'closed',
			branch: 'prototype',
			commit: head,
			sameRepository: true,
		});
		expect(
			(await api.deps.services.previews.prepare(failed, api.deps.sourceControl, true)).state,
		).toBe('deleting');
	});

	it('inherits live parent labels and rejects sessions after parent deletion', async () => {
		const record = await create();
		const child = record.current!.notebook_id;
		const key = paths.project(pid).notebook(nid).meta;
		const object = (await api.bucket.get(key))!;
		const meta = await readStored(NotebookMetaSchema, object, key);
		await api.bucket.put(
			key,
			JSON.stringify({
				...meta,
				security_labels: { classification: 'restricted', compartments: ['review'] },
			}),
		);
		expect(await api.deps.services.notebooks.getSecurityLabels(pid, child)).toEqual({
			classification: 'restricted',
			compartments: ['review'],
		});
		await api.bucket.put(key, JSON.stringify({ ...meta, status: 'deleted' }));
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			404,
		);
		await expect(api.deps.services.notebooks.getSecurityLabels(pid, child)).rejects.toThrow();
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
	});
	it('enforces token actions before resolving refs or starting preview code', async () => {
		const record = await create();
		const tokenApi = (actions: AuthorizationAction[], projects: ProjectId[] = [pid]) =>
			createTestApi({
				bucket: api.bucket,
				compute: api.deps.compute,
				deps: {
					sourceControl: api.deps.sourceControl,
					authenticator: {
						authenticate: async () => ({
							id: ACTOR,
							email: 'actor@example.com',
							credential: { kind: 'personal-access-token', grant: { actions, projects } },
						}),
					},
				},
			});
		const readerOnly = tokenApi(['project.read']);
		await expectOk(await readerOnly.request('GET', `${base}/${record.id}`));
		await expectError(await readerOnly.request('POST', base, body), 403);
		await expectError(
			await readerOnly.request('GET', `/projects/${pid}/notebooks/${nid}/source/refs?type=branch`),
			403,
		);
		vi.mocked(reader.getBranchHead).mockClear();
		await expectError(
			await readerOnly.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			403,
		);
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		await expectOk(await tokenApi(['preview.manage']).request('POST', base, body), 202);
		await expectError(
			await tokenApi(['project.read', 'preview.manage'], []).request('POST', base, body),
			404,
		);
	});

	it('uses preview compute defaults for viewers and never mounts a personal home', async () => {
		const record = await create();
		const baseViewer = await userApi('viewer');
		const compute = makeFakeCompute();
		const resolve = vi.fn(() => ({ path: '/home/me', key: 'personal' }));
		const sandbox = {
			...baseViewer.deps.sandbox,
			computeProfiles: [
				{ name: 'normal', resources: { cpu: 4 } },
				{ name: 'preview', resources: { cpu: 1 } },
			],
			previewComputeProfile: 'preview',
			userHome: { resolve },
		};
		const viewer = createTestApi({
			bucket: api.bucket,
			userId: uid('viewer'),
			compute,
			deps: { sourceControl: api.deps.sourceControl, policy: baseViewer.deps.policy, sandbox },
		});
		const session = await expectOk<Session>(
			await viewer.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		expect(session.compute_profile).toBe('preview');
		expect(compute.lastCreateOptions?.resources?.cpu).toBe(1);
		expect(compute.lastCreateOptions?.userHome).toBeUndefined();
		expect(resolve).not.toHaveBeenCalled();
		const stored = await viewer.deps.services.sessions.getSession(pid, session.session_id);
		expect(stored.idle_timeout_ms).toBe(300_000);
		expect(stored.authorization_expires_at).toBe(record.expires_at);
	});

	it('keeps deleting state during startup and retries a late failed destruction', async () => {
		const record = await create();
		const { instance, calls } = makeFakeSandbox();
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const startProcess = instance.startProcess;
		instance.startProcess = async (...args) => {
			const process = await startProcess(...args);
			started.resolve();
			await proceed.promise;
			return process;
		};
		const destroy = instance.destroy;
		instance.destroy = vi.fn(async () => {
			throw new Error('Provider unavailable');
		});
		api = createTestApi({
			bucket: api.bucket,
			compute: fakeComputeFrom(instance),
			deps: { sourceControl: api.deps.sourceControl },
		});
		const starting = api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' });
		await started.promise;
		await expectOk(await api.request('DELETE', `${base}/${record.id}`), 202);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleting');
		expect(calls.destroy).toBe(0);
		proceed.resolve();
		expect((await starting).status).toBeGreaterThanOrEqual(400);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleting');
		instance.destroy = destroy;
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
		expect(calls.destroy).toBeGreaterThan(0);
	});

	it('prunes unused old revisions and drops deleted maintenance markers after the grace period', async () => {
		const original = await create();
		head = NEXT;
		const updated = await api.deps.services.previews.prepare(
			original,
			api.deps.sourceControl,
			true,
		);
		await sweepPreviews(api.deps);
		const pruned = await api.deps.services.previews.get(pid, nid, original.id);
		expect(pruned.revisions.map((revision) => revision.notebook_id)).toEqual([
			updated.current!.notebook_id,
		]);
		expect(
			await api.bucket.get(paths.project(pid).notebook(original.current!.notebook_id).previewMeta),
		).toBeNull();
		await api.deps.services.previews.retire(pruned);
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 901_000);
			await sweepPreviews(api.deps);
			expect(await api.deps.services.previews.cleanupCandidates()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
		await expect(api.deps.services.previews.get(pid, nid, original.id)).rejects.toThrow(
			NotFoundError,
		);
	});

	it('shares discovery across previews but rechecks each runtime before reclamation', async () => {
		const records = [await create(), await create({ ...body, name: 'Second preview' })];
		head = NEXT;
		for (const record of records)
			await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		const scan = vi.spyOn(api.deps.services.sessions, 'listByProject');
		await sweepPreviews(api.deps);
		expect(scan.mock.calls).toEqual([
			[pid],
			...records.map((record) => [pid, record.current!.notebook_id]),
		]);
		for (const record of records) {
			const pruned = await api.deps.services.previews.get(pid, nid, record.id);
			expect(pruned.revisions).toEqual([
				expect.objectContaining({ notebook_id: pruned.current!.notebook_id, state: 'ready' }),
			]);
		}
	});

	it('retains revisions when discovery fails and retries discovery on the next sweep', async () => {
		const records = [await create(), await create({ ...body, name: 'Second preview' })];
		head = NEXT;
		for (const record of records)
			await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		const scan = vi
			.spyOn(api.deps.services.sessions, 'listByProject')
			.mockRejectedValueOnce(new Error('Unreadable session'));
		await sweepPreviews(api.deps);
		expect(scan).toHaveBeenCalledExactlyOnceWith(pid);
		for (const record of records)
			expect((await api.deps.services.previews.get(pid, nid, record.id)).revisions).toHaveLength(2);
		await sweepPreviews(api.deps);
		for (const record of records)
			expect((await api.deps.services.previews.get(pid, nid, record.id)).revisions).toHaveLength(1);
	});

	it('keeps admission authoritative when discovery predates a launch', async () => {
		const record = await create();
		head = NEXT;
		const service = api.deps.services.previews;
		await service.prepare(record, api.deps.sourceControl, true);
		const scan = vi
			.spyOn(api.deps.services.sessions, 'listByProject')
			.mockImplementationOnce(async () => {
				await service.reserveAdmission(record, record.current!.notebook_id, createSessionId(), 10);
				return [];
			});
		await sweepPreviews(api.deps);
		expect(scan).toHaveBeenCalledExactlyOnceWith(pid);
		expect((await service.get(pid, nid, record.id)).revisions).toHaveLength(2);
		expect(
			await api.bucket.get(paths.project(pid).notebook(record.current!.notebook_id).previewMeta),
		).not.toBeNull();
	});

	it('retains a retiring revision after failed cleanup and rejects new admission until retry', async () => {
		const record = await create();
		head = NEXT;
		const service = api.deps.services.previews;
		const updated = await service.prepare(record, api.deps.sourceControl, true);
		await service.prune(
			updated,
			async () => false,
			async () => false,
		);
		const retiring = await service.get(pid, nid, record.id);
		expect(retiring.revisions).toEqual([
			{ ...record.revisions[0], state: 'retiring' },
			updated.revisions[1],
		]);
		await expect(
			service.reserveAdmission(retiring, record.current!.notebook_id, createSessionId(), 10),
		).rejects.toThrow(NotFoundError);
		expect(
			await api.bucket.get(paths.project(pid).notebook(record.current!.notebook_id).previewMeta),
		).not.toBeNull();
		await service.prune(
			retiring,
			async () => false,
			async () => true,
		);
		expect((await service.get(pid, nid, record.id)).revisions).toEqual([updated.revisions[1]]);
		expect(
			await api.bucket.get(paths.project(pid).notebook(record.current!.notebook_id).previewMeta),
		).toBeNull();
	});
});

describe('Preview failure recovery and boundaries', () => {
	it.each([
		{ viewerMode: 'static', mode: 'app' },
		{ viewerMode: 'static', mode: 'edit' },
		{ viewerMode: 'applications', mode: 'edit' },
	] as const)(
		'denies $mode in viewer mode $viewerMode before checking GitHub',
		async ({ viewerMode, mode }) => {
			const record = await create();
			await userApi('viewer');
			const viewer = createTestApi({
				bucket: api.bucket,
				userId: uid('viewer'),
				compute: api.deps.compute,
				deps: { sourceControl: api.deps.sourceControl, policy: { viewerMode } },
			});
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(Date.now() + 61_000);
			vi.mocked(reader.getBranchHead).mockClear();
			const shown = await expectOk<{ can: { app: boolean; edit: boolean } }>(
				await viewer.request('GET', `${base}/${record.id}`),
			);
			expect(shown.can[mode]).toBe(false);
			await expectError(
				await viewer.request('POST', `${base}/${record.id}/sessions`, { mode }),
				403,
			);
			expect(reader.getBranchHead).not.toHaveBeenCalled();
			expect(await api.deps.services.sessions.listActiveByProject(pid)).toEqual([]);
		},
	);

	it('retires preview compute when its parent project is deleted', async () => {
		const record = await create();
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		expect((await api.request('DELETE', `/projects/${pid}`)).status).toBe(200);
		await sweepPreviews(api.deps);
		await expectError(await api.request('GET', `${base}/${record.id}`), 404);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
		expect(
			(await api.deps.services.sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at,
		).toBeDefined();
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await sweepPreviews(api.deps);
		expect(
			await api.bucket.get(paths.project(pid).notebook(record.current!.notebook_id).source),
		).toBeNull();
	});

	it.each([
		{ name: 'empty name', input: { ...body, name: '  ' } },
		{ name: 'empty branch', input: { ...body, source: { type: 'branch', branch: '' } } },
		...[
			'bad..branch',
			'bad@{branch',
			'bad.lock',
			'.hidden/ref',
			'bad ref',
			'bad~ref',
			'/bad',
			'bad/',
			'bad//ref',
			'bad.',
			'-bad',
			'@',
		].map((branch) => ({
			name: `invalid branch ${branch}`,
			input: { ...body, source: { type: 'branch', branch } },
		})),
		{ name: 'short SHA', input: { ...body, source: { type: 'commit', commit: 'abcdef' } } },
		{
			name: 'mixed selectors',
			input: { ...body, source: { type: 'commit', commit: SHA, branch: 'main' } },
		},
		{ name: 'repository override', input: { ...body, repository: 'other/repository' } },
		{ name: 'invalid PR number', input: { ...body, pull_request: 0 } },
		{ name: 'invalid expiry', input: { ...body, expires_at: 'tomorrow' } },
	])('rejects $name before publishing or fetching source', async ({ input }) => {
		await expectError(await api.request('POST', base, input), 422);
		expect(await api.deps.services.previews.list(pid, nid)).toEqual([]);
		expect(await api.deps.services.previews.cleanupCandidates()).toEqual([]);
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
	});

	it.each([-1, 0, 30 * 24 * 60 * 60_000 + 1])(
		'rejects expiry offset %i without leaving a maintenance marker',
		async (offset) => {
			vi.useFakeTimers({ toFake: ['Date'] });
			await expectError(
				await api.request('POST', base, {
					...body,
					expires_at: new Date(Date.now() + offset).toISOString(),
				}),
				400,
			);
			expect(await api.deps.services.previews.cleanupCandidates()).toEqual([]);
			expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		},
	);

	it.each(['disabled', 'no commit resolver', 'repository denied'] as const)(
		'rejects a GitHub connection with %s before creating records',
		async (condition) => {
			const unavailable = { ...reader };
			if (condition === 'disabled') unavailable.previews = false;
			if (condition === 'no commit resolver') unavailable.resolveCommit = undefined;
			if (condition === 'repository denied') unavailable.supportsRepository = () => false;
			const denied = createTestApi({
				bucket: api.bucket,
				deps: { sourceControl: stubSourceControl({ reader: unavailable }) },
			});
			await expectError(await denied.request('POST', base, body), 400);
			expect(await api.deps.services.previews.cleanupCandidates()).toEqual([]);
			expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		},
	);

	it('blocks launches after initial preparation fails and recovers on a later retry', async () => {
		const fetchWorkspace = vi.mocked(reader.fetchWorkspace);
		fetchWorkspace.mockRejectedValueOnce(new Error('provider credential: must-not-leak'));
		const record = await create();
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		expect(record.lease).toBeUndefined();
		const shown = await expectOk(await api.request('GET', `${base}/${record.id}`));
		expect(JSON.stringify(shown)).not.toContain('must-not-leak');
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			409,
		);
		expect(await api.deps.services.sessions.listActiveByProject(pid)).toEqual([]);
		const recovered = await api.deps.services.previews.prepare(
			record,
			api.deps.sourceControl,
			true,
		);
		expect(recovered.id).toBe(record.id);
		expect(recovered.preparation).toBe('ready');
		expect(recovered.error).toBeUndefined();
		await expectOk(await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }));
	});

	it('keeps serving the last prepared revision when a branch disappears', async () => {
		const record = await create();
		vi.mocked(reader.getBranchHead).mockRejectedValue(
			new ValidationError('Branch no longer exists'),
		);
		const failed = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		expect(failed.state).toBe('active');
		expect(failed.preparation).toBe('failed');
		expect(failed.current).toEqual(record.current);
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		expect(session.origin!.revision_id).toBe(record.current!.version_id);
	});

	it('does not publish an archive missing the configured entry notebook', async () => {
		vi.mocked(reader.fetchWorkspace).mockResolvedValue([
			{ path: 'other.py', bytes: new TextEncoder().encode('unrelated') },
		]);
		const record = await create();
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
			409,
		);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await sweepPreviews(api.deps);
		expect(
			(await api.deps.services.previews.get(pid, nid, record.id)).revisions.map(
				(revision) => revision.notebook_id,
			),
		).toEqual([]);
	});

	it.each([
		{ name: 'fork', sameRepository: false, branch: 'prototype' },
		{ name: 'different head branch', sameRepository: true, branch: 'other' },
	])('never fetches code for a PR with a $name', async ({ sameRepository, branch }) => {
		vi.mocked(reader.getPullRequest!).mockResolvedValue({
			number: 1,
			state: 'open',
			commit: SHA,
			sameRepository,
			branch,
		});
		let record = await api.deps.services.previews.create(
			pid,
			nid,
			{ ...body, pull_request: 1 },
			ACTOR,
			api.deps.sourceControl,
		);
		record = await api.deps.services.previews.prepare(record, api.deps.sourceControl);
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		expect(record.revisions.map((revision) => revision.notebook_id)).toEqual([]);
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
	});

	it('accepts the maximum lifetime but denies access at the exact expiry before cleanup runs', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const expires = Date.now() + 30 * 24 * 60 * 60_000;
		const created = await expectOk<{ id: string }>(
			await api.request('POST', base, { ...body, expires_at: new Date(expires).toISOString() }),
			202,
		);
		await api.deps.services.previews.prepare(
			await api.deps.services.previews.get(pid, nid, created.id),
			api.deps.sourceControl,
		);
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${created.id}/sessions`, { mode: 'edit' }),
		);
		vi.setSystemTime(expires);
		expect(await expectOk(await api.request('GET', base))).toEqual({
			items: [],
			next_cursor: null,
		});
		await expectError(await api.request('GET', `${base}/${created.id}`), 404);
		await expectError(
			await api.request('POST', `${base}/${created.id}/sessions`, { mode: 'app' }),
			404,
		);
		await expectError(
			await api.request(
				'POST',
				`/projects/${pid}/notebooks/${session.notebook_id}/sessions/${session.session_id}/heartbeat`,
			),
			404,
		);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, created.id)).state).toBe('deleted');
		expect(
			(await api.deps.services.sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at,
		).toBeDefined();
	});

	it('revokes preview and live session access when project membership is removed', async () => {
		const record = await create();
		const member = await userApi('editor');
		const session = await expectOk<Session>(
			await member.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		await api.deps.services.projects.removeMember(pid, uid('editor'), ACTOR);
		await expectError(await member.request('GET', `${base}/${record.id}`), 404);
		await expectError(
			await member.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
			404,
		);
		await expectError(
			await member.request(
				'POST',
				`/projects/${pid}/notebooks/${session.notebook_id}/sessions/${session.session_id}/heartbeat`,
			),
			404,
		);
		await expectOk(await api.request('GET', `${base}/${record.id}`));
	});

	it('does not let an expired update lease overwrite a newer prepared revision', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const record = await create();
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		vi.mocked(reader.fetchWorkspace).mockImplementationOnce(async () => {
			started.resolve();
			await proceed.promise;
			return [{ path: 'notebook.py', bytes: new TextEncoder().encode('stale') }];
		});
		head = NEXT;
		const stale = api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		await started.promise;
		try {
			vi.setSystemTime(Date.now() + 600_001);
			head = 'c'.repeat(40);
			const winner = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
			expect(winner.current?.commit).toBe(head);
			proceed.resolve();
			expect((await stale).current).toEqual(winner.current);
			vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
			await sweepPreviews(api.deps);
			expect(
				(await api.deps.services.previews.get(pid, nid, record.id)).revisions.map(
					(revision) => revision.notebook_id,
				),
			).toEqual([winner.current!.notebook_id]);
		} finally {
			proceed.resolve();
			await stale;
		}
	});

	it('recovers from a partial workspace write without publishing or retaining incomplete artifacts', async () => {
		const put = api.bucket.put.bind(api.bucket);
		const writes = vi.spyOn(api.bucket, 'put').mockImplementation((key, value, options) => {
			if (key.endsWith('/workspace/notebook.py'))
				return Promise.reject(new Error('Storage unavailable'));
			return put(key, value, options);
		});
		const record = await create();
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		const failedRuntime = record.revisions[0].notebook_id;
		expect(
			await api.bucket.get(paths.project(pid).notebook(failedRuntime).previewMeta),
		).not.toBeNull();
		writes.mockRestore();
		const recovered = await api.deps.services.previews.prepare(
			record,
			api.deps.sourceControl,
			true,
		);
		expect(recovered.preparation).toBe('ready');
		expect(recovered.current?.notebook_id).not.toBe(failedRuntime);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await sweepPreviews(api.deps);
		expect(
			(await api.bucket.list({ prefix: paths.project(pid).notebook(failedRuntime).base })).objects,
		).toEqual([]);
	});

	it('retains an old revision until its running editor is stopped and reclaimed', async () => {
		const record = await create();
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		head = NEXT;
		const updated = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		await sweepPreviews(api.deps);
		expect(
			(await api.deps.services.previews.get(pid, nid, record.id)).revisions.map(
				(revision) => revision.notebook_id,
			),
		).toContain(record.current!.notebook_id);
		const sessionPath = `/projects/${pid}/notebooks/${session.notebook_id}/sessions/${session.session_id}`;
		const stillRunning = await expectOk<Session>(
			await api.request('POST', `${sessionPath}/heartbeat`),
		);
		expect(stillRunning.status).toBe('running');
		expect(stillRunning.origin!.revision_id).toBe(record.current!.version_id);
		await expectOk(await api.request('DELETE', sessionPath));
		await sweepPreviews(api.deps);
		expect(
			(await api.deps.services.previews.get(pid, nid, record.id)).revisions.map(
				(revision) => revision.notebook_id,
			),
		).toEqual([updated.current!.notebook_id]);
		expect(
			await api.bucket.get(paths.project(pid).notebook(record.current!.notebook_id).previewMeta),
		).toBeNull();
	});
});

describe('Preview admission fencing', () => {
	it('enforces the preview-wide limit through launches and reuses reclaimed capacity', async () => {
		const record = await create();
		const sessions: Session[] = [];
		for (let i = 0; i < 10; i++) {
			const reviewer = await userApi('editor', `reviewer-${i}`);
			sessions.push(
				await expectOk<Session>(
					await reviewer.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
				),
			);
		}
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
			429,
		);
		const first = sessions[0];
		await expectOk(
			await api.request(
				'DELETE',
				`/projects/${pid}/notebooks/${first.notebook_id}/sessions/${first.session_id}`,
			),
		);
		await expectOk(await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }));
		expect((await api.deps.services.previews.get(pid, nid, record.id)).admissions).toHaveLength(10);
	});

	it('releases an unused reservation when the project app cap rejects provisioning', async () => {
		api = createTestApi({
			bucket: api.bucket,
			compute: api.deps.compute,
			deps: {
				sourceControl: api.deps.sourceControl,
				policy: { maxAppsPerProject: 1 },
			},
		});
		const record = await create();
		const first = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		head = NEXT;
		await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			429,
		);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).admissions).toEqual([
			expect.objectContaining({ session_id: first.session_id }),
		]);
	});

	it('rejects a missing ownership ledger instead of deleting an untracked runtime', async () => {
		const record = await create();
		const key = `_system/previews/${pid}/${nid}/${record.id}.json`;
		const { revisions: _revisions, ...corrupt } = record;
		await api.bucket.put(key, JSON.stringify(corrupt));
		await expect(api.deps.services.previews.get(pid, nid, record.id)).rejects.toThrow(
			'Stored data is temporarily unavailable',
		);
		expect(
			await api.bucket.get(paths.project(pid).notebook(record.current!.notebook_id).previewMeta),
		).not.toBeNull();
	});

	it('atomically admits only one concurrent contender for the last slot', async () => {
		const record = await create();
		const service = api.deps.services.previews;
		for (let i = 0; i < 9; i++)
			await service.reserveAdmission(record, record.current!.notebook_id, createSessionId(), 10);
		const outcomes = await Promise.allSettled(
			Array.from({ length: 2 }, () =>
				service.reserveAdmission(record, record.current!.notebook_id, createSessionId(), 10),
			),
		);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
		expect(rejected).toMatchObject({ reason: expect.any(ResourceExhaustedError) });
		expect((await service.get(pid, nid, record.id)).admissions).toHaveLength(10);
	});

	it('retains an old runtime when admission wins after the prune session scan', async () => {
		const record = await create();
		head = NEXT;
		const service = api.deps.services.previews;
		const updated = await service.prepare(record, api.deps.sourceControl, true);
		const old = record.current!.notebook_id;
		const sid = createSessionId();
		await service.prune(
			updated,
			async (runtime) => {
				expect(runtime).toBe(old);
				await service.reserveAdmission(updated, old, sid, 10);
				return false;
			},
			async () => {
				throw new Error('Admitted runtime must not be retired');
			},
		);
		expect(
			(await service.get(pid, nid, record.id)).revisions.map((revision) => revision.notebook_id),
		).toContain(old);
		expect(await api.bucket.get(paths.project(pid).notebook(old).previewMeta)).not.toBeNull();
	});

	it('rejects a delayed admission after pruning fenced the old runtime', async () => {
		const record = await create();
		head = NEXT;
		const service = api.deps.services.previews;
		const updated = await service.prepare(record, api.deps.sourceControl, true);
		await service.prune(
			updated,
			async () => false,
			async () => true,
		);
		await expect(
			service.reserveAdmission(record, record.current!.notebook_id, createSessionId(), 10),
		).rejects.toThrow(NotFoundError);
	});

	it('does not reap a reservation that commits after an expired reservation scan', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const record = await create();
		const service = api.deps.services.previews;
		const sid = createSessionId();
		await service.reserveAdmission(record, record.current!.notebook_id, sid, 10);
		const reserved = await service.get(pid, nid, record.id);
		vi.setSystemTime(Date.now() + 600_001);
		const reaped = await service.reapAdmissions(reserved, async (): Promise<undefined> => {
			await service.commitAdmission(reserved, sid);
		});
		expect(reaped.admissions).toEqual([
			expect.objectContaining({ session_id: sid, committed: true }),
		]);
		const reclaimed = await service.reapAdmissions(reaped, async () => false);
		expect(reclaimed.admissions).toEqual([]);
	});

	it('reaps crashed reservations and fences their delayed session record commits', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const record = await create();
		const service = api.deps.services.previews;
		const sid = createSessionId();
		await service.reserveAdmission(record, record.current!.notebook_id, sid, 10);
		const reserved = await service.get(pid, nid, record.id);
		vi.setSystemTime(Date.now() + 600_001);
		expect(
			(
				await service.reapAdmissions(
					reserved,
					vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
				)
			).admissions,
		).toEqual([]);
		await expect(service.commitAdmission(reserved, sid)).rejects.toThrow(NotFoundError);
	});

	it('rejects a partially prepared runtime while continuing to serve its published predecessor', async () => {
		const original = await create();
		const put = api.bucket.put.bind(api.bucket);
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		vi.spyOn(api.bucket, 'put').mockImplementation(async (key, bytes, options) => {
			if (key.endsWith('/workspace/notebook.py')) {
				started.resolve();
				await proceed.promise;
			}
			return put(key, bytes, options);
		});
		head = NEXT;
		const updating = api.deps.services.previews.prepare(original, api.deps.sourceControl, true);
		await started.promise;
		try {
			const record = await api.deps.services.previews.get(pid, nid, original.id);
			const reserved = record.revisions
				.map((revision) => revision.notebook_id)
				.find((id) => id !== original.current!.notebook_id)!;
			await expect(api.deps.services.notebooks.getNotebookMeta(pid, reserved)).rejects.toThrow(
				NotFoundError,
			);
			await expect(
				api.deps.services.notebooks.getNotebookMeta(pid, original.current!.notebook_id),
			).resolves.toMatchObject({ id: original.current!.notebook_id });
		} finally {
			proceed.resolve();
			await updating;
		}
	});
});

describe('Preview source and compute boundaries', () => {
	it.each([251, 255, 256])('accepts a valid branch name with %i characters', async (length) => {
		const branch = 'a'.repeat(length);
		const record = await create({ ...body, source: { type: 'branch', branch } });
		expect(record.preparation).toBe('ready');
		expect(reader.getBranchHead).toHaveBeenCalledWith('owner/repo', branch, {
			signal: expect.any(AbortSignal),
		});
	});

	it.each(['branch', 'workspace', 'pull request'] as const)(
		'retains the last revision after a provider NotFoundError for %s and retries later',
		async (operation) => {
			const result = await expectOk<{ id: string }>(
				await api.request('POST', base, {
					...body,
					...(operation === 'pull request' ? { pull_request: 1 } : {}),
				}),
				202,
			);
			const record = await api.deps.services.previews.prepare(
				await api.deps.services.previews.get(pid, nid, result.id),
				api.deps.sourceControl,
			);
			const method =
				operation === 'branch'
					? reader.getBranchHead
					: operation === 'workspace'
						? reader.fetchWorkspace
						: reader.getPullRequest!;
			vi.mocked(method).mockRejectedValueOnce(new NotFoundError('Source unavailable'));
			head = NEXT;
			const failed = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
			expect(failed).toMatchObject({
				state: 'active',
				preparation: 'failed',
				current: record.current,
			});
			expect(failed.lease).toBeUndefined();
			const session = await expectOk<Session>(
				await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			);
			expect(session.origin!.revision_id).toBe(record.current!.version_id);
			const recovered = await api.deps.services.previews.prepare(
				failed,
				api.deps.sourceControl,
				true,
			);
			expect(recovered).toMatchObject({
				state: 'active',
				preparation: 'ready',
				current: { commit: NEXT },
			});
		},
	);

	it('keeps a pinned preview retryable when its initial commit lookup returns NotFoundError', async () => {
		vi.mocked(reader.resolveCommit!).mockRejectedValueOnce(new NotFoundError('Commit unavailable'));
		const result = await expectOk<{ id: string }>(
			await api.request('POST', base, {
				...body,
				source: { type: 'commit', commit: SHA },
			}),
			202,
		);
		const record = await api.deps.services.previews.prepare(
			await api.deps.services.previews.get(pid, nid, result.id),
			api.deps.sourceControl,
		);
		expect(record).toMatchObject({ state: 'active', preparation: 'failed' });
		expect(record.current).toBeUndefined();
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			409,
		);
		const recovered = await api.deps.services.previews.prepare(
			record,
			api.deps.sourceControl,
			true,
		);
		expect(recovered).toMatchObject({
			state: 'active',
			preparation: 'ready',
			current: { commit: SHA },
		});
	});

	it('retires a preview when parent metadata is confirmed missing', async () => {
		const record = await create();
		await api.bucket.delete(paths.project(pid).notebook(nid).meta);
		const result = await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
		expect(result.state).toBe('deleting');
	});

	it('refuses filesystem snapshot writes for hidden preview runtimes', async () => {
		const record = await create();
		const child = record.current!.notebook_id;
		const nb = paths.project(pid).notebook(child);
		expect(await api.bucket.get(nb.meta)).toBeNull();
		await expect(
			api.deps.services.notebooks.setFsSnapshot(pid, child, {
				snapshot_id: 'discard-only',
				captured_at: new Date().toISOString(),
			}),
		).rejects.toThrow('Preview sessions cannot persist changes');
		expect(await api.bucket.get(nb.fsSnapshot)).toBeNull();
	});

	it.each([
		{ requested: undefined, expected: 'small', stored: undefined, namedDefault: false },
		{ requested: 'default', expected: 'small', stored: undefined, namedDefault: false },
		{ requested: 'normal', expected: 'normal', stored: 'normal', namedDefault: false },
		{ requested: 'large', expected: 'large', stored: 'large', namedDefault: false },
		{ requested: 'default', expected: 'default', stored: 'default', namedDefault: true },
	])(
		'selects $expected for override $requested (named default: $namedDefault) despite the parent profile',
		async ({ requested, expected, stored, namedDefault }) => {
			const parentKey = paths.project(pid).notebook(nid).meta;
			const parent = await api.deps.services.notebooks.getNotebookMeta(pid, nid);
			await api.bucket.put(parentKey, JSON.stringify({ ...parent, compute_profile: 'large' }));
			const compute = makeFakeCompute();
			api = createTestApi({
				bucket: api.bucket,
				compute,
				deps: {
					sourceControl: api.deps.sourceControl,
					sandbox: {
						...api.deps.sandbox,
						computeProfileOverride: 'editors',
						previewComputeProfile: 'small',
						computeProfiles: [
							{ name: 'normal', resources: { cpu: 4 } },
							{ name: 'large', resources: { cpu: 8 } },
							{ name: 'small', resources: { cpu: 1 } },
							...(namedDefault ? [{ name: 'default', resources: { cpu: 2 } }] : []),
						],
					},
				},
			});
			const result = await expectOk<{ id: string }>(
				await api.request('POST', base, {
					...body,
					...(requested ? { compute_profile: requested } : {}),
				}),
				202,
			);
			const record = await api.deps.services.previews.prepare(
				await api.deps.services.previews.get(pid, nid, result.id),
				api.deps.sourceControl,
			);
			expect(record.compute_profile).toBe(stored);
			for (const mode of ['edit', 'app'] as const) {
				const session = await expectOk<Session>(
					await api.request('POST', `${base}/${record.id}/sessions`, { mode }),
				);
				expect(session.compute_profile).toBe(expected);
			}
			expect((await api.deps.services.notebooks.getNotebookMeta(pid, nid)).compute_profile).toBe(
				'large',
			);
		},
	);
});

describe('asynchronous preview preparation', () => {
	it('does not consume scheduled work when already cancelled', async () => {
		const service = api.deps.services.previews;
		const scan = vi.spyOn(service.store, 'nextProjects');
		await service.preparePending(api.deps.sourceControl!, AbortSignal.abort());
		expect(scan).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		'does not count shutdown cancellation as a preparation failure: published=%s',
		async (published) => {
			const service = api.deps.services.previews;
			const record = published
				? await create()
				: await service.create(pid, nid, body, ACTOR, api.deps.sourceControl);
			const reached = Promise.withResolvers<void>();
			vi.mocked(reader.getBranchHead).mockImplementation(() => {
				reached.resolve();
				return new Promise(() => {});
			});
			const controller = new AbortController();
			const preparing = service.prepare(record, api.deps.sourceControl, true, controller.signal);
			await reached.promise;
			controller.abort(new Error('server shutdown'));
			const cancelled = await preparing;
			expect(cancelled.preparation).toBe(published ? 'ready' : 'pending');
			expect(cancelled.preparation_failures).toBe(record.preparation_failures);
			expect(cancelled.next_attempt_at).toBe(record.next_attempt_at);
			expect(cancelled.current).toEqual(record.current);
			expect(cancelled.error).toBeUndefined();
			expect(cancelled.lease).toBeUndefined();
		},
	);

	it('recovers the same retry key after capacity is released beyond the creation deadline', async () => {
		const service = api.deps.services.previews;
		const createPending = (key?: string, input = body) =>
			service.create(pid, nid, input, ACTOR, api.deps.sourceControl, key);
		const first = await createPending();
		for (let i = 1; i < 25; i++) await createPending();
		await expect(createPending('retry-capacity')).rejects.toThrow(ResourceExhaustedError);
		const receipt = await (await api.bucket.get(`_system/preview-receipts/${pid}.json`))!.json<{
			entries: { id: string; created_at: string; expires_at: number }[];
		}>();
		await expect(createPending('retry-capacity', { ...body, name: 'Different' })).rejects.toThrow(
			'Idempotency',
		);
		const retired = await service.retire(first);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await service.cleanup(retired, async () => true);
		const recovered = await createPending('retry-capacity');
		expect(recovered.id).toBe(receipt.entries[0].id);
		expect(recovered.created_at).toBe(receipt.entries[0].created_at);
		expect((await createPending('retry-capacity')).id).toBe(recovered.id);
		expect(await service.list(pid, nid)).toHaveLength(25);
		const deleted = await service.retire(recovered);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await service.cleanup(deleted, async () => true);
		await expect(createPending('retry-capacity')).rejects.toThrow('deleted');
	});

	it('fences an in-flight retry after the original preview is deleted and reclaimed', async () => {
		const service = api.deps.services.previews;
		const record = await service.create(
			pid,
			nid,
			body,
			ACTOR,
			api.deps.sourceControl,
			'stale-retry',
		);
		const arrived = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const reserve = service.store.reserve.bind(service.store);
		vi.spyOn(service.store, 'reserve').mockImplementationOnce(async (...args) => {
			arrived.resolve();
			await resume.promise;
			return reserve(...args);
		});
		const retry = service.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'stale-retry');
		const rejected = expect(retry).rejects.toThrow('creation attempt expired');
		await arrived.promise;
		try {
			const retired = await service.retire(record);
			vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
			await service.cleanup(retired, async () => true);
		} finally {
			resume.resolve();
		}
		await rejected;
		expect(await service.list(pid, nid)).toEqual([]);
	});

	it('creates pending intent without GitHub and returns a stable share URL', async () => {
		vi.mocked(reader.getBranchHead).mockImplementation(() => new Promise(() => {}));
		const pending = await expectOk<{ id: string; preparation: string; url: string }>(
			await api.request('POST', base, body),
			202,
		);
		expect(pending.preparation).toBe('pending');
		expect(pending.url).toContain(pending.id);
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		const response = await api.request('POST', `${base}/${pending.id}/sessions`, { mode: 'app' });
		await expectError(response, 409, 'PREVIEW_NOT_READY');
		expect(await api.deps.services.sessions.listActiveByProject(pid)).toEqual([]);
	});

	it('launches the published revision and runs maintenance during a hung refresh', async () => {
		const ready = await create();
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		vi.mocked(reader.getBranchHead).mockImplementation(async (_repo, _branch, options) => {
			started.resolve();
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			return new Promise(() => {});
		});
		const preparing = api.deps.services.previews.prepare(
			ready,
			api.deps.sourceControl,
			true,
			controller.signal,
		);
		await started.promise;
		try {
			const session = await expectOk<Session>(
				await api.request('POST', `${base}/${ready.id}/sessions`, { mode: 'app' }),
			);
			expect(session.origin!.revision_id).toBe(ready.current!.version_id);
			await sweepPreviews(api.deps);
			expect(reader.getBranchHead).toHaveBeenCalledTimes(2);
		} finally {
			controller.abort();
			await preparing;
		}
		expect((await api.deps.services.previews.get(pid, nid, ready.id)).current).toEqual(
			ready.current,
		);
	});

	it('aborts at the attempt deadline, backs off, and ignores late archive completion', async () => {
		vi.useFakeTimers();
		const pending = await api.deps.services.previews.create(
			pid,
			nid,
			body,
			ACTOR,
			api.deps.sourceControl,
		);
		const started = Promise.withResolvers<void>();
		const archive =
			Promise.withResolvers<Awaited<ReturnType<SourceControlReader['fetchWorkspace']>>>();
		let signal: AbortSignal | undefined;
		vi.mocked(reader.fetchWorkspace).mockImplementation((_repo, _sha, _root, options) => {
			signal = options?.signal;
			started.resolve();
			return archive.promise;
		});
		const preparation = api.deps.services.previews.prepare(pending, api.deps.sourceControl);
		await started.promise;
		await vi.advanceTimersByTimeAsync(119_000);
		const failed = await preparation;
		expect(signal?.aborted).toBe(true);
		expect(failed.preparation).toBe('failed');
		expect(failed.next_attempt_at).toBeGreaterThan(Date.now());
		expect(failed.preparation_failures).toBe(1);
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(1);
		archive.resolve([{ path: 'notebook.py', bytes: new TextEncoder().encode('late') }]);
		await vi.advanceTimersByTimeAsync(0);
		expect((await api.deps.services.previews.get(pid, nid, pending.id)).current).toBeUndefined();
		for (const runtime of failed.revisions.map((revision) => revision.notebook_id))
			expect(await api.bucket.head(paths.project(pid).notebook(runtime).previewMeta)).toBeNull();
	});

	it('repairs creation interrupted after membership was persisted', async () => {
		const put = api.bucket.put.bind(api.bucket);
		const writes = vi
			.spyOn(api.bucket, 'put')
			.mockImplementation((key, value, options) =>
				key.startsWith('_system/previews/')
					? Promise.reject(new Error('unavailable'))
					: put(key, value, options),
			);
		await expect(
			api.deps.services.previews.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'recover'),
		).rejects.toThrow('unavailable');
		writes.mockRestore();
		await api.deps.services.previews.preparePending(api.deps.sourceControl!);
		const replay = await api.deps.services.previews.create(
			pid,
			nid,
			body,
			ACTOR,
			api.deps.sourceControl,
			'recover',
		);
		expect(replay.preparation).toBe('ready');
		expect(await api.deps.services.previews.list(pid, nid)).toHaveLength(1);
	});

	it('lists a bounded active index, paginates, and does not scan historical tombstones', async () => {
		const first = await create();
		const second = await create({ ...body, name: 'Second' });
		for (let i = 0; i < 50; i++)
			await api.bucket.put(
				`_system/previews/${pid}/${nid}/history-${i}.json`,
				'invalid historical record',
			);
		const lists = vi.spyOn(api.bucket, 'list');
		const page = await expectOk<{ items: { id: string }[]; next_cursor: string }>(
			await api.request('GET', `${base}?limit=1`),
		);
		const next = await expectOk<{ items: { id: string }[]; next_cursor: null }>(
			await api.request('GET', `${base}?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`),
		);
		expect([...page.items, ...next.items].map((item) => item.id).sort()).toEqual(
			[first.id, second.id].sort(),
		);
		expect(next.next_cursor).toBeNull();
		expect(lists).not.toHaveBeenCalled();
		await expectError(await api.request('GET', `${base}?cursor=invalid`), 400);
	});

	it('revokes immediately and retains capacity until reclamation and grace complete', async () => {
		const record = await create();
		const cleanup = vi.spyOn(api.deps.services.previews, 'cleanup');
		await expectOk(await api.request('DELETE', `${base}/${record.id}`), 202);
		expect(cleanup).not.toHaveBeenCalled();
		await expectError(await api.request('GET', `${base}/${record.id}`), 404);
		expect((await api.deps.services.previews.store.project(pid)).entries).toHaveLength(1);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.store.project(pid)).entries).toEqual([]);
		expect(await api.bucket.head(`_system/previews/${pid}/${nid}/${record.id}.json`)).toBeNull();
	});
});

describe('preview worker recovery', () => {
	it('rotates due previews within a project and skips pinned revisions after preparation', async () => {
		const service = api.deps.services.previews;
		const branch = await service.create(pid, nid, body, ACTOR, api.deps.sourceControl);
		const pinned = await service.create(
			pid,
			nid,
			{ name: 'Pinned', source: { type: 'commit', commit: SHA } },
			ACTOR,
			api.deps.sourceControl,
		);
		await service.preparePending(api.deps.sourceControl!);
		await service.preparePending(api.deps.sourceControl!);
		expect((await service.get(pid, nid, branch.id)).current?.commit).toBe(SHA);
		expect((await service.get(pid, nid, pinned.id)).current?.commit).toBe(SHA);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
		head = NEXT;
		await service.preparePending(api.deps.sourceControl!);
		expect((await service.get(pid, nid, branch.id)).current?.commit).toBe(NEXT);
		expect((await service.get(pid, nid, pinned.id)).current?.commit).toBe(SHA);
		expect(reader.resolveCommit).toHaveBeenCalledOnce();
	});

	it('does not rematerialize a preview after cleanup stops between record deletion and membership removal', async () => {
		const service = api.deps.services.previews;
		const record = await create();
		await service.retire(record);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		const forget = vi
			.spyOn(service.store, 'forget')
			.mockRejectedValueOnce(new Error('storage unavailable'));
		await sweepPreviews(api.deps);
		expect(await service.list(pid, nid)).toEqual([]);
		expect(await api.bucket.head(`_system/previews/${pid}/${nid}/${record.id}.json`)).toBeNull();
		forget.mockRestore();
		await sweepPreviews(api.deps);
		expect((await service.store.project(pid)).entries).toEqual([]);
		await expect(service.get(pid, nid, record.id)).rejects.toThrow(NotFoundError);
	});

	it('retains artifact ownership while reclamation fails', async () => {
		const service = api.deps.services.previews;
		const record = await create();
		const retired = await service.retire(record);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await service.cleanup(retired, async () => false);
		expect((await service.store.project(pid)).entries[0].artifacts).toHaveLength(1);
		await service.cleanup(retired, async () => true);
		expect((await service.store.project(pid)).entries).toEqual([]);
	});
});

describe('preview preparation quota failures', () => {
	it('retains the published revision and avoids downloading when artifact capacity is exhausted', async () => {
		const record = await create();
		const service = api.deps.services.previews;
		const reserve = vi
			.spyOn(service.store, 'reserveArtifact')
			.mockRejectedValueOnce(new ResourceExhaustedError('full'));
		head = NEXT;
		const failed = await service.prepare(record, api.deps.sourceControl, true);
		expect(failed.preparation).toBe('failed');
		expect(failed.current).toEqual(record.current);
		expect(failed.revisions.map((revision) => revision.notebook_id)).toEqual(
			record.revisions.map((revision) => revision.notebook_id),
		);
		expect(failed.revisions).toEqual(record.revisions);
		expect(reader.fetchWorkspace).toHaveBeenCalledOnce();
		reserve.mockRestore();
		const recovered = await service.prepare(failed, api.deps.sourceControl, true);
		expect(recovered.current?.commit).toBe(NEXT);
	});
});

describe('preview session resource identity', () => {
	it.each(['app', 'edit'] as const)(
		'persists immutable %s provenance and exposes only the parent identity',
		async (mode) => {
			const record = await create();
			const started = await expectOk<Session & { resource_path: string }>(
				await api.request('POST', `${base}/${record.id}/sessions`, { mode }),
			);
			const expectedOrigin = {
				type: 'preview',
				notebook_id: nid,
				preview_id: record.id,
				revision_id: record.current!.version_id,
				commit: SHA,
			};
			expect(started.notebook_id).toBe(nid);
			expect(started).not.toHaveProperty('source_version_id');
			expect(started.origin).toEqual(expectedOrigin);
			expect(started.resource_path).toBe(`${base}/${record.id}`);
			expect(JSON.stringify(started)).not.toContain(record.current!.notebook_id);
			const stored = await api.deps.services.sessions.getSession(pid, started.session_id);
			expect(stored.notebook_id).toBe(record.current!.notebook_id);
			expect(stored.origin).toEqual(expectedOrigin);
			head = NEXT;
			await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
			const path = `/projects/${pid}/notebooks/${nid}/sessions/${started.session_id}`;
			expect((await expectOk<Session>(await api.request('GET', path))).origin).toEqual(
				expectedOrigin,
			);
			expect(
				(await expectOk<Session>(await api.request('POST', `${path}/heartbeat`))).origin,
			).toEqual(expectedOrigin);
			await expectError(
				await api.request(
					'GET',
					`/projects/${pid}/notebooks/${record.current!.notebook_id}/sessions/${started.session_id}`,
				),
				404,
			);
			await expectError(
				await api.request(
					'GET',
					`/projects/${pid}/notebooks/nb-0000000000000000/sessions/${started.session_id}`,
				),
				404,
			);
			await expectOk(await api.request('DELETE', path));
		},
	);

	it('preserves provenance when an app allocation is reused', async () => {
		const record = await create();
		const launch = () => api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' });
		const first = await expectOk<Session>(await launch());
		const reused = await expectOk<Session & { reused: boolean }>(await launch());
		expect(reused.reused).toBe(true);
		expect(reused.session_id).toBe(first.session_id);
		expect(reused.origin).toEqual(first.origin);
	});

	it.each(['deleting', 'expired'] as const)(
		'rejects app reuse when a preview becomes %s after loading the runtime',
		async (state) => {
			const record = await create();
			const launch = () => api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' });
			await expectOk<Session>(await launch());
			const notebooks = api.deps.services.notebooks;
			const getNotebook = notebooks.getNotebook.bind(notebooks);
			vi.spyOn(notebooks, 'getNotebook').mockImplementation(async (projectId, notebookId) => {
				const result = await getNotebook(projectId, notebookId);
				if (notebookId === record.current!.notebook_id) {
					if (state === 'deleting') await api.deps.services.previews.retire(record);
					else vi.spyOn(Date, 'now').mockReturnValue(Date.parse(record.expires_at));
				}
				return result;
			});

			await expectError(await launch(), 404);
		},
	);

	it('serves preview surfaces through the parent route and revokes them on deletion', async () => {
		const record = await create();
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		await api.deps.services.sessions.setSurfaceState(pid, session.session_id, 'vscode', {
			status: 'ready',
			port: 8443,
			started_at: new Date().toISOString(),
		});
		const suffix = `/sessions/${session.session_id}/surfaces/vscode`;
		const path = `/projects/${pid}/notebooks/${nid}${suffix}`;
		expect(await expectOk(await api.request('GET', path))).toMatchObject({ status: 'ready' });
		await expectError(
			await api.request(
				'GET',
				`/projects/${pid}/notebooks/${record.current!.notebook_id}${suffix}`,
			),
			404,
		);
		await api.deps.services.previews.retire(record);
		await expectError(await api.request('GET', path), 404);
	});

	it('retains readable history and audit attribution after preview and runtime cleanup', async () => {
		const record = await create();
		const started = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		const path = `/projects/${pid}/notebooks/${nid}/sessions/${started.session_id}`;
		await expectOk(await api.request('DELETE', `${base}/${record.id}`), 202);
		const poolView = vi
			.spyOn(AppPoolService.prototype, 'view')
			.mockRejectedValue(new Error('Unavailable pool'));
		const revoked = await expectOk<{
			origin: Session['origin'];
			can: { attach: boolean };
			sandbox_url?: string;
		}>(await api.request('GET', path));
		expect(revoked.origin).toEqual(started.origin);
		expect(revoked.can.attach).toBe(false);
		expect(revoked.sandbox_url).toBeUndefined();
		const listed = await expectOk<{ items: Session[] }>(
			await api.request('GET', `/projects/${pid}/sessions`),
		);
		expect(listed.items.find((session) => session.session_id === started.session_id)).toMatchObject(
			{
				notebook_id: nid,
				origin: started.origin,
				can: { attach: false, stop: false },
			},
		);
		expect(poolView).not.toHaveBeenCalled();
		poolView.mockRestore();
		await expectError(await api.request('POST', `${path}/heartbeat`), 404);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await sweepPreviews(api.deps);
		expect(
			await api.bucket.get(paths.project(pid).notebook(record.current!.notebook_id).previewMeta),
		).toBeNull();
		const history = await expectOk<Session>(await api.request('GET', path));
		expect(history.origin).toEqual(started.origin);
		expect(history.notebook_id).toBe(nid);
		expect(history.status).toBe('terminated');
		const events = await api.deps.services.events.getEvents(new Date().toISOString().slice(0, 10));
		expect(events.find((event) => event.event === 'app.start')).toMatchObject({
			notebook_id: nid,
			origin: started.origin,
			session_id: started.session_id,
		});
	});

	it('uses current parent permissions for history after runtime cleanup', async () => {
		const record = await create();
		const member = await userApi('editor');
		const started = await expectOk<Session>(
			await member.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		await api.deps.services.previews.retire(record);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
		await sweepPreviews(api.deps);
		const path = `/projects/${pid}/notebooks/${nid}/sessions/${started.session_id}`;
		await expectOk(await member.request('GET', path));
		await api.deps.services.projects.removeMember(pid, uid('editor'), ACTOR);
		await expectError(await member.request('GET', path), 404);
	});
});

it('blocks proxy access immediately after preview revocation without consulting runtime metadata', async () => {
	api = createTestApi({
		bucket: api.bucket,
		compute: api.deps.compute,
		deps: {
			...api.deps,
			sandbox: {
				...api.deps.sandbox,
				appBaseUrl: 'https://hub.example.com',
				exposure: new ProxyExposure('preview-provenance-secret'),
			},
		},
	});
	const record = await create();
	const started = await expectOk<Session>(
		await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
	);
	const request = new Request(started.sandbox_url!);
	expect((await authorizeProxyRequest(request, api.deps)).kind).toBe('forward');
	await api.deps.services.previews.retire(record);
	expect(await authorizeProxyRequest(request, api.deps)).toMatchObject({
		kind: 'reject',
		status: 404,
	});
});

it('pins session provenance to the loaded runtime when the branch advances during launch', async () => {
	const record = await create();
	const started = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const notebooks = api.deps.services.notebooks;
	const getNotebook = notebooks.getNotebook.bind(notebooks);
	let blocked = false;
	vi.spyOn(notebooks, 'getNotebook').mockImplementation(async (projectId, notebookId) => {
		const result = await getNotebook(projectId, notebookId);
		if (notebookId === record.current!.notebook_id && !blocked) {
			blocked = true;
			started.resolve();
			await proceed.promise;
		}
		return result;
	});
	const launching = api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' });
	await started.promise;
	try {
		head = NEXT;
		await api.deps.services.previews.prepare(record, api.deps.sourceControl, true);
	} finally {
		proceed.resolve();
	}
	const session = await expectOk<Session>(await launching);
	expect(session.origin).toMatchObject({ revision_id: record.current!.version_id, commit: SHA });
});

describe('source discovery validation and cancellation', () => {
	it.each(['branch', 'commit'] as const)(
		'rejects blank %s resolution queries before provider calls',
		async (type) => {
			for (const query of ['', '&query=', '&query=%20%09']) {
				await expectError(
					await api.request(
						'GET',
						`/projects/${pid}/notebooks/${nid}/source/refs?type=${type}&resolve=true${query}`,
					),
					422,
				);
			}
			expect(reader.getBranchHead).not.toHaveBeenCalled();
			expect(reader.resolveCommit).not.toHaveBeenCalled();
			expect(reader.listBranches).not.toHaveBeenCalled();
			expect(reader.listCommits).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ type: 'branch', resolve: false, method: 'listBranches' },
		{ type: 'commit', resolve: false, method: 'listCommits' },
		{ type: 'branch', resolve: true, method: 'getBranchHead' },
		{ type: 'commit', resolve: true, method: 'resolveCommit' },
	] as const)('forwards cancellation to $method', async ({ type, resolve, method }) => {
		const controller = new AbortController();
		const reason = new Error('Discovery request disconnected');
		const called = Promise.withResolvers<AbortSignal>();
		const proceed = Promise.withResolvers<void>();
		const waitForCancellation = async (options?: SourceReadOptions) => {
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			called.resolve(options!.signal!);
			await proceed.promise;
		};
		if (method === 'listBranches' || method === 'listCommits') {
			vi.mocked(reader[method]!).mockImplementation(async (_repo, _query, options) => {
				await waitForCancellation(options);
				return [];
			});
		} else {
			vi.mocked(reader[method]!).mockImplementation(async (_repo, _query, options) => {
				await waitForCancellation(options);
				return { commit: SHA };
			});
		}
		const request = api.app.request(
			`/api/v1/projects/${pid}/notebooks/${nid}/source/refs?type=${type}&resolve=${resolve}&query=${SHA}`,
			{ signal: controller.signal },
		);
		const signal = await called.promise;
		controller.abort(reason);
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBe(reason);
		proceed.resolve();
		await expectOk(await request);
	});
});
