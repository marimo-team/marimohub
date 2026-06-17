import { z } from 'zod';
import { ProjectId, NotebookId, SnapshotId, VersionId, SessionId } from './ids';

// --- Schema versioning ---
//
// Every persisted object carries `schema_version`. Writers always stamp the
// CURRENT version (see the constants below). Readers are intentionally
// forward-tolerant: the object schemas accept any positive integer
// `schema_version`, so an object written by a newer replica during a rolling
// deploy (e.g. a v2 snapshot) does not crash an older reader. Normalizing a
// forward-read object to the in-memory shape is the job of an upgrade seam
// (see `upgradeSnapshot` in CatalogService), not the parser.
//
// To bump a version: change the relevant CURRENT_* constant (writers follow it)
// and add the upgrade branch in the corresponding seam. The read schema does
// not change — it already tolerates the new version.

/** A persisted object's `schema_version`: any positive integer on read. */
const SchemaVersionSchema = z.number().int().positive();

/** Current version stamped onto newly-written snapshots. */
export const CURRENT_SNAPSHOT_VERSION = 1;
/** Current version stamped onto newly-written projects. */
export const CURRENT_PROJECT_VERSION = 1;
/** Current version stamped onto newly-written notebook meta. */
export const CURRENT_NOTEBOOK_META_VERSION = 1;
/** Current version stamped onto newly-written source records. */
export const CURRENT_SOURCE_VERSION = 1;
/** Current version stamped onto newly-written versions. */
export const CURRENT_VERSION_VERSION = 1;
/** Current version stamped onto newly-written events. */
export const CURRENT_EVENT_VERSION = 1;

// --- ID schemas ---

// proj/nb/snap/sess ids are lowercase, hyphen-separated, 16-char random bodies
// (subdomain-safe, see ids.ts). ver ids stay uppercase ULIDs because their
// lexicographic order is load-bearing (version pruning).
export const ProjectIdSchema = z
	.string()
	.regex(/^proj-[0-9a-z]{16}$/)
	.transform((val) => val as ProjectId);
export const NotebookIdSchema = z
	.string()
	.regex(/^nb-[0-9a-z]{16}$/)
	.transform((val) => val as NotebookId);
export const SnapshotIdSchema = z
	.string()
	.regex(/^snap-[0-9a-z]{16}$/)
	.transform((val) => val as SnapshotId);
export const VersionIdSchema = z
	.string()
	.regex(/^ver_[0-9A-Z]{26}$/)
	.transform((val) => val as VersionId);
export const SessionIdSchema = z
	.string()
	.regex(/^sess-[0-9a-z]{16}$/)
	.transform((val) => val as SessionId);

// --- Catalog ---

export const CatalogSchema = z.object({
	version: z.literal(1),
	updated_at: z.iso.datetime(),
	current_snapshot_id: SnapshotIdSchema,
	current_snapshot_key: z.string(),
	previous_snapshot_id: SnapshotIdSchema.nullable(),
});

export type Catalog = z.infer<typeof CatalogSchema>;

// --- Snapshot ---

