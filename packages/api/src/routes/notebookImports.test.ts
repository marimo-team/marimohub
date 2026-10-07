import { MAX_FOLDER_IMPORT_ARCHIVE_BYTES } from '@marimo-hub/core/workspace-ignore';
import { beforeEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { ACTOR, uid } from '@marimo-hub/core/testing';
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
const encode = (text: string) => new TextEncoder().encode(text);
const archive = zipSync({
	'reports/revenue.py': encode('import marimo'),
	'helpers.py': encode('VALUE = 1'),
	'data/raw.bin': new Uint8Array([0, 255]),
});
async function prepare() {
	return expectOk<{ id: string; files: { path: string; size: number }[] }>(
		await env.app.request(`/api/v1/projects/${env.projectId}/notebook-imports`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/zip' },
			body: new Uint8Array(archive),
		}),
		201,
	);
}

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
		const path = `/projects/${env.projectId}/notebook-imports/${preparation.id}/notebooks`;
		const body = { entry_notebook: 'reports/revenue.py', title: 'Revenue' };
		const notebook = await expectOk<{ id: string }>(await env.request('POST', path, body), 201);
		expect(
			await expectOk(await env.request('GET', `${path}?entry_notebook=reports%2Frevenue.py`)),
		).toMatchObject({ state: 'complete', notebook: { id: notebook.id } });
		expect(await expectOk(await env.request('POST', path, body), 201)).toMatchObject({
			id: notebook.id,
		});
		expect(
			await expectOk(
				await env.request('GET', `/projects/${env.projectId}/notebooks/${notebook.id}`),
			),
		).toMatchObject({ source: { type: 'local', entry_notebook: 'reports/revenue.py' } });
	});

	it('enforces project authorization on preparation and status', async () => {
		const preparation = await prepare();
		const outsider = createTestApi({ bucket: env.bucket, userId: uid('outsider') });
		await expectError(
			await outsider.app.request(`/api/v1/projects/${env.projectId}/notebook-imports`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/zip' },
				body: new Uint8Array(archive),
			}),
			403,
		);
		await expectError(
			await outsider.request(
				'GET',
				`/projects/${env.projectId}/notebook-imports/${preparation.id}/notebooks?entry_notebook=reports/revenue.py`,
			),
			403,
		);
	});

	it('rejects malformed archive and missing entrypoints without publishing a notebook', async () => {
		await expectError(
			await env.app.request(`/api/v1/projects/${env.projectId}/notebook-imports`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/zip' },
				body: 'invalid',
			}),
			400,
		);
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
	it('replays normalized default settings even after deployment options change', async () => {
		const preparation = await prepare();
		const path = `/projects/${env.projectId}/notebook-imports/${preparation.id}/notebooks`;
		const { request } = createTestApi({
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
		const first = await expectOk<{ id: string; base_image?: string; compute_profile?: string }>(
			await request('POST', path, body),
			201,
		);
		expect(first.base_image).toBeUndefined();
		expect(first.compute_profile).toBeUndefined();
		const replay = await expectOk<{ id: string }>(await env.request('POST', path, body), 201);
		expect(replay.id).toBe(first.id);
		await expectError(await env.request('POST', path, { ...body, compute_profile: 'large' }), 409);
	});

	it('rejects blank names and invalid status paths without creating notebooks', async () => {
		const preparation = await prepare();
		const path = `/projects/${env.projectId}/notebook-imports/${preparation.id}/notebooks`;
		await expectError(
			await env.request('POST', path, { entry_notebook: 'reports/revenue.py', title: '   ' }),
			422,
		);
		await expectError(await env.request('GET', `${path}?entry_notebook=..%2Fescape.py`), 400);
		expect(await env.deps.services.notebooks.listNotebooks(env.projectId)).toHaveLength(0);
	});

	it('rejects unavailable runtime settings without publication', async () => {
		const preparation = await prepare();
		const path = `/projects/${env.projectId}/notebook-imports/${preparation.id}/notebooks`;
		await expectError(
			await env.request('POST', path, {
				entry_notebook: 'reports/revenue.py',
				title: 'Revenue',
				compute_profile: 'large',
			}),
			403,
		);
		expect(await env.deps.services.notebooks.listNotebooks(env.projectId)).toHaveLength(0);
	});
});
