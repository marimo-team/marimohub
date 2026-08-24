import { describe, it, expect, beforeEach, vi } from 'vitest';
import { zipSync } from 'fflate';
import {
	BadRequestError,
	createNotebookId,
	createServices,
	MAX_GIT_DIRECTORY_FILES,
	paths,
	UnavailableError,
} from '@marimo-hub/core';
import type {
	NotebookId,
	ProjectId,
	SourceControlReader,
	SourceWorkspaceFile,
	VersionId,
} from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	stubSourceControl,
} from '../testing';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const encode = (s: string) => new TextEncoder().encode(s);

function stubReader(overrides: Partial<SourceControlReader> = {}): SourceControlReader {
	return {
		provider: 'github',
		supportsRepository: () => true,
		getBranchHead: async () => ({ commit: HEAD }),
		fetchWorkspace: async () => [{ path: 'app.py', bytes: encode('print("synced")') }],
		...overrides,
	};
}

describe('Source drift and sync-now routes', () => {
	let bucket: MemoryBucket;
	let projectId: ProjectId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const project = await createServices(bucket).projects.createProject(
			{ name: 'Test', description: 'test' },
			ACTOR,
		);
		projectId = project.id;
	});

	function api(reader?: SourceControlReader) {
		return createTestApi({
			bucket,
			deps: reader ? { sourceControl: stubSourceControl({ reader }) } : {},
		});
	}

	async function createSyncedNotebook(
		request: ReturnType<typeof createTestApi>['request'],
		repo = 'org/repo',
	) {
		const data = await expectOk<{ notebook: { id: string } }>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'GitHub app',
				description: 'Synced',
				repo,
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);
		return data.notebook.id;
	}

	async function createPullNotebook(request: ReturnType<typeof createTestApi>['request']) {
		const data = await expectOk<{ notebook: { id: string } }>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Connected app',
				description: 'Pulled by the server',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
				sync_mode: 'pull',
			}),
			201,
		);
		return data.notebook.id;
	}

	it('creates a pull source with an inline first sync and no push credentials', async () => {
		const reader = stubReader({
			fetchGitDirectory: async () => [
				{ path: 'HEAD', bytes: encode('ref: refs/heads/main\n') },
				{ path: 'index', bytes: encode('index') },
			],
		});
		const { request, deps } = api(reader);
		const created = await expectOk<{
			notebook: { id: string; status: string };
			sync_url?: string;
			sync_token?: string;
		}>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Connected app',
				description: 'Pulled by the server',
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
				sync_mode: 'pull',
			}),
			201,
		);
		expect(created.notebook.status).toBe('active');
		expect(created.sync_url).toBeUndefined();
		expect(created.sync_token).toBeUndefined();

		const detail = await deps.services.notebooks.getNotebook(
			projectId,
			created.notebook.id as NotebookId,
		);
		expect(detail.source).toMatchObject({ sync_mode: 'pull', commit: HEAD });
		if (detail.source.type !== 'git' || !detail.source.current_version_id) {
			throw new Error('expected pull source version');
		}
		const version = paths
			.project(projectId)
			.notebook(created.notebook.id as NotebookId)
			.version(detail.source.current_version_id);
		expect(await (await bucket.get(version.gitFile('HEAD')))!.text()).toBe(
			'ref: refs/heads/main\n',
		);
		expect(
			await bucket.get(
				paths.project(projectId).notebook(created.notebook.id as NotebookId).integrationSyncToken,
			),
		).toBeNull();
	});

	it('returns the created notebook when the post-sync refetch fails', async () => {
		const reader = stubReader({
			fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }],
		});
		const { request, deps } = api(reader);
		const getNotebook = deps.services.notebooks.getNotebook.bind(deps.services.notebooks);
		const notebookLookup = vi
			.spyOn(deps.services.notebooks, 'getNotebook')
			.mockImplementationOnce(getNotebook)
			.mockImplementationOnce(getNotebook)
			.mockRejectedValueOnce(new UnavailableError('Notebook refetch failed'));

		const created = await expectOk<{
			notebook: { id: string; status: string };
			sync_error?: unknown;
		}>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Connected app',
				description: 'Pulled by the server',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
				sync_mode: 'pull',
			}),
			201,
		);

		expect(created.notebook.status).toBe('draft');
		expect(created.sync_error).toBeUndefined();
		expect(notebookLookup).toHaveBeenCalledTimes(3);
		expect(
			await deps.services.notebooks.listVersions(projectId, created.notebook.id as NotebookId),
		).toHaveLength(1);
	});

	it('rejects pull creation without Git materialization support or with a subtree', async () => {
		const { request } = api(stubReader());
		const body = {
			title: 'Connected app',
			description: 'Pulled by the server',
			repo: 'org/repo',
			branch: 'main',
			root_path: '',
			entry_notebook: 'app.py',
			sync_mode: 'pull',
		};
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/git`, body),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		const capable = api(stubReader({ fetchGitDirectory: async () => [] }));
		await expectError(
			await capable.request('POST', `/projects/${projectId}/notebooks/git`, {
				...body,
				root_path: 'apps',
			}),
			400,
		);
	});

	it('keeps a draft pull source and surfaces an inline sync failure', async () => {
		const reader = stubReader({
			fetchWorkspace: async () => {
				throw new UnavailableError('GitHub tarball is unavailable');
			},
			fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }],
		});
		const { request } = api(reader);
		const created = await expectOk<{
			notebook: { id: string; status: string };
			sync_error: { code: string; message: string };
		}>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Connected app',
				description: 'Pulled by the server',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
				sync_mode: 'pull',
			}),
			201,
		);
		expect(created.notebook.status).toBe('draft');
		expect(created.sync_error).toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
			message: 'GitHub tarball is unavailable',
		});
		expect(
			(
				await expectOk<any>(
					await request('GET', `/projects/${projectId}/notebooks/${created.notebook.id}`),
				)
			).source,
		).toMatchObject({ sync_mode: 'pull', current_version_id: null });
	});

	it('rejects oversized Git metadata before persisting a version', async () => {
		const reader = stubReader({
			fetchGitDirectory: async () =>
				Array.from({ length: MAX_GIT_DIRECTORY_FILES + 1 }, (_, index) => ({
					path: `objects/${index}`,
					bytes: new Uint8Array(),
				})),
		});
		const { request, deps } = api(reader);
		const created = await expectOk<{
			notebook: { id: string; status: string };
			sync_error: { code: string; message: string };
		}>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Connected app',
				description: 'Pulled by the server',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
				sync_mode: 'pull',
			}),
			201,
		);

		expect(created.notebook.status).toBe('draft');
		expect(created.sync_error).toMatchObject({ code: 'BAD_REQUEST' });
		expect(created.sync_error.message).toMatch(`${MAX_GIT_DIRECTORY_FILES}-file limit`);
		expect(
			await deps.services.notebooks.listVersions(projectId, created.notebook.id as NotebookId),
		).toHaveLength(0);
	});

	it('rejects mode switching for a pull source', async () => {
		const { request } = api(
			stubReader({
				supportsRepository: (repo) => !repo.includes('enterprise'),
				fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }],
			}),
		);
		const notebookId = await createPullNotebook(request);
		const path = `/projects/${projectId}/notebooks/${notebookId}/source`;
		await expectError(
			await request('PATCH', path, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
				sync_mode: 'push',
			}),
			400,
		);
		const detail = await expectOk<{ source: { sync_mode: string } }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebookId}`),
		);
		expect(detail.source.sync_mode).toBe('pull');
	});

	it('rejects subtree settings for a pull source', async () => {
		const { request } = api(
			stubReader({ fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }] }),
		);
		const notebookId = await createPullNotebook(request);
		const path = `/projects/${projectId}/notebooks/${notebookId}/source`;

		await expectError(
			await request('PATCH', path, {
				repo: 'org/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'app.py',
			}),
			400,
		);
		const detail = await expectOk<{
			source: { root_path: string; pending_config?: unknown };
		}>(await request('GET', `/projects/${projectId}/notebooks/${notebookId}`));
		expect(detail.source).toMatchObject({ root_path: '' });
		expect(detail.source.pending_config).toBeUndefined();
	});

	it('rejects unsupported pull repositories without mutating the source', async () => {
		const { request } = api(
			stubReader({
				supportsRepository: (repo) => !repo.includes('enterprise'),
				fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }],
			}),
		);
		const notebookId = await createPullNotebook(request);
		const path = `/projects/${projectId}/notebooks/${notebookId}/source`;

		await expectError(
			await request('PATCH', path, {
				repo: 'https://gitlab.com/org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
			}),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		await expectError(
			await request('PATCH', path, {
				repo: 'https://github.enterprise.example/org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
			}),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		const detail = await expectOk<{
			source: { repo: string; branch: string; pending_config?: unknown };
		}>(await request('GET', `/projects/${projectId}/notebooks/${notebookId}`));
		expect(detail.source).toMatchObject({ repo: 'org/repo', branch: 'main' });
		expect(detail.source.pending_config).toBeUndefined();
	});

	it('keeps a supported pending update when a later pull-source update is rejected', async () => {
		const { request } = api(
			stubReader({ fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }] }),
		);
		const notebookId = await createPullNotebook(request);
		const path = `/projects/${projectId}/notebooks/${notebookId}/source`;
		await expectOk(
			await request('PATCH', path, {
				repo: 'other/repo',
				branch: 'release',
				root_path: '',
				entry_notebook: 'app.py',
			}),
		);
		await expectError(
			await request('PATCH', path, {
				repo: 'https://gitlab.com/org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
			}),
			409,
			'SYNC_NOT_CONFIGURED',
		);

		const detail = await expectOk<{
			source: { pending_config?: { repo: string; branch: string } };
		}>(await request('GET', `/projects/${projectId}/notebooks/${notebookId}`));
		expect(detail.source.pending_config).toMatchObject({
			repo: 'other/repo',
			branch: 'release',
		});
	});

	it('rejects pull-source updates when the configured reader is removed', async () => {
		const capable = api(
			stubReader({ fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }] }),
		);
		const notebookId = await createPullNotebook(capable.request);
		const disconnected = api();

		await expectError(
			await disconnected.request('PATCH', `/projects/${projectId}/notebooks/${notebookId}/source`, {
				repo: 'other/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
			}),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		const detail = await expectOk<{ source: { repo: string; pending_config?: unknown } }>(
			await disconnected.request('GET', `/projects/${projectId}/notebooks/${notebookId}`),
		);
		expect(detail.source.repo).toBe('org/repo');
		expect(detail.source.pending_config).toBeUndefined();
	});

	it('rejects drift and sync when no reader is configured (409 SYNC_NOT_CONFIGURED)', async () => {
		const { request } = api();
		const nid = await createSyncedNotebook(request);
		await expectError(
			await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
	});

	it('rejects a source with no provider even when a reader is configured (409)', async () => {
		const { request } = api(stubReader());
		const nid = await createSyncedNotebook(request, 'https://code.example.com/group/project');
		await expectError(
			await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
	});

	it('rejects a provider no configured reader covers (409)', async () => {
		const { request } = api(stubReader());
		const nid = await createSyncedNotebook(request, 'https://gitlab.com/org/repo');
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
	});

	it('rejects a repository the reader does not support, such as GitHub Enterprise (409)', async () => {
		const { request } = api(
			stubReader({ supportsRepository: (repo) => !repo.includes('mycompany') }),
		);
		const nid = await createSyncedNotebook(request, 'https://github.mycompany.com/org/repo');
		await expectError(
			await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
	});

	it('dispatches on the pending provider when settings move to an unsupported host (409)', async () => {
		const { request } = api(stubReader());
		const nid = await createSyncedNotebook(request);
		await expectOk(await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`));

		await expectOk(
			await request('PATCH', `/projects/${projectId}/notebooks/${nid}/source`, {
				repo: 'https://gitlab.com/org/other',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
			}),
		);
		await expectError(
			await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			409,
			'SYNC_NOT_CONFIGURED',
		);
	});

	it('dispatches on the pending provider when settings move to a supported host', async () => {
		const { request, deps } = api(stubReader());
		const nid = await createSyncedNotebook(request, 'https://gitlab.com/org/repo');
		// Seed the first version the way CI would: a push against the GitLab source.
		await deps.services.notebooks.synced.sync(projectId, nid as NotebookId, {
			repo: 'https://gitlab.com/org/repo',
			branch: 'main',
			root_path: '',
			commit: '1111111111111111111111111111111111111111',
			files: [{ path: 'app.py', bytes: encode('print(0)') }],
		});

		// A bare owner/repo would rehome onto the source's current (GitLab) host,
		// so the provider move needs the explicit URL.
		await expectOk(
			await request('PATCH', `/projects/${projectId}/notebooks/${nid}/source`, {
				repo: 'https://github.com/org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
			}),
		);
		const outcome = await expectOk<{ synced: boolean; commit: string }>(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
		);
		expect(outcome).toMatchObject({ synced: true, commit: HEAD });

		const detail = await expectOk<{
			source: { repo: string; provider: string | null; pending_config?: unknown };
		}>(await request('GET', `/projects/${projectId}/notebooks/${nid}`));
		expect(detail.source).toMatchObject({
			repo: 'https://github.com/org/repo',
			provider: 'github',
		});
		expect(detail.source.pending_config).toBeUndefined();
	});

	it('rejects drift and sync for an unknown notebook (404)', async () => {
		const { request } = api(stubReader());
		const missing = createNotebookId();
		await expectError(
			await request('GET', `/projects/${projectId}/notebooks/${missing}/source/drift`),
			404,
		);
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${missing}/source/sync`),
			404,
		);
	});

	it('surfaces a provider outage as 503 on both endpoints', async () => {
		const { request } = api(
			stubReader({
				getBranchHead: async () => {
					throw new UnavailableError('GitHub is unavailable');
				},
			}),
		);
		const nid = await createSyncedNotebook(request);
		await expectError(
			await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
			503,
			'SERVICE_UNAVAILABLE',
		);
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			503,
			'SERVICE_UNAVAILABLE',
		);
	});

	it('surfaces a cap violation from the fetched tree as 400', async () => {
		const { request } = api(
			stubReader({
				fetchWorkspace: async () => {
					throw new BadRequestError('Archive exceeds the 1000-file limit');
				},
			}),
		);
		const nid = await createSyncedNotebook(request);
		const error = await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			400,
			'BAD_REQUEST',
		);
		expect(error.message).toMatch(/1000-file limit/);
	});

	it('rejects drift and sync for a non-git notebook (404)', async () => {
		const { request } = api(stubReader());
		const data = await expectOk<{ id: string }>(
			await request('POST', `/projects/${projectId}/notebooks`, {
				title: 'Local',
				description: 'd',
				code: 'import marimo',
			}),
			201,
		);
		await expectError(
			await request('GET', `/projects/${projectId}/notebooks/${data.id}/source/drift`),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${data.id}/source/sync`),
			404,
			'NOT_FOUND',
		);
	});

	it('requires editor access', async () => {
		const owner = api(stubReader());
		const nid = await createSyncedNotebook(owner.request);
		const outsider = createTestApi({
			bucket,
			userId: uid('outsider'),
			deps: owner.deps.sourceControl ? { sourceControl: owner.deps.sourceControl } : {},
		});
		await expectError(
			await outsider.request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
			403,
			'FORBIDDEN',
		);
		await expectError(
			await outsider.request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			403,
			'FORBIDDEN',
		);
	});

	it('reports drift before and after the first sync', async () => {
		const { request } = api(stubReader());
		const nid = await createSyncedNotebook(request);

		const before = await expectOk<{
			current_commit: string | null;
			remote_commit: string;
			in_sync: boolean;
			pending_config: boolean;
		}>(await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`));
		expect(before).toMatchObject({
			current_commit: null,
			remote_commit: HEAD,
			in_sync: false,
			pending_config: false,
		});

		await expectOk(await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`));
		const after = await expectOk<{ in_sync: boolean; current_commit: string }>(
			await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
		);
		expect(after).toMatchObject({ current_commit: HEAD, remote_commit: HEAD, in_sync: true });
	});

	it('syncs to the branch head, then no-ops at the same commit', async () => {
		const { request, deps } = api(stubReader());
		const nid = await createSyncedNotebook(request);

		const first = await expectOk<{ synced: boolean; commit: string; version_id: string | null }>(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
		);
		expect(first.synced).toBe(true);
		expect(first.commit).toBe(HEAD);
		expect(first.version_id).not.toBeNull();

		const detail = await expectOk<{ source: { commit: string; current_version_id: string } }>(
			await request('GET', `/projects/${projectId}/notebooks/${nid}`),
		);
		expect(detail.source.commit).toBe(HEAD);
		expect(detail.source.current_version_id).toBe(first.version_id);

		const again = await expectOk<{ synced: boolean; commit: string; version_id: string | null }>(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
		);
		expect(again).toEqual({ synced: false, commit: HEAD, version_id: null });

		const today = new Date().toISOString().slice(0, 10);
		const events = await deps.services.events.getEvents(today);
		const syncEvents = events.filter((e) => e.event === 'notebook.source.sync');
		expect(syncEvents).toHaveLength(1);
		expect(syncEvents[0]).toMatchObject({
			actor: ACTOR,
			project_id: projectId,
			notebook_id: nid,
			commit: HEAD,
			trigger: 'manual',
		});
	});

	it('a pull that satisfies pending settings promotes them', async () => {
		const files: SourceWorkspaceFile[] = [
			{ path: 'app.py', bytes: encode('print(1)') },
			{ path: 'main.py', bytes: encode('print(2)') },
		];
		const heads = ['1111111111111111111111111111111111111111', HEAD];
		const reader = stubReader({
			getBranchHead: async () => ({ commit: heads.shift() ?? HEAD }),
			fetchWorkspace: async () => files,
		});
		const { request } = api(reader);
		const nid = await createSyncedNotebook(request);
		await expectOk(await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`));

		await expectOk(
			await request('PATCH', `/projects/${projectId}/notebooks/${nid}/source`, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'main.py',
			}),
		);
		const drift = await expectOk<{ pending_config: boolean; in_sync: boolean }>(
			await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`),
		);
		expect(drift).toMatchObject({ pending_config: true, in_sync: false });

		await expectOk(await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`));
		const detail = await expectOk<{
			source: { entry_notebook: string; pending_config?: unknown; commit: string };
		}>(await request('GET', `/projects/${projectId}/notebooks/${nid}`));
		expect(detail.source.entry_notebook).toBe('main.py');
		expect(detail.source.pending_config).toBeUndefined();
		expect(detail.source.commit).toBe(HEAD);
	});

	it('rejects a stale pull when the source advances mid-download (409)', async () => {
		const NEWER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
		const midDownload: { advance?: () => Promise<unknown> } = {};
		const reader = stubReader({
			fetchWorkspace: async () => {
				await midDownload.advance?.();
				return [{ path: 'app.py', bytes: encode('stale') }];
			},
		});
		const { request, deps } = api(reader);
		const nid = await createSyncedNotebook(request);
		midDownload.advance = () =>
			deps.services.notebooks.synced.sync(projectId, nid as NotebookId, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				commit: NEWER,
				files: [{ path: 'app.py', bytes: encode('newer') }],
			});

		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			409,
			'CONFLICT',
		);
		const detail = await expectOk<{ source: { commit: string } }>(
			await request('GET', `/projects/${projectId}/notebooks/${nid}`),
		);
		expect(detail.source.commit).toBe(NEWER);
	});

	it('rejects a stale pull even when the source commit cycles back to the observed one', async () => {
		// ABA: the commit string alone would falsely match after C0 → C2 → C0, so
		// the precondition must fence on the version id, which never repeats.
		const C0 = '0000000000000000000000000000000000000000';
		const C2 = '2222222222222222222222222222222222222222';
		const push = (commit: string, deps: ReturnType<typeof api>['deps'], nid: string) =>
			deps.services.notebooks.synced.sync(projectId, nid as NotebookId, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				commit,
				files: [{ path: 'app.py', bytes: encode(`print("${commit}")`) }],
			});
		const midDownload: { advance?: () => Promise<unknown> } = {};
		const reader = stubReader({
			fetchWorkspace: async () => {
				await midDownload.advance?.();
				return [{ path: 'app.py', bytes: encode('stale head') }];
			},
		});
		const { request, deps } = api(reader);
		const nid = await createSyncedNotebook(request);
		await push(C0, deps, nid);
		midDownload.advance = async () => {
			await push(C2, deps, nid);
			await push(C0, deps, nid);
		};

		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			409,
			'CONFLICT',
		);
		const detail = await expectOk<{ source: { commit: string } }>(
			await request('GET', `/projects/${projectId}/notebooks/${nid}`),
		);
		expect(detail.source.commit).toBe(C0);
	});

	it('reports synced: false when a concurrent sync of the same commit wins (no audit event)', async () => {
		const midDownload: { advance?: () => Promise<unknown> } = {};
		const reader = stubReader({
			fetchWorkspace: async () => {
				await midDownload.advance?.();
				return [{ path: 'app.py', bytes: encode('print("synced")') }];
			},
		});
		const { request, deps } = api(reader);
		const nid = await createSyncedNotebook(request);
		midDownload.advance = () =>
			deps.services.notebooks.synced.sync(projectId, nid as NotebookId, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				commit: HEAD,
				files: [{ path: 'app.py', bytes: encode('print("synced")') }],
			});

		const outcome = await expectOk<{ synced: boolean; version_id: string | null }>(
			await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
		);
		expect(outcome).toEqual({ synced: false, commit: HEAD, version_id: null });

		const today = new Date().toISOString().slice(0, 10);
		const events = await deps.services.events.getEvents(today);
		expect(events.filter((e) => e.event === 'notebook.source.sync')).toHaveLength(0);
	});

	it('resolves the head and tree from pending coordinates, not the active ones', async () => {
		const branchCalls: [string, string][] = [];
		const fetchCalls: [string, string][] = [];
		const heads = ['1111111111111111111111111111111111111111'];
		const reader = stubReader({
			getBranchHead: async (repo, branch) => {
				branchCalls.push([repo, branch]);
				return { commit: heads.shift() ?? HEAD };
			},
			fetchWorkspace: async (_repo, commit, rootPath) => {
				fetchCalls.push([commit, rootPath]);
				return [{ path: 'app.py', bytes: encode('print(1)') }];
			},
		});
		const { request } = api(reader);
		const nid = await createSyncedNotebook(request);
		await expectOk(await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`));

		await expectOk(
			await request('PATCH', `/projects/${projectId}/notebooks/${nid}/source`, {
				repo: 'org/repo',
				branch: 'release',
				root_path: 'apps',
				entry_notebook: 'app.py',
			}),
		);
		await expectOk(await request('GET', `/projects/${projectId}/notebooks/${nid}/source/drift`));
		await expectOk(await request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`));

		expect(branchCalls).toEqual([
			['org/repo', 'main'],
			['org/repo', 'release'],
			['org/repo', 'release'],
		]);
		expect(fetchCalls).toEqual([
			['1111111111111111111111111111111111111111', ''],
			[HEAD, 'apps'],
		]);
		const detail = await expectOk<{
			source: { branch: string; root_path: string; pending_config?: unknown };
		}>(await request('GET', `/projects/${projectId}/notebooks/${nid}`));
		expect(detail.source).toMatchObject({ branch: 'release', root_path: 'apps' });
		expect(detail.source.pending_config).toBeUndefined();
	});

	it('rejects a pulled tree that misses the entry notebook (422) and an empty tree (400)', async () => {
		const missingEntry = api(
			stubReader({ fetchWorkspace: async () => [{ path: 'other.py', bytes: encode('x') }] }),
		);
		const nid = await createSyncedNotebook(missingEntry.request);
		await expectError(
			await missingEntry.request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			422,
			'VALIDATION_ERROR',
		);

		const empty = api(stubReader({ fetchWorkspace: async () => [] }));
		await expectError(
			await empty.request('POST', `/projects/${projectId}/notebooks/${nid}/source/sync`),
			400,
			'BAD_REQUEST',
		);
	});

	it('creates a version byte-for-byte the shape a push creates', async () => {
		const content = 'print("synced")';
		const { request, app } = api(
			stubReader({ fetchWorkspace: async () => [{ path: 'app.py', bytes: encode(content) }] }),
		);

		const pushed = await expectOk<{ notebook: { id: string }; sync_token: string }>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Pushed',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);
		const pushRes = await app.request(
			`/api/sync/git/v1/projects/${projectId}/notebooks/${pushed.notebook.id}`,
			{
				method: 'POST',
				body: zipSync({ 'app.py': encode(content) }),
				headers: {
					'Content-Type': 'application/zip',
					Authorization: `Bearer ${pushed.sync_token}`,
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Commit': HEAD,
				},
			},
		);
		expect(pushRes.status).toBe(200);

		const pulledId = await createSyncedNotebook(request);
		const pull = await expectOk<{ version_id: string }>(
			await request('POST', `/projects/${projectId}/notebooks/${pulledId}/source/sync`),
		);

		async function versionRecord(nid: string, vid: string) {
			const versionPaths = paths
				.project(projectId)
				.notebook(nid as NotebookId)
				.version(vid as VersionId);
			const meta = JSON.parse(await (await bucket.get(versionPaths.meta))!.text()) as Record<
				string,
				unknown
			>;
			const workspace = await (await bucket.get(versionPaths.workspaceFile('app.py')))!.text();
			return { meta, workspace };
		}

		const pushedDetail = await expectOk<{ source: { current_version_id: string } }>(
			await request('GET', `/projects/${projectId}/notebooks/${pushed.notebook.id}`),
		);
		const pushVersion = await versionRecord(
			pushed.notebook.id,
			pushedDetail.source.current_version_id,
		);
		const pullVersion = await versionRecord(pulledId, pull.version_id);

		expect(pullVersion.workspace).toBe(pushVersion.workspace);
		expect(Object.keys(pullVersion.meta).sort()).toEqual(Object.keys(pushVersion.meta).sort());
		// Identity fields necessarily differ (fresh ids/timestamps, and a pull is
		// attributed to the requesting editor rather than the system pusher).
		const identity = ['version_id', 'notebook_id', 'saved_at', 'author'];
		for (const key of identity) {
			delete pullVersion.meta[key];
			delete pushVersion.meta[key];
		}
		expect(pullVersion.meta).toEqual(pushVersion.meta);
	});
});
