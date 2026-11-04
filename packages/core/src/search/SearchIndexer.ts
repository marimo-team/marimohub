import { forEachConcurrentUntilFailure } from '../async';
import { sameSearchBuild, searchSnapshotDigest } from './build';
import type { Bucket } from '../ports/bucket';
import type { CatalogService } from '../services/catalog/CatalogService';
import type { ProjectService } from '../services/content/ProjectService';
import type { ProjectId } from '../ids';
import { ProjectId as ProjectIdValue } from '../ids';
import { PreconditionFailedError, NotFoundError } from '../errors';
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
} from './contracts';

export class SearchIndexer {
	static async requestRefresh(
		bucket: Bucket,
		projectId: ProjectId,
		revision: string = crypto.randomUUID(),
	): Promise<void> {
		await bucket.put(searchPaths.refresh(projectId), JSON.stringify(revision));
	}

	constructor(
		private readonly bucket: Bucket,
		private readonly index: SearchSnapshotStore,
		private readonly sources: readonly SearchSource[],
		private readonly catalog: CatalogService,
		private readonly projects: ProjectService,
		private readonly embeddings?: EmbeddingProvider,
		private readonly minRecrawlIntervalMs = MIN_RECRAWL_INTERVAL_MS,
	) {}
	async step(projectId: ProjectId, source: SearchSource, signal: AbortSignal): Promise<boolean> {
		signal.throwIfAborted();
		const scope = { projectId, source: source.id };
		const paths = searchPaths.scope(scope);
		const key = paths.checkpoint;
		const stored = await this.bucket.get(key);
		const refresh = await this.bucket.get(searchPaths.refresh(projectId));
		const build = SearchBuildSchema.parse({
			revision: 1,
			source_revision: source.revision,
			configuration: JSON.stringify({
				source: source.configuration ?? '',
				refresh: refresh ? await refresh.json() : null,
				embedding: source.embeddable ? (this.embeddings?.space ?? null) : null,
			}),
		});
		const project = await this.liveProject(projectId);
		if (!project) {
			const head = await this.index.head(scope, signal);
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
		// Every recrawl writes pages that cleanup retains for a day, even when nothing changed.
		if (loaded.verifiedAt && Date.now() - Date.parse(loaded.verifiedAt) < this.minRecrawlIntervalMs)
			return true;
		const initial = () => emptyCheckpoint(loaded.revision, build);
		// Oversized legacy checkpoints restart without parsing their unbounded bodies.
		let state =
			stored && stored.size <= MAX_SEARCH_CHECKPOINT_BYTES
				? SearchCheckpointSchema.parse(await stored.json())
				: initial();
		if (state.revision !== loaded.revision || !sameSearchBuild(state.build, build))
			state = initial();
		let checkpointEtag = stored?.etag;
		if (!state.ready) {
			const page = await source.page(project, state.cursor, signal);
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
					(await this.embed(
						page.documents,
						(await this.index.read(scope, signal)).snapshot?.documents ?? [],
						signal,
					)) || page.partial;
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
		const unchanged =
			current !== null &&
			revision !== null &&
			loaded.digest !== undefined &&
			loaded.digest === (await searchSnapshotDigest({ partial: state.partial, documents }));
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
	private async liveProject(projectId: ProjectId) {
		try {
			const project = await this.projects.getProject(projectId);
			return project.status === 'deleted' ? null : project;
		} catch (error) {
			if (error instanceof NotFoundError) return null;
			throw error;
		}
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
		const cursor = object ? SearchCursorSchema.parse(await object.json()) : { after: '' };
		const snapshot = await this.catalog.getCurrentSnapshot();
		const tasks = snapshot.projects
			.flatMap((p) =>
				this.sources.map((source) => ({ projectId: p.id, source, id: `${p.id}/${source.id}` })),
			)
			.sort((a, b) => a.id.localeCompare(b.id));
		const task = tasks.find((t) => t.id > cursor.after) ?? tasks[0];
		signal.throwIfAborted();
		const cleanup = await this.bucket.list({
			prefix: searchPaths.projects,
			delimiter: '/',
			cursor: cursor.cleanup,
			limit: 1,
		});
		signal.throwIfAborted();
		try {
			await this.bucket.put(
				key,
				JSON.stringify({ after: task?.id ?? '', cleanup: cleanup.cursor }),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
		} catch (error) {
			if (error instanceof PreconditionFailedError) return;
			throw error;
		}
		for (const prefix of cleanup.delimitedPrefixes) {
			const id = prefix.split('/').at(-2);
			if (!id || !ProjectIdValue.is(id)) continue;
			for (const source of this.sources) {
				const scope = { projectId: id, source: source.id };
				if (!snapshot.projects.some((p) => p.id === id)) await this.step(id, source, signal);
				const checkpoint = await this.bucket.get(searchPaths.scope(scope).checkpoint);
				if (
					!checkpoint ||
					(checkpoint.size <= MAX_SEARCH_CHECKPOINT_BYTES &&
						SearchCheckpointSchema.parse(await checkpoint.json()).pages.length === 0)
				) {
					await this.index.prune?.(scope, signal);
					await this.prunePages(id, source.id, signal);
				}
			}
		}
		if (task)
			for (let i = 0; i < 4; i++) {
				signal.throwIfAborted();
				if (await this.step(task.projectId, task.source, signal)) break;
			}
	}
	private async prunePages(projectId: ProjectId, source: string, signal: AbortSignal) {
		const paths = searchPaths.scope({ projectId, source });
		const object = await this.bucket.get(paths.checkpoint);
		if (!object || object.size > MAX_SEARCH_CHECKPOINT_BYTES) return;
		const state = SearchCheckpointSchema.parse(await object.json());
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
		const pages = await this.bucket.list({ prefix: paths.pages, limit: 100 });
		for (const page of pages.objects) {
			signal.throwIfAborted();
			if (
				Date.now() - page.uploaded.getTime() > 24 * 3600_000 &&
				!state.pages.some((id) => page.key === paths.page(id))
			)
				await this.bucket.delete(page.key);
		}
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
