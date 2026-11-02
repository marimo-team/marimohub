import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServices } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { SearchIndexer, SearchCheckpointSchema } from '@marimo-hub/core/search';
import type { SearchSource, SearchDocument } from '@marimo-hub/core/search';
import { searchPaths } from '@marimo-hub/core/search/paths';
import { BucketSearchIndex } from '@marimo-hub/search-bucket';

const signal = () => new AbortController().signal;
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function setup() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const project = await services.projects.createProject(
		{ name: 'Research', description: '' },
		ACTOR,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Revenue', code: '', description: '' },
		ACTOR,
	);
	const document: SearchDocument = {
		id: 'revenue',
		kind: 'notebook',
		title: 'Revenue',
		text: 'annual revenue',
		fingerprint: '1',
		resource: { type: 'notebook', notebook_id: notebook.id },
	};
	const page = vi.fn<SearchSource['page']>(async () => ({ documents: [document], partial: false }));
	const source: SearchSource = {
		id: 'notebooks',
		revision: 1,
		kinds: ['notebook'],
		page,
		validate: async (_project, docs) => docs,
	};
	const index = new BucketSearchIndex(bucket);
	const scope = { projectId: project.id, source: source.id };
	const paths = searchPaths.scope(scope);
	const indexer = (src = source, revision = 1) =>
		new SearchIndexer(
			bucket,
			index,
			[src],
			services.catalog,
			services.projects,
			undefined,
			revision,
		);
	const step = (src = source, revision = 1, abort = signal()) =>
		indexer(src, revision).step(project.id, src, abort);
	await step();
	page.mockClear();
	return { bucket, services, project, document, source, page, index, scope, paths, indexer, step };
}

async function readyCrawl(
	f: Awaited<ReturnType<typeof setup>>,
	count: number,
	documentsPerPage = 1,
) {
	const checkpoint = (await f.bucket.get(f.paths.checkpoint))!;
	const state = SearchCheckpointSchema.parse(await checkpoint.json());
	const pages = Array.from({ length: count }, () => crypto.randomUUID());
	await Promise.all(
		pages.map((id, i) =>
			f.bucket.put(
				f.paths.page(id),
				JSON.stringify({
					schema_version: 1,
					indexed_at: new Date().toISOString(),
					partial: false,
					documents: Array.from({ length: documentsPerPage }, (_, j) => ({
						...f.document,
						id: `page-${i}-${j}`,
					})),
				}),
			),
		),
	);
	await f.bucket.put(
		f.paths.checkpoint,
		JSON.stringify({
			...state,
			pages,
			ready: true,
			count: count * documentsPerPage,
			bytes: count * documentsPerPage * 256,
		}),
		{ onlyIfEtagMatches: checkpoint.etag },
	);
	return pages;
}

