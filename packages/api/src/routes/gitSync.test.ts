import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync } from 'fflate';
import { createServices } from '@marimo-hub/core';
import type { ProjectId } from '@marimo-hub/core';
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

	it('rejects creating a synced notebook whose repo is not owner/repo or a URL (400)', async () => {
		await expectError(
			await request('POST', `/projects/${projectId}/notebooks/git`, {
				title: 'Bad repo',
				description: 'd',
				repo: 'just-a-name',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			400,
			'BAD_REQUEST',
		);
	});

	it('rejects a request with no Authorization header (401)', async () => {
		const { notebookId } = await createSyncedNotebook();
		await expectError(await syncRequest({ notebookId }), 401, 'UNAUTHORIZED');
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
			400,
			'BAD_REQUEST',
		);

		expect(error.message).toContain('X-Marimohub-Repo received "other/repo", expected "org/repo"');
		expect(error.message).toContain('X-Marimohub-Branch received "feature", expected "main"');
		expect(error.message).toContain('X-Marimohub-Root-Path received "apps", expected ""');
		expect(error.message).toContain("notebook's sync settings");
	});
});
