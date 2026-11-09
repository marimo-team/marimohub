import { describe, expect, it, vi } from 'vitest';
import { ACTOR, uid, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { paths } from '@marimo-hub/core';
import { thumbnailPng } from '@marimo-hub/core/testing/thumbnail';
import { createTestApi, createInitializedBucket, expectError, expectOk } from '../testing';

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
	it('caches matching revisions for a day and revalidates unversioned or stale URLs', async () => {
		const { app, deps, path, project, notebook, bucket } = await setup();
		const metadata = await deps.services.notebooks.thumbnails.setCustom(
			project.id,
			notebook.id,
			thumbnailPng(),
		);
		const get = vi.spyOn(bucket, 'get');
		const response = await app.request(`${path}/image?r=${metadata.revision}`);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
		const nb = paths.project(project.id).notebook(notebook.id);
		expect(get.mock.calls.some(([key]) => key === nb.source || key === nb.readme)).toBe(false);
		const revalidated = await app.request(`${path}/image?r=${metadata.revision}`, {
			headers: { 'If-None-Match': response.headers.get('etag')! },
		});
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get('cache-control')).toBe('private, max-age=86400');
		for (const url of [`${path}/image`, `${path}/image?r=stale`]) {
			expect((await app.request(url)).headers.get('cache-control')).toBe('private, no-cache');
		}
	});

	it('does not give a replaced revision long-lived caching even when its bytes still match', async () => {
		const { app, deps, path, project, notebook } = await setup();
		const thumbnails = deps.services.notebooks.thumbnails;
		const original = await thumbnails.setCustom(project.id, notebook.id, thumbnailPng());
		const response = await app.request(`${path}/image?r=${original.revision}`);
		await thumbnails.removeCustom(project.id, notebook.id);
		const replacement = await thumbnails.setCustom(project.id, notebook.id, thumbnailPng());
		expect(replacement.revision).not.toBe(original.revision);
		const current = await app.request(`${path}/image?r=${replacement.revision}`);
		expect(current.headers.get('cache-control')).toBe('private, max-age=86400');
		for (const [etag, status] of [
			[response.headers.get('etag')!, 200],
			[current.headers.get('etag')!, 304],
		] as const) {
			const stale = await app.request(`${path}/image?r=${original.revision}`, {
				headers: { 'If-None-Match': etag },
			});
			expect(stale.status).toBe(status);
			expect(stale.headers.get('cache-control')).toBe('private, no-cache');
		}
	});

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
	it('revalidates wildcard, weak, and list validators without reading image bytes', async () => {
		const { app, deps, path, project, notebook } = await setup();
		await deps.services.notebooks.thumbnails.setCustom(project.id, notebook.id, thumbnailPng());
		const selected = (await deps.services.notebooks.thumbnails.imageWithRevision(
			project.id,
			notebook.id,
		))!;
		const { image } = selected;
		const bytes = vi.spyOn(image, 'bytes');
		vi.spyOn(deps.services.notebooks.thumbnails, 'imageWithRevision').mockResolvedValue(selected);
		const etag = `"${image.etag}"`;
		for (const validator of [
			'*',
			etag,
			`W/${etag}`,
			`"other", W/${etag}`,
			`"has,comma", ${etag}`,
		]) {
			const response = await app.request(`${path}/image`, {
				headers: { 'If-None-Match': validator },
			});
			expect(response.status).toBe(304);
			expect(response.headers.get('etag')).toBe(etag);
			expect(response.headers.get('cache-control')).toBe('private, no-cache');
			expect(await response.text()).toBe('');
		}
		expect(bytes).not.toHaveBeenCalled();
		expect(
			(await app.request(`${path}/image`, { headers: { 'If-None-Match': 'W/"other"' } })).status,
		).toBe(200);
		expect(bytes).toHaveBeenCalledOnce();
	});

	it('batches only visible, current notebook metadata', async () => {
		const { bucket, deps, project, notebook } = await setup();
		const hidden = await deps.services.notebooks.createNotebook(
			project.id,
			{
				title: 'Hidden',
				description: '',
				code: 'x = 1',
			},
			ACTOR,
		);
		const deleted = await deps.services.notebooks.createNotebook(
			project.id,
			{
				title: 'Deleted',
				description: '',
				code: 'x = 1',
			},
			ACTOR,
		);
		await deps.services.notebooks.deleteNotebook(project.id, deleted.id, ACTOR);
		await deps.services.notebooks.thumbnails.setCustom(project.id, notebook.id, thumbnailPng());
		await deps.services.notebooks.setSecurityLabels(
			project.id,
			hidden.id,
			{
				classification: 'SECRET',
				compartments: ['finance'],
			},
			ACTOR,
		);
		const viewer = uid('viewer');
		await deps.services.projects.addMember(project.id, { user_id: viewer }, 'viewer', ACTOR);
		const api = createTestApi({
			bucket,
			userId: viewer,
			deps: {
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ compartments: [] }),
				),
			},
		});
		const metadata = vi.spyOn(api.deps.services.notebooks.thumbnails, 'metadata');
		const path = `/api/v1/projects/${project.id}/thumbnails`;
		expect(await expectOk(await api.app.request(path))).toEqual({
			[notebook.id]: expect.objectContaining({ source: 'custom', has_custom: true }),
		});
		expect(metadata).toHaveBeenCalledExactlyOnceWith(project.id, notebook.id);
		const outsider = createTestApi({ bucket, userId: uid('outsider') }).app;
		expect([403, 404]).toContain((await outsider.request(path)).status);
	});

	it('rejects invalid and oversized images without replacing the previous thumbnail', async () => {
		const { app, path } = await setup();
		await app.request(path, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: thumbnailPng(),
		});
		for (const [body, status, code] of [
			[new Uint8Array([1, 2, 3]), 422, 'VALIDATION_ERROR'],
			[new Uint8Array(3 * 1024 * 1024 + 1), 413, 'PAYLOAD_TOO_LARGE'],
		] as const) {
			await expectError(
				await app.request(path, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body }),
				status,
				code,
			);
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