describe('search lifecycle across deployments', () => {
	it('retires an unfinished deleted crawl, reclaims copied content, and fences delayed writers', async () => {
		const f = await setup();
		f.page.mockResolvedValueOnce({ documents: [f.document], cursor: 'next', partial: false });
		await f.step();
		const old = await f.index.read(f.scope, signal());
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		f.page.mockImplementationOnce(async () => {
			entered.resolve();
			await resume.promise;
			return { documents: [f.document], partial: false };
		});
		const late = f.step();
		await entered.promise;
		await f.services.projects.deleteProject(f.project.id, ACTOR);
		await f.indexer().tick(signal());
		expect(
			SearchCheckpointSchema.parse(await (await f.bucket.get(f.paths.checkpoint))!.json()).pages,
		).toEqual([]);
		expect((await f.index.head(f.scope, signal())).deleted).toBe(true);
		resume.resolve();
		expect(await late).toBe(false);
		expect(await f.index.publish(f.scope, old.snapshot, old.revision, signal())).toBe(false);
		expect((await f.bucket.list({ prefix: f.paths.pages })).objects.length).toBeGreaterThan(0);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3600_000);
		await f.indexer().tick(signal());
		expect((await f.bucket.list({ prefix: f.paths.pages })).objects).toEqual([]);
		expect((await f.bucket.list({ prefix: f.paths.snapshots })).objects).toEqual([]);
		expect((await f.index.head(f.scope, signal())).deleted).toBe(true);
		expect(await f.bucket.get(f.paths.checkpoint)).not.toBeNull();
	});
	it('retries retirement when a late checkpoint wins before deletion fences it', async () => {
		const f = await setup();
		f.page.mockResolvedValueOnce({ documents: [f.document], cursor: 'next', partial: false });
		await f.step();
		await f.services.projects.deleteProject(f.project.id, ACTOR);
		const put = f.bucket.put.bind(f.bucket);
		let raced = false;
		vi.spyOn(f.bucket, 'put').mockImplementation(async (...args) => {
			if (args[0] === f.paths.checkpoint && !raced) {
				raced = true;
				const current = (await f.bucket.get(args[0]))!;
				await put(args[0], await current.text(), { onlyIfEtagMatches: current.etag });
			}
			return put(...args);
		});
		expect(await f.step()).toBe(false);
		expect(await f.step()).toBe(true);
		expect(
			SearchCheckpointSchema.parse(await (await f.bucket.get(f.paths.checkpoint))!.json()).pages,
		).toEqual([]);
	});
	it('restarts an incompatible cursor without discarding the published snapshot', async () => {
		const f = await setup();
		f.page.mockResolvedValueOnce({
			documents: [{ ...f.document, id: 'old-page' }],
			cursor: 'old-format',
			partial: false,
		});
		await f.step();
		const old = (await f.index.read(f.scope, signal())).snapshot;
		const page = vi
			.fn<SearchSource['page']>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce({ documents: [{ ...f.document, id: 'replacement' }], partial: false });
		const source = { ...f.source, revision: 2, page };
		await expect(f.step(source)).rejects.toThrow('offline');
		expect((await f.index.read(f.scope, signal())).snapshot).toEqual(old);
		await f.step(source);
		expect(page.mock.calls.map((call) => call[1])).toEqual([undefined, undefined]);
		expect((await f.index.read(f.scope, signal())).snapshot?.documents.map((d) => d.id)).toEqual([
			'replacement',
		]);
		await f.step();
		expect(f.page).toHaveBeenCalledTimes(1);
	});
	it('fences an old worker paused at final publication when a newer build takes over', async () => {
		const f = await setup();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const put = f.bucket.put.bind(f.bucket);
		let paused = false;
		vi.spyOn(f.bucket, 'put').mockImplementation(async (...args) => {
			if (args[0] === f.paths.head && !paused) {
				paused = true;
				entered.resolve();
				await resume.promise;
			}
			return put(...args);
		});
		const old = f.step();
		await entered.promise;
		const source = {
			...f.source,
			revision: 2,
			page: async () => ({ documents: [{ ...f.document, id: 'new-build' }], partial: false }),
		};
		await f.step(source);
		resume.resolve();
		await old;
		expect((await f.index.read(f.scope, signal())).snapshot?.documents[0].id).toBe('new-build');
		expect((await f.index.head(f.scope, signal())).build?.source_revision).toBe(2);
	});
	it('requires a monotonic deployment revision for configuration changes and rejects rollback', async () => {
		const f = await setup();
		const source = { ...f.source, configuration: 'schema-discovery-enabled' };
		await expect(f.step(source)).rejects.toThrow('MARIMOHUB_SEARCH_BUILD_REVISION');
		await f.step(source, 2);
		const published = await f.index.head(f.scope, signal());
		await f.step();
		expect(await f.index.head(f.scope, signal())).toEqual(published);
		expect(f.page).toHaveBeenCalledTimes(1);
	});
	it('restarts unversioned checkpoints without interpreting their cursor', async () => {
		const f = await setup();
		const state = SearchCheckpointSchema.parse(
			await (await f.bucket.get(f.paths.checkpoint))!.json(),
		);
		await f.bucket.put(
			f.paths.checkpoint,
			JSON.stringify({ ...state, build: undefined, cursor: 'unknown-old-cursor' }),
		);
		await f.step();
		expect(f.page.mock.calls[0][1]).toBeUndefined();
	});
	it('does not load the published snapshot when resuming a keyword crawl', async () => {
		const f = await setup();
		f.page.mockResolvedValueOnce({ documents: [], cursor: 'next', partial: false });
		const get = vi.spyOn(f.bucket, 'get');
		await f.step();
		expect(get.mock.calls.some(([key]) => key.startsWith(f.paths.snapshots))).toBe(false);
	});
});

