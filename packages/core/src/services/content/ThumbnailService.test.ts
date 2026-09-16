import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv } from '../../testing';
import { thumbnailPng } from '../../testing/thumbnail';
import { paths } from '../../paths';
import { Millis } from '../../duration';
import { listAllKeys } from '../catalog/storage';

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
		expect(await thumbnails.prepare(pid, nid)).toBeNull();
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
	it('skips identical HTML across versions and retains the rendered version as provenance', async () => {
		const { pid, nid, thumbnails } = await notebook();
		const html = '<div>same output</div>';
		await env.notebooks.commitSession(pid, nid, { code: 'x = 1', html }, ACTOR);
		const capture = (await thumbnails.prepare(pid, nid))!;
		await thumbnails.publish(pid, nid, capture, thumbnailPng());
		const previous = await thumbnails.get(pid, nid);
		await env.notebooks.commitSession(pid, nid, { code: 'x = 2', html }, ACTOR);
		const current = await env.notebooks.getNotebook(pid, nid);
		expect(current.source).not.toMatchObject({ current_version_id: capture.versionId });
		const skipped = vi.fn();
		expect(await thumbnails.prepare(pid, nid, skipped)).toBeNull();
		expect(skipped).toHaveBeenCalledWith('unchanged_html');
		expect(await thumbnails.get(pid, nid)).toEqual(previous);
	});

	it('reclaims old capture attempts but retains recent attempts', async () => {
		const { pid, nid, thumbnails } = await notebook();
		vi.useFakeTimers();
		const start = Date.now();
		await thumbnails.claimAttempt(pid, nid, 'old');
		vi.setSystemTime(start + Millis.days(1));
		await thumbnails.claimAttempt(pid, nid, 'recent');
		await thumbnails.prune(pid, nid, Date.now() + 1);
		const nb = paths.project(pid).notebook(nid);
		expect(await env.bucket.get(nb.thumbnailAttempt('old'))).toBeNull();
		expect(await thumbnails.claimAttempt(pid, nid, 'recent')).toBe(false);
	});

	it.each([
		['notebook', false],
		['notebook', true],
		['project', false],
		['project', true],
	] as const)(
		'does not recreate a thumbnail record when %s retirement overlaps hard deletion (repeat=%s)',
		async (scope, repeat) => {
			const { pid, nid, thumbnails } = await notebook();
			await thumbnails.setCustom(pid, nid, thumbnailPng());
			const nb = paths.project(pid).notebook(nid);
			if (repeat) {
				if (scope === 'project') await env.projects.deleteProject(pid, ACTOR);
				else await env.notebooks.deleteNotebook(pid, nid, ACTOR);
			}
			const paused = pauseNextWrite(nb.thumbnail);
			const deletion =
				scope === 'project'
					? env.projects.deleteProject(pid, ACTOR)
					: env.notebooks.deleteNotebook(pid, nid, ACTOR);
			await paused.entered;
			if (scope === 'project') await env.projects.sweepDeletedProjects(0);
			else await env.notebooks.sweepDeletedNotebooks(0);
			paused.release();
			await deletion;
			await thumbnails.retire(pid, nid);
			expect(await listAllKeys(env.bucket, `${nb.base}/`)).toEqual([]);
		},
	);

	it.each(['image', 'record'] as const)(
		'removes a first automatic %s write that completes after hard deletion',
		async (stage) => {
			const { pid, nid, thumbnails } = await notebook();
			await env.notebooks.commitSession(
				pid,
				nid,
				{ code: 'x = 1', html: '<div>saved</div>' },
				ACTOR,
			);
			const capture = (await thumbnails.prepare(pid, nid))!;
			const nb = paths.project(pid).notebook(nid);
			const paused = pauseNextWrite(stage === 'image' ? nb.thumbnailImages : nb.thumbnail);
			const pending = thumbnails.publish(pid, nid, capture, thumbnailPng());
			await paused.entered;
			await env.notebooks.deleteNotebook(pid, nid, ACTOR);
			await env.notebooks.sweepDeletedNotebooks(0);
			paused.release();
			expect(await pending).toBe(false);
			expect(await listAllKeys(env.bucket, `${nb.base}/`)).toEqual([]);
		},
	);

	it('removes a first custom publication that completes after hard deletion', async () => {
		const { pid, nid, thumbnails } = await notebook();
		const nb = paths.project(pid).notebook(nid);
		const paused = pauseNextWrite(nb.thumbnail);
		const pending = thumbnails.setCustom(pid, nid, thumbnailPng());
		const rejection = expect(pending).rejects.toThrow('not found');
		await paused.entered;
		await env.projects.deleteProject(pid, ACTOR);
		await env.projects.sweepDeletedProjects(0);
		paused.release();
		await rejection;
		expect(await listAllKeys(env.bucket, `${nb.base}/`)).toEqual([]);
	});

	it.each(['record', 'listing'] as const)(
		'continues notebook GC when thumbnail %s pruning fails',
		async (stage) => {
			const { pid, nid } = await notebook();
			const other = await env.notebooks.createNotebook(
				pid,
				{ title: 'Keep', description: '', code: 'x = 1' },
				ACTOR,
			);
			await env.notebooks.deleteNotebook(pid, nid, ACTOR);
			const nb = paths.project(pid).notebook(other.id);
			if (stage === 'record') await env.bucket.put(nb.thumbnail, 'invalid');
			else {
				const list = env.bucket.list.bind(env.bucket);
				vi.spyOn(env.bucket, 'list').mockImplementation(async (options) => {
					if (options?.prefix === nb.thumbnailImages) throw new Error('Listing unavailable');
					return list(options);
				});
			}
			expect((await env.notebooks.sweepDeletedNotebooks(0)).purged).toBe(1);
			expect(await listAllKeys(env.bucket, `${paths.project(pid).notebook(nid).base}/`)).toEqual(
				[],
			);
		},
	);

	it('continues project deletion and deep-link cleanup when thumbnail retirement fails', async () => {
		const { pid, nid, thumbnails } = await notebook();
		await thumbnails.setCustom(pid, nid, thumbnailPng());
		const put = env.bucket.put.bind(env.bucket);
		vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === paths.project(pid).notebook(nid).thumbnail) throw new Error('Unavailable');
			return put(key, value, options);
		});
		const release = vi.spyOn(env.deepLinks, 'releaseProject');
		await env.projects.deleteProject(pid, ACTOR);
		expect((await env.projects.getProject(pid)).status).toBe('deleted');
		expect(release).toHaveBeenCalledWith(pid);
		await expect(env.projects.deleteProject(pid, ACTOR)).resolves.toBeUndefined();
	});

	it.each(['notebook', 'project'] as const)(
		'retries %s GC after the subtree was purged before the catalog update',
		async (scope) => {
			const { pid, nid } = await notebook();
			if (scope === 'project') {
				await env.projects.deleteProject(pid, ACTOR);
				await env.projects.hardDeleteProject(pid);
				expect(await env.projects.sweepDeletedProjects(0)).toBe(1);
			} else {
				await env.notebooks.deleteNotebook(pid, nid, ACTOR);
				await env.notebooks.hardDeleteNotebook(pid, nid);
				expect((await env.notebooks.sweepDeletedNotebooks(0)).purged).toBe(1);
			}
		},
	);
	it('removes an attempt marker whose first write completes after hard deletion', async () => {
		const { pid, nid, thumbnails } = await notebook();
		const nb = paths.project(pid).notebook(nid);
		const paused = pauseNextWrite(nb.thumbnailAttempt('sandbox'));
		const pending = thumbnails.claimAttempt(pid, nid, 'sandbox');
		await paused.entered;
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		await env.notebooks.sweepDeletedNotebooks(0);
		paused.release();
		expect(await pending).toBe(false);
		expect(await listAllKeys(env.bucket, `${nb.base}/`)).toEqual([]);
	});

	it('continues deep-link cleanup when the thumbnail retirement catalog read fails', async () => {
		const { pid } = await notebook();
		const update = env.catalog.updateProjectEntry.bind(env.catalog);
		vi.spyOn(env.catalog, 'updateProjectEntry').mockImplementation(async (...args) => {
			const snapshot = await update(...args);
			vi.spyOn(env.catalog, 'getCurrentSnapshot').mockRejectedValue(new Error('Unavailable'));
			return snapshot;
		});
		const release = vi.spyOn(env.deepLinks, 'releaseProject');
		await expect(env.projects.deleteProject(pid, ACTOR)).resolves.toBeUndefined();
		expect(release).toHaveBeenCalledWith(pid);
	});
});
