import type { AuthenticatedPrincipal } from '../ports/auth';
import type { CatalogService } from '../services/catalog/CatalogService';
import type { ProjectService } from '../services/content/ProjectService';
import type { AuthorizationService } from '../services/authorization/AuthorizationService';
import { withDeadline } from '../async';
import { BoundedLruMap } from '../cache';
import { embedWithDeadline } from './embeddings';
import { mapWithConcurrency } from '../concurrency';
import { SearchRequestSchema, SearchResponseSchema } from './contracts';
import type {
	SearchRetriever,
	SearchSource,
	SearchRequest,
	SearchResponse,
	EmbeddingProvider,
	SearchDocument,
} from './contracts';
import { rank, snippet, resourceHref } from './rank';
import { MAX_SEARCH_PROJECT_SCAN } from './limits';
import type { ProjectId } from '../ids';
import type { Project } from '../schema';

const MAX_SEARCH_PROJECTS = 16;
const PROJECT_SCAN_BATCH = 8;
const STALE_AFTER_MS = 15 * 60_000;

interface RankedBatch {
	project: Project;
	source: SearchSource;
	indexedAt: string;
	rows: { document: SearchDocument; score: number }[];
}

export class SearchService {
	get supportsSemantic(): boolean {
		return Boolean(this.embeddings);
	}

	private readonly queryEmbeddings = new BoundedLruMap<string, number[]>(128);
	constructor(
		readonly index: SearchRetriever,
		readonly sources: readonly SearchSource[],
		private readonly catalog: CatalogService,
		private readonly projects: ProjectService,
		private readonly authz: AuthorizationService,
		private readonly embeddings?: EmbeddingProvider,
		private readonly timeoutMs = 3000,
	) {
		if (
			sources.length > 4 ||
			sources.some((s) => !/^[a-z][a-z0-9-]{0,63}$/.test(s.id)) ||
			new Set(sources.map((s) => s.id)).size !== sources.length
		)
			throw new Error('Search requires at most four distinct sources');
	}
	private async authorizedProject(projectId: ProjectId, principal: AuthenticatedPrincipal) {
		const project = await this.projects.getProject(projectId, { consistency: 'validated' });
		const decision = await this.authz.authorize(principal, 'project.read', {
			kind: 'project',
			project,
		});
		return decision.allowed ? project : null;
	}
	/**
	 * Catalog-order projects the caller can read. Scanning stops once more than
	 * `MAX_SEARCH_PROJECTS` are found (the surplus signals truncation) or after
	 * `MAX_SEARCH_PROJECT_SCAN` ids, which `scanTruncated` reports when ids remain.
	 */
	private async accessibleProjects(
		ids: readonly ProjectId[],
		principal: AuthenticatedPrincipal,
		signal: AbortSignal,
		unavailable: () => void,
	) {
		const accessible: Project[] = [];
		const limit = Math.min(ids.length, MAX_SEARCH_PROJECT_SCAN);
		let offset = 0;
		while (offset < limit && accessible.length <= MAX_SEARCH_PROJECTS) {
			const batch = ids.slice(offset, Math.min(offset + PROJECT_SCAN_BATCH, limit));
			offset += batch.length;
			const loaded = await mapWithConcurrency(batch, PROJECT_SCAN_BATCH, async (id) => {
				signal.throwIfAborted();
				return this.authorizedProject(id, principal).catch(() => {
					signal.throwIfAborted();
					unavailable();
					return null;
				});
			});
			accessible.push(...loaded.filter((project) => project !== null));
		}
		return {
			accessible,
			scanTruncated: accessible.length <= MAX_SEARCH_PROJECTS && offset < ids.length,
		};
	}