describe('bounded remote page assembly', () => {
	it.each([400, 1000])(
		'assembles %i pages with 100 ms reads inside the 30-second attempt',
		async (count) => {
			const f = await setup();
			await readyCrawl(f, count, 20);
			vi.useFakeTimers();
			const get = f.bucket.get.bind(f.bucket);
			let active = 0,
				peak = 0,
				reads = 0;
			vi.spyOn(f.bucket, 'get').mockImplementation(async (key) => {
				if (!key.startsWith(f.paths.pages)) return get(key);
				reads++;
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 100));
				active--;
				return get(key);
			});
			const start = Date.now();
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30_000);
			const pending = f.step(f.source, 1, controller.signal).finally(() => clearTimeout(timeout));
			await vi.runAllTimersAsync();
			expect(await pending).toBe(true);
			expect(Date.now() - start).toBe((count / 8) * 100);
			expect(peak).toBe(8);
			expect(reads).toBe(count);
			expect((await f.index.read(f.scope, signal())).snapshot?.documents.map((d) => d.id)).toEqual(
				Array.from({ length: count }, (_, i) =>
					Array.from({ length: 20 }, (_, j) => `page-${i}-${j}`),
				).flat(),
			);
			expect(f.page).not.toHaveBeenCalled();
		},
	);
	it('retains a ready crawl when slow storage exceeds the assembly deadline', async () => {
		const f = await setup();
		await readyCrawl(f, 400);
		const old = await f.index.read(f.scope, signal());
		const checkpoint = (await f.bucket.get(f.paths.checkpoint))!.etag;
		vi.useFakeTimers();
		const get = f.bucket.get.bind(f.bucket);
		let reads = 0;
		vi.spyOn(f.bucket, 'get').mockImplementation(async (key) => {
			if (key.startsWith(f.paths.pages)) {
				reads++;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			return get(key);
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30_000);
		const pending = expect(f.step(f.source, 1, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		await vi.runAllTimersAsync();
		await pending;
		expect(reads).toBeLessThan(400);
		expect((await f.bucket.get(f.paths.checkpoint))!.etag).toBe(checkpoint);
		expect(await f.index.read(f.scope, signal())).toEqual(old);
	});
	it('rejects a corrupt checkpoint whose pages exceed the aggregate document budget', async () => {
		const f = await setup();
		await readyCrawl(f, 101, 200);
		const old = await f.index.read(f.scope, signal());
		await expect(f.step()).rejects.toThrow('document budget');
		expect(await f.index.read(f.scope, signal())).toEqual(old);
	});
	it.each(['missing', 'malformed', 'cancelled'] as const)(
		'stops queued reads after a %s page and retains the ready checkpoint for retry',
		async (failure) => {
			const f = await setup();
			const pages = await readyCrawl(f, 40);
			const old = await f.index.read(f.scope, signal());
			const checkpoint = (await f.bucket.get(f.paths.checkpoint))!.etag;
			const body = (await f.bucket.get(f.paths.page(pages[0])))!;
			if (failure === 'missing') await f.bucket.delete(body.key);
			if (failure === 'malformed') await f.bucket.put(body.key, '{}');
			const controller = new AbortController();
			const get = f.bucket.get.bind(f.bucket);
			const spy = vi.spyOn(f.bucket, 'get').mockImplementation(async (key) => {
				if (failure === 'cancelled' && key === body.key) controller.abort();
				return get(key);
			});
			await expect(f.step(f.source, 1, controller.signal)).rejects.toThrow();
			expect(
				spy.mock.calls.filter(([key]) => key.startsWith(f.paths.pages)).length,
			).toBeLessThanOrEqual(8);
			expect((await f.bucket.get(f.paths.checkpoint))!.etag).toBe(checkpoint);
			expect(await f.index.read(f.scope, signal())).toEqual(old);
			spy.mockRestore();
			await f.bucket.put(body.key, await body.text());
			await f.step();
			expect((await f.index.read(f.scope, signal())).snapshot?.documents).toHaveLength(40);
			expect(f.page).not.toHaveBeenCalled();
		},
	);
});
