import { z } from 'zod';
import { ResourceSecurityLabelsSchema } from './securityLabels';
import { TokenGrantSchema } from './tokenGrants';
import { DomainError } from './errors';
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
	ProposalId,
	SessionId,
	SandboxId,
	TokenId,
	IntegrationId,
	AlertDestinationId,
	JobId,
	RunId,
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
// Mutable operational objects (Session, Identity, FsSnapshot) carry NO
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

const MAX_STORED_OBJECT_ISSUES = 20;

/**
 * Parse an object read from storage, turning a schema mismatch into a labeled
 * error. Diagnostics retain field paths and issue codes, but not stored values
 * or validator messages.
 */
export class StoredObjectError extends DomainError {
	readonly code = 'SERVICE_UNAVAILABLE';
	readonly status = 503;
	readonly reason: 'invalid_json' | 'schema_mismatch';
	readonly object: string;
	readonly issues?: { path: string; code: string }[];
	readonly cause_name?: string;

	constructor(
		what: string,
		reason: 'invalid_json' | 'schema_mismatch',
		options?: { issues?: { path: string; code: string }[]; causeName?: string },
	) {
		super('Stored data is temporarily unavailable');
		this.name = 'StoredObjectError';
		this.object = what;
		this.reason = reason;
		this.issues = options?.issues;
		this.cause_name = options?.causeName;
	}
}

export function parseStored<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	throw new StoredObjectError(what, 'schema_mismatch', {
		issues: result.error.issues.slice(0, MAX_STORED_OBJECT_ISSUES).map((issue) => ({
			path: issue.path.map(String).join('.'),
			code: issue.code,
		})),
	});
}

export async function readStored<T>(
	schema: z.ZodType<T>,
	body: { json(): Promise<unknown> },
	what: string,
): Promise<T> {
	return parseStored(schema, await readStoredJson(body, what), what);
}

export async function readStoredJson(
	body: { json(): Promise<unknown> },
	what: string,
): Promise<unknown> {
	let value: unknown;
	try {
		value = await body.json();
	} catch (err) {
		throw new StoredObjectError(what, 'invalid_json', {
			causeName: err instanceof Error ? err.name : `non-error(${typeof err})`,
		});
	}
	return value;
}

// --- ID schemas ---

// zod narrows `.refine(guard)` output to the guard's type, so refining with the
// `XId.is` guards (defined in ids.ts) both validates the format and brands the
// value — no `as` cast, and the regex lives only in ids.ts.
export const ProjectIdSchema = z.string().refine(ProjectId.is);
export const NotebookIdSchema = z.string().refine(NotebookId.is);
export const SnapshotIdSchema = z.string().refine(SnapshotId.is);
export const VersionIdSchema = z.string().refine(VersionId.is);
export const ProposalIdSchema = z.string().refine(ProposalId.is);
export const SessionIdSchema = z.string().refine(SessionId.is);
export const SandboxIdSchema = z.string().refine(SandboxId.is);
export const TokenIdSchema = z.string().refine(TokenId.is);
export const IntegrationIdSchema = z.string().refine(IntegrationId.is);
export const AlertDestinationIdSchema = z.string().refine(AlertDestinationId.is);
export const JobIdSchema = z.string().refine(JobId.is);
export const RunIdSchema = z.string().refine(RunId.is);
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

export const JobScheduleSchema = z.looseObject({
	/** Five-field cron expression, validated at write time (see services/jobs/cron.ts). */
	cron: z.string().min(1).max(100),
	/** IANA time zone the cron fields are evaluated in. */
	timezone: z.string().min(1).max(64),
});

export type JobSchedule = z.infer<typeof JobScheduleSchema>;

/**
 * The snapshot's per-notebook job index: just enough for the scheduler to find
 * every scheduled job without scanning `projects/**`. `job.json` stays
 * authoritative for the full definition. Maintained by `JobsService` through
 * `CatalogService.mutateSnapshot`, so the catalog invariant is untouched.
 */
export const SnapshotJobEntrySchema = z.looseObject({
	id: JobIdSchema,
	enabled: z.boolean(),
	schedule: JobScheduleSchema.optional(),
	updated_at: z.iso.datetime().optional(),
});

export type SnapshotJobEntry = z.infer<typeof SnapshotJobEntrySchema>;

