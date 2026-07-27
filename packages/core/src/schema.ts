import { z } from 'zod';
import {
	NOTEBOOK_STATUSES,
	PROJECT_STATUSES,
	ROLES,
	SESSION_MODES,
	SESSION_STATUSES,
	SOURCE_TYPES,
} from './constants';
import {
	ProjectId,
	NotebookId,
	SnapshotId,
	VersionId,
	SessionId,
	SandboxId,
	TokenId,
	UserId,
} from './ids';

// --- Schema versioning ---
//
// Only the immutable / append-only objects carry `schema_version`: snapshots,
// `project.json`, `meta.json`, `source.json`, `version.json`, and events. These
// persist indefinitely and are never rewritten in place, so a future schema bump
// needs an upgrade seam (lazy or fan-out) keyed on the version — see
// development_docs/migrations.md. Writers always stamp the CURRENT version (the
// constants below). Readers are intentionally forward-tolerant: the schemas accept
// any positive integer `schema_version`, so an object written by a newer replica
// during a rolling deploy (e.g. a v2 snapshot) does not crash an older reader.
// Normalizing a forward-read object to the in-memory shape is the job of the
// upgrade seam (see `upgradeSnapshot` in CatalogService), not the parser.
//
// The mutable, last-writer-wins objects (Session, Identity, FsSnapshot) carry NO
// `schema_version`: they are rewritten constantly or reaped, so they never need a
// migration and evolve safely through optional fields + zod defaults instead. The
// catalog pointer is its own case — a strict `version` literal, migrated in place
// on first write (so it is deliberately NOT forward-tolerant).
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

/**
 * Parse an object read from storage, turning a schema mismatch into a clearly
 * labeled error. A bare `ZodError` reaching the request path becomes an opaque
 * 500; wrapping it with `what` (the object's identity) and keeping the `ZodError`
 * as `cause` means the server log says exactly which stored object is corrupted —
 * while the client still gets the standard sanitized 500.
 */
export function parseStored<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	throw new Error(`Corrupted stored object: ${what}`, { cause: result.error });
}

// --- ID schemas ---

// zod narrows `.refine(guard)` output to the guard's type, so refining with the
// `XId.is` guards (defined in ids.ts) both validates the format and brands the
// value — no `as` cast, and the regex lives only in ids.ts.
export const ProjectIdSchema = z.string().refine(ProjectId.is);
export const NotebookIdSchema = z.string().refine(NotebookId.is);
export const SnapshotIdSchema = z.string().refine(SnapshotId.is);
export const VersionIdSchema = z.string().refine(VersionId.is);
export const SessionIdSchema = z.string().refine(SessionId.is);
export const SandboxIdSchema = z.string().refine(SandboxId.is);
export const TokenIdSchema = z.string().refine(TokenId.is);
// User ids (`author`/`owner`/`user_id`/`actor` foreign keys) are the opaque auth
// `sub`. UserId.is only checks non-empty, so this brands without imposing a
// format the identity provider doesn't guarantee.
export const UserIdSchema = z.string().refine(UserId.is);

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
	status: z.enum(NOTEBOOK_STATUSES),
	source_type: z.enum(SOURCE_TYPES),
	author: UserIdSchema,
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	tags: z.array(z.string()),
	last_run_at: z.iso.datetime().nullable(),
	key_prefix: z.string(),
});

export type SnapshotNotebookEntry = z.infer<typeof SnapshotNotebookEntrySchema>;

// `looseObject` for the same rolling-deploy reason as SnapshotSchema below:
// entries round-trip through every replica's parse during a catalog CAS
// mutation, and a strict object would strip fields added by a newer version
// (exactly what happened to `member_emails` under strict parsing). The public
// projection (`toPublicProjectEntry`) is an explicit pick, so preserved unknown
// keys never leak into API responses.
export const SnapshotProjectEntrySchema = z.looseObject({
	id: ProjectIdSchema,
	name: z.string(),
	description: z.string(),
	owner: UserIdSchema,
	// Defaulted so catalog entries written before projects had a status (which
	// omit the field) still parse — zod fills 'active' on read. Like notebooks,
	// 'deleted' is a soft-delete tombstone; the deletion time is `updated_at`.
	status: z.enum(PROJECT_STATUSES).default('active'),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	notebook_count: z.number().int().nonnegative(),
	notebooks: z.array(SnapshotNotebookEntrySchema),
	// Denormalized roster (user ids of `owner` + every member) so the project
	// list can be filtered to a caller's visible projects in-memory, without an
	// extra `project.json` read per entry — see ProjectService.listProjects and
	// bucket_spec.md §12. Optional: entries written before this field existed omit
	// it, and the list falls back to loading `project.json` for those.
	member_ids: z.array(UserIdSchema).optional(),
	// Companion roster for pending email invites (lowercased). Unlike a missing
	// `member_ids`, a missing `member_emails` does NOT trigger the project.json
	// fallback — see canSeeProjectEntry for why it fails closed instead.
	// Lowercased on parse so authz matching against a lowercased subject email holds
	// regardless of the case an invite was stored in.
	member_emails: z.array(z.string().transform((e) => e.toLowerCase())).optional(),
});

