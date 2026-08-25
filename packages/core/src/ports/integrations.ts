import type { IntegrationId, SessionId, UserId } from '../ids';
import type { BrowseSurface, ObjectBrowseCapability } from './objectBrowser';

export const INTEGRATION_CATEGORIES = [
	'database',
	'catalog',
	'engine',
	'storage',
	'other',
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

/** Widgets supported by the schema-driven integration form. */
export type FieldWidget =
	| 'text'
	| 'password'
	| 'textarea'
	| 'select'
	| 'toggle'
	| 'number'
	| 'kv-pairs';

/**
 * Cosmetic layer hints keyed by dotted config paths (`auth.clientSecret`).
 * Purely additive to the JSON Schema — a hint must never change what value is
 * stored (that belongs in the schema).
 */
export interface FieldHint {
	widget?: FieldWidget;
	placeholder?: string;
	/** Section heading used to group related fields. */
	group?: string;
	order?: number;
	/** Whether the group starts inside the advanced disclosure. */
	advanced?: boolean;
	docs_url?: string;
}

export type UiHints = Record<string, FieldHint>;

/** Vendor brand presentation; cosmetic only. */
export interface KindBrand {
	/** simple-icons slug; omitted when no vendor mark exists. */
	icon?: string;
	/** `#rrggbb`; always present so consumers can tint icon-less fallbacks. */
	color: string;
}

export interface IntegrationSecretReferenceSource {
	backend: string;
	title: string;
	locator_placeholder: string;
	locator_help: string;
	docs_url?: string;
}

export interface IntegrationSecretSources {
	inline: boolean;
	references: IntegrationSecretReferenceSource[];
}

/** Serializable kind description used to build integration forms. */
export interface KindDescriptor {
	kind: string;
	title: string;
	description: string;
	category: IntegrationCategory;
	brand: KindBrand;
	schema_version: number;
	/** Form schema derived from the kind's Zod config schema. */
	json_schema: Record<string, unknown>;
	ui_hints: UiHints;
	/** Whether this deployment can run the kind's connectivity probe. */
	supports_test: boolean;
	/** Whether this deployment can browse the kind's catalog metadata. */
	supports_browse: boolean;
	/** Read-only resource models this deployment exposes for the kind. */
	browse_surfaces: BrowseSurface[];
	secret_sources: IntegrationSecretSources;
	/** Informational package requirements for notebook code. */
	requirements: string[];
}

/** Connectivity result whose details must be safe to return to users. */
export interface TestResult {
	ok: boolean;
	latency_ms?: number;
	details?: string;
}

/**
 * One page of read-only catalog metadata. `next_cursor` is the upstream
 * pagination token passed through opaquely; null on the last page.
 */
export interface BrowsePage<T> {
	items: T[];
	next_cursor: string | null;
}

export interface BrowsePageRequest {
	limit: number;
	cursor?: string;
	/** Effective upstream identity for engines that authorize each query. */
	query_user?: string;
	signal?: AbortSignal;
}

export interface BrowseNamespacesRequest extends BrowsePageRequest {
	/** List namespaces nested under this one; absent lists the roots. */
	parent?: string[];
}

export interface TableColumn {
	name: string;
	type: string;
	nullable: boolean;
	comment?: string;
}

export interface TableSchema {
	columns: TableColumn[];
	/** Partition fields, e.g. `region` or `day(ts)`. */
	partitioning?: string[];
	/** Ready-to-paste notebook code that loads this table via the integration. */
	snippet?: string;
	/** Table root location, e.g. `s3://warehouse/sales/orders`. */
	location?: string;
	/** Table format version (Iceberg: 1, 2, or 3). */
	format_version?: number;
	/** Facts from the table's current snapshot, when the catalog reports one. */
	current_snapshot?: {
		committed_at?: string;
		total_records?: number;
		total_data_size_bytes?: number;
	};
}

/** A bounded, JSON-safe row sample returned by the data browser. */
export interface TablePreview {
	columns: string[];
	rows: unknown[][];
}

export interface TablePreviewRequest {
	limit: number;
	query_user?: string;
	signal?: AbortSignal;
}

/**
 * Whether one stored instance can be browsed from the hub. Kind support alone
 * is not enough: the verdict depends on the instance config (auth method, TLS
 * material) and on the deployment having browsing wired.
 */
export interface BrowseCapabilityResult {
	/** Resolved integration kind for internal dialect and adapter decisions. */
	integration_kind: string;
	metadata: boolean;
	/** Whether this kind can preview rows directly through its guarded HTTP API. */
	hub_preview: boolean;
	reason?: string;
	/**
	 * The resolved head's config version and last-write time. Callers that
	 * cache browse results key on BOTH: the version invalidates on config
	 * edits, `updated_at` on head-only writes (a rename changes the snippet an
	 * instance renders without bumping the version). Required — an
	 * implementation that omitted them would let cached results outlive the
	 * state they were computed from. Not exposed over the API.
	 */
	current_version: number;
	updated_at: string;
	surfaces: {
		tables?: { available: boolean; preview: boolean; reason?: string };
		objects?: ObjectBrowseCapability;
		query?: { available: boolean; reason?: string };
	};
}

/** The only network path allowed to integration probes; implementations enforce egress policy. */
export interface IntegrationProbe {
	fetch(url: string, init?: ProbeRequestInit): Promise<ProbeResponse>;
}

export interface ProbeRequestInit {
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface ProbeResponse {
	ok: boolean;
	status: number;
	headers?: Readonly<Record<string, string>>;
	/** Body parsed as JSON, or `undefined` when it is not JSON (or was truncated). */
	json(): Promise<unknown>;
}

/** Where an integration instance lives. Org instances are deployment-wide and
 *  inherited by every project; a same-name project instance (enabled or not)
 *  shadows the org one, which makes it both the override and the opt-out. */
export type IntegrationScopeKind = 'project' | 'org';

/** List projection that intentionally omits config. */
export interface IntegrationEntry {
	id: IntegrationId;
	kind: string;
	name: string;
	enabled: boolean;
	current_version: number;
	created_by: UserId;
	created_at: string;
	updated_at: string;
	/** The storage tier that owns this integration. */
	scope: IntegrationScopeKind;
	/** Org entries in a project listing only: a same-name project integration shadows this one. */
	shadowed?: boolean;
}

/** Detail projection whose secret fields are always redacted. */
export interface IntegrationDetail extends IntegrationEntry {
	config: Record<string, unknown>;
	change_note?: string;
}

export interface IntegrationVersionMeta {
	version: number;
	kind_schema_version: number;
	created_by: UserId;
	created_at: string;
	change_note?: string;
}

/**
 * Keyset page over the version history. The page bounds the work: an
 * implementation must read only the records it returns, never the whole
 * (unbounded, append-only) history.
 */
export interface IntegrationVersionPageRequest {
	/** Max records to return; callers apply their own default and ceiling. */
	limit: number;
	/** Opaque `next_cursor` from the previous page. */
	cursor?: string;
}

export interface IntegrationVersionPage {
	/** Newest first. */
	items: IntegrationVersionMeta[];
	/**
	 * Cursor for the next page, or null on the last one. A page can hold fewer
	 * than `limit` items and still carry a cursor (a record removed underneath the
	 * reader), so callers follow the cursor rather than the item count.
	 */
	next_cursor: string | null;
}

export interface CreateIntegrationInput {
	kind: string;
	name: string;
	/** Authoring config; secret fields are plaintext strings. */
	config: Record<string, unknown>;
	change_note?: string;
}

export interface UpdateIntegrationInput {
	name?: string;
	enabled?: boolean;
	/**
	 * Authoring shape; an untouched secret submitted as `{ $secret: { set: true } }`
	 * keeps the stored value (merge-keep) — editing never requires re-entry.
	 */
	config?: Record<string, unknown>;
	change_note?: string;
}

export type TestIntegrationRequest =
	| { source: 'draft'; kind: string; config: Record<string, unknown>; id?: IntegrationId }
	| { source: 'stored'; id: IntegrationId };

export interface QueryReadinessRequest {
	kind: string;
	config: Record<string, unknown>;
}

export interface QueryReadinessCheck {
	id: string;
	label: string;
	ready: boolean;
	field: string;
	reason: string;
}

export interface CopyIntegrationOptions {
	/** Name for the copy; defaults to the source instance's name. */
	name?: string;
}

export interface SessionRenderContext {
	sessionId: SessionId;
	principal: { userId: UserId; email: string };
}

export interface IntegrationVersionPin {
	id: IntegrationId;
	name: string;
	kind: string;
	version: number;
}

/** Files, variables, and audit pins produced for session provisioning. */
export interface SessionRender {
	files: { path: string; content: string }[];
	vars: Record<string, string>;
	/** Version pins persisted on the session record. */
	attachments: IntegrationVersionPin[];
}