export const SnapshotNotebookEntrySchema = z.looseObject({
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
	compute_profile: z.string().optional(),
	/**
	 * Notebook security-label OVERRIDE projection, mirroring the tri-state on
	 * `SnapshotProjectEntrySchema.security_labels`: object = overridden, `null`
	 * = known no-override, absent = indeterminate. Enforcement evaluates the
	 * project labels AND the override, so an override can only add restrictions.
	 */
	security_labels: ResourceSecurityLabelsSchema.nullable().optional(),
	/**
	 * Set while a label mutation is in flight. Routine projections preserve it
	 * and keep `security_labels` indeterminate; only the mutation's own
	 * finalization clears it (see `catalogProjection.ts`).
	 */
	security_labels_pending: z.literal(true).optional(),
	/** Job index (see `SnapshotJobEntrySchema`); absent = no jobs defined. */
	jobs: z.array(SnapshotJobEntrySchema).optional(),
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
	// Filtering aid added after the v1 snapshot shape shipped. Legacy entries
	// omit it; ProjectService falls back to project.json for those entries.
	tags: z.array(z.string()).optional(),
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
	/**
	 * Denormalized security-label projection for list filtering ahead of
	 * pagination. Tri-state: an object = labeled, `null` = KNOWN unlabeled,
	 * absent = indeterminate (a legacy entry, or a label mutation in flight) —
	 * an indeterminate entry must be decided from the authoritative
	 * `project.json`, never treated as unlabeled. The authoritative write and
	 * this projection are not atomic; the label mutation flow parks the
	 * projection at indeterminate first so a crash between the writes can only
	 * fail closed.
	 */
	security_labels: ResourceSecurityLabelsSchema.nullable().optional(),
	/**
	 * Set while a label mutation is in flight. Routine projections preserve it
	 * and keep `security_labels` indeterminate; only the mutation's own
	 * finalization clears it (see `catalogProjection.ts`).
	 */
	security_labels_pending: z.literal(true).optional(),
});

export type SnapshotProjectEntry = z.infer<typeof SnapshotProjectEntrySchema>;

// Public API shapes: `key_prefix` is an internal physical path and is never
// exposed to clients. The stored snapshot keeps it; the API strips it.
export type PublicNotebookEntry = Pick<
	SnapshotNotebookEntry,
	| 'id'
	| 'title'
	| 'description'
	| 'status'
	| 'source_type'
	| 'author'
	| 'created_at'
	| 'updated_at'
	| 'tags'
	| 'last_run_at'
	| 'compute_profile'
>;

// The project-list entry drops the nested `notebooks` array entirely: it is
// unbounded (a project can hold thousands of notebooks) and would let one row
// blow up a page that is otherwise bounded by the cursor. Clients use
// `notebook_count` for the summary and page `GET /projects/{pid}/notebooks` for
// the list. `tags`, `member_ids`, and `member_emails` are server-side filtering
// aids, not part of the public contract, so they are stripped too. The bytes
// stay in the persisted snapshot — the GC sweep and list filters read them.
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
	return {
		id: entry.id,
		title: entry.title,
		description: entry.description,
		status: entry.status,
		source_type: entry.source_type,
		author: entry.author,
		created_at: entry.created_at,
		updated_at: entry.updated_at,
		tags: entry.tags,
		last_run_at: entry.last_run_at,
		compute_profile: entry.compute_profile,
	};
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

// --- Email addresses ---

// Match the trusted IdP boundary: some providers issue addresses such as
// `user@localhost` that z.email rejects. Transport-unsafe input still fails.
export const EmailAddressSchema = z.string().refine(
	(value) => {
		if (value.length > 320 || /\s/.test(value)) return false;
		for (const character of value) {
			const code = character.charCodeAt(0);
			if (code <= 31 || code === 127) return false;
		}
		const at = value.indexOf('@');
		return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1;
	},
	{ message: 'Invalid email address' },
);

// --- Project ---