export type SnapshotProjectEntry = z.infer<typeof SnapshotProjectEntrySchema>;

// Public API shapes: `key_prefix` is an internal physical path and is never
// exposed to clients. The stored snapshot keeps it; the API strips it.
export type PublicNotebookEntry = Omit<SnapshotNotebookEntry, 'key_prefix'>;

// The project-list entry drops the nested `notebooks` array entirely: it is
// unbounded (a project can hold thousands of notebooks) and would let one row
// blow up a page that is otherwise bounded by the cursor. Clients use
// `notebook_count` for the summary and page `GET /projects/{pid}/notebooks` for
// the list. `member_ids`/`member_emails` are server-side filtering aids, not
// part of the public contract, so they are stripped too. The bytes stay in the
// persisted snapshot — the GC sweep and the list filter read them.
export type PublicProjectEntry = Pick<
	SnapshotProjectEntry,
	| 'id'
	| 'name'
	| 'description'
	| 'owner'
	| 'status'
	| 'created_at'
	| 'updated_at'
	| 'notebook_count'
>;

export function toPublicNotebookEntry(entry: SnapshotNotebookEntry): PublicNotebookEntry {
	const { key_prefix: _key_prefix, ...rest } = entry;
	return rest;
}

// Explicit pick (not a rest-spread): the entry schema is loose, so unknown keys
// written by newer replicas survive parsing and MUST NOT leak into responses.
export function toPublicProjectEntry(entry: SnapshotProjectEntry): PublicProjectEntry {
	return {
		id: entry.id,
		name: entry.name,
		description: entry.description,
		owner: entry.owner,
		status: entry.status,
		created_at: entry.created_at,
		updated_at: entry.updated_at,
		notebook_count: entry.notebook_count,
	};
}

