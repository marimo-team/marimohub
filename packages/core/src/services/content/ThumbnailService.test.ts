import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv } from '../../testing';
import { thumbnailPng } from '../../testing/thumbnail';
import { paths } from '../../paths';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('thumbnails', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	beforeEach(async () => {
		env = await setupTestEnv();
	});
	async function notebook() {
		const project = await env.projects.createProject({ name: 'P', description: '' }, ACTOR);
		const nb = await env.notebooks.createNotebook(
			project.id,
			{ title: 'N', description: '', code: 'x = 1' },
			ACTOR,
		);
		return { pid: project.id, nid: nb.id, thumbnails: env.notebooks.thumbnails };
	}
	function pauseNextWrite(prefix: string) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = env.bucket.put.bind(env.bucket);
		let pending = true;
		vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
			if (pending && key.startsWith(prefix)) {
				pending = false;
				entered.resolve();
				await release.promise;
			}
			return put(key, value, options);
		});
		return { entered: entered.promise, release: release.resolve };
	}
	it('loads notebook and thumbnail metadata concurrently before reading HTML', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>saved</div>' }, ACTOR);
		const gate = Promise.withResolvers<void>();
		const started = new Set<string>();
		const getNotebook = env.notebooks.getNotebook.bind(env.notebooks);
		const getThumbnail = thumbnails.get.bind(thumbnails);
		vi.spyOn(env.notebooks, 'getNotebook').mockImplementation(async (...args) => {
			started.add('notebook');
			await gate.promise;
			return getNotebook(...args);
		});
		vi.spyOn(thumbnails, 'get').mockImplementation(async (...args) => {
			started.add('thumbnail');
			await gate.promise;
			return getThumbnail(...args);
		});
		const html = vi.spyOn(env.notebooks, 'getVersionHtmlSnapshot');
		const pending = thumbnails.prepare(pid, nid);
		try {
			await vi.waitFor(() => expect([...started].sort()).toEqual(['notebook', 'thumbnail']));
			expect(html).not.toHaveBeenCalled();
		} finally {
			gate.resolve();
			await pending;
		}
		expect(html).toHaveBeenCalledOnce();
	});
	it('reads active status and the CAS head concurrently but waits for all checks before writing', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await thumbnails.setCustom(pid, nid, thumbnailPng());
		const nb = paths.project(pid).notebook(nid);
		const keys = [paths.project(pid).meta, nb.meta, nb.thumbnail].sort();
		const gate = Promise.withResolvers<void>();
		const started = new Set<string>();
		const get = env.bucket.get.bind(env.bucket);
		vi.spyOn(env.bucket, 'get').mockImplementation(async (key) => {
			if (keys.includes(key)) {
				started.add(key);
				await gate.promise;
			}
			return get(key);
		});
		const put = vi.spyOn(env.bucket, 'put');
		const pending = thumbnails.removeCustom(pid, nid);
		try {
			await vi.waitFor(() => expect([...started].sort()).toEqual(keys));
			expect(put).not.toHaveBeenCalled();
		} finally {
			gate.resolve();
			await pending;
		}
		expect((await thumbnails.metadata(pid, nid)).has_custom).toBe(false);
	});

	it.each(['save', 'custom', 'delete'] as const)(
		'does not publish when %s happens during image transfer',
		async (change) => {
			const { pid, nid, thumbnails } = await notebook();
			await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>old</div>' }, ACTOR);
			const capture = (await thumbnails.prepare(pid, nid))!;
			const paused = pauseNextWrite(paths.project(pid).notebook(nid).thumbnailImages);
			const pending = thumbnails.publish(pid, nid, capture, thumbnailPng());
			await paused.entered;
			if (change === 'save')
				await env.notebooks.commitSession(
					pid,
					nid,
					{ code: 'x = 2', html: '<div>new</div>' },
					ACTOR,
				);
			if (change === 'custom') await thumbnails.setCustom(pid, nid, thumbnailPng());
			if (change === 'delete') await env.notebooks.deleteNotebook(pid, nid, ACTOR);
			paused.release();
			expect(await pending).toBe(false);
			expect((await thumbnails.metadata(pid, nid)).source).toBe(
				change === 'custom' ? 'custom' : null,
			);
		},
	);
	it('does not retry a stale automatic CAS over a concurrent custom thumbnail', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>saved</div>' }, ACTOR);
		const capture = (await thumbnails.prepare(pid, nid))!;
		const paused = pauseNextWrite(paths.project(pid).notebook(nid).thumbnail);
		const pending = thumbnails.publish(pid, nid, capture, thumbnailPng());
		await paused.entered;
		await thumbnails.setCustom(pid, nid, thumbnailPng());
		const selected = await thumbnails.metadata(pid, nid);
		paused.release();
		expect(await pending).toBe(false);
		expect(await thumbnails.metadata(pid, nid)).toEqual(selected);
	});
	it('does not publish if image transfer exhausts the deadline', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>saved</div>' }, ACTOR);
		const capture = (await thumbnails.prepare(pid, nid))!;
		const deadline = Date.now() + 1000;
		const paused = pauseNextWrite(paths.project(pid).notebook(nid).thumbnailImages);
		const pending = thumbnails.publish(pid, nid, capture, thumbnailPng(), deadline);
		await paused.entered;
		vi.useFakeTimers();
		vi.setSystemTime(deadline);
		paused.release();
		expect(await pending).toBe(false);
		expect(await thumbnails.get(pid, nid)).toBeNull();
	});
	it.each(['image', 'record'])(
		'preserves the selected custom image on a failed %s write',
		async (stage) => {
			const { pid, nid, thumbnails } = await notebook();
			await thumbnails.setCustom(pid, nid, thumbnailPng());
			const previous = await thumbnails.metadata(pid, nid);
			const put = env.bucket.put.bind(env.bucket);
			vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key.endsWith(stage === 'image' ? '.png' : '/thumbnail.json'))
					throw new Error('Storage unavailable');
				return put(key, value, options);
			});
			await expect(thumbnails.setCustom(pid, nid, thumbnailPng())).rejects.toThrow(
				'Storage unavailable',
			);
			expect(await thumbnails.metadata(pid, nid)).toEqual(previous);
			expect(await thumbnails.image(pid, nid)).not.toBeNull();
		},
	);

	it('selects custom over automatic and reveals automatic after removal', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(
			pid,
			nid,
			{ code: 'x = 1', html: '<div>saved output</div>' },
			ACTOR,
		);
		const capture = await thumbnails.prepare(pid, nid);
		expect(capture).not.toBeNull();
		expect(await thumbnails.publish(pid, nid, capture!, thumbnailPng())).toBe(true);
		expect(await thumbnails.prepare(pid, nid)).toBeNull();
		await thumbnails.setCustom(pid, nid, thumbnailPng());
		expect(await thumbnails.metadata(pid, nid)).toMatchObject({ source: 'custom' });
		expect(await thumbnails.prepare(pid, nid)).toBeNull();
		await thumbnails.removeCustom(pid, nid);
		expect(await thumbnails.metadata(pid, nid)).toMatchObject({ source: 'automatic' });
	});
	it('does not publish a capture after a custom upload, even when it is subsequently removed', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>saved</div>' }, ACTOR);
		const capture = (await thumbnails.prepare(pid, nid))!;
		await thumbnails.setCustom(pid, nid, thumbnailPng());
		await thumbnails.removeCustom(pid, nid);
		expect(await thumbnails.publish(pid, nid, capture, thumbnailPng())).toBe(false);
	});
	it('rejects stale output and deleted notebooks', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>old</div>' }, ACTOR);
		const capture = (await thumbnails.prepare(pid, nid))!;
		await env.notebooks.commitSession(pid, nid, { code: 'x = 2', html: '<div>new</div>' }, ACTOR);
		expect(await thumbnails.publish(pid, nid, capture, thumbnailPng())).toBe(false);
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect(await thumbnails.prepare(pid, nid)).toBeNull();
		await expect(thumbnails.setCustom(pid, nid, thumbnailPng())).rejects.toThrow();
	});
	it('fences thumbnail publication when a project is deleted', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>saved</div>' }, ACTOR);
		const capture = (await thumbnails.prepare(pid, nid))!;
		await env.projects.deleteProject(pid, ACTOR);
		expect(await thumbnails.publish(pid, nid, capture, thumbnailPng())).toBe(false);
		await expect(thumbnails.setCustom(pid, nid, thumbnailPng())).rejects.toThrow();
	});

	it('grants only one attempt per sandbox across concurrent callers', async () => {
		const { pid, nid, thumbnails } = await notebook();
		expect(
			(
				await Promise.all([
					thumbnails.claimAttempt(pid, nid, 'sandbox'),
					thumbnails.claimAttempt(pid, nid, 'sandbox'),
				])
			).sort((a, b) => Number(a) - Number(b)),
		).toEqual([false, true]);
	});
	it('prunes old orphans while retaining both references and recent uploads', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html: '<div>saved</div>' }, ACTOR);
		await thumbnails.publish(pid, nid, (await thumbnails.prepare(pid, nid))!, thumbnailPng());
		const automatic = (await thumbnails.get(pid, nid))!.automatic!.id;
		await thumbnails.setCustom(pid, nid, thumbnailPng());
		const first = (await thumbnails.get(pid, nid))!.custom!.id;
		await thumbnails.setCustom(pid, nid, thumbnailPng());
		await thumbnails.prune(pid, nid);
		expect(
			await env.bucket.get(paths.project(pid).notebook(nid).thumbnailImage(first)),
		).not.toBeNull();
		await thumbnails.prune(pid, nid, Date.now() + 86_400_001);
		expect(
			await env.bucket.get(paths.project(pid).notebook(nid).thumbnailImage(automatic)),
		).not.toBeNull();
		expect(await env.bucket.get(paths.project(pid).notebook(nid).thumbnailImage(first))).toBeNull();
		expect(await thumbnails.image(pid, nid)).not.toBeNull();
	});
});
