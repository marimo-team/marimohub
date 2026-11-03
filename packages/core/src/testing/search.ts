import { describe, expect, it } from 'vitest';
import type {
	SearchRetriever,
	SearchSnapshotStore,
	SearchScope,
	SearchSnapshot,
	SearchCandidatesRequest,
	SearchBuild,
	SearchSource,
} from '../search/contracts';
import { canClaimSearchBuild, sameSearchBuild, searchSnapshotDigest } from '../search/build';
import {
	terms,
	SearchSnapshotSchema,
	SearchBuildSchema,
	SearchRequestSchema,
	MAX_INDEX_BYTES,
} from '../search/contracts';
import { selectSearchCandidates } from '../search/embeddings';
import { MAX_SEARCH_CANDIDATES } from '../search/limits';
import { NotebookSource } from '../search/NotebookSource';
import { SearchIndexer } from '../search/SearchIndexer';
import { SearchService } from '../search/SearchService';
import { createServices } from '../services';
import { AuthorizationService } from '../services/authorization/AuthorizationService';
import { MemoryBucket } from './MemoryBucket';
import { createNotebookId, createProjectId, UserId } from '../ids';
import type { AuthenticatedPrincipal } from '../ports/auth';

interface MemorySearchRecord {
	revision: string;
	snapshot: SearchSnapshot | null;
	build?: SearchBuild;
	deleted: boolean;
	digest?: string;
	verifiedAt?: string;
}

export class MemorySearchIndex implements SearchRetriever, SearchSnapshotStore {
	private readonly records = new Map<string, MemorySearchRecord>();
	private generation = 0;
	async head(scope: SearchScope) {
		const { revision, build, deleted, digest, verifiedAt } = this.records.get(
			`${scope.projectId}/${scope.source}`,
		) ?? { revision: null, deleted: false };
		return { revision, build, deleted, digest, verifiedAt };
	}
	async claim(scope: SearchScope, input: SearchBuild) {
		const build = SearchBuildSchema.parse(input);
		const key = `${scope.projectId}/${scope.source}`;
		const current = this.records.get(key);
		if (current?.deleted || !canClaimSearchBuild(current?.build, build)) return null;
		if (!current || !sameSearchBuild(current.build, build))
			this.records.set(key, {
				...current,
				revision: String(++this.generation),
				snapshot: current?.snapshot ?? null,
				build,
				deleted: false,
				verifiedAt: undefined,
			});
		return this.head(scope);
	}
	async read(scope: SearchScope) {
		const { revision, snapshot } = this.records.get(`${scope.projectId}/${scope.source}`) ?? {
			revision: null,
			snapshot: null,
		};
		return { revision, snapshot };
	}
	async publish(scope: SearchScope, input: SearchSnapshot | null, revision: string | null) {
		const key = `${scope.projectId}/${scope.source}`;
		const snapshot = input ? SearchSnapshotSchema.parse(input) : null;
		if (snapshot && new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_INDEX_BYTES)
			throw new Error('Search snapshot exceeds budget');
		const digest = snapshot ? await searchSnapshotDigest(snapshot) : undefined;
		const current = this.records.get(key);
		if ((current?.revision ?? null) !== revision || (snapshot && current?.deleted)) return false;
		this.records.set(key, {
			revision: String(++this.generation),
			snapshot,
			build: current?.build,
			deleted: snapshot === null,
			digest,
			verifiedAt: snapshot?.indexed_at,
		});
		return true;
	}
	async touch(scope: SearchScope, revision: string) {
		const key = `${scope.projectId}/${scope.source}`;
		const current = this.records.get(key);
		if (current?.revision !== revision || !current.snapshot) return false;
		this.records.set(key, {
			...current,
			revision: String(++this.generation),
			verifiedAt: new Date().toISOString(),
		});
		return true;
	}
	async candidates(scope: SearchScope, request: SearchCandidatesRequest) {
		const record = this.records.get(`${scope.projectId}/${scope.source}`);
		const documents = record?.snapshot?.documents ?? [];
		const wanted = terms(request.query);
		const keyword = documents
			.map((document) => ({
				document,
				count: terms(`${document.title} ${document.text}`).filter((t) => wanted.includes(t)).length,
			}))
			.filter(({ count }) => count > 0)
			.sort((a, b) => b.count - a.count)
			.map(({ document }) => document);
		const selected = selectSearchCandidates(keyword, documents, request);
		return {
			documents: selected.documents,
			indexedAt: record?.snapshot?.indexed_at,
			verifiedAt: record?.verifiedAt,
			partial: !record?.snapshot || record.snapshot.partial || selected.partial,
		};
	}
}