// `looseObject` (not `object`): a snapshot is the one object that is read,
// mutated in memory, and re-written by *any* replica (`CatalogService`'s lazy
// upgrade + CAS commit). During a rolling deploy an old replica may read a
// snapshot a newer replica wrote with extra fields; a strict object would strip
// those unknown keys on the round-trip, silently destroying the newer data.
// Preserving unknown fields is the "old code tolerates new" half of the
// rolling-deploy compatibility policy (see development_docs/migrations.md). The matching
// "never downgrade the version" half lives in `CatalogService.mutateSnapshot`.
export const SnapshotSchema = z.looseObject({
	snapshot_id: SnapshotIdSchema,
	schema_version: SchemaVersionSchema,
	created_at: z.iso.datetime(),
	operation: z.string(),
	actor: UserIdSchema,
	projects: z.array(SnapshotProjectEntrySchema),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

// --- Project ---

// A member is either a known user (by id) or a pending email invite: someone
// added before they ever logged in. Exactly one of the two identifiers is set.
// The schema lowercases emails on parse so the authz comparison (see authz.ts)
// can rely on the invariant even for rows written outside ProjectService. An
// email row is not rewritten to an id when the invitee first logs in — it keeps
// matching by email.
export const ProjectMemberSchema = z
	.object({
		user_id: UserIdSchema.optional(),
		email: z.string().toLowerCase().optional(),
		role: z.enum(ROLES),
	})
	.refine((m) => (m.user_id === undefined) !== (m.email === undefined), {
		message: 'a member has exactly one of user_id or email',
	});

export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

/**
 * Per-project workload-identity federation: whether this project's sandboxes
 * receive federated storage credentials ("when"), and which deployment-registered
 * federation target to use ("for what"). Absent/`enabled: false` = no federated
 * credentials, even when the deployment has WIF configured. The deployment owns
 * the capability (issuer + targets); a project admin opts in here.
 */
export const ProjectFederationSchema = z.object({
	enabled: z.boolean(),
	/**
	 * Target name this project selects, for when the deployment registers more than
	 * one. The deployment exposes a single target today, so this is accepted but not
	 * yet consulted.
	 */
	target: z.string().optional(),
});

export type ProjectFederation = z.infer<typeof ProjectFederationSchema>;

export const ProjectSchema = z.object({
	schema_version: SchemaVersionSchema,
	id: ProjectIdSchema,
	name: z.string(),
	description: z.string(),
	owner: UserIdSchema,
	members: z.array(ProjectMemberSchema),
	/** Optional WIF opt-in; see ProjectFederationSchema. */
	federation: ProjectFederationSchema.optional(),
	// Defaulted for backward compatibility: project.json written before this
	// field existed omits it and reads back as 'active'. See the matching field
	// on SnapshotProjectEntrySchema.
	status: z.enum(PROJECT_STATUSES).default('active'),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	tags: z.array(z.string()),
});

export type Project = z.infer<typeof ProjectSchema>;

// `schema_version` is an internal persistence/migration concern; the public API
// never exposes it. The detail responses project through these before serializing.
export type PublicProject = Omit<Project, 'schema_version'>;
export function toPublicProject(project: Project): PublicProject {
	const { schema_version: _schema_version, ...rest } = project;
	return rest;
}

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
	status: z.enum(NOTEBOOK_STATUSES),
	author: z.string(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	last_run_at: z.iso.datetime().nullable(),
	tags: z.array(z.string()),
	runtime: RuntimeSchema.optional(),
	// Absent = the deployment's default image. Only a non-default choice is
	// persisted; session start resolves it against the configured list and falls
	// back to the default when the image is no longer offered.
	base_image: z.string().optional(),
});

export type NotebookMeta = z.infer<typeof NotebookMetaSchema>;

export type PublicNotebookMeta = Omit<NotebookMeta, 'schema_version'>;
export function toPublicNotebookMeta(meta: NotebookMeta): PublicNotebookMeta {
	const { schema_version: _schema_version, ...rest } = meta;
	return rest;
}

// --- Source ---

export const LocalSourceSchema = z.object({
	// NOTE: SourceSchema discriminates on `type` (below), NOT on schema_version,
	// so loosening schema_version here does not weaken the discriminated union.
	schema_version: SchemaVersionSchema,
	type: z.literal('local'),
	current_version_id: VersionIdSchema,
});

// A git repository mirrored into the store by an external pusher (e.g. a CI
// workflow). The platform never reaches out to the host — content arrives by
// `push` only — so `provider` is informational (for display/links) and `repo`,
// `branch`, `commit` are plain git coordinates, host-agnostic. Sync fields are
// null until the first push lands; see `SyncedNotebookService`.
export const GitSourceSchema = z.object({
	schema_version: SchemaVersionSchema,
	type: z.literal('git'),
	provider: z.literal('github'),
	repo: z.string(),
	branch: z.string(),
	root_path: z.string(),
	entry_notebook: z.string(),
	sync_mode: z.literal('push'),
	current_version_id: VersionIdSchema.nullable(),
	commit: z.string().nullable(),
	last_synced_at: z.iso.datetime().nullable(),
});

export const SourceSchema = z.discriminatedUnion('type', [LocalSourceSchema, GitSourceSchema]);

export type Source = z.infer<typeof SourceSchema>;
export type LocalSource = z.infer<typeof LocalSourceSchema>;
export type GitSource = z.infer<typeof GitSourceSchema>;

export type PublicSource = Omit<LocalSource, 'schema_version'> | Omit<GitSource, 'schema_version'>;
export function toPublicSource(source: Source): PublicSource {
	const { schema_version: _schema_version, ...rest } = source;
	return rest;
}

// --- Version ---

// Records the presence and size of an optional artifact captured into a version
// folder on session teardown (the rendered `notebook.html` and the marimo
// `session.json`). It carries no storage path — clients address notebooks by id
// (see development_docs/bucket_spec.md §4.7). Absent when the artifact was not captured.
export const SnapshotDescriptorSchema = z.object({
	captured_at: z.iso.datetime(),
	size_bytes: z.number().int().nonnegative(),
});

export type SnapshotDescriptor = z.infer<typeof SnapshotDescriptorSchema>;

export const VersionSchema = z.object({
	schema_version: SchemaVersionSchema,
	version_id: VersionIdSchema,
	notebook_id: NotebookIdSchema,
	saved_at: z.iso.datetime(),
	author: UserIdSchema,
	message: z.string(),
	parent_id: VersionIdSchema.nullable(),
	// Optional teardown snapshots living beside the code in this version folder.
	// Forward-tolerant: a reader that predates these fields simply ignores them,
	// so no migration of existing version.json objects is required.
	html_snapshot: SnapshotDescriptorSchema.optional(),
	session_snapshot: SnapshotDescriptorSchema.optional(),
});

export type Version = z.infer<typeof VersionSchema>;

export type PublicVersion = Omit<Version, 'schema_version'>;
export function toPublicVersion(version: Version): PublicVersion {
	const { schema_version: _schema_version, ...rest } = version;
	return rest;
}

// --- Filesystem snapshot ---
//
// Per-notebook pointer to the current CoreWeave-native filesystem snapshot,
// stored in the mutable `fs_snapshot.json` sidecar (latest-wins). The id is an
// opaque provider-native string (NOT branded — unlike the catalog `SnapshotId`
// ULID). No `provider` field: the capability gate (`asFilesystemSnapshots`)
// already ensures only a snapshot-capable backend reads or writes this pointer,
// so a backend switch ignores it.
export const FsSnapshotSchema = z.object({
	snapshot_id: z.string(),
	captured_at: z.iso.datetime(),
	size_bytes: z.number().int().nonnegative().optional(),
});

export type FsSnapshot = z.infer<typeof FsSnapshotSchema>;

// --- Session ---

export const SessionSchema = z.object({
	session_id: SessionIdSchema,
	notebook_id: NotebookIdSchema,
	project_id: ProjectIdSchema,
	user_id: UserIdSchema,
	status: z.enum(SESSION_STATUSES),
	started_at: z.iso.datetime(),
	last_heartbeat: z.iso.datetime(),
	/**
	 * When the lifecycle sweep will gracefully reap this session (save + destroy).
	 * Stamped at `setRunning` as now + the session TTL, so the clock starts when the
	 * kernel is actually live; slides forward while editors stay connected
	 * (connection-aware extension). Absent on records that predate the sweep.
	 */
	expires_at: z.iso.datetime().optional(),
	/**
	 * Last time the periodic snapshotter saved the notebook back to the bucket.
	 * Cadence bookkeeping only — `commitSession` dedupes unchanged content, so this
	 * never gates on whether anything changed.
	 */
	last_snapshot_at: z.iso.datetime().optional(),
	/**
	 * Set once the lifecycle sweep has saved + destroyed the sandbox of an
	 * already-terminal (`expired`) record, so reclaim runs exactly once instead of
	 * re-probing a long-gone sandbox every sweep until the record is reaped.
	 */
	sandbox_reclaimed_at: z.iso.datetime().optional(),
	/**
	 * A viewer's throwaway session (MARIMOHUB_VIEWER_MODE=ephemeral-sandbox):
	 * nothing is written back at teardown — no version, HTML/session snapshot,
	 * workspace mirror, or FS snapshot. Every teardown/snapshot path must honor
	 * this. Absent = persisting (all records predating the flag).
	 */
	ephemeral: z.boolean().optional(),
	/**
	 * `edit` (per-user editor) or `app` (read-only, shared per notebook, never
	 * written back — see `sessionPersistsEdits`). Absent = `edit` (records
	 * predating the field); read via `sessionMode()`, never directly. Immutable
	 * for the session's life.
	 */
	mode: z.enum(SESSION_MODES).optional(),
	/**
	 * `app` only: the notebook's head version at provision. Never mutated after
	 * create — comparing it against the current head is what detects a stale app.
	 */
	source_version_id: VersionIdSchema.optional(),
	/**
	 * `app` only: connection count from the lifecycle sweep's last kernel probe —
	 * approximate by design (as fresh as the sweep cadence).
	 */
	active_connections: z.number().int().nonnegative().optional(),
	connections_checked_at: z.iso.datetime().optional(),
	runtime: RuntimeSchema.optional(),
	sandbox_id: SandboxIdSchema.optional(),
	sandbox_url: z.string().optional(),
	/**
	 * Server-reachable kernel endpoint, persisted only in `proxy` exposure mode so
	 * the app's `/proxy/*` forwarder can reach the kernel. Distinct from
	 * `sandbox_url` (the client-facing `…/proxy/<token>/` URL) and never returned in
	 * the API response. Absent in `subdomain` mode (the client reaches the kernel
	 * directly).
	 */
	sandbox_origin_url: z.string().optional(),
	used_fallback: z.boolean().optional(),
	/**
	 * Why a session went `failed` — a sanitized `{ code, message }` set by
	 * `markFailed` when a provision fails, so the client polling the record sees a
	 * reason instead of a bare `failed`. Optional: successful/older records omit it,
	 * and it NEVER carries secret material (see the projection in `sessions.ts`).
	 */
	error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export type Session = z.infer<typeof SessionSchema>;

// --- App claim ---
//
// Per-notebook pointer anchoring the "one app sandbox per notebook" singleton:
// `_system/apps/{pid}/{nid}.json` names the `run` session that owns the app.
// Written create-if-absent by the create saga's `app_claim` step (exactly one
// concurrent "Run as app" wins; losers attach to the winner via reuse) and
// replaced via ETag CAS when it points at a dead session. Beside the catalog
// pointer, this is the second CAS-managed mutable object in the store — all
// writes go through `SessionService.claimApp`/`releaseApp`.
//
// `session_id: null` is the free marker a release CAS-writes in place of a
// delete, so a release racing a re-acquire cannot drop the new holder's claim.
export const AppClaimSchema = z.object({
	session_id: SessionIdSchema.nullable(),
	claimed_at: z.iso.datetime(),
});

export type AppClaim = z.infer<typeof AppClaimSchema>;

// --- Identity ---
//
// A directory record mapping a stable user id (the auth `sub`) to its current
// human-readable identity. Upserted on every authenticated request (throttled),
// so it never goes stale: opaque ids stored as `author`/`user_id` foreign keys
// are resolved against this directory at read time. These are the one class of
// mutable, last-writer-wins per-user objects — distinct from the immutable
// content store and the CAS-guarded catalog pointer.
export const IdentitySchema = z.object({
	id: UserIdSchema,
	email: z.string(),
	name: z.string(),
	updated_at: z.iso.datetime(),
});

export type Identity = z.infer<typeof IdentitySchema>;

// --- Personal access token ---
//
// A machine credential acting as its issuing user (CI, scripts, the CLI). Only
// the SHA-256 of the secret is stored. A mutable per-token object (the coarse
// `last_used_at` refresh rewrites it), so it carries no `schema_version`.
//
// `looseObject` for the same rolling-deploy reason as the snapshot schemas: the
// `last_used_at` touch reads-modifies-writes the whole record, so a strict parse
// would strip fields a newer replica added and silently downgrade the object.
// The API projection (`toResponse` in routes/tokens.ts) is an explicit pick, so
// preserved unknown keys never leak into a response.
export const TokenSchema = z.looseObject({
	id: TokenIdSchema,
	user_id: UserIdSchema,
	name: z.string(),
	/** Lowercase-hex SHA-256 of the token secret. Never leaves the server. */
	hash: z.string(),
	created_at: z.iso.datetime(),
	expires_at: z.iso.datetime().optional(),
	/** Daily-coalesced usage marker (last-writer-wins, like the identity directory). */
	last_used_at: z.iso.datetime().optional(),
});

export type Token = z.infer<typeof TokenSchema>;

// Explicit Pick (not Omit): the schema is loose, so `Token` carries an index
// signature; `Omit` would collapse the named keys under it (and preserved
// unknown fields must never leak into a response anyway — same reasoning as
// `toPublicProjectEntry`). The one field to hide is `hash`.
export type PublicToken = Pick<
	Token,
	'id' | 'user_id' | 'name' | 'created_at' | 'expires_at' | 'last_used_at'
>;
export function toPublicToken(token: Token): PublicToken {
	return {
		id: token.id,
		user_id: token.user_id,
		name: token.name,
		created_at: token.created_at,
		...(token.expires_at !== undefined ? { expires_at: token.expires_at } : {}),
		...(token.last_used_at !== undefined ? { last_used_at: token.last_used_at } : {}),
	};
}

// --- Event ---

export const EventSchema = z.looseObject({
	schema_version: SchemaVersionSchema,
	ts: z.iso.datetime(),
	event: z.string(),
	actor: UserIdSchema,
});

export type Event = z.infer<typeof EventSchema>;
