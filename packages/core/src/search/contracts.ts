import { z } from 'zod';
import { ProjectIdSchema, NotebookIdSchema, IntegrationIdSchema } from '../schema';
import type { ProjectId } from '../ids';
import type { AuthenticatedPrincipal } from '../ports/auth';
import type { Project } from '../schema';
import {
	MAX_INDEX_DOCUMENTS,
	MAX_SEARCH_TEXT_LENGTH,
	MAX_SEARCH_CURSOR_LENGTH,
	MAX_EMBEDDING_DIMENSIONS,
} from './limits';

export { MAX_INDEX_BYTES, MAX_INDEX_DOCUMENTS } from './limits';
export const SEARCH_KINDS = [
	'notebook',
	'code',
	'output',
	'datasource',
	'namespace',
	'table',
	'column',
	'chat',
] as const;
export const SearchKindSchema = z.enum(SEARCH_KINDS);
export const SearchRequestSchema = z.object({
	q: z.string().trim().min(1).max(256),
	project_id: ProjectIdSchema.optional(),
	kinds: z.array(SearchKindSchema).min(1).max(SEARCH_KINDS.length).optional(),
	limit: z.number().int().min(1).max(50).default(20),
	mode: z.enum(['keyword', 'hybrid']).default('keyword'),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export const SearchResourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('notebook'), notebook_id: NotebookIdSchema }),
	z.object({
		type: z.literal('integration'),
		integration_id: IntegrationIdSchema,
		version: z.number().int().positive(),
		namespace: z.array(z.string().max(256)).max(16).optional(),
		table: z.string().max(256).optional(),
		column: z.string().max(256).optional(),
	}),
	z.object({
		type: z.literal('chat'),
		conversation_id: z.string().max(256),
		owner_id: z.string().max(256),
		message_id: z.string().max(256).optional(),
	}),
]);
export const SearchDocumentSchema = z.object({
	id: z.string().min(1).max(1024),
	kind: SearchKindSchema,
	resource: SearchResourceSchema,
	title: z.string().max(256),
	text: z.string().max(MAX_SEARCH_TEXT_LENGTH),
	fingerprint: z.string().max(256),
	// Only notebook sources can opt into sending content to an embedding provider.
	embedding: z
		.object({
			space: z.string().max(512),
			vector: z.array(z.number()).min(1).max(MAX_EMBEDDING_DIMENSIONS),
		})
		.optional(),
});
export type SearchDocument = z.infer<typeof SearchDocumentSchema>;
export const SearchSnapshotSchema = z.object({
	schema_version: z.literal(1),
	indexed_at: z.iso.datetime(),
	partial: z.boolean(),
	documents: z.array(SearchDocumentSchema).max(MAX_INDEX_DOCUMENTS),
});
export type SearchSnapshot = z.infer<typeof SearchSnapshotSchema>;
export const SearchBuildSchema = z.object({
	revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	source_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	configuration: z.string().max(2048),
});
export type SearchBuild = z.infer<typeof SearchBuildSchema>;
export const SearchHeadSchema = z.object({
	schema_version: z.literal(1),
	generation: z.uuid(),
	deleted: z.boolean(),
	fence: z.uuid().optional(),
	build: SearchBuildSchema.optional(),
	key: z.string().max(1024).nullable(),
});
export type SearchHead = z.infer<typeof SearchHeadSchema>;
export const SearchCursorSchema = z.object({
	after: z.string().max(1024),
	cleanup: z.string().max(2048).optional(),
});
export const SearchCheckpointSchema = z.object({
	build: SearchBuildSchema.optional(),
	ready: z.boolean().default(false),
	schema_version: z.literal(1),
	generation: z.uuid(),
	revision: z.string().nullable(),
	cursor: z.string().max(MAX_SEARCH_CURSOR_LENGTH).optional(),
	pages: z.array(z.uuid()).max(1000),
	count: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	partial: z.boolean(),
});
export const SearchHitSchema = SearchDocumentSchema.pick({
	id: true,
	kind: true,
	resource: true,
	title: true,
}).extend({
	project_id: ProjectIdSchema,
	project_name: z.string().max(256),
	score: z
		.number()
		.describe('Unstable ranking detail. Preserve response order; do not apply score thresholds.'),
	href: z.string().max(4096),
	indexed_at: z.iso.datetime(),
	snippet: z.object({
		text: z.string().max(400),
		highlights: z
			.array(
				z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
			)
			.max(200),
	}),
});
export const SearchResponseSchema = z.object({
	items: z.array(SearchHitSchema).max(50),
	partial: z.boolean(),
	coverage: z
		.array(
			z.object({
				source: z.string().max(64),
				project_id: ProjectIdSchema.optional(),
				status: z.enum([
					'complete',
					'partial',
					'unavailable',
					'timeout',
					'not_indexed',
					'stale',
					'disabled',
				]),
			}),
		)
		.max(100),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export interface SearchScope {
	projectId: ProjectId;
	source: string;
}
export interface SearchCandidatesRequest {
	query: string;
	kinds?: SearchRequest['kinds'];
	embedding?: SearchDocument['embedding'];
}
export interface SearchRetriever {
	candidates(
		scope: SearchScope,
		request: SearchCandidatesRequest,
		signal: AbortSignal,
	): Promise<{ documents: SearchDocument[]; indexedAt?: string; partial: boolean }>;
}
export interface SearchRevision {
	revision: string | null;
	build?: SearchBuild;
	deleted: boolean;
}
/** Snapshot ingestion is separate from query retrieval; other engines can use different writers. */
export interface SearchSnapshotStore {
	prune?(scope: SearchScope, signal: AbortSignal): Promise<void>;
	head(scope: SearchScope, signal: AbortSignal): Promise<SearchRevision>;
	/** Fence incompatible older writers while retaining the published snapshot. Null means CAS conflict or superseded build. */
	claim(
		scope: SearchScope,
		build: SearchBuild,
		signal: AbortSignal,
	): Promise<SearchRevision | null>;
	read(
		scope: SearchScope,
		signal: AbortSignal,
	): Promise<{ revision: string | null; snapshot: SearchSnapshot | null }>;
	publish(
		scope: SearchScope,
		snapshot: SearchSnapshot | null,
		revision: string | null,
		signal: AbortSignal,
	): Promise<boolean>;
}
export interface SearchSource {
	readonly id: string;
	/** Increase when extraction or cursor interpretation changes. */
	readonly revision: number;
	readonly configuration?: string;
	readonly kinds: readonly SearchDocument['kind'][];
	page(
		project: Project,
		cursor: string | undefined,
		signal: AbortSignal,
	): Promise<{ documents: SearchDocument[]; cursor?: string; partial: boolean }>;
	/** Recheck source existence and freshness; no authorization results survive a query. */
	validate(
		project: Project,
		documents: SearchDocument[],
		principal: AuthenticatedPrincipal,
		phase: 'rank' | 'return',
		signal: AbortSignal,
	): Promise<SearchDocument[]>;
}
export interface EmbeddingProvider {
	readonly space: string;
	embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}
export function terms(text: string): string[] {
	return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
}
