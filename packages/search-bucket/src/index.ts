import { canClaimSearchBuild, sameSearchBuild } from '@marimo-hub/core/search/build';
import { withAbortSignal } from '@marimo-hub/core/async';
import { LRUCache } from 'lru-cache';
import type { Bucket } from '@marimo-hub/core/ports/bucket';
import { PreconditionFailedError } from '@marimo-hub/core/errors';
import { searchPaths } from '@marimo-hub/core/search/paths';
import { MAX_SEARCH_CANDIDATES } from '@marimo-hub/core/search/limits';
import {
	MAX_INDEX_BYTES,
	SearchSnapshotSchema,
	SearchHeadSchema,
	SearchBuildSchema,
	terms,
} from '@marimo-hub/core/search/contracts';
import type {
	SearchRetriever,
	SearchSnapshotStore,
	SearchBuild,
	SearchHead,
	SearchScope,
	SearchSnapshot,
	SearchDocument,
	SearchCandidatesRequest,
} from '@marimo-hub/core/search/contracts';

const MAX_PENDING_LOADS = 64;

interface Cached {
	snapshot: SearchSnapshot;
	postings: Map<string, number[]>;
	bytes: number;
}

export class BucketSearchIndex implements SearchRetriever, SearchSnapshotStore {
	private readonly cache: LRUCache<string, Cached>;
	private readonly loading = new Map<string, Promise<Cached>>();
	constructor(
		private readonly bucket: Bucket,
		maxCacheBytes = 64 * 1024 * 1024,
	) {
		this.cache = new LRUCache({ maxSize: maxCacheBytes, sizeCalculation: (entry) => entry.bytes });
	}
	private async loadHead(scope: SearchScope, signal: AbortSignal) {
		signal.throwIfAborted();
		const paths = searchPaths.scope(scope);
		const object = await this.bucket.get(paths.head);
		signal.throwIfAborted();
		if (!object) return { revision: null, head: null };
		if (object.size > 4096) throw new Error('Search head exceeds budget');
		const head = SearchHeadSchema.parse(await object.json());
		if (head.key && head.key !== paths.snapshot(head.generation))
			throw new Error('Invalid search snapshot path');
		return { revision: object.etag, head };
	}
	private async writeHead(
		scope: SearchScope,
		head: SearchHead,
		revision: string | null,
		signal: AbortSignal,
	) {
		const body = JSON.stringify(SearchHeadSchema.parse(head));
		if (new TextEncoder().encode(body).length > 4096) throw new Error('Search head exceeds budget');
		signal.throwIfAborted();
		return this.bucket.put(
			searchPaths.scope(scope).head,
			body,
			revision === null ? { onlyIfNotExists: true } : { onlyIfEtagMatches: revision },
		);
	}
	async head(scope: SearchScope, signal: AbortSignal) {
		const { revision, head } = await this.loadHead(scope, signal);
		return { revision, build: head?.build, deleted: head?.deleted ?? false };
	}
	async claim(scope: SearchScope, build: SearchBuild, signal: AbortSignal) {
		SearchBuildSchema.parse(build);
		const { revision, head } = await this.loadHead(scope, signal);
		if (head?.deleted || !canClaimSearchBuild(head?.build, build)) return null;
		if (sameSearchBuild(head?.build, build)) return { revision, build, deleted: false };
		signal.throwIfAborted();
		try {
			const result = await this.writeHead(
				scope,
				{
					schema_version: 1,
					generation: crypto.randomUUID(),
					deleted: false,
					key: null,
					...head,
					build,
				},
				revision,
				signal,
			);
			return { revision: result.etag, build, deleted: false };
		} catch (error) {
			if (error instanceof PreconditionFailedError) return null;
			throw error;
		}
	}
	async read(scope: SearchScope, signal: AbortSignal) {
		const { revision, head } = await this.loadHead(scope, signal);
		if (!head || head.deleted || !head.key) return { revision, snapshot: null };
		signal.throwIfAborted();
		const cached =
			this.cache.get(head.key) ?? (await withAbortSignal(this.loadSnapshot(head.key), signal));
		signal.throwIfAborted();
		return { revision, snapshot: cached.snapshot, postings: cached.postings };
	}
	private loadSnapshot(key: string): Promise<Cached> {
		const pending = this.loading.get(key);
		if (pending) return pending;
		if (this.loading.size >= MAX_PENDING_LOADS)
			return Promise.reject(new Error('Search snapshot loading capacity exceeded'));
		// Each caller cancels its own wait; immutable snapshot work is shared across callers.
		const loading = this.fetchSnapshot(key).finally(() => this.loading.delete(key));
		this.loading.set(key, loading);
		return loading;
	}
	private async fetchSnapshot(key: string): Promise<Cached> {
		const body = await this.bucket.get(key);
		if (!body || body.size > MAX_INDEX_BYTES)
			throw new Error('Search snapshot unavailable or exceeds budget');
		const snapshot = SearchSnapshotSchema.parse(await body.json());
		const postings = new Map<string, number[]>();
		snapshot.documents.forEach((document, index) => {
			for (const term of terms(`${document.title} ${document.text}`)) {
				const list = postings.get(term) ?? [];
				list.push(index);
				postings.set(term, list);
			}
		});
		const cached = { snapshot, postings, bytes: body.size * 4 };
		this.cache.set(key, cached);
		return cached;
	}

