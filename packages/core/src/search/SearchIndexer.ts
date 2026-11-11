import { BoundedLruMap } from '../cache';
import type { Snapshot } from '../schema';
import type { Metrics } from '../ports/metrics';
import { noopMetrics } from '../ports/metrics';
import { forEachConcurrentUntilFailure } from '../async';
import { sha256Hex } from '../internal/sha256';
import { sameSearchBuild, searchSnapshotDigest } from './build';
import type { Bucket } from '../ports/bucket';
import type { CatalogService } from '../services/catalog/CatalogService';
import type { ProjectService } from '../services/content/ProjectService';
import type { ProjectId } from '../ids';
import { ProjectId as ProjectIdValue } from '../ids';
import { PreconditionFailedError } from '../errors';
import { logEvent } from '../logs';
import { embedWithDeadline } from './embeddings';
import { searchPaths } from './paths';
import {
	MAX_EMBEDDING_BATCH_SIZE,
	MAX_SOURCE_PAGE_DOCUMENTS,
	MAX_SEARCH_CURSOR_LENGTH,
	MAX_SEARCH_CHECKPOINT_BYTES,
	MIN_RECRAWL_INTERVAL_MS,
} from './limits';
import {
	SearchDocumentSchema,
	SearchBuildSchema,
	SearchCursorSchema,
	SearchCheckpointSchema,
	SearchSnapshotSchema,
	MAX_INDEX_BYTES,
	MAX_INDEX_DOCUMENTS,
} from './contracts';
import type {
	SearchSnapshotStore,
	SearchSource,
	SearchDocument,
	EmbeddingProvider,
	SearchBuild,
	SearchSnapshot,
} from './contracts';

type IncrementalSearchSource = SearchSource & {
	readonly incremental?: boolean;
	readonly catalogBacked?: boolean;
	page(
		...args: [...Parameters<SearchSource['page']>, previous?: SearchSnapshot | null]
	): ReturnType<SearchSource['page']>;
};

const MAX_TICK_STEPS = 32;
const TICK_BUDGET_MS = 100;
const CLEANUP_DELETE_BATCH_SIZE = 10;

export class SearchIndexer {
	private readonly verifiedCatalogs = new BoundedLruMap<
		string,
		{ digest: string | undefined; fingerprint: string; indexedAt: number }
	>(1024);
	private previousCrawl:
		| { key: string; revision: string | null; snapshot: SearchSnapshot | null }
		| undefined;

