import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createSearchFixture as setup,
	searchOutsider as outsider,
	searchOwner as owner,
	stubSearchSource,
} from '../testing/search';
import { paths } from '../paths';
import { SearchIndexer } from './SearchIndexer';
import { SearchService } from './SearchService';
import { SearchCheckpointSchema, terms } from './contracts';
import { searchPaths } from './paths';
import {
	MAX_SEARCH_CHECKPOINT_BYTES,
	MAX_SEARCH_CURSOR_LENGTH,
	MAX_SEARCH_PROJECT_SCAN,
	MIN_RECRAWL_INTERVAL_MS,
} from './limits';
import type { SearchSource, SearchDocument } from './contracts';

const signal = () => new AbortController().signal;
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
describe('authorized search', () => {
	it('refreshes both projects after a move without waiting for the recrawl interval', async () => {
		const f = await setup();
		const destination = await f.services.projects.createProject(
			{ name: 'Destination', description: '' },
			owner.id,
		);
		const indexer = new SearchIndexer(
			f.bucket,
			f.index,
			[f.source],
			f.services.catalog,
			f.services.projects,
		);
		await indexer.step(destination.id, f.source, signal());
		await f.services.moves.move({
			source: f.project.id,
			destination: destination.id,
			notebookId: f.notebook.id,
			actor: owner.id,
			idempotencyKey: 'search-move',
			authorize: async () => {},
		});
		expect((await f.search.search(owner, f.query)).items).toHaveLength(0);
		await indexer.step(f.project.id, f.source, signal());
		await indexer.step(destination.id, f.source, signal());
		expect(
			(await f.search.search(owner, { ...f.query, project_id: destination.id })).items,
		).toHaveLength(1);
		expect(
			(await f.index.read({ projectId: f.project.id, source: f.source.id })).snapshot?.documents,
		).toHaveLength(0);
	});

	it.each(['राजस्व', 'รายได้', 'café'])('keeps combining marks in the token %s', (text) => {
		expect(terms(`${text} ${text}`)).toEqual([text.normalize('NFC')]);
	});
	it('reports a failed project read without leaking its identity or dropping other projects', async () => {
		const f = await setup();
		const unavailable = await f.services.projects.createProject(
			{ name: 'Unavailable', description: '' },
			owner.id,
		);
		const getProject = f.services.projects.getProject.bind(f.services.projects);
		vi.spyOn(f.services.projects, 'getProject').mockImplementation((id, options) => {
			if (id === unavailable.id) return Promise.reject(new Error('private storage details'));
			return getProject(id, options);
		});
		const result = await f.search.search(owner, { ...f.query, project_id: undefined });
		expect(result.items).toHaveLength(1);
		expect(result.partial).toBe(true);
		expect(result.coverage).toContainEqual({ source: 'search', status: 'unavailable' });
		expect(JSON.stringify(result)).not.toContain(unavailable.id);
		expect(JSON.stringify(result)).not.toContain('private storage details');
	});
	it.each(['rank', 'return'])(
		'preserves verified results when %s validation is partial',
		async (phase) => {
			const f = await setup();
			const validate = f.source.validate.bind(f.source);
			vi.spyOn(f.source, 'validate').mockImplementation(async (...args) => ({
				...(await validate(...args)),
				partial: args[3] === phase,
			}));
			const result = await f.search.search(owner, f.query);
			expect(result.items).toHaveLength(1);
			expect(result.partial).toBe(true);
			expect(result.coverage).toEqual([
				{ source: f.source.id, project_id: f.project.id, status: 'partial' },
			]);
		},
	);
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
		const other = stubSearchSource({ id: 'other' });
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
		const result = await search.search(outsider, f.query);
		expect(result.items).toEqual([]);
		expect(result.partial).toBe(true);
		expect(result.coverage).toContainEqual({
			source: f.source.id,
			project_id: f.project.id,
			status: 'partial',
		});
	});
	it('rechecks project access after final validation when revoked during retrieval', async () => {
		const f = await setup();
		await f.services.projects.addMember(f.project.id, { user_id: outsider.id }, 'viewer', owner.id);
		const candidates = f.index.candidates.bind(f.index);
		vi.spyOn(f.index, 'candidates').mockImplementation(async (...args) => {
			const found = await candidates(...args);
			await f.services.projects.removeMember(f.project.id, outsider.id, owner.id);
			return found;
		});
		const result = await f.search.search(outsider, f.query);
		expect(result.items).toEqual([]);
		expect(result.coverage).toEqual([
			{ source: f.source.id, project_id: f.project.id, status: 'partial' },
		]);
	});
	it('checks project access once before retrieval and once after final validation', async () => {
		const f = await setup();
		const authorize = vi.spyOn(f.authz, 'authorize');
		expect((await f.search.search(owner, f.query)).items).toHaveLength(1);
		const projectChecks = authorize.mock.calls.filter(
			([, action, resource]) => action === 'project.read' && !('notebookLabels' in resource),
		);
		expect(projectChecks).toHaveLength(2);
	});
	it('drops hits when project labels change between ranking and final validation', async () => {
		const f = await setup();
		const validate = vi.spyOn(f.source, 'validate');
		const original = f.index.candidates.bind(f.index);
		vi.spyOn(f.index, 'candidates').mockImplementation(async (...args) => {
			const found = await original(...args);
			await f.services.projects.setSecurityLabels(
				f.project.id,
				{ classification: 'secret', compartments: [] },
				owner.id,
			);
			return found;
		});
		const result = await f.search.search(owner, f.query);
		expect(result.items).toEqual([]);
		expect(result.coverage).toEqual([
			{ source: f.source.id, project_id: f.project.id, status: 'partial' },
		]);
		expect(validate.mock.calls.map((call) => call[3])).toEqual(['rank']);
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

	it('keeps completed sources when a provider ignores its deadline', async () => {
		const f = await setup();
		const stuck = stubSearchSource({ id: 'stuck' });
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
		expect(result.coverage).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain('private-value');
	});
	it('validates final resources against the freshly read project', async () => {
		const f = await setup();
		const validate = f.source.validate.bind(f.source);
		const spy = vi.spyOn(f.source, 'validate').mockImplementation(async (...args) => {
			const docs = await validate(...args);
			if (args[3] === 'rank')
				await f.services.projects.updateProject(f.project.id, { name: 'Renamed' }, owner.id);
			return docs;
		});
		const result = await f.search.search(owner, f.query);
		expect(spy.mock.calls.find((call) => call[3] === 'return')?.[0].name).toBe('Renamed');
		expect(result.items.map((item) => item.project_name)).toEqual(['Renamed']);
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
		expect(stale.partial).toBe(false);
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
		const result = await f.search.search(owner, {
			...f.query,
			kinds: ['datasource'],
			mode: 'hybrid',
		});
		expect(result.partial).toBe(true);
		expect(result.items).toEqual([]);
		expect(result.coverage).toEqual([
			{ source: 'semantic', status: 'disabled' },
			{ source: 'datasource', status: 'disabled' },
		]);
	});
	it('searches the first sixteen accessible projects and reports truncation', async () => {
		const f = await setup();
		for (let i = 0; i < 16; i++)
			await f.services.projects.createProject({ name: `Hidden ${i}`, description: '' }, owner.id);
		const visible: string[] = [];
		for (let i = 0; i < 17; i++) {
			const project = await f.services.projects.createProject(
				{ name: `Shared ${i}`, description: '' },
				owner.id,
			);
			await f.services.notebooks.createNotebook(
				project.id,
				{ title: 'Revenue', description: '', code: 'net_revenue = 1' },
				owner.id,
			);
			await f.services.projects.addMember(project.id, { user_id: outsider.id }, 'viewer', owner.id);
			await f.indexer.step(project.id, f.source, signal());
			visible.push(project.id);
		}
		const order = (await f.services.catalog.getCurrentSnapshot()).projects.map((p) => p.id);
		const expected = order.filter((id) => visible.includes(id)).slice(0, 16);
		const result = await f.search.search(outsider, { ...f.query, project_id: undefined });
		expect(result.items.map((item) => item.project_id).toSorted()).toEqual(expected.toSorted());
		expect(result.partial).toBe(true);
		expect(result.coverage).toContainEqual({ source: 'projects', status: 'truncated' });
	});
	it('caps the cross-project scan and reports truncation', async () => {
		const f = await setup();
		for (let i = 1; i < 200; i++)
			await f.services.projects.createProject({ name: `Hidden ${i}`, description: '' }, owner.id);
		const getProject = vi.spyOn(f.services.projects, 'getProject');
		const result = await f.search.search(outsider, { ...f.query, project_id: undefined });
		const reads = getProject.mock.calls.filter(
			([, options]) => options?.consistency === 'validated',
		);
		expect(reads.length).toBeLessThanOrEqual(MAX_SEARCH_PROJECT_SCAN);
		expect(result.items).toEqual([]);
		expect(result.partial).toBe(true);
		expect(result.coverage).toEqual([{ source: 'projects', status: 'truncated' }]);
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
	it.each(['before starting', 'during cleanup listing'])(
		'does not advance maintenance after cancellation %s',
		async (when) => {
			const f = await setup();
			const cursor = await f.bucket.put(searchPaths.cursor, JSON.stringify({ after: '' }));
			const controller = new AbortController();
			const list = f.bucket.list.bind(f.bucket);
			vi.spyOn(f.bucket, 'list').mockImplementationOnce(async (options) => {
				const result = await list(options);
				controller.abort();
				return result;
			});
			const get = vi.spyOn(f.bucket, 'get');
			const put = vi.spyOn(f.bucket, 'put');
			const page = vi.spyOn(f.source, 'page');
			if (when === 'before starting') controller.abort();
			await expect(f.indexer.tick(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
			if (when === 'before starting') expect(get).not.toHaveBeenCalled();
			expect(put).not.toHaveBeenCalled();
			expect(page).not.toHaveBeenCalled();
			expect((await f.bucket.get(searchPaths.cursor))!.etag).toBe(cursor.etag);
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
	it('restarts a crawl with missing pages while retaining the published snapshot', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const old = await f.index.read(scope);
		const page = vi
			.spyOn(f.source, 'page')
			.mockResolvedValueOnce({ documents: [], partial: false, cursor: f.notebook.id })
			.mockResolvedValueOnce({ documents: [], partial: false, cursor: undefined });
		await f.indexer.step(f.project.id, f.source, signal());
		const pages = await f.bucket.list({ prefix: searchPaths.scope(scope).pages });
		await f.bucket.delete(pages.objects.map((p) => p.key));
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(false);
		expect(await f.index.read(scope)).toEqual(old);
		const checkpoint = SearchCheckpointSchema.parse(
			await (await f.bucket.get(searchPaths.scope(scope).checkpoint))!.json(),
		);
		expect(checkpoint).toMatchObject({ pages: [], ready: false });
		expect(checkpoint.cursor).toBeUndefined();
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(true);
		expect(page.mock.calls.map((call) => call[1])).toEqual([undefined, f.notebook.id, undefined]);
		expect((await f.index.read(scope)).snapshot?.documents).toEqual(old.snapshot!.documents);
	});
	it('does not overwrite a newer checkpoint when resetting a missing page', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const key = searchPaths.scope(scope).checkpoint;
		vi.spyOn(f.source, 'page').mockResolvedValue({
			documents: [],
			partial: false,
			cursor: undefined,
		});
		const get = f.bucket.get.bind(f.bucket);
		let replacement: unknown;
		vi.spyOn(f.bucket, 'get').mockImplementation(async (path) => {
			if (path.startsWith(searchPaths.scope(scope).pages)) {
				const checkpoint = SearchCheckpointSchema.parse(await (await get(key))!.json());
				replacement = {
					...checkpoint,
					generation: crypto.randomUUID(),
					cursor: 'newer',
					ready: false,
				};
				await f.bucket.put(key, JSON.stringify(replacement));
				return null;
			}
			return get(path);
		});
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(false);
		expect(await (await get(key))!.json()).toEqual(replacement);
	});
	it('does not read or reset a checkpoint after losing the publication CAS', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const key = searchPaths.scope(scope).checkpoint;
		const head = vi.spyOn(f.index, 'head');
		let checkpointEtag: string | undefined;
		const lose = async () => {
			checkpointEtag = (await f.bucket.get(key))!.etag;
			head.mockClear();
			return false;
		};
		vi.spyOn(f.index, 'publish').mockImplementation(lose);
		vi.spyOn(f.index, 'touch').mockImplementation(lose);
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(false);
		expect(head).not.toHaveBeenCalled();
		expect(checkpointEtag).toBeDefined();
		expect((await f.bucket.get(key))!.etag).toBe(checkpointEtag);
	});
	it('does not checkpoint or publish a page after caller cancellation', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const old = await f.index.read(scope);
		const key = searchPaths.scope(scope).checkpoint;
		const checkpoint = await f.bucket.get(key);
		const controller = new AbortController();
		vi.spyOn(f.source, 'page').mockImplementation(async () => {
			controller.abort();
			return { documents: [], partial: false, cursor: undefined };
		});
		await expect(f.indexer.step(f.project.id, f.source, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(checkpoint).not.toBeNull();
		expect((await f.bucket.get(key))!.etag).toBe(checkpoint!.etag);
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
		const source = stubSearchSource({
			kinds: ['code'],
			page: async () => ({
				documents: [{ ...document, id: 'invalid', text: 'x'.repeat(8193) }, document],
				partial: false,
			}),
		});
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
		const source = stubSearchSource({ id: 'pages', kinds: ['notebook'], page });
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
			0,
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
	it('re-claims and re-crawls when the embedding space changes at equal revisions', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const indexer = (space: string) =>
			new SearchIndexer(f.bucket, f.index, [f.source], f.services.catalog, f.services.projects, {
				space,
				embed: async (texts: string[]) => texts.map(() => [1, 0]),
			});
		for (const space of ['model-a', 'model-b']) {
			const page = vi.spyOn(f.source, 'page');
			expect(await indexer(space).step(f.project.id, f.source, signal())).toBe(true);
			expect(page.mock.calls[0][1]).toBeUndefined();
			expect(
				(await f.index.read(scope)).snapshot?.documents.every((d) => d.embedding?.space === space),
			).toBe(true);
			expect((await f.index.head(scope)).build?.configuration).toContain(`"embedding":"${space}"`);
			page.mockRestore();
		}
	});
	it.each(['publication', 'verification'])(
		'waits the minimum interval after a %s before re-crawling',
		async (event) => {
			const f = await setup();
			const scope = { projectId: f.project.id, source: f.source.id };
			const start = Date.now() + 60_000;
			vi.useFakeTimers({ now: start, toFake: ['Date'] });
			if (event === 'publication')
				await f.bucket.put(paths.project(f.project.id).notebook(f.notebook.id).code, 'profit = 9');
			const publish = vi.spyOn(f.index, 'publish');
			await f.indexer.step(f.project.id, f.source, signal());
			expect(publish).toHaveBeenCalledTimes(event === 'publication' ? 1 : 0);
			expect((await f.index.head(scope)).verifiedAt).toBe(new Date(start).toISOString());
			const indexer = new SearchIndexer(
				f.bucket,
				f.index,
				[f.source],
				f.services.catalog,
				f.services.projects,
			);
			const put = vi.spyOn(f.bucket, 'put');
			const page = vi.spyOn(f.source, 'page');
			vi.setSystemTime(start + MIN_RECRAWL_INTERVAL_MS - 1);
			expect(await indexer.step(f.project.id, f.source, signal())).toBe(true);
			expect(put).not.toHaveBeenCalled();
			expect(page).not.toHaveBeenCalled();
			vi.setSystemTime(start + MIN_RECRAWL_INTERVAL_MS);
			expect(await indexer.step(f.project.id, f.source, signal())).toBe(true);
			expect(page).toHaveBeenCalledOnce();
			expect(put.mock.calls.some(([key]) => key.startsWith(searchPaths.scope(scope).pages))).toBe(
				true,
			);
		},
	);
	it('verifies an unchanged corpus without republishing its snapshot', async () => {
		const f = await setup();
		const scope = { projectId: f.project.id, source: f.source.id };
		const before = await f.index.read(scope);
		const publish = vi.spyOn(f.index, 'publish');
		const touch = vi.spyOn(f.index, 'touch');
		const later = new Date(Date.now() + 20 * 60_000);
		vi.useFakeTimers({ now: later, toFake: ['Date'] });
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(true);
		expect(publish).not.toHaveBeenCalled();
		expect(touch).toHaveBeenCalledOnce();
		expect((await f.index.read(scope)).snapshot).toBe(before.snapshot);
		const result = await f.search.search(owner, f.query);
		expect(result.items[0].indexed_at).toBe(later.toISOString());
		expect(result.coverage).toEqual([
			{ source: f.source.id, project_id: f.project.id, status: 'complete' },
		]);
		await f.bucket.put(paths.project(f.project.id).notebook(f.notebook.id).code, 'profit = 9');
		expect(await f.indexer.step(f.project.id, f.source, signal())).toBe(true);
		expect(publish).toHaveBeenCalledOnce();
		expect((await f.index.read(scope)).snapshot?.documents.map((d) => d.text)).toContain(
			'profit = 9',
		);
	});
});
