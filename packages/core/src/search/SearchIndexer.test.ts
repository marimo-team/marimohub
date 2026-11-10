import { afterEach, expect, it, vi } from 'vitest';
import { createServices } from '../services';
import { MemoryBucket } from '../testing/MemoryBucket';
import { MemorySearchIndex, searchOwner, stubSearchSource } from '../testing/search';
import {
	makeProject,
	makeNotebookMeta,
	makeSnapshotProjectEntry,
	makeSnapshotNotebookEntry,
} from '../testing/fixtures';
import { AuthorizationService } from '../services/authorization/AuthorizationService';
import { paths } from '../paths';
import { createVersionId } from '../ids';
import { NotebookSource } from './NotebookSource';
import { SearchIndexer } from './SearchIndexer';
import { SearchService } from './SearchService';
import { SearchRequestSchema } from './contracts';
import type { SearchSource } from './contracts';
import { searchPaths } from './paths';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const signal = () => new AbortController().signal;

async function seed(projectCount: number, notebooksPerProject: number) {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(searchOwner.id);
	const entries: ReturnType<typeof makeSnapshotProjectEntry>[] = [];
	for (let i = 0; i < projectCount; i++) {
		const project = makeProject({
			owner: searchOwner.id,
			members: [{ user_id: searchOwner.id, role: 'admin' }],
		});
		await bucket.put(paths.project(project.id).meta, JSON.stringify(project));
		const notebooks = [];
		for (let j = 0; j < notebooksPerProject; j++) {
			const notebook = makeNotebookMeta({ project_id: project.id });
			const keys = paths.project(project.id).notebook(notebook.id);
			await bucket.put(keys.meta, JSON.stringify(notebook));
			await bucket.put(
				keys.source,
				JSON.stringify({ schema_version: 1, type: 'local', current_version_id: createVersionId() }),
			);
			await bucket.put(keys.code, 'revenue = 42');
			notebooks.push(
				makeSnapshotNotebookEntry(project.id, { ...notebook, author: searchOwner.id }),
			);
		}
		entries.push(
			makeSnapshotProjectEntry({ ...project, notebooks, notebook_count: notebooks.length }),
		);
	}
	await services.catalog.mutateSnapshot('search.seed', searchOwner.id, (snapshot) => ({
		...snapshot,
		projects: entries,
	}));
	const authz = new AuthorizationService({});
	const source = new NotebookSource(bucket, services.catalog, services.notebooks, authz);
	const index = new MemorySearchIndex();
	const indexer = (selected: SearchSource = source) =>
		new SearchIndexer(bucket, index, [selected], services.catalog, services.projects);
	const search = new SearchService(index, [source], services.catalog, services.projects, authz);
	const snapshot = async (projectId = entries[0].id, sourceId = source.id) =>
		(await index.read({ projectId, source: sourceId })).snapshot;
	return { bucket, services, entries, source, index, indexer, search, snapshot };
}

it('finishes 200 projects in one round and stays idle across indexer restarts', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.spyOn(performance, 'now').mockReturnValue(0);
	const f = await seed(200, 1);
	const page = vi.spyOn(f.source, 'page');
	const get = vi.spyOn(f.bucket, 'get');
	let ticks = 0;
	while (page.mock.calls.length < 200 && ticks < 200) {
		await f.indexer().tick(signal());
		vi.setSystemTime(Date.now() + 5000);
		ticks++;
	}
	expect(page).toHaveBeenCalledTimes(200);
	expect(ticks).toBeLessThan(60);
	expect(get.mock.calls.filter(([key]) => key.endsWith('/notebook.py'))).toHaveLength(200);
	get.mockClear();
	page.mockClear();
	const put = vi.spyOn(f.bucket, 'put');
	const head = vi.spyOn(f.bucket, 'head');
	const list = vi.spyOn(f.bucket, 'list');
	for (let i = 0; i < 10; i++) {
		await f.indexer().tick(signal());
		vi.setSystemTime(Date.now() + 5000);
	}
	expect(page).not.toHaveBeenCalled();
	expect(put).not.toHaveBeenCalled();
	expect(head).not.toHaveBeenCalled();
	expect(list).not.toHaveBeenCalled();
	expect(get.mock.calls.some(([key]) => key.includes('/notebooks/'))).toBe(false);
	expect(get.mock.calls.filter(([key]) => key.startsWith(searchPaths.projects))).toHaveLength(0);
});

