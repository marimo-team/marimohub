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
import type { ProjectId } from '../ids';

interface RankedBatch {
	projectId: ProjectId;
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

	async search(
		principal: AuthenticatedPrincipal,
		input: SearchRequest,
		signal?: AbortSignal,
	): Promise<SearchResponse> {
		const request = SearchRequestSchema.parse(input);
		signal?.throwIfAborted();
		const response: SearchResponse = { items: [], partial: false, coverage: [] };
		const batches: RankedBatch[] = [];
		const phaseTimeout = Math.max(1, Math.floor(this.timeoutMs / 2));
		const timed = async (work: (deadline: AbortSignal) => Promise<void>) => {
			await withDeadline(work, {
				timeoutMs: phaseTimeout,
				timeoutError: () => new DOMException('Search timed out', 'TimeoutError'),
				signal,
			}).catch((error) => {
				signal?.throwIfAborted();
				if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
				response.partial = true;
				response.coverage.push({ source: 'search', status: 'timeout' });
			});
		};
		await timed(async (deadline) => {
			const ids = request.project_id
				? [request.project_id]
				: (await this.catalog.getCurrentSnapshot()).projects
						.filter((p) => p.status !== 'deleted')
						.map((p) => p.id);
			response.partial ||= ids.length > 16;
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
						response.coverage.push({ source: 'semantic', status: 'unavailable' });
						response.partial = true;
					}
				} else {
					response.coverage.push({ source: 'semantic', status: 'disabled' });
					response.partial = true;
				}
			}
			const selected = this.sources.filter(
				(source) => !request.kinds || source.kinds.some((k) => request.kinds!.includes(k)),
			);
			for (const kind of request.kinds ?? [])
				if (!this.sources.some((s) => s.kinds.includes(kind))) {
					response.coverage.push({ source: kind, status: 'disabled' });
					response.partial = true;
				}
			await mapWithConcurrency(ids.slice(0, 16), 2, async (projectId) => {
				deadline.throwIfAborted();
				const project = await this.projects
					.getProject(projectId, { consistency: 'validated' })
					.catch(() => null);
				if (
					!project ||
					!(await this.authz.authorize(principal, 'project.read', { kind: 'project', project }))
						.allowed
				)
					return;
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
								const privateFiltered = found.documents.filter(
									(d) =>
										(d.resource.type !== 'chat' || d.resource.owner_id === principal.id) &&
										resourceHref(projectId, d).length <= 4096,
								);
								const rankProject = await this.authorizedProject(projectId, principal);
								if (!rankProject) return { status: 'complete' as const };
								const authorized = await source.validate(
									rankProject,
									privateFiltered,
									principal,
									'rank',
									providerSignal,
								);
								providerSignal.throwIfAborted();
								const rows = rank(authorized, request.q, embedding).slice(0, request.limit);
								return {
									batch: { projectId, source, indexedAt: found.indexedAt, rows },
									status:
										Date.now() - Date.parse(found.indexedAt) > 15 * 60_000
											? ('stale' as const)
											: found.partial || oversizedLinks
												? ('partial' as const)
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
						response.coverage.push({
							source: source.id,
							project_id: projectId,
							status: result.status,
						});
						response.partial ||= result.status !== 'complete';
					} catch (error) {
						deadline.throwIfAborted();
						response.partial = true;
						response.coverage.push({
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
		await timed(async (deadline) => {
			await mapWithConcurrency([...new Set(best.map((b) => b.batch))], 2, async (batch) => {
				const rows = best.filter((b) => b.batch === batch).map((b) => b.row);
				try {
					deadline.throwIfAborted();
					const project = await this.authorizedProject(batch.projectId, principal);
					if (!project) return;
					const live = await batch.source.validate(
						project,
						rows.map((r) => r.document),
						principal,
						'return',
						deadline,
					);
					const valid = new Set(
						live
							.filter((d) => d.resource.type !== 'chat' || d.resource.owner_id === principal.id)
							.map((d) => d.id),
					);
					const currentProject = await this.authorizedProject(batch.projectId, principal);
					if (!currentProject) return;
					deadline.throwIfAborted();
					if (valid.size < rows.length) {
						response.partial = true;
						const coverage = response.coverage.find(
							(c) => c.source === batch.source.id && c.project_id === batch.projectId,
						);
						if (coverage?.status === 'complete') coverage.status = 'partial';
					}
					response.items.push(
						...rows
							.filter((r) => valid.has(r.document.id))
							.map(({ document, score }) => ({
								id: document.id,
								kind: document.kind,
								resource: document.resource,
								title: document.title,
								project_id: batch.projectId,
								project_name: currentProject.name.slice(0, 256),
								score,
								href: resourceHref(batch.projectId, document),
								indexed_at: batch.indexedAt,
								snippet: snippet(document.text, request.q),
							})),
					);
				} catch {
					deadline.throwIfAborted();
					response.partial = true;
					response.coverage.push({
						source: batch.source.id,
						project_id: batch.projectId,
						status: 'unavailable',
					});
				}
			});
		});
		response.items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		response.coverage = response.coverage.slice(0, 100);
		return SearchResponseSchema.parse(response);
	}
}
