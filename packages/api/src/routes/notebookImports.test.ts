import { MAX_FOLDER_IMPORT_ARCHIVE_BYTES } from '@marimo-hub/core/workspace-ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { makeFolderArchive } from '@marimo-hub/core/testing/workspace-fixtures';
import { createServices } from '@marimo-hub/core';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

async function setup() {
	const bucket = await createInitializedBucket();
	const project = await createServices(bucket).projects.createProject(
		{ name: 'Folder import', description: '' },
		ACTOR,
	);
	return { projectId: project.id, ...createTestApi({ bucket }) };
}
let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
	env = await setup();
});
afterEach(() => vi.restoreAllMocks());
const archive = makeFolderArchive({
	'reports/revenue.py': 'import marimo',
	'helpers.py': 'VALUE = 1',
	'data/raw.bin': new Uint8Array([0, 255]),
});
type ImportOutcome = {
	id: string;
	expires_at: string;
	notebooks: { entry_notebook: string; state: string; notebook?: { id: string } }[];
};
const upload = (
	app = env.app,
	contentType = 'application/zip',
	body: BodyInit = new Uint8Array(archive),
) =>
	app.request(`/api/v1/projects/${env.projectId}/notebook-imports`, {
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body,
	});
async function prepare() {
	return expectOk<{ id: string; expires_at: string; files: { path: string; size: number }[] }>(
		await upload(),
		201,
	);
}
const importPath = (id: string) => `/projects/${env.projectId}/notebook-imports/${id}`;