it('wakes an idle crawler for a refresh token and after its recrawl interval', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const f = await seed(1, 1);
	await f.indexer().tick(signal());
	const page = vi.spyOn(f.source, 'page');
	await f.indexer().tick(signal());
	expect(page).not.toHaveBeenCalled();
	await f.services.catalog.mutateSnapshot('search.refresh', searchOwner.id, (snapshot) => ({
		...snapshot,
		projects: snapshot.projects.map((project) => ({ ...project, search_refresh: 'move' })),
	}));
	await f.indexer().tick(signal());
	expect(page).toHaveBeenCalledOnce();
	vi.setSystemTime(Date.now() + 5 * 60_000);
	await f.indexer().tick(signal());
	expect(page).toHaveBeenCalledTimes(2);
});

it('yields at a page boundary when a step consumes the tick budget', async () => {
	const f = await seed(2, 0);
	let elapsed = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
	const page = vi.fn(async () => {
		elapsed += 101;
		return { documents: [], partial: false };
	});
	const source = stubSearchSource({ page });
	const indexer = f.indexer(source);
	await indexer.tick(signal());
	expect(page).toHaveBeenCalledOnce();
	await indexer.tick(signal());
	expect(page).toHaveBeenCalledTimes(2);
});

it('does not rewrite an empty checkpoint during cleanup', async () => {
	const f = await seed(1, 1);
	await f.indexer().step(f.entries[0].id, f.source, signal());
	const put = vi.spyOn(f.bucket, 'put');
	await f.indexer().tick(signal());
	expect(put.mock.calls.map(([key]) => key)).toEqual([searchPaths.cursor]);
});

it.each([false, true])(
	'fences a batch of expired crawl pages (concurrent writer: %s)',
	async (conflict) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const f = await seed(1, 1);
		const indexer = f.indexer();
		await indexer.step(f.entries[0].id, f.source, signal());
		const scope = searchPaths.scope({ projectId: f.entries[0].id, source: f.source.id });
		const orphan = crypto.randomUUID();
		await f.bucket.put(scope.page(orphan), '{}');
		await f.bucket.put(scope.page(crypto.randomUUID()), '{}');
		vi.setSystemTime(Date.now() + 2 * 24 * 3600_000);
		vi.spyOn(indexer, 'step').mockResolvedValue(true);
		if (conflict) {
			const list = f.bucket.list.bind(f.bucket);
			vi.spyOn(f.bucket, 'list').mockImplementation(async (options) => {
				const result = await list(options);
				if (options?.prefix === scope.pages) {
					const checkpoint = (await f.bucket.get(scope.checkpoint))!;
					await f.bucket.put(
						scope.checkpoint,
						JSON.stringify({ ...(await checkpoint.json<object>()), pages: [orphan] }),
						{ onlyIfEtagMatches: checkpoint.etag },
					);
				}
				return result;
			});
		}
		const remove = vi.spyOn(f.bucket, 'delete');
		await indexer.tick(signal());
		if (conflict) expect(remove).not.toHaveBeenCalled();
		else {
			expect(remove).toHaveBeenCalledOnce();
			expect(remove.mock.calls[0][0]).toHaveLength(3);
		}
	},
);

it('reads notebook metadata only for the returned search page', async () => {
	const f = await seed(1, 200);
	const projectId = f.entries[0].id;
	while (!(await f.indexer().step(projectId, f.source, signal()))) {}
	const get = vi.spyOn(f.bucket, 'get');
	const head = vi.spyOn(f.bucket, 'head');
	const result = await f.search.search(
		searchOwner,
		SearchRequestSchema.parse({ project_id: projectId, q: 'revenue', limit: 5 }),
	);
	expect(result.items).toHaveLength(5);
	expect(
		get.mock.calls.filter(([key]) => key.includes('/notebooks/') && key.endsWith('/meta.json')),
	).toHaveLength(5);
	expect(get.mock.calls.filter(([key]) => key.includes('/notebooks/'))).toHaveLength(10);
	expect(head).toHaveBeenCalledTimes(15);
});

