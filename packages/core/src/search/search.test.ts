import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServices } from '../services';
import { MemoryBucket } from '../testing/MemoryBucket';
import { MemorySearchIndex } from '../testing/search';
import { UserId } from '../ids';
import { paths } from '../paths';
import { AuthorizationService } from '../services/authorization/AuthorizationService';
import { NotebookSource } from './NotebookSource';
import { SearchIndexer } from './SearchIndexer';
import { SearchService } from './SearchService';
import { SearchRequestSchema } from './contracts';
import { searchPaths } from './paths';
import { MAX_SEARCH_CHECKPOINT_BYTES, MAX_SEARCH_CURSOR_LENGTH } from './limits';
import type { SearchSource, SearchDocument } from './contracts';
import type { AuthenticatedPrincipal } from '../ports/auth';

const owner: AuthenticatedPrincipal = {
	id: UserId.parse('owner'),
	email: 'owner@example.com',
	credential: { kind: 'development' },
};
const outsider: AuthenticatedPrincipal = {
	id: UserId.parse('outsider'),
	email: 'outsider@example.com',
	credential: { kind: 'development' },
};
const signal = () => new AbortController().signal;
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function setup() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(owner.id);
	const project = await services.projects.createProject(
		{ name: 'Research', description: '' },
		owner.id,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Revenue', description: 'Quarterly', code: 'net_revenue = 42' },
		owner.id,
	);
	const index = new MemorySearchIndex();
	const authz = new AuthorizationService({});
	const source = new NotebookSource(bucket, services.catalog, services.notebooks, authz);
	const indexer = new SearchIndexer(bucket, index, [source], services.catalog, services.projects);
	const search = new SearchService(index, [source], services.catalog, services.projects, authz);
	await indexer.step(project.id, source, signal());
	return {
		bucket,
		services,
		project,
		notebook,
		index,
		authz,
		source,
		indexer,
		search,
		query: SearchRequestSchema.parse({ q: 'net_revenue', project_id: project.id }),
	};
}
describe('authorized search', () => {
	it('passes the query vector to a retrieval-only backend without snapshot methods', async () => {
		const f = await setup();
		const candidates = vi.fn(f.index.candidates.bind(f.index));
		const embedding = { space: 'model-v1', vector: [1, 0] };
		const search = new SearchService(
			{ candidates },
			[f.source],
			f.services.catalog,
			f.services.projects,
			f.authz,
			{ space: embedding.space, embed: async () => [embedding.vector] },
		);
		expect((await search.search(owner, { ...f.query, mode: 'hybrid' })).items).toHaveLength(1);
		expect(candidates).toHaveBeenCalledWith(
			{ projectId: f.project.id, source: f.source.id },
			{ query: f.query.q, kinds: undefined, embedding },
			expect.any(AbortSignal),
		);
	});
	it('searches saved code without embeddings, with plain snippets and typed links', async () => {
		const f = await setup();
		const result = await f.search.search(owner, f.query);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			kind: 'code',
			resource: { type: 'notebook', notebook_id: f.notebook.id },
			snippet: { text: 'net_revenue = 42', highlights: [{ start: 0, end: 11 }] },
		});
		expect(result.items[0].href).toBe(`/projects/${f.project.id}/notebooks/${f.notebook.id}`);
		expect(result.partial).toBe(false);
		expect((await f.search.search(outsider, f.query)).items).toEqual([]);
	});
	it('checks current code ETags even when source metadata does not change', async () => {
		const f = await setup();
		await f.bucket.put(paths.project(f.project.id).notebook(f.notebook.id).code, 'profit = 9');
		expect((await f.search.search(owner, f.query)).items).toEqual([]);
		await f.indexer.step(f.project.id, f.source, signal());
		const updated = await f.search.search(owner, { ...f.query, q: 'profit' });
		expect(updated.items[0].snippet.text).toBe('profit = 9');
	});
	it('does not return deleted notebooks from a cached index', async () => {
		const f = await setup();
		await f.services.notebooks.deleteNotebook(f.project.id, f.notebook.id, owner.id);
		expect((await f.search.search(owner, f.query)).items).toEqual([]);
	});
	it('applies notebook labels before ranking', async () => {
		const f = await setup();
		const key = paths.project(f.project.id).notebook(f.notebook.id).meta;
		const meta = await (await f.bucket.get(key))!.json<Record<string, unknown>>();
		await f.bucket.put(
			key,
			JSON.stringify({ ...meta, security_labels: { classification: 'secret', compartments: [] } }),
		);
		expect((await f.search.search(owner, f.query)).items).toEqual([]);
	});
	it('rechecks revocation after another source finishes', async () => {
		const f = await setup();
		await f.services.projects.addMember(f.project.id, { user_id: outsider.id }, 'viewer', owner.id);
		const other: SearchSource = {
			revision: 1,
			id: 'other',
			kinds: ['datasource'],
			page: async () => ({ documents: [], partial: false }),
			validate: async (_p, docs) => docs,
		};
		const original = f.index.candidates.bind(f.index);
		vi.spyOn(f.index, 'candidates').mockImplementation(async (...args) => {
			if (args[0].source === 'other')
				await f.services.projects.removeMember(f.project.id, outsider.id, owner.id);
			return original(...args);
		});
		const search = new SearchService(
			f.index,
			[f.source, other],
			f.services.catalog,
			f.services.projects,
			f.authz,
		);
		expect((await search.search(outsider, f.query)).items).toEqual([]);
	});
	it('rechecks project access before ranking after index retrieval', async () => {
		const f = await setup();
		await f.services.projects.addMember(f.project.id, { user_id: outsider.id }, 'viewer', owner.id);
		const candidates = f.index.candidates.bind(f.index);
		vi.spyOn(f.index, 'candidates').mockImplementation(async (...args) => {
			const found = await candidates(...args);
			await f.services.projects.removeMember(f.project.id, outsider.id, owner.id);
			return found;
		});
		const validate = vi.spyOn(f.source, 'validate');
		expect((await f.search.search(outsider, f.query)).items).toEqual([]);
		expect(validate).not.toHaveBeenCalled();
	});
	it('drops a notebook deleted between ranking and final validation', async () => {
		const f = await setup();
		const validate = f.source.validate.bind(f.source);
		vi.spyOn(f.source, 'validate').mockImplementation(async (...args) => {
			if (args[3] === 'return')
				await f.services.notebooks.deleteNotebook(f.project.id, f.notebook.id, owner.id);
			return validate(...args);
		});
		expect((await f.search.search(owner, f.query)).items).toEqual([]);
	});

	it('never passes another user’s private chats to a provider or ranking', async () => {
		const f = await setup();
		const documents: SearchDocument[] = [owner, outsider].map((user) => ({
			id: `chat:${user.id}`,
			kind: 'chat',
			resource: { type: 'chat', owner_id: user.id, conversation_id: user.id },
			title: 'Revenue chat',
			text: 'net_revenue',
			fingerprint: '1',
		}));
		await f.index.publish(
			{ projectId: f.project.id, source: 'chats' },
			{ schema_version: 1, indexed_at: new Date().toISOString(), documents, partial: false },
			null,
		);
		const validate = vi.fn<SearchSource['validate']>(async (_p, docs) => docs);
		const source: SearchSource = {
			revision: 1,
			id: 'chats',
			kinds: ['chat'],
			page: async () => ({ documents, partial: false }),
			validate,
		};
		const search = new SearchService(
			f.index,
			[source],
			f.services.catalog,
			f.services.projects,
			f.authz,
		);
		expect((await search.search(owner, f.query)).items.map((i) => i.id)).toEqual(['chat:owner']);
		expect(
			validate.mock.calls.every((call) =>
				call[1].every((d: SearchDocument) => d.id === 'chat:owner'),
			),
		).toBe(true);
	});
	it('keeps completed sources when a provider ignores its deadline', async () => {
		const f = await setup();
		const stuck: SearchSource = {
			revision: 1,
			id: 'stuck',
			kinds: ['datasource'],
			page: async () => ({ documents: [], partial: false }),
			validate: async () => [],
		};
		const original = f.index.candidates.bind(f.index);
		vi.spyOn(f.index, 'candidates').mockImplementation((...args) =>
			args[0].source === 'stuck' ? new Promise(() => {}) : original(...args),
		);
		const search = new SearchService(
			f.index,
			[f.source, stuck],
			f.services.catalog,
			f.services.projects,
			f.authz,
			undefined,
			300,
		);
		const result = await search.search(owner, f.query);
		expect(result.items).toHaveLength(1);
		expect(result.partial).toBe(true);
		expect(result.coverage).toContainEqual({
			source: 'stuck',
			project_id: f.project.id,
			status: 'timeout',
		});
	});
	it('does not return unchecked results when final validation exceeds its deadline', async () => {
		const f = await setup();
		vi.useFakeTimers();
		const started = Promise.withResolvers<void>();
		const validate = f.source.validate.bind(f.source);
		vi.spyOn(f.source, 'validate').mockImplementation((...args) => {
			if (args[3] === 'return') {
				started.resolve();
				return new Promise(() => {});
			}
			return validate(...args);
		});
		const search = new SearchService(
			f.index,
			[f.source],
			f.services.catalog,
			f.services.projects,
			f.authz,
			undefined,
			300,
		);
		const pending = search.search(owner, f.query);
		await started.promise;
		await vi.advanceTimersByTimeAsync(150);
		const result = await pending;
		expect(result.items).toEqual([]);
		expect(result.partial).toBe(true);
		expect(result.coverage).toContainEqual({ source: 'search', status: 'timeout' });
	});
	it('propagates caller cancellation', async () => {
		const f = await setup();
		const controller = new AbortController();
		controller.abort();
		await expect(f.search.search(owner, f.query, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
	});
	it('does not read indexes or reveal coverage for an unauthorized project', async () => {
		const f = await setup();
		const candidates = vi.spyOn(f.index, 'candidates');
		expect(await f.search.search(outsider, f.query)).toEqual({
			items: [],
			partial: false,
			coverage: [],
		});
		expect(candidates).not.toHaveBeenCalled();
	});
	it('propagates cancellation during retrieval without starting resource checks', async () => {
		const f = await setup();
		const controller = new AbortController();
		const candidates = f.index.candidates.bind(f.index);
		vi.spyOn(f.index, 'candidates').mockImplementation(async (...args) => {
			const result = await candidates(...args);
			controller.abort();
			return result;
		});
		const validate = vi.spyOn(f.source, 'validate');
		await expect(f.search.search(owner, f.query, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(validate).not.toHaveBeenCalled();
	});
	it('does not return ranked snippets when final checks fail', async () => {
		const f = await setup();
		const validate = f.source.validate.bind(f.source);
		vi.spyOn(f.source, 'validate').mockImplementation((...args) => {
			if (args[3] === 'return') throw new Error('credential=private-value');
			return validate(...args);
		});
		const result = await f.search.search(owner, f.query);
		expect(result.items).toEqual([]);
		expect(result.partial).toBe(true);
		expect(result.coverage).toContainEqual({
			source: 'notebooks',
			project_id: f.project.id,
			status: 'unavailable',
		});
		expect(JSON.stringify(result)).not.toContain('private-value');
	});
	it('drops results when project access is revoked during final resource checks', async () => {
		const f = await setup();
		await f.services.projects.addMember(f.project.id, { user_id: outsider.id }, 'viewer', owner.id);
		const validate = f.source.validate.bind(f.source);
		vi.spyOn(f.source, 'validate').mockImplementation(async (...args) => {
			const docs = await validate(...args);
			if (args[3] === 'return')
				await f.services.projects.removeMember(f.project.id, outsider.id, owner.id);
			return docs;
		});
		expect((await f.search.search(outsider, f.query)).items).toEqual([]);
	});
	it('keeps keyword results when query embeddings fail', async () => {
		const f = await setup();
		const embed = vi.fn().mockRejectedValue(new Error('private provider details'));
		const search = new SearchService(
			f.index,
			[f.source],
			f.services.catalog,
			f.services.projects,
			f.authz,
			{ space: 'test', embed },
		);
		const result = await search.search(owner, { ...f.query, mode: 'hybrid' });
		expect(result.items).toHaveLength(1);
		expect(result.partial).toBe(true);
		expect(result.coverage).toContainEqual({ source: 'semantic', status: 'unavailable' });
		expect(JSON.stringify(result)).not.toContain('private provider details');
	});
	it('distinguishes a missing index from an old but still valid snapshot', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const loaded = await f.index.read(scope);
		await f.index.publish(
			scope,
			{ ...loaded.snapshot!, indexed_at: '2000-01-01T00:00:00.000Z' },
			loaded.revision,
		);
		const stale = await f.search.search(owner, f.query);
		expect(stale.items).toHaveLength(1);
		expect(stale.partial).toBe(true);
		expect(stale.coverage).toContainEqual({
			source: f.source.id,
			project_id: f.project.id,
			status: 'stale',
		});
		await f.index.publish(scope, null, (await f.index.read(scope)).revision);
		const missing = await f.search.search(owner, f.query);
		expect(missing.items).toEqual([]);
		expect(missing.partial).toBe(true);
		expect(missing.coverage).toContainEqual({
			source: f.source.id,
			project_id: f.project.id,
			status: 'not_indexed',
		});
	});
	it('reports absent sources and optional semantics explicitly', async () => {
		const f = await setup();
		const result = await f.search.search(owner, { ...f.query, kinds: ['chat'], mode: 'hybrid' });
		expect(result.partial).toBe(true);
		expect(result.items).toEqual([]);
		expect(result.coverage).toEqual([
			{ source: 'semantic', status: 'disabled' },
			{ source: 'chat', status: 'disabled' },
		]);
	});
});

describe('resumable search indexing', () => {
	it.each(['documents', 'cursor'] as const)(
		'publishes partial coverage when a source exceeds its %s budget',
		async (budget) => {
			const f = await setup();
			const scope = { projectId: f.project.id, source: f.source.id };
			const old = await f.index.read(scope);
			const count = budget === 'documents' ? 201 : 1;
			const source: SearchSource = f.source;
			vi.spyOn(source, 'page').mockResolvedValue({
				documents: Array.from({ length: count }, (_, i) => ({
					...old.snapshot!.documents[0],
					id: `doc${i}`,
				})),
				cursor: budget === 'cursor' ? 'x'.repeat(64 * 1024 + 1) : 'more',
				partial: false,
			});
			expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(true);
			const result = (await f.index.read(scope)).snapshot!;
			expect(result.partial).toBe(true);
			expect(result.documents).toHaveLength(Math.min(count, 200));
		},
	);
	it.each(['界', '\u0000'])(
		'bounds serialized checkpoint bytes for %j cursors',
		async (character) => {
			const f = await setup();
			const scope = { projectId: f.project.id, source: f.source.id };
			const old = await f.index.read(scope);
			const source: SearchSource = f.source;
			const page = vi.spyOn(source, 'page').mockResolvedValue({
				documents: old.snapshot!.documents,
				cursor: character.repeat(MAX_SEARCH_CURSOR_LENGTH),
				partial: false,
			});
			const put = vi.spyOn(f.bucket, 'put');
			expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(true);
			expect((await f.index.read(scope)).snapshot).toMatchObject({
				partial: true,
				documents: old.snapshot!.documents,
			});
			for (const [, body] of put.mock.calls.filter(
				([key]) => key === searchPaths.scope(scope).checkpoint,
			))
				expect(
					typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength,
				).toBeLessThanOrEqual(MAX_SEARCH_CHECKPOINT_BYTES);
			page.mockResolvedValue({ documents: old.snapshot!.documents, partial: false });
			expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(true);
			expect(page.mock.lastCall?.[1]).toBeUndefined();
			expect((await f.index.read(scope)).snapshot?.partial).toBe(false);
		},
	);
	it.each([false, true])(
		'restarts oversized stored checkpoints with CAS (conflict: %s)',
		async (conflict) => {
			const f = await setup();
			const scope = { projectId: f.project.id, source: f.source.id };
			const key = searchPaths.scope(scope).checkpoint;
			const old = await f.index.read(scope);
			const checkpoint = await (await f.bucket.get(key))!.text();
			await f.bucket.put(key, 'invalid json'.repeat(MAX_SEARCH_CHECKPOINT_BYTES));
			const page = vi.spyOn(f.source, 'page').mockImplementation(async () => {
				if (conflict) await f.bucket.put(key, checkpoint);
				return { documents: old.snapshot!.documents, partial: false, cursor: undefined };
			});
			expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(!conflict);
			expect(page.mock.lastCall?.[1]).toBeUndefined();
			expect((await f.bucket.get(key))!.size).toBeLessThanOrEqual(MAX_SEARCH_CHECKPOINT_BYTES);
			if (conflict) {
				expect(await f.index.read(scope)).toEqual(old);
				expect(await (await f.bucket.get(key))!.text()).toBe(checkpoint);
			} else {
				expect((await f.index.read(scope)).revision).not.toBe(old.revision);
				expect((await f.index.read(scope)).snapshot?.documents).toEqual(old.snapshot!.documents);
			}
		},
	);
	it('maintenance skips oversized cleanup state and restarts the crawl', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const key = searchPaths.scope(scope).checkpoint;
		const old = await f.index.read(scope);
		await f.bucket.put(key, 'x'.repeat(MAX_SEARCH_CHECKPOINT_BYTES + 1));
		const page = vi.spyOn(f.source, 'page');
		await f.indexer.tick(signal());
		expect(page.mock.calls[0][1]).toBeUndefined();
		expect((await f.bucket.get(key))!.size).toBeLessThanOrEqual(MAX_SEARCH_CHECKPOINT_BYTES);
		expect((await f.index.read(scope)).snapshot?.documents).toEqual(old.snapshot!.documents);
	});
	it('publishes a tombstone when the project is deleted during discovery', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const old = await f.index.read(scope);
		vi.spyOn(f.source, 'page').mockImplementation(async () => {
			await f.services.projects.deleteProject(f.project.id, owner.id);
			return { documents: old.snapshot!.documents, partial: false, cursor: undefined };
		});
		await f.indexer.step(f.project.id, f.source, signal());
		const result = await f.index.read(scope);
		expect(result.snapshot).toBeNull();
		expect(result.revision).not.toBe(old.revision);
		expect(await f.index.publish(scope, old.snapshot, old.revision)).toBe(false);
	});
	it('keeps the published snapshot through a failed page and resumes its cursor', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const old = await f.index.read(scope);
		const doc = { ...old.snapshot!.documents[0], id: 'replacement', text: 'first' };
		const page = vi
			.spyOn(f.source, 'page')
			.mockResolvedValueOnce({ documents: [doc], partial: false, cursor: f.notebook.id })
			.mockRejectedValueOnce(new Error('source offline'))
			.mockResolvedValueOnce({
				documents: [{ ...doc, text: 'latest' }],
				partial: false,
				cursor: undefined,
			});
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(false);
		expect(await f.index.read(scope)).toEqual(old);
		await expect(f.indexer.step(f.project.id, f.source, signal())).rejects.toThrow(
			'source offline',
		);
		expect(await f.index.read(scope)).toEqual(old);
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(true);
		expect(page.mock.calls.map((call) => call[1])).toEqual([
			undefined,
			f.notebook.id,
			f.notebook.id,
		]);
		expect((await f.index.read(scope)).snapshot?.documents).toEqual([{ ...doc, text: 'latest' }]);
	});
	it('does not publish an incomplete corpus when a checkpoint page is missing', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const old = await f.index.read(scope);
		vi.spyOn(f.source, 'page')
			.mockResolvedValueOnce({ documents: [], partial: false, cursor: f.notebook.id })
			.mockResolvedValueOnce({ documents: [], partial: false, cursor: undefined });
		await f.indexer.step(f.project.id, f.source, signal());
		const pages = await f.bucket.list({
			prefix: `_system/search/projects/${f.project.id}/${f.source.id}/pages/`,
		});
		await f.bucket.delete(pages.objects.map((p) => p.key));
		await expect(f.indexer.step(f.project.id, f.source, signal())).rejects.toThrow(
			'crawl page unavailable',
		);
		expect(await f.index.read(scope)).toEqual(old);
	});
	it('does not checkpoint or publish a page after caller cancellation', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const old = await f.index.read(scope);
		const key = `_system/search/projects/${f.project.id}/${f.source.id}/crawl.json`;
		const checkpoint = await f.bucket.get(key);
		const controller = new AbortController();
		vi.spyOn(f.source, 'page').mockImplementation(async () => {
			controller.abort();
			return { documents: [], partial: false, cursor: undefined };
		});
		await expect(f.indexer.step(f.project.id, f.source, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect((await f.bucket.get(key))?.etag).toBe(checkpoint?.etag);
		expect(await f.index.read(scope)).toEqual(old);
	});
	it('abandons an old crawl after another writer advances the index head', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const old = await f.index.read(scope);
		const page = vi
			.spyOn(f.source, 'page')
			.mockResolvedValueOnce({ documents: [], partial: false, cursor: f.notebook.id })
			.mockResolvedValueOnce({
				documents: old.snapshot!.documents,
				partial: false,
				cursor: undefined,
			});
		await f.indexer.step(f.project.id, f.source, signal());
		await f.index.publish(scope, old.snapshot, old.revision);
		await f.indexer.step(f.project.id, f.source, signal());
		expect(page.mock.calls.map((call) => call[1])).toEqual([undefined, undefined]);
		expect((await f.index.read(scope)).snapshot?.documents).toEqual(old.snapshot!.documents);
	});
	it('skips invalid extracted documents without poisoning the crawl checkpoint', async () => {
		const f = await setup();
		const document: SearchDocument = {
			id: 'valid',
			kind: 'code',
			resource: { type: 'notebook', notebook_id: f.notebook.id },
			title: 'Revenue',
			text: 'revenue',
			fingerprint: '1',
		};
		const source: SearchSource = {
			revision: 1,
			id: 'custom',
			kinds: ['code'],
			page: async () => ({
				documents: [{ ...document, id: 'invalid', text: 'x'.repeat(8193) }, document],
				partial: false,
			}),
			validate: async (_p, docs) => docs,
		};
		const indexer = new SearchIndexer(
			f.bucket,
			f.index,
			[source],
			f.services.catalog,
			f.services.projects,
		);
		expect(await indexer.step(f.project.id, source, signal())).toBe(true);
		expect(
			(await f.index.read({ projectId: f.project.id, source: source.id })).snapshot,
		).toMatchObject({ partial: true, documents: [document] });
	});

	it('resumes a completed crawl after a failed publication without repeating its page', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: 'pages' };
		const page = vi.fn(async () => ({ documents: [], partial: false }));
		const source: SearchSource = {
			revision: 1,
			id: 'pages',
			kinds: ['notebook'],
			page,
			validate: async (_p, docs) => docs,
		};
		const indexer = new SearchIndexer(
			f.bucket,
			f.index,
			[source],
			f.services.catalog,
			f.services.projects,
		);
		vi.spyOn(f.index, 'publish').mockRejectedValueOnce(new Error('offline'));
		await expect(indexer.step(f.project.id, source, signal())).rejects.toThrow('offline');
		await indexer.step(f.project.id, source, signal());
		expect(page).toHaveBeenCalledTimes(1);
		expect((await f.index.read(scope)).snapshot).not.toBeNull();
	});
	it('fences late publication after deletion with a retained tombstone', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: 'notebooks' };
		const old = await f.index.read(scope);
		await f.services.projects.deleteProject(f.project.id, owner.id);
		await f.indexer.step(f.project.id, f.source, signal());
		const deleted = await f.index.read(scope);
		expect(deleted.snapshot).toBeNull();
		expect(deleted.revision).not.toBeNull();
		expect(await f.index.publish(scope, old.snapshot, old.revision)).toBe(false);
	});
	it('reuses unchanged embeddings and publishes keyword content on provider failure', async () => {
		const f = await setup();
		const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
		const indexer = new SearchIndexer(
			f.bucket,
			f.index,
			[f.source],
			f.services.catalog,
			f.services.projects,
			{ space: 'test', embed },
			2,
		);
		await indexer.step(f.project.id, f.source, signal());
		expect(embed).toHaveBeenCalledTimes(1);
		await indexer.step(f.project.id, f.source, signal());
		expect(embed).toHaveBeenCalledTimes(1);
		await f.bucket.put(paths.project(f.project.id).notebook(f.notebook.id).code, 'profit = 10');
		embed.mockRejectedValueOnce(new Error('offline'));
		await indexer.step(f.project.id, f.source, signal());
		const result = await f.search.search(owner, { ...f.query, q: 'profit' });
		expect(result.items).toHaveLength(1);
		expect(result.partial).toBe(true);
	});
});