	async search(
		principal: AuthenticatedPrincipal,
		input: SearchRequest,
		signal?: AbortSignal,
	): Promise<SearchResponse> {
		const request = SearchRequestSchema.parse(input);
		signal?.throwIfAborted();
		const response: SearchResponse = { items: [], partial: false, coverage: [] };
		const batches: RankedBatch[] = [];
		const coverage = (entry: SearchResponse['coverage'][number]) => {
			const existing = response.coverage.find(
				(value) => value.source === entry.source && value.project_id === entry.project_id,
			);
			if (existing) {
				if (entry.status !== 'partial' || ['complete', 'stale'].includes(existing.status))
					existing.status = entry.status;
			} else response.coverage.push(entry);
			// Stale snapshots are still complete; the visit period grows with project/source pairs.
			response.partial ||= entry.status !== 'complete' && entry.status !== 'stale';
		};
		const phaseTimeout = Math.max(1, Math.floor(this.timeoutMs / 2));
		const timed = async (work: (deadline: AbortSignal) => Promise<void>) => {
			await withDeadline(work, {
				timeoutMs: phaseTimeout,
				timeoutError: () => new DOMException('Search timed out', 'TimeoutError'),
				signal,
			}).catch((error) => {
				signal?.throwIfAborted();
				if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
				coverage({ source: 'search', status: 'timeout' });
			});
		};
		await timed(async (deadline) => {
			const ids = request.project_id
				? [request.project_id]
				: (await this.catalog.getCurrentSnapshot()).projects
						.filter((p) => p.status !== 'deleted')
						.map((p) => p.id);
			let embedding: { space: string; vector: number[] } | undefined;
			if (request.mode === 'hybrid') {
				if (this.embeddings) {
					try {
						let vector = this.queryEmbeddings.get(request.q);
						if (!vector) {
							const vectors = await embedWithDeadline(this.embeddings, [request.q], {
								timeoutMs: 500,
								signal: deadline,
							});
							vector = vectors[0];
							this.queryEmbeddings.set(request.q, vector);
						}
						embedding = { space: this.embeddings.space, vector };
					} catch {
						deadline.throwIfAborted();
						coverage({ source: 'semantic', status: 'unavailable' });
					}
				} else {
					coverage({ source: 'semantic', status: 'disabled' });
				}
			}
			const selected = this.sources.filter(
				(source) => !request.kinds || source.kinds.some((k) => request.kinds!.includes(k)),
			);
			for (const kind of request.kinds ?? [])
				if (!this.sources.some((s) => s.kinds.includes(kind))) {
					coverage({ source: kind, status: 'disabled' });
				}
			const { accessible: projects, scanTruncated } = await this.accessibleProjects(
				ids,
				principal,
				deadline,
				() => coverage({ source: 'search', status: 'unavailable' }),
			);
			if (scanTruncated || projects.length > MAX_SEARCH_PROJECTS)
				coverage({ source: 'projects', status: 'truncated' });
			await mapWithConcurrency(projects.slice(0, MAX_SEARCH_PROJECTS), 2, async (project) => {
				const projectId = project.id;
				for (const source of selected) {
					deadline.throwIfAborted();
					try {
						const result = await withDeadline(
							async (providerSignal) => {
								const found = await this.index.candidates(
									{ projectId, source: source.id },
									{ query: request.q, kinds: request.kinds, embedding },
									providerSignal,
								);
								providerSignal.throwIfAborted();
								if (!found.indexedAt) return { status: 'not_indexed' as const };
								const oversizedLinks = found.documents.some(
									(d) => resourceHref(projectId, d).length > 4096,
								);
								const authorized = await source.validate(
									project,
									found.documents.filter((d) => resourceHref(projectId, d).length <= 4096),
									principal,
									'rank',
									providerSignal,
								);
								providerSignal.throwIfAborted();
								const rows = rank(authorized.documents, request.q, embedding).slice(
									0,
									request.limit,
								);
								const indexedAt = found.verifiedAt ?? found.indexedAt;
								return {
									batch: { project, source, indexedAt, rows },
									status:
										found.partial || oversizedLinks || authorized.partial
											? ('partial' as const)
											: Date.now() - Date.parse(indexedAt) > STALE_AFTER_MS
												? ('stale' as const)
												: ('complete' as const),
								};
							},
							{
								timeoutMs: Math.max(1, phaseTimeout - 50),
								timeoutError: () => new DOMException('Source timed out', 'TimeoutError'),
								signal: deadline,
							},
						);
						deadline.throwIfAborted();
						if (result.batch) batches.push(result.batch);
						coverage({
							source: source.id,
							project_id: projectId,
							status: result.status,
						});
					} catch (error) {
						deadline.throwIfAborted();
						coverage({
							source: source.id,
							project_id: projectId,
							status:
								error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
						});
					}
				}
			});
		});
		// Reserve half the deadline for final live checks, including sources that finished early.
		const best = batches
			.flatMap((batch) => batch.rows.map((row) => ({ batch, row })))
			.sort(
				(a, b) => b.row.score - a.row.score || a.row.document.id.localeCompare(b.row.document.id),
			)
			.slice(0, request.limit);
		const verified = new Set<(typeof best)[number]>();
		const names = new Map<ProjectId, string>();
		await timed(async (deadline) => {
			await mapWithConcurrency([...new Set(best.map((b) => b.batch))], 2, async (batch) => {
				const entries = best.filter((b) => b.batch === batch);
				const projectId = batch.project.id;
				try {
					deadline.throwIfAborted();
					const currentProject = await this.authorizedProject(projectId, principal);
					if (!currentProject) {
						coverage({ source: batch.source.id, project_id: projectId, status: 'partial' });
						return;
					}
					deadline.throwIfAborted();
					const live = await batch.source.validate(
						currentProject,
						entries.map((e) => e.row.document),
						principal,
						'return',
						deadline,
					);
					deadline.throwIfAborted();
					const valid = new Set(live.documents.map((d) => d.id));
					if (live.partial || valid.size < entries.length) {
						coverage({ source: batch.source.id, project_id: projectId, status: 'partial' });
					}
					names.set(projectId, currentProject.name.slice(0, 256));
					for (const entry of entries) if (valid.has(entry.row.document.id)) verified.add(entry);
				} catch {
					deadline.throwIfAborted();
					coverage({ source: batch.source.id, project_id: projectId, status: 'unavailable' });
				}
			});
		});
		response.items = best
			.filter((entry) => verified.has(entry))
			.map(({ batch, row: { document } }) => ({
				id: document.id,
				kind: document.kind,
				resource: document.resource,
				title: document.title,
				project_id: batch.project.id,
				project_name: names.get(batch.project.id)!,
				href: resourceHref(batch.project.id, document),
				indexed_at: batch.indexedAt,
				snippet: snippet(document.text, request.q),
			}));
		response.coverage = response.coverage.slice(0, 100);
		return SearchResponseSchema.parse(response);
	}
}