it('does not let a failing project starve later projects and retries it next round', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.spyOn(performance, 'now').mockReturnValue(0);
	const f = await seed(3, 1);
	const ordered = [...f.entries].sort((a, b) => a.id.localeCompare(b.id));
	const page = f.source.page.bind(f.source);
	let failing = true;
	vi.spyOn(f.source, 'page').mockImplementation((project, ...args) => {
		if (project.id === ordered[1].id && failing) throw new Error('source unavailable');
		return page(project, ...args);
	});
	await expect(f.indexer().tick(signal())).rejects.toThrow('source unavailable');
	expect(await f.snapshot(ordered[0].id)).not.toBeNull();
	await f.indexer().tick(signal());
	expect(await f.snapshot(ordered[2].id)).not.toBeNull();
	failing = false;
	vi.setSystemTime(Date.now() + 5 * 60_000);
	await f.indexer().tick(signal());
	expect(await f.snapshot(ordered[1].id)).not.toBeNull();
});

it('resumes an unfinished page after a failed read without going idle', async () => {
	const f = await seed(1, 0);
	let elapsed = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
	const page = vi
		.fn<ReturnType<typeof stubSearchSource>['page']>()
		.mockImplementationOnce(async () => {
			elapsed += 101;
			return { documents: [], partial: false, cursor: 'second-page' };
		})
		.mockRejectedValueOnce(new Error('read failed'))
		.mockResolvedValue({ documents: [], partial: false });
	const source = stubSearchSource({ page });
	const indexer = () => f.indexer(source);
	await indexer().tick(signal());
	await expect(indexer().tick(signal())).rejects.toThrow('read failed');
	await indexer().tick(signal());
	expect(page.mock.calls.map((call) => call[1])).toEqual([undefined, 'second-page', 'second-page']);
	expect(await f.snapshot(f.entries[0].id, source.id)).not.toBeNull();
});

it('recovers from a lost cursor write without recrawling a committed project', async () => {
	const f = await seed(1, 1);
	const put = f.bucket.put.bind(f.bucket);
	let fail = true;
	vi.spyOn(f.bucket, 'put').mockImplementation((key, ...args) => {
		if (key === searchPaths.cursor && fail) {
			fail = false;
			throw new Error('cursor unavailable');
		}
		return put(key, ...args);
	});
	const page = vi.spyOn(f.source, 'page');
	await expect(f.indexer().tick(signal())).rejects.toThrow('cursor unavailable');
	await f.indexer().tick(signal());
	expect(page).toHaveBeenCalledOnce();
	expect(await f.bucket.get(searchPaths.cursor)).not.toBeNull();
});

it('idles with an empty catalog and wakes when a project appears', async () => {
	const f = await seed(0, 0);
	await f.indexer().tick(signal());
	const put = vi.spyOn(f.bucket, 'put');
	await f.indexer().tick(signal());
	expect(put).not.toHaveBeenCalled();
	const project = await f.services.projects.createProject(
		{ name: 'New project', description: '' },
		searchOwner.id,
	);
	await f.indexer().tick(signal());
	expect(await f.snapshot(project.id)).not.toBeNull();
});