export const SnapshotNotebookEntrySchema = z.object({
	id: NotebookIdSchema,
	title: z.string(),
	description: z.string(),
	status: z.enum(['draft', 'active', 'archived', 'deleted']),
	source_type: z.enum(['local', 'github']),
	author: z.string(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	tags: z.array(z.string()),
	last_run_at: z.iso.datetime().nullable(),
	key_prefix: z.string(),
});

export type SnapshotNotebookEntry = z.infer<typeof SnapshotNotebookEntrySchema>;

export const SnapshotProjectEntrySchema = z.object({
	id: ProjectIdSchema,
	name: z.string(),
	description: z.string(),
	owner: z.string(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	notebook_count: z.number().int().nonnegative(),
	notebooks: z.array(SnapshotNotebookEntrySchema),
});

export type SnapshotProjectEntry = z.infer<typeof SnapshotProjectEntrySchema>;

// Public API shapes: `key_prefix` is an internal physical path and is never
// exposed to clients. The stored snapshot keeps it; the API strips it.
export type PublicNotebookEntry = Omit<SnapshotNotebookEntry, 'key_prefix'>;
export type PublicProjectEntry = Omit<SnapshotProjectEntry, 'notebooks'> & {
	notebooks: PublicNotebookEntry[];
};

export function toPublicNotebookEntry(entry: SnapshotNotebookEntry): PublicNotebookEntry {
	const { key_prefix: _key_prefix, ...rest } = entry;
	return rest;
}

export function toPublicProjectEntry(entry: SnapshotProjectEntry): PublicProjectEntry {
	return { ...entry, notebooks: entry.notebooks.map(toPublicNotebookEntry) };
}

// `looseObject` (not `object`): a snapshot is the one object that is read,
// mutated in memory, and re-written by *any* replica (`CatalogService`'s lazy
// upgrade + CAS commit). During a rolling deploy an old replica may read a
// snapshot a newer replica wrote with extra fields; a strict object would strip
// those unknown keys on the round-trip, silently destroying the newer data.
// Preserving unknown fields is the "old code tolerates new" half of the
// rolling-deploy compatibility policy (see docs/migrations.md). The matching
// "never downgrade the version" half lives in `CatalogService.mutateSnapshot`.
export const SnapshotSchema = z.looseObject({
	snapshot_id: SnapshotIdSchema,
	schema_version: SchemaVersionSchema,
	created_at: z.iso.datetime(),
	operation: z.string(),
	actor: z.string(),
	projects: z.array(SnapshotProjectEntrySchema),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

// --- Project ---

export const ProjectMemberSchema = z.object({
	user_id: z.string(),
	role: z.enum(['admin', 'editor', 'viewer']),
});

export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const ProjectSchema = z.object({
	schema_version: SchemaVersionSchema,
	id: ProjectIdSchema,
	name: z.string(),
	description: z.string(),
	owner: z.string(),
	members: z.array(ProjectMemberSchema),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	tags: z.array(z.string()),
});

export type Project = z.infer<typeof ProjectSchema>;

// --- Notebook meta ---

export const RuntimeSchema = z.object({
	python_version: z.string().optional(),
	marimo_version: z.string().optional(),
});

export type Runtime = z.infer<typeof RuntimeSchema>;

export const NotebookMetaSchema = z.object({
	schema_version: SchemaVersionSchema,
	id: NotebookIdSchema,
	project_id: ProjectIdSchema,
	title: z.string(),
	description: z.string(),
	status: z.enum(['draft', 'active', 'archived', 'deleted']),
	author: z.string(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	last_run_at: z.iso.datetime().nullable(),
	tags: z.array(z.string()),
	runtime: RuntimeSchema.optional(),
});

export type NotebookMeta = z.infer<typeof NotebookMetaSchema>;

// --- Source ---

export const LocalSourceSchema = z.object({
	// NOTE: SourceSchema discriminates on `type` (below), NOT on schema_version,
	// so loosening schema_version here does not weaken the discriminated union.
	schema_version: SchemaVersionSchema,
	type: z.literal('local'),
	current_version_id: VersionIdSchema,
});

export const GithubSourceSchema = z.object({
	schema_version: SchemaVersionSchema,
	type: z.literal('github'),
	repo: z.string(),
	branch: z.string(),
	path: z.string(),
	commit: z.string(),
	last_synced_at: z.iso.datetime(),
});

export const SourceSchema = z.discriminatedUnion('type', [LocalSourceSchema, GithubSourceSchema]);

export type Source = z.infer<typeof SourceSchema>;
export type LocalSource = z.infer<typeof LocalSourceSchema>;
export type GithubSource = z.infer<typeof GithubSourceSchema>;

// --- Version ---

export const VersionSchema = z.object({
	schema_version: SchemaVersionSchema,
	version_id: VersionIdSchema,
	notebook_id: NotebookIdSchema,
	saved_at: z.iso.datetime(),
	author: z.string(),
	message: z.string(),
	parent_id: VersionIdSchema.nullable(),
});

export type Version = z.infer<typeof VersionSchema>;

// --- Session ---

export const SessionSchema = z.object({
	session_id: SessionIdSchema,
	notebook_id: NotebookIdSchema,
	project_id: ProjectIdSchema,
	user_id: z.string(),
	status: z.enum(['starting', 'running', 'idle', 'terminated', 'expired']),
	started_at: z.iso.datetime(),
	last_heartbeat: z.iso.datetime(),
	runtime: RuntimeSchema.optional(),
	sandbox_id: z.string().optional(),
	sandbox_url: z.string().optional(),
	used_fallback: z.boolean().optional(),
});

export type Session = z.infer<typeof SessionSchema>;

// --- Event ---

export const EventSchema = z.looseObject({
	schema_version: SchemaVersionSchema,
	ts: z.iso.datetime(),
	event: z.string(),
	actor: z.string(),
});

export type Event = z.infer<typeof EventSchema>;