describe('notebook import routes', () => {
	it.each([MAX_FOLDER_IMPORT_ARCHIVE_BYTES, MAX_FOLDER_IMPORT_ARCHIVE_BYTES + 1])(
		'enforces the import-specific archive body limit at %i bytes',
		async (length) => {
			const response = await env.app.request(`/api/v1/projects/${env.projectId}/notebook-imports`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/zip', 'Content-Length': String(length) },
				body: new Uint8Array(archive),
			});
			if (length > MAX_FOLDER_IMPORT_ARCHIVE_BYTES)
				await expectError(response, 413, 'PAYLOAD_TOO_LARGE');
			else await expectOk(response, 201);
		},
	);

	it('prepares raw zip, publishes, reconciles and exposes local original entrypoint', async () => {
		const preparation = await prepare();
		expect(preparation.files).toHaveLength(3);
		expect(preparation.id).toMatch(/^imp-[0-9a-z]{16}$/);
		expect(new Date(preparation.expires_at).toISOString()).toBe(preparation.expires_at);
		const path = `${importPath(preparation.id)}/notebooks`;
		expect(await expectOk(await env.request('GET', importPath(preparation.id)))).toEqual({
			id: preparation.id,
			expires_at: preparation.expires_at,
			notebooks: [],
		});
		const body = { entry_notebook: 'reports/revenue.py', title: 'Revenue' };
		const notebook = await expectOk<{ id: string }>(await env.request('POST', path, body), 201);
		expect(
			await expectOk<ImportOutcome>(await env.request('GET', importPath(preparation.id))),
		).toMatchObject({
			notebooks: [
				{ entry_notebook: 'reports/revenue.py', state: 'complete', notebook: { id: notebook.id } },
			],
		});
		expect(await expectOk(await env.request('POST', path, body), 201)).toMatchObject({
			id: notebook.id,
		});
		expect(
			await expectOk(
				await env.request('GET', `/projects/${env.projectId}/notebooks/${notebook.id}`),
			),
		).toMatchObject({ source: { type: 'local', entry_notebook: 'reports/revenue.py' } });
	});

	it('enforces project authorization on every import route', async () => {
		const preparation = await prepare();
		const body = { entry_notebook: 'reports/revenue.py', title: 'Revenue' };
		const outsider = createTestApi({ bucket: env.bucket, userId: uid('outsider') });
		const viewerId = uid('viewer');
		const writerId = uid('writer');
		const services = env.deps.services;
		await services.projects.addMember(env.projectId, { user_id: viewerId }, 'viewer', ACTOR);
		await services.projects.addMember(env.projectId, { user_id: writerId }, 'editor', ACTOR);
		const viewer = createTestApi({ bucket: env.bucket, userId: viewerId });
		const writer = createTestApi({ bucket: env.bucket, userId: writerId });
		for (const client of [outsider, viewer]) {
			await expectError(await upload(client.app), 403);
			await expectError(await client.request('GET', importPath(preparation.id)), 403);
			await expectError(
				await client.request('POST', `${importPath(preparation.id)}/notebooks`, body),
				403,
			);
		}
		// Another writer in the project cannot see or use someone else's upload.
		await expectError(await writer.request('GET', importPath(preparation.id)), 404);
		await expectError(
			await writer.request('POST', `${importPath(preparation.id)}/notebooks`, body),
			404,
		);
		expect(await services.notebooks.listNotebooks(env.projectId)).toHaveLength(0);
	});

	it.each(['application/octet-stream', 'application/json', 'multipart/form-data'])(
		'rejects an upload sent as %s',
		async (contentType) => {
			await expectError(await upload(env.app, contentType), 400, 'BAD_REQUEST');
		},
	);

	it('accepts a zip content type with parameters', async () => {
		await expectOk(await upload(env.app, 'Application/Zip; charset=binary'), 201);
	});

	it('rejects an empty folder and a malformed import id', async () => {
		await expectError(
			await upload(env.app, 'application/zip', new Uint8Array(makeFolderArchive({}))),
			400,
		);
		await expectError(await env.request('GET', importPath('not-an-import')), 422);
	});

	it('rejects malformed archive and missing entrypoints without publishing a notebook', async () => {
		await expectError(await upload(env.app, 'application/zip', 'invalid'), 400);
		const preparation = await prepare();
		await expectError(
			await env.request(
				'POST',
				`/projects/${env.projectId}/notebook-imports/${preparation.id}/notebooks`,
				{ entry_notebook: 'missing.py', title: 'Missing' },
			),
			400,
		);
		expect(await env.deps.services.notebooks.listNotebooks(env.projectId)).toHaveLength(0);
	});
	it.each(['complete', 'publishing'])(
		'replays %s settings even after deployment options change',
		async (state) => {
			const preparation = await prepare();
			const path = `${importPath(preparation.id)}/notebooks`;
			const { request, deps } = createTestApi({
				bucket: env.bucket,
				deps: {
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						computeProfiles: [{ name: 'small', resources: { cpu: 1 } }],
						computeProfileOverride: 'editors',
					},
				},
			});
			const body = {
				entry_notebook: 'reports/revenue.py',
				title: 'Revenue',
				base_image: 'default',
				compute_profile: 'small',
			};
			const publish = deps.services.notebooks.publishImportNotebook.bind(deps.services.notebooks);
			let notebookId: string | undefined;
			vi.spyOn(deps.services.notebooks, 'publishImportNotebook').mockImplementationOnce(
				async (...args) => {
					const notebook = await publish(...args);
					notebookId = notebook.id;
					expect(notebook.base_image).toBeUndefined();
					expect(notebook.compute_profile).toBeUndefined();
					if (state === 'publishing') throw new Error('publication response lost');
					return notebook;
				},
			);
			const response = await request('POST', path, body);
			if (state === 'publishing') await expectError(response, 500);
			else await expectOk(response, 201);
			const replay = await expectOk<{ id: string }>(await env.request('POST', path, body), 201);
			expect(replay.id).toBe(notebookId);
			await expectError(
				await env.request('POST', path, { ...body, compute_profile: 'large' }),
				409,
			);
		},
	);

	it('rejects blank names and invalid entrypoints without creating notebooks', async () => {
		const preparation = await prepare();
		const path = `${importPath(preparation.id)}/notebooks`;
		await expectError(
			await env.request('POST', path, { entry_notebook: 'reports/revenue.py', title: '   ' }),
			422,
		);
		await expectError(
			await env.request('POST', path, { entry_notebook: '../escape.py', title: 'Escape' }),
			400,
		);
		await expectError(
			await env.request('POST', path, { entry_notebook: 'data/raw.bin', title: 'Data' }),
			400,
		);
		expect(await env.deps.services.notebooks.listNotebooks(env.projectId)).toHaveLength(0);
	});

	it.each([
		{ settings: { compute_profile: 'large' }, status: 403 },
		{ settings: { base_image: 'missing' }, status: 400 },
	])(
		'allows correcting rejected runtime settings %j without uploading again',
		async ({ settings, status: rejectionStatus }) => {
			const preparation = await prepare();
			const path = `${importPath(preparation.id)}/notebooks`;
			await expectError(
				await env.request('POST', path, {
					entry_notebook: 'reports/revenue.py',
					title: 'Revenue',
					...settings,
				}),
				rejectionStatus,
			);
			expect(await env.deps.services.notebooks.listNotebooks(env.projectId)).toHaveLength(0);
			const outcome = await expectOk<ImportOutcome>(
				await env.request('GET', importPath(preparation.id)),
			);
			expect(outcome.notebooks).toEqual([]);
			await expectOk(
				await env.request('POST', path, { entry_notebook: 'reports/revenue.py', title: 'Revenue' }),
				201,
			);
			expect(await env.deps.services.notebooks.listNotebooks(env.projectId)).toHaveLength(1);
		},
	);
});