it('keeps valid page hits when other hits were deleted or access was revoked', async () => {
	const f = await seed(1, 3);
	const entry = f.entries[0];
	await f.indexer().step(entry.id, f.source, signal());
	const [deleted, denied, allowed] = entry.notebooks;
	await f.bucket.delete(paths.project(entry.id).notebook(deleted.id).meta);
	const deniedKey = paths.project(entry.id).notebook(denied.id).meta;
	const meta = await (await f.bucket.get(deniedKey))!.json<object>();
	await f.bucket.put(
		deniedKey,
		JSON.stringify({ ...meta, security_labels: { classification: 'secret', compartments: [] } }),
	);
	const get = vi.spyOn(f.bucket, 'get');
	const result = await f.search.search(
		searchOwner,
		SearchRequestSchema.parse({ project_id: entry.id, q: 'revenue', limit: 3 }),
	);
	expect(result.items.map((item) => item.resource)).toEqual([
		{ type: 'notebook', notebook_id: allowed.id },
	]);
	expect(result.partial).toBe(true);
	expect(
		get.mock.calls.filter(([key]) => key.includes('/notebooks/') && key.endsWith('/meta.json')),
	).toHaveLength(3);
});

it('preserves a competing cursor update after losing the cursor CAS', async () => {
	const f = await seed(1, 1);
	await f.bucket.put(searchPaths.cursor, JSON.stringify({ after: '' }));
	const put = f.bucket.put.bind(f.bucket);
	const winner = JSON.stringify({ after: 'another-worker' });
	vi.spyOn(f.bucket, 'put').mockImplementation(async (key, ...args) => {
		if (key === searchPaths.cursor) await put(key, winner);
		return put(key, ...args);
	});
	await f.indexer().tick(signal());
	expect(await (await f.bucket.get(searchPaths.cursor))!.text()).toBe(winner);
	expect(await f.snapshot(f.entries[0].id)).not.toBeNull();
});

it('resumes after cancellation partway through a batch without repeating completed extraction', async () => {
	const f = await seed(2, 1);
	vi.spyOn(performance, 'now').mockReturnValue(0);
	const controller = new AbortController();
	const page = f.source.page.bind(f.source);
	let calls = 0;
	const reads = vi.spyOn(f.source, 'page').mockImplementation(async (...args) => {
		if (++calls === 2) controller.abort();
		return page(...args);
	});
	await expect(f.indexer().tick(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	expect(await f.bucket.get(searchPaths.cursor)).toBeNull();
	await f.indexer().tick(signal());
	expect(reads).toHaveBeenCalledTimes(3);
	for (const project of f.entries) expect(await f.snapshot(project.id)).not.toBeNull();
});

it('keeps indexing other projects and retries failed cleanup deletion', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.spyOn(performance, 'now').mockReturnValue(0);
	const f = await seed(2, 1);
	f.entries.sort((a, b) => a.id.localeCompare(b.id));
	const scope = { projectId: f.entries[0].id, source: f.source.id };
	await f.indexer().step(scope.projectId, f.source, signal());
	const published = await f.snapshot(scope.projectId);
	const pages = searchPaths.scope(scope).pages;
	const expired = (await f.bucket.list({ prefix: pages })).objects.map((object) => object.key);
	vi.setSystemTime(Date.now() + 2 * 24 * 3600_000);
	vi.spyOn(f.bucket, 'delete').mockRejectedValueOnce(new Error('delete failed'));
	await expect(f.indexer().tick(signal())).rejects.toThrow('delete failed');
	expect(await f.snapshot(scope.projectId)).toEqual(published);
	expect(await f.snapshot(f.entries[1].id)).not.toBeNull();
	await f.indexer().tick(signal());
	for (const key of expired) expect(await f.bucket.head(key)).toBeNull();
	expect(await f.snapshot(scope.projectId)).toEqual(published);
});

it('propagates cancellation during an idle catalog check', async () => {
	const f = await seed(1, 1);
	await f.indexer().tick(signal());
	const controller = new AbortController();
	const getSnapshot = f.services.catalog.getCurrentSnapshot.bind(f.services.catalog);
	vi.spyOn(f.services.catalog, 'getCurrentSnapshot').mockImplementationOnce(async () => {
		const snapshot = await getSnapshot();
		controller.abort();
		return snapshot;
	});
	const put = vi.spyOn(f.bucket, 'put');
	await expect(f.indexer().tick(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	expect(put).not.toHaveBeenCalled();
});
