import { describe, it, expect, beforeEach, vi } from 'vitest';
import { zipSync } from 'fflate';
import { createServices } from '@marimo-hub/core';
import type { ProjectAlertDispatcher, ProjectId } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

describe('Git sync routes', () => {
	let bucket: MemoryBucket;
	let app: ReturnType<typeof createTestApi>['app'];
	let request: ReturnType<typeof createTestApi>['request'];
	let projectId: ProjectId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const project = await createServices(bucket).projects.createProject(
			{ name: 'Test', description: 'test' },
			ACTOR,
		);
		projectId = project.id;
		const api = createTestApi({ bucket });
		app = api.app;
		request = api.request;
	});

	const archive = () => zipSync({ 'app.py': new TextEncoder().encode('print("synced")') });

	async function createSyncedNotebook() {
		const data = await expectOk<{ notebook: { id: string }; sync_token: string }>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);
		return { notebookId: data.notebook.id, syncToken: data.sync_token };
	}

	function syncRequest(options: {
		notebookId: string;
		projectId?: string;
		headers?: Record<string, string>;
	}) {
		const pid = options.projectId ?? projectId;
		return app.request(`/api/sync/git/v1/projects/${pid}/notebooks/${options.notebookId}`, {
			method: 'POST',
			body: archive(),
			headers: {
				'Content-Type': 'application/zip',
				...options.headers,
			},
		});
	}

	const requiredHeaders = (token: string) => ({
		Authorization: `Bearer ${token}`,
		'X-Marimohub-Repo': 'org/repo',
		'X-Marimohub-Branch': 'main',
		'X-Marimohub-Commit': 'abc123',
	});

	it('rejects creating a synced notebook whose repo is not owner/repo or a URL (422)', async () => {
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Bad repo',
				description: 'd',
				repo: 'just-a-name',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('rejects a request with no Authorization header (401)', async () => {
		const { notebookId } = await createSyncedNotebook();
		const error = await expectError(
			await syncRequest({ notebookId, headers: { 'X-Request-Id': 'sync-req-123' } }),
			401,
			'UNAUTHORIZED',
		);
		expect(error.request_id).toBe('sync-req-123');
	});

	it('rejects a malformed Authorization header (400)', async () => {
		const { notebookId } = await createSyncedNotebook();
		await expectError(
			await syncRequest({ notebookId, headers: { Authorization: 'Basic xyz' } }),
			400,
			'BAD_REQUEST',
		);
	});

	it('rejects a wrong sync token (401)', async () => {
		const { notebookId } = await createSyncedNotebook();
		await expectError(
			await syncRequest({
				notebookId,
				headers: { Authorization: 'Bearer mhsync_not_the_right_token' },
			}),
			401,
			'UNAUTHORIZED',
		);
	});

	it('rejects malformed project/notebook ids in the path even with a plausible token (401)', async () => {
		const { syncToken } = await createSyncedNotebook();
		await expectError(
			await syncRequest({
				projectId: 'not-a-project',
				notebookId: 'not-a-notebook',
				headers: requiredHeaders(syncToken),
			}),
			401,
			'UNAUTHORIZED',
		);
	});

	it('syncs an archive with a valid token and records content + commit', async () => {
		const { notebookId, syncToken } = await createSyncedNotebook();

		const data = await expectOk<{ notebook: Record<string, unknown> }>(
			await syncRequest({ notebookId, headers: requiredHeaders(syncToken) }),
		);
		expect(data.notebook).toMatchObject({ id: notebookId, status: 'active' });
		// Public meta shape — no internal schema_version leaks out.
		expect(data.notebook.schema_version).toBeUndefined();

		const detail = await expectOk<{ source: { commit: string } }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebookId}`),
		);
		expect(detail.source.commit).toBe('abc123');
		const content = await expectOk<{ code: string }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebookId}/content`),
		);
		expect(content.code).toBe('print("synced")');

		// The cut version exposes the commit it mirrors (for the UI's GitHub links).
		const versions = await expectOk<{ items: { commit?: string; message: string }[] }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebookId}/versions`),
		);
		expect(versions.items[0]?.commit).toBe('abc123');
	});

	it('syncs a markdown entry notebook end to end', async () => {
		const markdown = '# Report\n\n```python {.marimo}\nx = 1\n```\n';
		const { notebook, sync_token } = await expectOk<{
			notebook: { id: string };
			sync_token: string;
		}>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Markdown app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'docs/page.md',
			}),
			201,
		);

		const response = await app.request(
			`/api/sync/git/v1/projects/${projectId}/notebooks/${notebook.id}`,
			{
				method: 'POST',
				body: zipSync({ 'docs/page.md': new TextEncoder().encode(markdown) }),
				headers: { 'Content-Type': 'application/zip', ...requiredHeaders(sync_token) },
			},
		);
		await expectOk(response);

		const content = await expectOk<{ code: string }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebook.id}/content`),
		);
		expect(content.code).toBe(markdown);
	});

	// `.ipynb` isn't in NOTEBOOK_FILE_EXTENSIONS yet; a bare `.md` has no stem, so
	// marimo would refuse to open it.
	for (const entry of ['notes.ipynb', 'notes.txt', '.md', 'docs/.qmd', 'page.MD']) {
		it(`rejects creating a synced notebook with entry_notebook ${JSON.stringify(entry)} (400)`, async () => {
			await expectError(
				await request('POST', `/projects/${projectId}/notebooks/git`, {
					title: 'Bad entry',
					description: 'd',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: entry,
				}),
				400,
				'BAD_REQUEST',
			);
		});
	}

	it('syncs a prose-only markdown notebook (no code fences)', async () => {
		// marimo compiles prose into mo.md cells, so a page with zero code fences is
		// still a real notebook — the sync path must not gate on "has Python".
		const prose = '# Quarterly report\n\nAll numbers are up and to the right.\n';
		const { notebook, sync_token } = await expectOk<{
			notebook: { id: string };
			sync_token: string;
		}>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Prose page',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'report.md',
			}),
			201,
		);

		await expectOk(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${notebook.id}`, {
				method: 'POST',
				body: zipSync({ 'report.md': new TextEncoder().encode(prose) }),
				headers: { 'Content-Type': 'application/zip', ...requiredHeaders(sync_token) },
			}),
		);

		const content = await expectOk<{ code: string }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebook.id}/content`),
		);
		expect(content.code).toBe(prose);
	});

	it('rejects a sync whose archive is missing the markdown entry notebook (422)', async () => {
		const { notebook, sync_token } = await expectOk<{
			notebook: { id: string };
			sync_token: string;
		}>(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Markdown app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'page.md',
			}),
			201,
		);

		const error = await expectError(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${notebook.id}`, {
				method: 'POST',
				body: zipSync({ 'other.md': new TextEncoder().encode('# not the entry') }),
				headers: { 'Content-Type': 'application/zip', ...requiredHeaders(sync_token) },
			}),
			422,
			'VALIDATION_ERROR',
		);
		expect(error.message).toContain('page.md');
	});

	it('switches a synced notebook from a .py to a .md entry via pending config', async () => {
		const { notebookId, syncToken } = await createSyncedNotebook();
		await expectOk(await syncRequest({ notebookId, headers: requiredHeaders(syncToken) }));

		// Staged (not applied) until an archive matching the new config arrives.
		const patched = await expectOk<{ source: { entry_notebook: string } }>(
			await request('PATCH', `/projects/${projectId}/notebooks/${notebookId}/source`, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'page.md',
			}),
		);
		expect(patched.source.entry_notebook).toBe('app.py');

		const markdown = '# Ported\n\n```python {.marimo}\ny = 2\n```\n';
		await expectOk(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${notebookId}`, {
				method: 'POST',
				body: zipSync({ 'page.md': new TextEncoder().encode(markdown) }),
				headers: { 'Content-Type': 'application/zip', ...requiredHeaders(syncToken) },
			}),
		);

		const detail = await expectOk<{ source: { entry_notebook: string } }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebookId}`),
		);
		expect(detail.source.entry_notebook).toBe('page.md');
		const content = await expectOk<{ code: string }>(
			await request('GET', `/projects/${projectId}/notebooks/${notebookId}/content`),
		);
		expect(content.code).toBe(markdown);
	});

	it('does not perform alert metadata reads before a successful sync', async () => {
		const { notebookId, syncToken } = await createSyncedNotebook();
		const services = createServices(bucket);
		const projectLookup = vi
			.spyOn(services.projects, 'getProject')
			.mockRejectedValue(new Error('down'));
		const notebookLookup = vi.spyOn(services.notebooks, 'getNotebook');
		app = createTestApi({ bucket, deps: { services } }).app;

		await expectOk(await syncRequest({ notebookId, headers: requiredHeaders(syncToken) }));
		expect(projectLookup).not.toHaveBeenCalled();
		expect(notebookLookup).toHaveBeenCalledOnce();
	});

	it("rejects a valid sync token used against a DIFFERENT notebook's path (401 IDOR)", async () => {
		// Two independently-synced notebooks, each with its own per-notebook token.
		const a = await createSyncedNotebook();
		const b = await createSyncedNotebook();
		expect(a.notebookId).not.toBe(b.notebookId);

		// A's token presented on B's path must not authenticate (tokens are scoped
		// per-notebook, so one notebook's token can't push to another's workspace).
		await expectError(
			await syncRequest({ notebookId: b.notebookId, headers: requiredHeaders(a.syncToken) }),
			401,
			'UNAUTHORIZED',
		);
	});

	it('rejects a request missing a required header, naming it (400)', async () => {
		const { notebookId, syncToken } = await createSyncedNotebook();
		const headers = requiredHeaders(syncToken);
		delete (headers as Record<string, string>)['X-Marimohub-Commit'];

		const error = await expectError(await syncRequest({ notebookId, headers }), 400, 'BAD_REQUEST');
		expect(error.message).toContain('x-marimohub-commit');
	});

	it('does not alert for an unauthenticated sync attempt', async () => {
		const { notebookId } = await createSyncedNotebook();
		const deliver = vi.fn<ProjectAlertDispatcher['deliver']>(async () => 'delivered' as const);
		app = createTestApi({
			bucket,
			deps: {
				projectAlerts: {
					store: {} as never,
					dispatcher: { deliver, test: vi.fn() },
					maxDestinations: 10,
				},
			},
		}).app;

		await expectError(await syncRequest({ notebookId }), 401, 'UNAUTHORIZED');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(deliver).not.toHaveBeenCalled();
	});

	it('alerts after an authenticated sync validation failure with sanitized data', async () => {
		const { notebookId, syncToken } = await createSyncedNotebook();
		const deliver = vi.fn<ProjectAlertDispatcher['deliver']>(async () => 'delivered' as const);
		app = createTestApi({
			bucket,
			deps: {
				projectAlerts: {
					store: {} as never,
					dispatcher: { deliver, test: vi.fn() },
					maxDestinations: 10,
				},
			},
		}).app;
		const headers = requiredHeaders(syncToken);
		delete (headers as Record<string, string>)['X-Marimohub-Branch'];

		await expectError(await syncRequest({ notebookId, headers }), 400, 'BAD_REQUEST');
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
		expect(deliver).toHaveBeenCalledWith(
			projectId,
			'sync.failed',
			expect.objectContaining({
				kind: 'sync.failed',
				data: expect.objectContaining({
					notebook_id: notebookId,
					commit: 'abc123',
					error_code: 'BAD_REQUEST',
				}),
			}),
		);
		const notification = vi.mocked(deliver).mock.calls[0]?.[2];
		expect(notification?.data).not.toHaveProperty('repo');
	});

	it('reports every mismatched source header with expected and received values', async () => {
		const { notebookId, syncToken } = await createSyncedNotebook();
		const error = await expectError(
			await syncRequest({
				notebookId,
				headers: {
					...requiredHeaders(syncToken),
					'X-Marimohub-Repo': 'other/repo',
					'X-Marimohub-Branch': 'feature',
					'X-Marimohub-Root-Path': 'apps',
				},
			}),
			422,
			'VALIDATION_ERROR',
		);

		expect(error.message).toContain('X-Marimohub-Repo received "other/repo", expected "org/repo"');
		expect(error.message).toContain('X-Marimohub-Branch received "feature", expected "main"');
		expect(error.message).toContain('X-Marimohub-Root-Path received "apps", expected ""');
		expect(error.message).toContain("notebook's sync settings");
	});
});