	constructor(
		private readonly bucket: Bucket,
		private readonly index: SearchSnapshotStore,
		private readonly sources: readonly IncrementalSearchSource[],
		private readonly catalog: CatalogService,
		private readonly projects: ProjectService,
		private readonly embeddings?: EmbeddingProvider,
		private readonly minRecrawlIntervalMs = MIN_RECRAWL_INTERVAL_MS,
		private readonly metrics: Metrics = noopMetrics,
	) {}
	/**
	 * A changed `search_refresh` token bypasses the recrawl interval.
	 * `tick` supplies the token from its catalog snapshot to avoid another read.
	 */
	async step(
		projectId: ProjectId,
		source: IncrementalSearchSource,
		signal: AbortSignal,
		refresh?: string | null,
		catalogFingerprint?: string,
	): Promise<boolean> {
		signal.throwIfAborted();
		const scope = { projectId, source: source.id };
		const paths = searchPaths.scope(scope);
		const key = paths.checkpoint;
		const stored = await this.bucket.get(key);
		const refreshToken = refresh === undefined ? await this.refreshToken(projectId) : refresh;
		const build = SearchBuildSchema.parse({
			revision: 1,
			source_revision: source.revision,
			configuration: JSON.stringify({
				source: source.configuration ?? '',
				refresh: refreshToken ?? null,
				embedding: source.embeddable ? (this.embeddings?.space ?? null) : null,
			}),
		});
		const project = await this.liveProject(projectId);
		if (!project) {
			const head = await this.index.head(scope, signal);
			if (head.deleted && stored && stored.size <= MAX_SEARCH_CHECKPOINT_BYTES) {
				const state = SearchCheckpointSchema.parse(await stored.json());
				if (state.revision === head.revision && state.pages.length === 0 && !state.ready)
					return true;
			}
			// Keep both CAS records: late first writes must not recreate a deleted scope.
			if (!head.deleted && !(await this.index.publish(scope, null, head.revision, signal)))
				return false;
			signal.throwIfAborted();
			try {
				await this.bucket.put(
					key,
					encodeCheckpoint(
						emptyCheckpoint((await this.index.head(scope, signal)).revision, head.build ?? build),
					),
					stored ? { onlyIfEtagMatches: stored.etag } : { onlyIfNotExists: true },
				);
			} catch (error) {
				if (error instanceof PreconditionFailedError) return false;
				throw error;
			}
			return true;
		}
		const loaded = await this.index.claim(scope, build, signal);
		if (!loaded) return true;
		// Skip fresh scopes before creating pages retained by the cleanup grace period.
		if (loaded.verifiedAt && Date.now() - Date.parse(loaded.verifiedAt) < this.minRecrawlIntervalMs)
			return true;
		const scopeKey = `${projectId}/${source.id}`;
		let previous: SearchSnapshot | null = null;
		if (loaded.verifiedAt && ((this.embeddings && source.embeddable) || source.incremental)) {
			const cached = this.verifiedCatalogs.get(scopeKey);
			// Catalog publication can lag a source write; force a full verification every day.
			if (
				catalogFingerprint &&
				cached &&
				loaded.digest !== undefined &&
				cached.digest === loaded.digest &&
				cached.fingerprint === catalogFingerprint &&
				Date.now() - cached.indexedAt < 24 * 3600_000
			) {
				this.metrics.increment('search.projects.unchanged', 1, { source: source.id });
				return loaded.revision !== null && this.index.touch(scope, loaded.revision, signal);
			}
			previous =
				this.previousCrawl?.key === scopeKey && this.previousCrawl.revision === loaded.revision
					? this.previousCrawl.snapshot
					: (await this.index.read(scope, signal)).snapshot;
			this.previousCrawl = { key: scopeKey, revision: loaded.revision, snapshot: previous };
			if (
				catalogFingerprint &&
				previous?.catalog_fingerprint === catalogFingerprint &&
				!previous.partial &&
				Date.now() - Date.parse(previous.indexed_at) < 24 * 3600_000
			) {
				this.verifiedCatalogs.set(scopeKey, {
					digest: loaded.digest,
					fingerprint: catalogFingerprint,
					indexedAt: Date.parse(previous.indexed_at),
				});
				this.metrics.increment('search.projects.unchanged', 1, { source: source.id });
				return loaded.revision !== null && this.index.touch(scope, loaded.revision, signal);
			}
		}
		const initial = () => ({
			...emptyCheckpoint(loaded.revision, build),
			catalog_fingerprint: catalogFingerprint,
		});
		// Oversized legacy checkpoints restart without parsing their unbounded bodies.
		let state =
			stored && stored.size <= MAX_SEARCH_CHECKPOINT_BYTES
				? SearchCheckpointSchema.parse(await stored.json())
				: initial();
		if (
			state.revision !== loaded.revision ||
			state.catalog_fingerprint !== catalogFingerprint ||
			!sameSearchBuild(state.build, build) ||
			state.pages.length === 0
		)
			state = initial();
		let checkpointEtag = stored?.etag;
		if (!state.ready) {
			const page = await source.page(
				project,
				state.cursor,
				signal,
				loaded.verifiedAt ? previous : null,
			);
			const oldDocuments = new Set(previous?.documents ?? []);
			const reused = page.documents.filter((document) => oldDocuments.has(document)).length;
			this.metrics.increment('search.documents.reused', reused, { source: source.id });
			this.metrics.increment('search.documents.read', page.documents.length - reused, {
				source: source.id,
			});
			const valid: SearchDocument[] = [];
			for (const document of page.documents.slice(0, MAX_SOURCE_PAGE_DOCUMENTS)) {
				const parsed = SearchDocumentSchema.safeParse(document);
				if (parsed.success && source.kinds.includes(parsed.data.kind)) valid.push(parsed.data);
				else page.partial = true;
			}
			if (
				page.documents.length > MAX_SOURCE_PAGE_DOCUMENTS ||
				(page.cursor?.length ?? 0) > MAX_SEARCH_CURSOR_LENGTH
			) {
				page.partial = true;
				page.cursor = undefined;
			}
			page.documents = valid;
			if (this.embeddings && source.embeddable)
				page.partial =
					(await this.embed(page.documents, previous?.documents ?? [], signal)) || page.partial;
			const documents: SearchDocument[] = [];
			let bytes = state.bytes;
			for (const document of page.documents) {
				const size = new TextEncoder().encode(JSON.stringify(document)).length + 1;
				if (
					state.count + documents.length >= MAX_INDEX_DOCUMENTS ||
					bytes + size > MAX_INDEX_BYTES - 1024
				) {
					page.partial = true;
					page.cursor = undefined;
					break;
				}
				bytes += size;
				documents.push(document);
			}
			const pageId = crypto.randomUUID();
			signal.throwIfAborted();
			await this.bucket.put(
				paths.page(pageId),
				JSON.stringify({
					schema_version: 1,
					indexed_at: new Date().toISOString(),
					partial: page.partial,
					documents,
				}),
				{ onlyIfNotExists: true },
			);
			state = {
				...state,
				pages: [...state.pages, pageId],
				count: state.count + documents.length,
				bytes,
				partial: state.partial || page.partial,
				cursor: page.cursor,
				ready: !page.cursor,
			};
			if (
				state.pages.length >= 1000 ||
				new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_SEARCH_CHECKPOINT_BYTES
			) {
				state.cursor = undefined;
				state.ready = true;
				state.partial = true;
			}
			signal.throwIfAborted();
			try {
				checkpointEtag = (
					await this.bucket.put(
						key,
						encodeCheckpoint(state),
						stored ? { onlyIfEtagMatches: stored.etag } : { onlyIfNotExists: true },
					)
				).etag;
			} catch (error) {
				if (error instanceof PreconditionFailedError) return false;
				throw error;
			}
			if (!state.ready) return false;
		}
		const pages: SearchDocument[][] = Array.from({ length: state.pages.length }, () => []);
		let bytes = 0;
		let count = 0;
		const missingPage = new Error('Search crawl page unavailable');
		try {
			await forEachConcurrentUntilFailure({
				items: state.pages,
				concurrency: 8,
				run: async (id, position) => {
					signal.throwIfAborted();
					const body = await this.bucket.get(paths.page(id));
					signal.throwIfAborted();
					if (!body) throw missingPage;
					if (body.size > MAX_INDEX_BYTES) throw new Error('Search crawl page exceeds budget');
					bytes += body.size;
					if (bytes > MAX_INDEX_BYTES + state.pages.length * 1024)
						throw new Error('Search crawl exceeds budget');
					const documents = SearchSnapshotSchema.parse(await body.json()).documents;
					count += documents.length;
					if (count > MAX_INDEX_DOCUMENTS) throw new Error('Search crawl exceeds document budget');
					pages[position] = documents;
				},
			});
		} catch (error) {
			signal.throwIfAborted();
			if (error !== missingPage) throw error;
			try {
				await this.bucket.put(key, encodeCheckpoint(initial()), {
					onlyIfEtagMatches: checkpointEtag!,
				});
			} catch (resetError) {
				if (!(resetError instanceof PreconditionFailedError)) throw resetError;
			}
			return false;
		}
		const documents = [...new Map(pages.flat().map((d) => [d.id, d])).values()];
		const current = await this.liveProject(projectId);
		const revision = state.revision;
		const digest = await searchSnapshotDigest({ partial: state.partial, documents });
		const unchanged =
			current !== null &&
			revision !== null &&
			loaded.digest !== undefined &&
			loaded.digest === digest &&
			(!state.catalog_fingerprint || previous?.catalog_fingerprint === state.catalog_fingerprint);
		signal.throwIfAborted();
		// Republishing an unchanged corpus would write a full snapshot on every round-robin visit.
		const committed = unchanged
			? await this.index.touch(scope, revision, signal)
			: await this.index.publish(
					scope,
					current
						? {
								schema_version: 1,
								indexed_at: new Date().toISOString(),
								catalog_fingerprint: state.catalog_fingerprint,
								partial: state.partial,
								documents,
							}
						: null,
					revision,
					signal,
				);
		if (!committed) return false;
		// A crash after publication leaves a different head revision, which resets the checkpoint on retry.
		const published = await this.index.head(scope, signal);
		// A competing publication can replace the head before this read.
		if (!state.partial && state.catalog_fingerprint && published.digest === digest)
			this.verifiedCatalogs.set(scopeKey, {
				digest: published.digest,
				fingerprint: state.catalog_fingerprint,
				indexedAt: Date.now(),
			});
		this.previousCrawl = undefined;
		signal.throwIfAborted();
		try {
			await this.bucket.put(key, encodeCheckpoint({ ...initial(), revision: published.revision }), {
				onlyIfEtagMatches: checkpointEtag!,
			});
		} catch (error) {
			if (!(error instanceof PreconditionFailedError)) throw error;
		}
		return true;
	}
	async shouldRun(): Promise<boolean> {
		const object = await this.bucket.get(searchPaths.cursor);
		if (!object) return true;
		if (object.size > 4096) throw new Error('Search cursor exceeds budget');
		const cursor = SearchCursorSchema.parse(await object.json());
		if ((cursor.next_run_at ?? 0) <= Date.now()) return true;
		return cursor.schedule !== (await this.schedule(await this.catalog.getCurrentSnapshot()));
	}
	private schedule(snapshot: Snapshot): Promise<string> {
		return sha256Hex(
			JSON.stringify([
				snapshot.projects
					.flatMap((project) =>
						this.sources.map((source) => [
							`${project.id}/${source.id}`,
							project.search_refresh ?? null,
							source.revision,
							source.configuration,
						]),
					)
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
				this.embeddings?.space,
			]),
		);
	}
	private async refreshToken(projectId: ProjectId): Promise<string | null> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		return snapshot.projects.find((project) => project.id === projectId)?.search_refresh ?? null;
	}
	private async liveProject(projectId: ProjectId) {
		const project = await this.projects.findProject(projectId);
		if (!project) {
			logEvent({ level: 'info', event: 'search.project_missing', project_id: projectId });
			return null;
		}
		return project.status === 'deleted' ? null : project;
	}
	private async embed(
		documents: SearchDocument[],
		previous: SearchDocument[],
		signal: AbortSignal,
	): Promise<boolean> {
		const provider = this.embeddings!;
		const reusable = new Map(
			previous
				.filter((d) => d.embedding?.space === provider.space)
				.map((d) => [d.text, d.embedding!]),
		);
		const missing = [...new Set(documents.filter((d) => !reusable.has(d.text)).map((d) => d.text))];
		let partial = false;
		for (let offset = 0; offset < missing.length; offset += MAX_EMBEDDING_BATCH_SIZE) {
			signal.throwIfAborted();
			const batch = missing.slice(offset, offset + MAX_EMBEDDING_BATCH_SIZE);
			try {
				const vectors = await embedWithDeadline(provider, batch, { timeoutMs: 2000, signal });
				batch.forEach((text, i) =>
					reusable.set(text, { space: provider.space, vector: vectors[i] }),
				);
			} catch {
				signal.throwIfAborted();
				partial = true;
				break;
			}
		}
		for (const document of documents) document.embedding = reusable.get(document.text);
		return partial;
	}
	async tick(signal: AbortSignal) {
		signal.throwIfAborted();
		const key = searchPaths.cursor;
		const object = await this.bucket.get(key);
		if (object && object.size > 4096) throw new Error('Search cursor exceeds budget');
		const cursor = SearchCursorSchema.parse(object ? await object.json() : { after: '' });
		const roundStartedAt = cursor.round_started_at ?? Date.now();
		const snapshot = await this.catalog.getCurrentSnapshot();
		const tasks = snapshot.projects
			.flatMap((p) =>
				this.sources.map((source) => ({
					projectId: p.id,
					source,
					refresh: p.search_refresh ?? null,
					catalogFingerprint: source.catalogBacked
						? JSON.stringify([p.status, p.search_refresh, p.notebooks])
						: undefined,
					id: `${p.id}/${source.id}`,
				})),
			)
			.sort((a, b) => a.id.localeCompare(b.id));
		const schedule = await this.schedule(snapshot);
		signal.throwIfAborted();
		if (cursor.schedule === schedule && (cursor.next_run_at ?? 0) > Date.now()) return;
		let after = cursor.schedule && cursor.schedule !== schedule ? '' : cursor.after;
		let position = tasks.findIndex((task) => task.id > after);
		if (position === -1) position = 0;
		signal.throwIfAborted();
		const cleanup = await this.bucket.list({
			prefix: searchPaths.projects,
			delimiter: '/',
			cursor: cursor.cleanup,
			limit: 1,
		});
		signal.throwIfAborted();
		let failure: { error: unknown } | undefined;
		for (const prefix of cleanup.delimitedPrefixes) {
			const id = prefix.split('/').at(-2);
			if (!id || !ProjectIdValue.is(id)) continue;
			for (const source of this.sources) {
				try {
					if (!snapshot.projects.some((p) => p.id === id))
						await this.step(id, source, signal, null);
					await this.pruneScope(id, source.id, signal);
				} catch (error) {
					signal.throwIfAborted();
					failure ??= { error };
				}
			}
		}
		const cleanupCursor = failure ? cursor.cleanup : cleanup.cursor;
		const started = performance.now();
		for (let steps = 0; position < tasks.length && steps < MAX_TICK_STEPS; steps++) {
			signal.throwIfAborted();
			const task = tasks[position];
			try {
				if (
					await this.step(
						task.projectId,
						task.source,
						signal,
						task.refresh,
						task.catalogFingerprint ? await sha256Hex(task.catalogFingerprint) : undefined,
					)
				) {
					after = task.id;
					position++;
				}
			} catch (error) {
				signal.throwIfAborted();
				// Retry the failed scope next round without starving the scopes after it.
				after = task.id;
				failure ??= { error };
				break;
			}
			// Check the budget between resumable steps, not during publication.
			if (performance.now() - started >= TICK_BUDGET_MS) break;
		}
		if (!failure && position === tasks.length)
			this.metrics.histogram?.('search.round.duration_ms', Date.now() - roundStartedAt);
		const next = {
			round_started_at: position === tasks.length ? undefined : roundStartedAt,
			after: position === tasks.length ? '' : after,
			cleanup: cleanupCursor,
			schedule,
			next_run_at:
				!failure && position === tasks.length ? Date.now() + this.minRecrawlIntervalMs : undefined,
		};
		if (JSON.stringify(cursor) !== JSON.stringify(next)) {
			signal.throwIfAborted();
			try {
				await this.bucket.put(
					key,
					JSON.stringify(next),
					object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
				);
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
			}
		}
		if (failure) throw failure.error;
	}
	private async pruneScope(projectId: ProjectId, source: string, signal: AbortSignal) {
		const scope = { projectId, source };
		const paths = searchPaths.scope(scope);
		signal.throwIfAborted();
		const object = await this.bucket.get(paths.checkpoint);
		signal.throwIfAborted();
		if (object && object.size > MAX_SEARCH_CHECKPOINT_BYTES) return;
		const state = object ? SearchCheckpointSchema.parse(await object.json()) : null;
		if (state && state.pages.length > 0) return;
		await this.index.prune?.(scope, signal);
		signal.throwIfAborted();
		if (!object || !state) return;
		const pages = await this.bucket.list({ prefix: paths.pages, limit: 100 });
		signal.throwIfAborted();
		const expired = pages.objects.filter(
			(page) =>
				Date.now() - page.uploaded.getTime() > 24 * 3600_000 &&
				!state.pages.some((id) => page.key === paths.page(id)),
		);
		if (expired.length === 0) return;
		signal.throwIfAborted();
		try {
			await this.bucket.put(
				paths.checkpoint,
				encodeCheckpoint({ ...state, generation: crypto.randomUUID() }),
				{ onlyIfEtagMatches: object.etag },
			);
		} catch (error) {
			if (error instanceof PreconditionFailedError) return;
			throw error;
		}
		for (let offset = 0; offset < expired.length; offset += CLEANUP_DELETE_BATCH_SIZE) {
			signal.throwIfAborted();
			await this.bucket.delete(
				expired.slice(offset, offset + CLEANUP_DELETE_BATCH_SIZE).map((page) => page.key),
			);
		}
		signal.throwIfAborted();
	}
}

function emptyCheckpoint(revision: string | null, build: SearchBuild) {
	return {
		schema_version: 1 as const,
		build,
		generation: crypto.randomUUID(),
		revision,
		pages: [] as string[],
		count: 0,
		bytes: 0,
		partial: false,
		cursor: undefined as string | undefined,
		ready: false,
	};
}

function encodeCheckpoint(state: ReturnType<typeof SearchCheckpointSchema.parse>) {
	const body = new TextEncoder().encode(JSON.stringify(state));
	if (body.byteLength > MAX_SEARCH_CHECKPOINT_BYTES)
		throw new Error('Search checkpoint exceeds budget');
	return body;
}
