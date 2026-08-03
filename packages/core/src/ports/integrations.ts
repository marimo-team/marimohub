import type { IntegrationId, SessionId, UserId } from '../ids';

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

/** Serializable kind description used to build integration forms. */
export interface KindDescriptor {
	kind: string;
	title: string;
	description: string;
	category: IntegrationCategory;
	schema_version: number;
	/** Form schema derived from the kind's Zod config schema. */
	json_schema: Record<string, unknown>;
	ui_hints: UiHints;
	/** Whether this deployment can run the kind's connectivity probe. */
	supports_test: boolean;
	/** Informational package requirements for notebook code. */
	requirements: string[];
}

/** Connectivity result whose details must be safe to return to users. */
export interface TestResult {
	ok: boolean;
	latency_ms?: number;
	details?: string;
}

/** The only network path allowed to integration probes; implementations enforce egress policy. */
export interface IntegrationProbe {
	fetch(url: string, init?: ProbeRequestInit): Promise<ProbeResponse>;
}

export interface ProbeRequestInit {
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
}

export interface ProbeResponse {
	ok: boolean;
	status: number;
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
	| { source: 'draft'; kind: string; config: Record<string, unknown> }
	| { source: 'stored'; id: IntegrationId };

export interface CopyIntegrationOptions {
	/** Name for the copy; defaults to the source instance's name. */
	name?: string;
}

export interface SessionRenderContext {
	sessionId: SessionId;
	principal: { userId: UserId; email: string };
}

/** Files, variables, and audit pins produced for session provisioning. */
export interface SessionRender {
	files: { path: string; content: string }[];
	vars: Record<string, string>;
	/** Version pins persisted on the session record. */
	attachments: { id: IntegrationId; name: string; kind: string; version: number }[];
}