	async publish(
		scope: SearchScope,
		snapshot: SearchSnapshot | null,
		revision: string | null,
		signal: AbortSignal,
	) {
		signal.throwIfAborted();
		const current = await this.loadHead(scope, signal);
		if (current.revision !== revision || (snapshot && current.head?.deleted)) return false;
		const generation = crypto.randomUUID();
		const paths = searchPaths.scope(scope);
		const key = snapshot ? paths.snapshot(generation) : null;
		if (snapshot && key) {
			const serialized = JSON.stringify(SearchSnapshotSchema.parse(snapshot));
			if (new TextEncoder().encode(serialized).length > MAX_INDEX_BYTES)
				throw new Error('Search snapshot exceeds budget');
			await this.bucket.put(key, serialized, { onlyIfNotExists: true });
		}
		signal.throwIfAborted();
		try {
			await this.writeHead(
				scope,
				{
					schema_version: 1,
					generation,
					deleted: snapshot === null,
					key,
					build: current.head?.build,
				},
				revision,
				signal,
			);
			return true;
		} catch (error) {
			if (error instanceof PreconditionFailedError) return false;
			throw error;
		}
	}
	async prune(scope: SearchScope, signal: AbortSignal): Promise<void> {
		const paths = searchPaths.scope(scope);
		const { revision, head } = await this.loadHead(scope, signal);
		if (!head) return;
		signal.throwIfAborted();
		try {
			await this.writeHead(scope, { ...head, fence: crypto.randomUUID() }, revision, signal);
		} catch (error) {
			if (error instanceof PreconditionFailedError) return;
			throw error;
		}
		const page = await this.bucket.list({ prefix: paths.snapshots, limit: 100 });
		for (const item of page.objects) {
			signal.throwIfAborted();
			if (item.key !== head.key && Date.now() - item.uploaded.getTime() > 24 * 3600_000)
				await this.bucket.delete(item.key);
		}
	}

	async candidates(
		scope: SearchScope,
		{ query, kinds, embedding }: SearchCandidatesRequest,
		signal: AbortSignal,
	) {
		const loaded = await this.read(scope, signal);
		if (!loaded.snapshot) return { documents: [], partial: true };
		const indexes = new Set<number>();
		for (const term of terms(query))
			for (const i of loaded.postings?.get(term) ?? []) indexes.add(i);
		if (embedding)
			loaded.snapshot.documents.forEach((doc, i) => {
				if (
					doc.embedding?.space === embedding.space &&
					doc.embedding.vector.length === embedding.vector.length
				)
					indexes.add(i);
			});
		const documents: SearchDocument[] = [];
		let partial = loaded.snapshot.partial;
		for (const i of indexes) {
			const doc = loaded.snapshot.documents[i];
			if (kinds && !kinds.includes(doc.kind)) continue;
			if (documents.length === MAX_SEARCH_CANDIDATES) {
				partial = true;
				break;
			}
			documents.push(doc);
		}
		return { documents, indexedAt: loaded.snapshot.indexed_at, partial };
	}
}