export const searchOwner: AuthenticatedPrincipal = {
	id: UserId.parse('owner'),
	email: 'owner@example.com',
	credential: { kind: 'development' },
};
export const searchOutsider: AuthenticatedPrincipal = {
	id: UserId.parse('outsider'),
	email: 'outsider@example.com',
	credential: { kind: 'development' },
};

/** One indexed project with a single notebook containing `net_revenue = 42`. */
export async function createSearchFixture() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(searchOwner.id);
	const project = await services.projects.createProject(
		{ name: 'Research', description: '' },
		searchOwner.id,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Revenue', description: 'Quarterly', code: 'net_revenue = 42' },
		searchOwner.id,
	);
	const index = new MemorySearchIndex();
	const authz = new AuthorizationService({});
	const source = new NotebookSource(bucket, services.catalog, services.notebooks, authz);
	// Without a re-crawl interval, each `step` crawls so tests can drive crawl mechanics directly.
	const indexer = new SearchIndexer(
		bucket,
		index,
		[source],
		services.catalog,
		services.projects,
		undefined,
		0,
	);
	const search = new SearchService(index, [source], services.catalog, services.projects, authz);
	await indexer.step(project.id, source, new AbortController().signal);
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

export function stubSearchSource(overrides: Partial<SearchSource> = {}): SearchSource {
	return {
		revision: 1,
		id: 'stub',
		kinds: ['datasource'],
		page: async () => ({ documents: [], partial: false }),
		validate: async (_project, documents) => ({ documents, partial: false }),
		...overrides,
	};
}

