import { describe, expect, it } from 'vitest';
import { ACTOR, uid, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { paths } from '@marimo-hub/core';
import { thumbnailPng } from '@marimo-hub/core/testing/thumbnail';
import { createTestApi, createInitializedBucket, expectOk } from '../testing';

async function setup() {
	const bucket = await createInitializedBucket();
	const api = createTestApi({ bucket });
	const project = await api.deps.services.projects.createProject(
		{ name: 'P', description: '' },
		ACTOR,
	);
	const notebook = await api.deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: 'x = 1' },
		ACTOR,
	);
	return {
		...api,
		project,
		notebook,
		path: `/api/v1/projects/${project.id}/notebooks/${notebook.id}/thumbnail`,
	};
}
describe('thumbnail API', () => {
	it('uploads, serves, revalidates, and removes a thumbnail', async () => {
		const { app, path } = await setup();
		expect(await expectOk(await app.request(path))).toMatchObject({ source: null });
		const put = await app.request(path, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: thumbnailPng(),
		});
		expect(await expectOk(put)).toMatchObject({ source: 'custom' });
		const image = await app.request(`${path}/image`);
		expect(image.status).toBe(200);
		expect(image.headers.get('content-type')).toBe('image/png');
		expect(image.headers.get('cache-control')).toBe('private, no-cache');
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(thumbnailPng());
		expect(
			(
				await app.request(`${path}/image`, {
					headers: { 'If-None-Match': image.headers.get('etag')! },
				})
			).status,
		).toBe(304);
		expect(await expectOk(await app.request(path, { method: 'DELETE' }))).toMatchObject({
			source: null,
		});
		expect((await app.request(`${path}/image`)).status).toBe(404);
	});
	it('rejects invalid and oversized images without replacing the previous thumbnail', async () => {
		const { app, path } = await setup();
		await app.request(path, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: thumbnailPng(),
		});
		for (const [body, status] of [
			[new Uint8Array([1, 2, 3]), 422],
			[new Uint8Array(3 * 1024 * 1024 + 1), 413],
		] as const) {
			expect(
				(await app.request(path, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body }))
					.status,
			).toBe(status);
		}
		expect(await expectOk(await app.request(path))).toMatchObject({ source: 'custom' });
	});
	it('checks security labels before serving cached image bytes or accepting changes', async () => {
		const { app, bucket, path, project, notebook } = await setup();
		await app.request(path, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: thumbnailPng(),
		});
		const etag = (await app.request(`${path}/image`)).headers.get('etag')!;
		const key = paths.project(project.id).notebook(notebook.id).meta;
		const meta = await (await bucket.get(key))!.json<Record<string, unknown>>();
		await bucket.put(
			key,
			JSON.stringify({
				...meta,
				security_labels: { classification: 'SECRET', compartments: ['finance'] },
			}),
		);
		const constrained = createTestApi({
			bucket,
			deps: {
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ compartments: [] }),
				),
			},
		}).app;
		for (const [url, method] of [
			[path, 'GET'],
			[`${path}/image`, 'GET'],
			[path, 'DELETE'],
			[path, 'PUT'],
		]) {
			const response = await constrained.request(url, {
				method,
				headers: { 'If-None-Match': etag, 'Content-Type': 'image/png' },
				...(method === 'PUT' ? { body: thumbnailPng() } : {}),
			});
			expect(response.status).toBe(404);
		}
	});

	it('allows viewers to read but not upload or remove and denies outsiders', async () => {
		const { bucket, deps, project, path } = await setup();
		const viewer = uid('viewer');
		await deps.services.projects.addMember(project.id, { user_id: viewer }, 'viewer', ACTOR);
		const viewerApi = createTestApi({ bucket, userId: viewer }).app;
		expect((await viewerApi.request(path)).status).toBe(200);
		for (const method of ['PUT', 'DELETE'])
			expect(
				(
					await viewerApi.request(path, {
						method,
						headers: { 'Content-Type': 'image/png' },
						...(method === 'PUT' ? { body: thumbnailPng() } : {}),
					})
				).status,
			).toBe(403);
		const outsider = createTestApi({ bucket, userId: uid('outsider') }).app;
		for (const url of [path, `${path}/image`])
			expect([403, 404]).toContain((await outsider.request(url)).status);
	});
});