// A member is either a known user (by id) or a pending email invite: someone
// added before they ever logged in. Exactly one of the two identifiers is set.
// The schema lowercases emails on parse so the authz comparison (see authz.ts)
// can rely on the invariant even for rows written outside ProjectService. An
// email row keeps matching during the pending window, then becomes an id row on
// the next membership write or maintenance sweep after the invitee signs in.
export const ProjectMemberSchema = z
	.object({
		user_id: UserIdSchema.optional(),
		email: EmailAddressSchema.transform((email) => email.toLowerCase()).optional(),
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
 * the capability (issuer + targets); a project manager opts in here.
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
	/**
	 * Optional resource security labels — the AUTHORITATIVE copy (the snapshot
	 * entry carries a projection). Absent = unlabeled: current role behavior.
	 * Labels only add restrictions; they never grant access. Mutated only
	 * through the dedicated security-label flow, never by project updates.
	 */
	security_labels: ResourceSecurityLabelsSchema.optional(),
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
	// Absent = the deployment's default compute profile. Only a non-default
	// choice is persisted.
	compute_profile: z.string().optional(),
	/**
	 * Optional security-label override — authoritative copy. Enforced IN
	 * ADDITION to the project's labels (both must be satisfied), so an override
	 * can keep or increase restrictions but never lower them. Absent = the
	 * notebook inherits the project labels unchanged.
	 */
	security_labels: ResourceSecurityLabelsSchema.optional(),
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

// A Git repository mirrored into the store by CI push or a configured provider
// reader. `repo`, `branch`, and `commit` remain provider-neutral coordinates.
// Host detection takes precedence over an explicit provider claim; provider is
// null when neither is available. Sync fields are null until the first sync.
// Static repository coordinates supplied when a git-backed notebook is configured.
export const GitSourceConfigSchema = z.object({
	repo: z.string(),
	branch: z.string(),
	root_path: z.string(),
	entry_notebook: z.string(),
});

export type GitSourceConfig = z.infer<typeof GitSourceConfigSchema>;

// Immutable repository coordinates recorded on a synced notebook version.
export const GitSourceRevisionSchema = z.object({
	provider: z.string().min(1).nullable(),
	...GitSourceConfigSchema.shape,
	commit: z.string().min(1),
});

export type GitSourceRevision = z.infer<typeof GitSourceRevisionSchema>;

// Mutable live sync state for a git-backed notebook.
export const GitSourceSchema = z.object({
	schema_version: SchemaVersionSchema,
	type: z.literal('git'),
	provider: z.string().min(1).nullable(),
	...GitSourceConfigSchema.shape,
	pending_config: GitSourceConfigSchema.optional(),
	sync_mode: z.enum(['push', 'pull']),
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
	// The git commit a sync-cut version mirrors (git-synced sources only; the
	// UI links it to the host). Forward-tolerant like the snapshots above.
	commit: z.string().optional(),
	git_source: GitSourceRevisionSchema.optional(),
});

export type Version = z.infer<typeof VersionSchema>;

export type PublicVersion = Omit<Version, 'schema_version'>;
export function toPublicVersion(version: Version): PublicVersion {
	const { schema_version: _schema_version, ...rest } = version;
	return rest;
}

// --- Synced-source proposals ---

const ProposalContentChangeSchema = z.object({
	path: z.string().min(1),
	operation: z.enum(['add', 'modify']),
	size_bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const ProposalDeleteChangeSchema = z.object({
	path: z.string().min(1),
	operation: z.literal('delete'),
});

export const ProposalChangeSchema = z.discriminatedUnion('operation', [
	ProposalContentChangeSchema,
	ProposalDeleteChangeSchema,
]);

export type ProposalChange = z.infer<typeof ProposalChangeSchema>;

export const NotebookProposalSchema = z.object({
	schema_version: SchemaVersionSchema,
	proposal_id: ProposalIdSchema,
	notebook_id: NotebookIdSchema,
	session_id: SessionIdSchema,
	author: UserIdSchema,
	created_at: z.iso.datetime(),
	base_version_id: VersionIdSchema,
	capture_strategy: z.enum(['entry-notebook', 'git-working-tree']).default('entry-notebook'),
	source: GitSourceRevisionSchema.extend({ provider: z.string().min(1) }),
	target_proposal_id: ProposalIdSchema.optional(),
	changes: z.array(ProposalChangeSchema).min(1).max(1_000),
});

export type NotebookProposal = z.infer<typeof NotebookProposalSchema>;

export const ProposalPayloadMarkerSchema = z.object({
	schema_version: SchemaVersionSchema,
	proposal_id: ProposalIdSchema,
	project_id: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
	expires_at: z.iso.datetime(),
	change_indexes: z
		.array(z.number().int().nonnegative())
		.max(1_000)
		.refine((indexes) => new Set(indexes).size === indexes.length, 'Change indexes must be unique'),
});

export type ProposalPayloadMarker = z.infer<typeof ProposalPayloadMarkerSchema>;

export const ChangeRequestPublicationSchema = z.object({
	provider: z.string().min(1),
	number: z.number().int().positive(),
	url: z.url().refine((value) => value.startsWith('https://')),
	head_branch: z.string().min(1),
	head_commit: z.string().min(1),
});

export const ProposalPublicationSchema = z.discriminatedUnion('state', [
	z.looseObject({
		state: z.literal('pending'),
		updated_at: z.iso.datetime(),
	}),
	z.looseObject({
		state: z.literal('published'),
		updated_at: z.iso.datetime(),
		change_request: ChangeRequestPublicationSchema,
	}),
]);

export type ProposalPublication = z.infer<typeof ProposalPublicationSchema>;

// --- Filesystem snapshot ---
//
// Per-notebook pointer to the current CoreWeave-native filesystem snapshot,
// stored in the mutable `fs_snapshot.json` sidecar (latest-wins). The id is an
// opaque provider-native string (NOT branded — unlike the catalog `SnapshotId`
// ULID). No `provider` field: the capability gate (`asFilesystemSnapshots`)
// already ensures only a snapshot-capable backend reads or writes this pointer,
// so a backend switch ignores it.
export const ComputeResourceRecordSchema = z.looseObject({
	cpu: z.number().optional(),
	memory_bytes: z.number().optional(),
	gpu: z.string().optional(),
});

export type ComputeResourceRecord = z.infer<typeof ComputeResourceRecordSchema>;

export const FsSnapshotSchema = z.object({
	snapshot_id: z.string(),
	captured_at: z.iso.datetime(),
	size_bytes: z.number().int().nonnegative().optional(),
	compute_profile: z.string().optional(),
	compute_resources: ComputeResourceRecordSchema.optional(),
	owner_user_id: UserIdSchema.optional(),
});

export type FsSnapshot = z.infer<typeof FsSnapshotSchema>;

// --- Integration ---

// Mutable CAS-managed head; IntegrationVersionRecord objects are immutable.
export const IntegrationRecordSchema = z.looseObject({
	id: IntegrationIdSchema,
	/** Owning project; absent on org-scoped heads (`_system/integrations/…`). */
	project_id: ProjectIdSchema.optional(),
	/** Stable registry discriminator; changing it requires a migration. */
	kind: z.string(),
	/** Instance name used to derive rendered paths and environment variables. */
	name: z.string(),
	/** Disabled integrations are omitted from session rendering. */
	enabled: z.boolean(),
	current_version: z.number().int().positive(),
	created_by: UserIdSchema,
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
});

export type IntegrationRecord = z.infer<typeof IntegrationRecordSchema>;

/** Storage schema version for immutable integration config records. */
export const CURRENT_INTEGRATION_CONFIG_VERSION = 1;

export const IntegrationVersionRecordSchema = z.object({
	schema_version: SchemaVersionSchema,
	version: z.number().int().positive(),
	kind: z.string(),
	/** Kind schema version used to select the migration chain. */
	kind_schema_version: z.number().int().positive(),
	/** Config with secret fields replaced by encrypted envelopes. */
	config: z.record(z.string(), z.unknown()),
	created_by: UserIdSchema,
	created_at: z.iso.datetime(),
	change_note: z.string().optional(),
});

export type IntegrationVersionRecord = z.infer<typeof IntegrationVersionRecordSchema>;

export const SecretEnvelopeSchema = z.object({
	kek_id: z.string(),
	alg: z.literal('A256GCM'),
	/** base64 */
	iv: z.string(),
	/** base64 */
	ciphertext: z.string(),
});

export type SecretEnvelopeRecord = z.infer<typeof SecretEnvelopeSchema>;

// --- Session ---

export const SurfaceStateSchema = z.looseObject({
	status: z.enum(['starting', 'ready', 'stopping', 'stopped', 'failed', 'unavailable']),
	attempt_id: z.string().optional(),
	attempt_started_at: z.iso.datetime().optional(),
	cancelled_attempt_id: z.string().optional(),
	port: z.number().int().positive().optional(),
	url: z.string().optional(),
	origin_url: z.string().optional(),
	proxy_path: z.enum(['strip-prefix', 'preserve-prefix']).optional(),
	started_at: z.iso.datetime().optional(),
	probe: z
		.looseObject({
			available: z.boolean(),
			reason: z.string().optional(),
			version: z.string().optional(),
		})
		.optional(),
	last_error: z.string().optional(),
});

export type SurfaceState = z.infer<typeof SurfaceStateSchema>;

// `looseObject` for the same rolling-deploy reason as TokenSchema: every status
// change is a CAS read-modify-write of the whole record, so a strict parse on an
// older replica would strip fields a newer replica wrote (e.g. the `integrations`
// audit pin) and silently rewrite the record without them on the next heartbeat.
// The API projection (`toSessionResponse` in routes/sessions.ts) is an explicit
// pick, so preserved unknown keys never leak into a response.
export const SessionSchema = z.looseObject({
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
	/** Non-extendable expiry of the entitlement credential that authorized this kernel. */
	authorization_expires_at: z.iso.datetime().optional(),
	/**
	 * Last time the periodic snapshotter saved the notebook back to the bucket.
	 * Cadence bookkeeping only — `commitSession` dedupes unchanged content, so this
	 * never gates on whether anything changed.
	 */
	last_snapshot_at: z.iso.datetime().optional(),
	/**
	 * Set after sandbox destruction is confirmed. Claim replacement and
	 * reconciliation use it to distinguish terminal records still awaiting teardown
	 * from sandboxes that are already gone.
	 */
	sandbox_reclaimed_at: z.iso.datetime().optional(),
	/**
	 * Durable takeover checkpoint written after the strict source/workspace capture
	 * and before sandbox destruction. A draining retry can safely skip a second
	 * capture when destruction succeeded but a later session-record write failed.
	 */
	takeover_capture_completed_at: z.iso.datetime().optional(),
	/**
	 * A discard-only session. This includes viewer throwaways and explicit
	 * temporary editors: nothing is written back at teardown — no version,
	 * HTML/session snapshot, workspace mirror, or FS snapshot. Absent means the
	 * session can persist if its mode and editor claim permit it.
	 */
	ephemeral: z.boolean().optional(),
	editor_sandbox_sharing: z.enum(['shared', 'exclusive']).optional(),
	ended_reason: z.enum(['takeover']).optional(),
	ended_by_user_id: UserIdSchema.optional(),
	/**
	 * `edit` (editor sandbox) or `app` (read-only, shared per notebook, never
	 * written back — see `sessionPersistsEdits`). Absent = `edit` (records
	 * predating the field); read via `sessionMode()`, never directly. Immutable
	 * for the session's life.
	 */
	mode: z.enum(SESSION_MODES).optional(),
	/**
	 * The immutable notebook version used to start the session. App sessions compare
	 * it with the current head for staleness; edit sessions use it as save provenance.
	 */
	source_version_id: VersionIdSchema.optional(),
	/**
	 * Connection count for shared app/editor sessions from the lifecycle sweep's
	 * last kernel probe — approximate by design.
	 */
	active_connections: z.number().int().nonnegative().optional(),
	connections_checked_at: z.iso.datetime().optional(),
	runtime: RuntimeSchema.optional(),
	sandbox_id: SandboxIdSchema.optional(),
	sandbox_url: z.string().optional(),
	compute_profile: z.string().optional(),
	compute_resources: ComputeResourceRecordSchema.optional(),
	compute_from_snapshot: z.boolean().optional(),
	/**
	 * Server-reachable kernel endpoint, persisted only in `proxy` exposure mode so
	 * the app's `/proxy/*` forwarder can reach the kernel. Distinct from
	 * `sandbox_url` (the client-facing `…/proxy/<token>/` URL) and never returned in
	 * the API response. Absent in `subdomain` mode (the client reaches the kernel
	 * directly).
	 */
	sandbox_origin_url: z.string().optional(),
	surfaces: z.record(z.string(), SurfaceStateSchema).optional(),
	used_fallback: z.boolean().optional(),
	/**
	 * Why a session went `failed` — a sanitized `{ code, message }` set by
	 * `markFailed` when a provision fails, so the client polling the record sees a
	 * reason instead of a bare `failed`. Optional: successful/older records omit it,
	 * and it NEVER carries secret material (see the projection in `sessions.ts`).
	 */
	error: z.object({ code: z.string(), message: z.string() }).optional(),
	/**
	 * The audit pin: exactly which integration config versions rendered into this
	 * sandbox at provision. Written once at `setRunning`, never mutated. Absent =
	 * none rendered (or the record predates integrations).
	 */
	integrations: z
		.array(
			z.object({
				id: IntegrationIdSchema,
				name: z.string(),
				kind: z.string(),
				version: z.number().int().positive(),
			}),
		)
		.optional(),
});

export type Session = z.infer<typeof SessionSchema>;

export const VersionPruneCutoffSchema = z.object({
	cutoff_version_id: VersionIdSchema,
});

export type VersionPruneCutoff = z.infer<typeof VersionPruneCutoffSchema>;

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

export const EditorClaimSchema = z.looseObject({
	session_id: SessionIdSchema.nullable(),
	sharing: z.enum(['shared', 'exclusive']),
	claimed_at: z.iso.datetime(),
	transfer: z
		.looseObject({
			takeover_id: z.string().min(1).max(255),
			requested_by: UserIdSchema,
			expected_activity: z.enum(['active', 'idle', 'unknown', 'starting']),
			phase: z.enum(['requested', 'draining', 'ready']),
			requested_at: z.iso.datetime(),
			drain_lease_id: z.string().min(1).max(255).optional(),
			drain_lease_expires_at: z.iso.datetime().optional(),
			drain_lease_stage: z
				.enum(['capturing', 'snapshotting', 'destroying', 'finalizing'])
				.optional(),
			drain_lease_progress_deadline_at: z.iso.datetime().optional(),
			replacement_session_id: SessionIdSchema.optional(),
		})
		.optional(),
});

export type EditorClaim = z.infer<typeof EditorClaimSchema>;

// Per-notebook workspace mutation lease at
// `projects/{pid}/notebooks/{nid}/workspace_mutation_claim.json`, written only
// by `NotebookWorkspaceService`. A lease past `expires_at` is stale and gets
// replaced, so a crashed mutator cannot wedge the workspace. `holder: null` is
// the free marker a release CAS-writes in place of a delete. A union rather
// than a refine so the generated bucket contract encodes the two valid states
// (released or held) instead of accepting a mixed one.
export const WorkspaceMutationClaimSchema = z.union([
	z.object({ holder: z.null(), expires_at: z.null() }),
	z.object({ holder: z.string().min(1), expires_at: z.iso.datetime() }),
]);

export type WorkspaceMutationClaim = z.infer<typeof WorkspaceMutationClaimSchema>;

// --- Jobs ---
//
// A job is a per-notebook headless-run definition (schedule + policy) at
// `projects/{pid}/notebooks/{nid}/jobs/{job-id}/job.json`; a run is the record
// of one execution beside it. Both are CAS-managed mutable records with exactly
// one writer each (`JobsService`, `JobRunService`), `looseObject` for the same
// rolling-deploy reason as Session. Terminal runs are never rewritten; retention
// deletes whole `runs/{rid}/` prefixes.

export const RUN_STATUSES = [
	'queued',
	'provisioning',
	'running',
	'succeeded',
	'failed',
	'timed_out',
	'cancelled',
	'skipped',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['schedule', 'manual'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** `forbid` skips a scheduled fire while a run of the same job is still active. */
export const JOB_CONCURRENCY_POLICIES = ['forbid', 'allow'] as const;
export type JobConcurrencyPolicy = (typeof JOB_CONCURRENCY_POLICIES)[number];

export const JOB_NOTIFICATION_EVENTS = ['failure', 'success'] as const;
export type JobNotificationEvent = (typeof JOB_NOTIFICATION_EVENTS)[number];

export const MAX_JOB_NAME_LENGTH = 120;
export const MAX_JOB_PARAMETERS = 32;
export const MAX_JOB_PARAMETER_VALUE_LENGTH = 4096;
export const MAX_JOB_RETRIES = 5;
export const MAX_JOB_RETRY_BACKOFF_SECONDS = 3600;
export const MAX_QUEUED_RUNS_PER_JOB = 20;
export const MIN_JOB_TIMEOUT_SECONDS = 60;

export const CURRENT_JOB_DEFINITION_VERSION = 1;
export const CURRENT_JOB_RUN_VERSION = 1;

/** Keys become `--key value` argv for `mo.cli_args()`, so they must be flag-safe. */
export const JOB_PARAMETER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const JOB_PARAMETERS_JSON_SCHEMA = {
	maxProperties: MAX_JOB_PARAMETERS,
	propertyNames: { type: 'string', pattern: JOB_PARAMETER_KEY_PATTERN.source },
} as const;

export const JobParametersSchema = z
	.record(
		z.string().regex(JOB_PARAMETER_KEY_PATTERN),
		z.string().max(MAX_JOB_PARAMETER_VALUE_LENGTH),
	)
	.refine((parameters) => Object.keys(parameters).length <= MAX_JOB_PARAMETERS, {
		message: `At most ${MAX_JOB_PARAMETERS} parameters are allowed`,
	})
	.meta(JOB_PARAMETERS_JSON_SCHEMA);

export type JobParameters = z.infer<typeof JobParametersSchema>;

export const JobRetryPolicySchema = z.looseObject({
	max_retries: z.number().int().min(0).max(MAX_JOB_RETRIES),
	backoff_seconds: z.number().int().min(0).max(MAX_JOB_RETRY_BACKOFF_SECONDS).default(60),
});

export type JobRetryPolicy = z.infer<typeof JobRetryPolicySchema>;

export const JobNotificationsSchema = z.looseObject({
	on: z
		.array(z.enum(JOB_NOTIFICATION_EVENTS))
		.min(1)
		.refine((events) => new Set(events).size === events.length, {
			message: 'Notification events must be unique',
		})
		.meta({ uniqueItems: true }),
});

export type JobNotifications = z.infer<typeof JobNotificationsSchema>;

export const JobDefinitionSchema = z.looseObject({
	schema_version: z.literal(CURRENT_JOB_DEFINITION_VERSION),
	id: JobIdSchema,
	notebook_id: NotebookIdSchema,
	project_id: ProjectIdSchema,
	name: z.string().min(1).max(MAX_JOB_NAME_LENGTH),
	enabled: z.boolean(),
	/** Absent = manual-trigger only. */
	schedule: JobScheduleSchema.optional(),
	/** Passed to the notebook as `mo.cli_args()`. */
	parameters: JobParametersSchema.optional(),
	retry: JobRetryPolicySchema.optional(),
	/** Absent = the deployment default; capped by MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS. */
	timeout_seconds: z.number().int().min(MIN_JOB_TIMEOUT_SECONDS).optional(),
	concurrency_policy: z.enum(JOB_CONCURRENCY_POLICIES).default('forbid'),
	/** Delivered through the project's alert destinations (`job.run.*` kinds). */
	notifications: JobNotificationsSchema.optional(),
	created_by: UserIdSchema,
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
});

export type JobDefinition = z.infer<typeof JobDefinitionSchema>;

export const RunErrorSchema = z.looseObject({ code: z.string(), message: z.string() });

export type RunError = z.infer<typeof RunErrorSchema>;

export const JobRunSchema = z.looseObject({
	schema_version: z.literal(CURRENT_JOB_RUN_VERSION),
	run_id: RunIdSchema,
	job_id: JobIdSchema,
	notebook_id: NotebookIdSchema,
	project_id: ProjectIdSchema,
	status: z.enum(RUN_STATUSES),
	trigger: z.enum(RUN_TRIGGERS),
	/** Manual runs only; scheduled runs attribute to the job. */
	triggered_by: UserIdSchema.optional(),
	/** The occurrence this scheduled run fired for. */
	scheduled_for: z.iso.datetime().optional(),
	/** The notebook head at enqueue time — the same provenance app sessions carry. */
	source_version_id: VersionIdSchema.optional(),
	/** As-executed parameters, persisted for audit. */
	parameters: JobParametersSchema.optional(),
	attempt: z.number().int().min(1).default(1),
	retry_of: RunIdSchema.optional(),
	/** Stamped when the run goes `provisioning`; the reconciler reads it. */
	sandbox_id: SandboxIdSchema.optional(),
	/** The sandbox image and compute the run provisioned with — the same provenance a session carries. */
	image: z.string().optional(),
	compute_profile: z.string().optional(),
	compute_resources: ComputeResourceRecordSchema.optional(),
	timeout_seconds: z.number().int().min(1),
	queued_at: z.iso.datetime(),
	/** A retry's backoff: not dispatched before this instant. */
	eligible_at: z.iso.datetime().optional(),
	started_at: z.iso.datetime().optional(),
	finished_at: z.iso.datetime().optional(),
	/** Watchdog anchor: a run still active past this instant is timed out. */
	deadline_at: z.iso.datetime().optional(),
	exit_code: z.number().int().optional(),
	/** Sanitized like a session's `error`; never carries secret material. */
	error: RunErrorSchema.optional(),
	output: z
		.looseObject({
			html_bytes: z.number().int().nonnegative(),
			logs_bytes: z.number().int().nonnegative().optional(),
		})
		.optional(),
	cancelled_by: UserIdSchema.optional(),
});

export type JobRun = z.infer<typeof JobRunSchema>;

const StoredJobVersionSchema = z.looseObject({ schema_version: SchemaVersionSchema });

export function parseStoredJobDefinition(value: unknown, what: string): JobDefinition {
	const { schema_version } = parseStored(StoredJobVersionSchema, value, what);
	switch (schema_version) {
		case 1:
			return parseStored(JobDefinitionSchema, value, what);
		default:
			throw new StoredObjectError(what, 'schema_mismatch', {
				issues: [{ path: 'schema_version', code: 'unsupported_version' }],
			});
	}
}

export async function readStoredJobDefinition(
	body: { json(): Promise<unknown> },
	what: string,
): Promise<JobDefinition> {
	return parseStoredJobDefinition(await readStoredJson(body, what), what);
}

export function parseStoredJobRun(value: unknown, what: string): JobRun {
	const { schema_version } = parseStored(StoredJobVersionSchema, value, what);
	switch (schema_version) {
		case 1:
			return parseStored(JobRunSchema, value, what);
		default:
			throw new StoredObjectError(what, 'schema_mismatch', {
				issues: [{ path: 'schema_version', code: 'unsupported_version' }],
			});
	}
}

export async function readStoredJobRun(
	body: { json(): Promise<unknown> },
	what: string,
): Promise<JobRun> {
	return parseStoredJobRun(await readStoredJson(body, what), what);
}

/** Scheduled-fire claim: create-if-absent, immutable (see `paths.job().occurrence`). */
export const JobOccurrenceSchema = z.object({
	run_id: RunIdSchema,
	fired_at: z.iso.datetime(),
	outcome: z.enum(['run', 'skip']).optional(),
});

export type JobOccurrence = z.infer<typeof JobOccurrenceSchema>;

/** Execution/finalization marker under `_system/job-runs/` (see `paths.jobRunMarker`). */
export const JobRunMarkerSchema = z.object({
	run_id: RunIdSchema,
	continuation_run_id: RunIdSchema,
	job_id: JobIdSchema,
	notebook_id: NotebookIdSchema,
	project_id: ProjectIdSchema,
	created_at: z.iso.datetime(),
});

export type JobRunMarker = z.infer<typeof JobRunMarkerSchema>;

// Explicit picks (not rest-spreads): both schemas are loose, so preserved unknown
// keys must never leak into a response.
export type PublicJobDefinition = Pick<
	JobDefinition,
	| 'id'
	| 'notebook_id'
	| 'project_id'
	| 'name'
	| 'enabled'
	| 'schedule'
	| 'parameters'
	| 'retry'
	| 'timeout_seconds'
	| 'concurrency_policy'
	| 'notifications'
	| 'created_by'
	| 'created_at'
	| 'updated_at'
>;

export function toPublicJobDefinition(job: JobDefinition): PublicJobDefinition {
	return {
		id: job.id,
		notebook_id: job.notebook_id,
		project_id: job.project_id,
		name: job.name,
		enabled: job.enabled,
		...(job.schedule !== undefined
			? { schedule: { cron: job.schedule.cron, timezone: job.schedule.timezone } }
			: {}),
		...(job.parameters !== undefined ? { parameters: job.parameters } : {}),
		...(job.retry !== undefined
			? {
					retry: {
						max_retries: job.retry.max_retries,
						backoff_seconds: job.retry.backoff_seconds,
					},
				}
			: {}),
		...(job.timeout_seconds !== undefined ? { timeout_seconds: job.timeout_seconds } : {}),
		concurrency_policy: job.concurrency_policy,
		...(job.notifications !== undefined ? { notifications: { on: job.notifications.on } } : {}),
		created_by: job.created_by,
		created_at: job.created_at,
		updated_at: job.updated_at,
	};
}

export type PublicJobRun = Pick<
	JobRun,
	| 'run_id'
	| 'job_id'
	| 'notebook_id'
	| 'project_id'
	| 'status'
	| 'trigger'
	| 'triggered_by'
	| 'scheduled_for'
	| 'source_version_id'
	| 'parameters'
	| 'attempt'
	| 'retry_of'
	| 'image'
	| 'compute_profile'
	| 'compute_resources'
	| 'timeout_seconds'
	| 'queued_at'
	| 'eligible_at'
	| 'started_at'
	| 'finished_at'
	| 'deadline_at'
	| 'exit_code'
	| 'error'
	| 'output'
	| 'cancelled_by'
>;

export function toPublicJobRun(run: JobRun): PublicJobRun {
	return {
		run_id: run.run_id,
		job_id: run.job_id,
		notebook_id: run.notebook_id,
		project_id: run.project_id,
		status: run.status,
		trigger: run.trigger,
		...(run.triggered_by !== undefined ? { triggered_by: run.triggered_by } : {}),
		...(run.scheduled_for !== undefined ? { scheduled_for: run.scheduled_for } : {}),
		...(run.source_version_id !== undefined ? { source_version_id: run.source_version_id } : {}),
		...(run.parameters !== undefined ? { parameters: run.parameters } : {}),
		attempt: run.attempt,
		...(run.retry_of !== undefined ? { retry_of: run.retry_of } : {}),
		...(run.image !== undefined ? { image: run.image } : {}),
		...(run.compute_profile !== undefined ? { compute_profile: run.compute_profile } : {}),
		...(run.compute_resources !== undefined
			? {
					compute_resources: {
						...(run.compute_resources.cpu !== undefined ? { cpu: run.compute_resources.cpu } : {}),
						...(run.compute_resources.memory_bytes !== undefined
							? { memory_bytes: run.compute_resources.memory_bytes }
							: {}),
						...(run.compute_resources.gpu !== undefined ? { gpu: run.compute_resources.gpu } : {}),
					},
				}
			: {}),
		timeout_seconds: run.timeout_seconds,
		queued_at: run.queued_at,
		...(run.eligible_at !== undefined ? { eligible_at: run.eligible_at } : {}),
		...(run.started_at !== undefined ? { started_at: run.started_at } : {}),
		...(run.finished_at !== undefined ? { finished_at: run.finished_at } : {}),
		...(run.deadline_at !== undefined ? { deadline_at: run.deadline_at } : {}),
		...(run.exit_code !== undefined ? { exit_code: run.exit_code } : {}),
		...(run.error !== undefined
			? { error: { code: run.error.code, message: run.error.message } }
			: {}),
		...(run.output !== undefined
			? {
					output: {
						html_bytes: run.output.html_bytes,
						...(run.output.logs_bytes !== undefined ? { logs_bytes: run.output.logs_bytes } : {}),
					},
				}
			: {}),
		...(run.cancelled_by !== undefined ? { cancelled_by: run.cancelled_by } : {}),
	};
}

// --- Identity ---
//
// A directory record mapping a stable user id (the auth `sub`) to its current
// human-readable identity. Upserted on every authenticated request (throttled),
// so it never goes stale: opaque ids stored as `author`/`user_id` foreign keys
// are resolved against this directory at read time. IdentityService owns these
// mutable per-user records and updates them with ETag compare-and-swap.
export const IdentitySchema = z.object({
	id: UserIdSchema,
	// Keep legacy reads permissive. IdentityService validates new writes so an
	// older invalid record remains readable and can be repaired after sign-in.
	email: z.string(),
	name: z.string(),
	picture_url: z.url({ protocol: /^https$/ }).optional(),
	suspended_at: z.iso.datetime().optional(),
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
const TokenBaseSchema = {
	id: TokenIdSchema,
	user_id: UserIdSchema,
	name: z.string(),
	/** Lowercase-hex SHA-256 of the token secret. Never leaves the server. */
	hash: z.string(),
	created_at: z.iso.datetime(),
	expires_at: z.iso.datetime().optional(),
	/** Daily-coalesced usage marker; concurrent touches are intentionally last-writer-wins. */
	last_used_at: z.iso.datetime().optional(),
};

export const TokenSchema = z
	.looseObject({
		...TokenBaseSchema,
		credential_version: z.literal(2).optional(),
		grant: TokenGrantSchema.optional(),
	})
	.refine(
		(token) => (token.credential_version === 2) === (token.grant !== undefined),
		'A version 2 token must have a grant, and a grant requires version 2',
	)
	.meta({
		dependentRequired: {
			credential_version: ['grant'],
			grant: ['credential_version'],
		},
	});

export type Token = z.infer<typeof TokenSchema>;

// Explicit Pick (not Omit): the schema is loose, so `Token` carries an index
// signature; `Omit` would collapse the named keys under it (and preserved
// unknown fields must never leak into a response anyway — same reasoning as
// `toPublicProjectEntry`). The one field to hide is `hash`.
export type PublicToken = Pick<
	Token,
	'id' | 'user_id' | 'name' | 'created_at' | 'expires_at' | 'last_used_at' | 'grant'
>;
export function toPublicToken(token: Token): PublicToken {
	return {
		id: token.id,
		user_id: token.user_id,
		name: token.name,
		created_at: token.created_at,
		...(token.expires_at !== undefined ? { expires_at: token.expires_at } : {}),
		...(token.last_used_at !== undefined ? { last_used_at: token.last_used_at } : {}),
		...(token.grant !== undefined ? { grant: token.grant } : {}),
	};
}

// --- Event ---

export const EventSchema = z.looseObject({
	id: z.string().min(1),
	schema_version: SchemaVersionSchema,
	ts: z.iso.datetime(),
	event: z.string(),
	actor: UserIdSchema,
});

export type Event = z.infer<typeof EventSchema>;

export const EventIdempotencyMarkerSchema = z.object({
	event_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
	body: z.string(),
});