/** CAS behaviors every `SearchSnapshotStore` must share with `BucketSearchIndex`. */
export function searchIndexContract(
	name: string,
	makeIndex: () => SearchRetriever & SearchSnapshotStore,
): void {
	const signal = () => new AbortController().signal;
	const scope = { projectId: createProjectId(), source: 'notebooks' };
	const build = { revision: 1, source_revision: 1, configuration: 'keyword' };
	const snapshot = (count = 1): SearchSnapshot => ({
		schema_version: 1,
		indexed_at: new Date().toISOString(),
		partial: false,
		documents: Array.from({ length: count }, (_, i) => ({
			id: `doc-${i}`,
			kind: 'code',
			resource: { type: 'notebook', notebook_id: createNotebookId() },
			title: `Notebook ${i}`,
			text: `net_revenue metric${i}`,
			fingerprint: `${i}`,
		})),
	});

	describe(`Search index contract: ${name}`, () => {
		it.each([false, true])(
			'admits one concurrent publication with existing head %j',
			async (existing) => {
				const index = makeIndex();
				if (existing) await index.publish(scope, snapshot(), null, signal());
				const { revision } = await index.head(scope, signal());
				const first = snapshot();
				const second = snapshot(2);
				const results = await Promise.all([
					index.publish(scope, first, revision, signal()),
					index.publish(scope, second, revision, signal()),
				]);
				expect(results.filter(Boolean)).toHaveLength(1);
				expect((await index.read(scope, signal())).snapshot).toEqual(results[0] ? first : second);
			},
		);
		it('does not resurrect a tombstone with its current revision or a newer build', async () => {
			const index = makeIndex();
			await index.publish(scope, null, null, signal());
			const tombstone = await index.head(scope, signal());
			expect(tombstone.deleted).toBe(true);
			expect(await index.publish(scope, snapshot(), tombstone.revision, signal())).toBe(false);
			expect(await index.claim(scope, { ...build, revision: 2 }, signal())).toBeNull();
			expect(await index.touch(scope, tombstone.revision!, signal())).toBe(false);
			expect(await index.head(scope, signal())).toEqual(tombstone);
		});
		it('rejects malformed snapshots without changing the current publication', async () => {
			const index = makeIndex();
			const current = snapshot();
			await index.publish(scope, current, null, signal());
			const { revision } = await index.head(scope, signal());
			await expect(
				index.publish(scope, { ...snapshot(), indexed_at: 'invalid' }, revision, signal()),
			).rejects.toThrow();
			expect((await index.read(scope, signal())).snapshot).toEqual(current);
		});
		it('keeps documents matching more query terms when the keyword cut applies', async () => {
			const index = makeIndex();
			const data = snapshot(MAX_SEARCH_CANDIDATES);
			data.documents.push({ ...data.documents[0], id: 'both', text: 'net_revenue gross_margin' });
			await index.publish(scope, data, null, signal());
			const found = await index.candidates(scope, { query: 'net_revenue gross_margin' }, signal());
			expect(found.partial).toBe(true);
			expect(found.documents).toHaveLength(MAX_SEARCH_CANDIDATES);
			expect(found.documents[0].id).toBe('both');
			expect(found.documents.at(-1)?.id).toBe(`doc-${MAX_SEARCH_CANDIDATES - 2}`);
		});
		it('measures snapshot budget in UTF-8 bytes rather than code units', async () => {
			const index = makeIndex();
			const data = snapshot();
			data.documents = Array.from({ length: 800 }, (_, i) => ({
				...data.documents[0],
				id: String(i),
				text: '界'.repeat(8192),
			}));
			const serialized = JSON.stringify(data);
			expect(serialized.length).toBeLessThan(MAX_INDEX_BYTES);
			expect(new TextEncoder().encode(serialized).length).toBeGreaterThan(MAX_INDEX_BYTES);
			await expect(index.publish(scope, data, null, signal())).rejects.toThrow(
				'snapshot exceeds budget',
			);
			expect((await index.head(scope, signal())).revision).toBeNull();
		});
		it.each([
			{ revision: 0, source_revision: 1, configuration: '' },
			{ revision: 1, source_revision: 0, configuration: '' },
			{ revision: 1, source_revision: 1, configuration: 'x'.repeat(2049) },
		])('rejects invalid builds %j', async (invalid: SearchBuild) => {
			const index = makeIndex();
			await expect(index.claim(scope, invalid, signal())).rejects.toThrow();
			expect((await index.head(scope, signal())).revision).toBeNull();
		});
		it('copies build and snapshot inputs before retaining them', async () => {
			const index = makeIndex();
			const input = { ...build };
			const head = await index.claim(scope, input, signal());
			const data = snapshot();
			await index.publish(scope, data, head!.revision, signal());
			input.configuration = 'changed';
			data.documents[0].title = 'changed';
			expect((await index.head(scope, signal())).build?.configuration).toBe('keyword');
			expect((await index.read(scope, signal())).snapshot?.documents[0].title).toBe('Notebook 0');
		});
		it('claims a new build, fencing older revisions and preserving the last snapshot', async () => {
			const index = makeIndex();
			const data = snapshot();
			await index.publish(scope, data, null, signal());
			const previous = await index.head(scope, signal());
			const claimed = await index.claim(scope, build, signal());
			expect(claimed?.revision).not.toBe(previous.revision);
			expect(previous.verifiedAt).toBe(data.indexed_at);
			expect(claimed?.verifiedAt).toBeUndefined();
			expect(await index.publish(scope, snapshot(2), previous.revision, signal())).toBe(false);
			expect((await index.read(scope, signal())).snapshot).toEqual(data);
			expect(await index.claim(scope, build, signal())).toEqual(claimed);
		});
		it('rejects revision downgrades', async () => {
			const index = makeIndex();
			const newest = { ...build, revision: 2, source_revision: 2 };
			expect(await index.claim(scope, newest, signal())).not.toBeNull();
			for (const older of [build, { ...newest, revision: 1 }, { ...newest, source_revision: 1 }])
				expect(await index.claim(scope, older, signal())).toBeNull();
		});
		it('lets the newest configuration claim the head at equal revisions', async () => {
			const index = makeIndex();
			const first = await index.claim(scope, build, signal());
			const changed = await index.claim(scope, { ...build, configuration: 'hybrid' }, signal());
			expect(changed?.revision).not.toBe(first?.revision);
			expect(changed?.build?.configuration).toBe('hybrid');
			expect(await index.claim(scope, build, signal())).not.toBeNull();
			expect((await index.head(scope, signal())).build).toEqual(build);
		});
		it('records a content digest and verifies unchanged content without republishing', async () => {
			const index = makeIndex();
			const data = snapshot();
			await index.publish(scope, data, null, signal());
			const published = await index.head(scope, signal());
			expect(published.digest).toBe(await searchSnapshotDigest(data));
			expect((await index.head(scope, signal())).verifiedAt).toBe(data.indexed_at);
			expect(await index.touch(scope, published.revision!, signal())).toBe(true);
			const verified = await index.head(scope, signal());
			expect(verified.revision).not.toBe(published.revision);
			expect(verified.digest).toBe(published.digest);
			expect((await index.read(scope, signal())).snapshot).toEqual(data);
			const found = await index.candidates(scope, { query: 'net_revenue' }, signal());
			expect(found.indexedAt).toBe(data.indexed_at);
			expect(Date.parse(found.verifiedAt!)).toBeGreaterThanOrEqual(Date.parse(data.indexed_at));
			expect(await index.touch(scope, published.revision!, signal())).toBe(false);
			expect(await index.touch({ ...scope, source: 'absent' }, 'missing', signal())).toBe(false);
		});
	});
}
