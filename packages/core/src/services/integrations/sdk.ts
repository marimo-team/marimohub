import { z } from 'zod';
import { DomainError, UnavailableError, ValidationError } from '../../errors';
import type {
	BrowseNamespacesRequest,
	BrowsePage,
	BrowsePageRequest,
	IntegrationCategory,
	IntegrationProbe,
	IntegrationVersionPin,
	KindBrand,
	ProbeRequestInit,
	TableSchema,
	TablePreview,
	TablePreviewRequest,
	TestResult,
	UiHints,
} from '../../ports/integrations';
import type { ProjectId, SessionId, UserId } from '../../ids';
import type { ObjectStoreProvider, ObjectStoreSourceFor } from '../../ports/objectBrowser';
import type {
	PreviewProgramAvailability,
	PreviewProgramInput,
	PreviewPrograms,
} from './data-preview/programs';
import type { DataQueryPlan } from './data-query';
import { secretPaths } from './secretFields';
import type { SecretPath } from './secretFields';

export interface RenderInput<C> {
	/** Validated config with secret fields resolved to plaintext. */
	config: C;
	/** Instance name used to parameterize paths and environment variables. */
	instanceName: string;
	projectId: ProjectId;
	principal: { userId: UserId; email: string };
	session: { sessionId: SessionId };
}

export interface RenderOutput {
	/**
	 * Files to place in the sandbox, paths relative to the integrations dir
	 * (POSIX separators, no `..`). The bundler prefixes the absolute dir and
	 * hard-errors on cross-integration path collisions.
	 */
	files?: { path: string; content: string }[];
	/**
	 * Structured YAML fragments sharing a path are recursively merged by the
	 * bundler. Conflicting leaves fail closed.
	 */
	yamlFiles?: { path: string; value: Record<string, unknown> }[];
	/**
	 * Env vars to inject. Kind-authored names (not user input) — validated for
	 * POSIX shape and shell-vector safety by the bundler; two integrations
	 * emitting the same key with different values is a hard error.
	 */
	env?: Record<string, string>;
	/** User-safe metadata copied into this instance's manifest entry. */
	manifestExtra?: Record<string, unknown>;
}

/**
 * Read-only catalog browsing for kinds with an HTTP-native metadata API.
 * Metadata operations must not write upstream. Like `testConnection`, ALL
 * network access goes through `probe`.
 */
export interface BrowseCapability<C> {
	/**
	 * Instance-level gate (auth method, TLS material, …) mirroring the
	 * short-circuits `testConnection` applies. Evaluated on a config whose
	 * secret fields may be placeholders — never inspect secret values here.
	 */
	available(config: C): { ok: true } | { ok: false; reason: string };
	listNamespaces(
		config: C,
		probe: IntegrationProbe,
		request: BrowseNamespacesRequest,
	): Promise<BrowsePage<string[]>>;
	listTables(
		config: C,
		probe: IntegrationProbe,
		namespace: string[],
		request: BrowsePageRequest,
	): Promise<BrowsePage<string>>;
	getTableSchema(
		config: C,
		probe: IntegrationProbe,
		namespace: string[],
		table: string,
		request?: Pick<TablePreviewRequest, 'query_user'>,
	): Promise<TableSchema>;
	/** Optional cheap row preview executed by this kind's read-only HTTP API. */
	previewRows?(
		config: C,
		probe: IntegrationProbe,
		namespace: string[],
		table: string,
		request: TablePreviewRequest,
	): Promise<TablePreview>;
	/** Notebook code that loads the table through this instance's rendered config. */
	snippet(instanceName: string, namespace: string[], table: string): string;
}

export type ObjectBrowseDefinition<C> = {
	[P in ObjectStoreProvider]: {
		provider: P;
		source(config: C): ObjectStoreSourceFor<P>;
		snippet(instanceName: string, bucket: string, key: string): string;
	};
}[ObjectStoreProvider];

export function pageByNameCursor<T>(
	items: T[],
	request: BrowsePageRequest,
	key: (item: T) => string,
): BrowsePage<T> {
	const after = decodeNameCursor(request.cursor);
	const byKey = new Map(items.map((item) => [key(item), item]));
	const remaining = [...byKey.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.filter(([itemKey]) => after === undefined || itemKey > after);
	const selected = remaining.slice(0, request.limit);
	return {
		items: selected.map(([, item]) => item),
		next_cursor:
			remaining.length > selected.length ? `name:${encodeURIComponent(selected.at(-1)![0])}` : null,
	};
}

function decodeNameCursor(cursor: string | undefined): string | undefined {
	if (cursor === undefined) return undefined;
	if (!cursor.startsWith('name:')) throw new ValidationError('Invalid browse cursor.');
	try {
		return decodeURIComponent(cursor.slice('name:'.length));
	} catch {
		throw new ValidationError('Invalid browse cursor.');
	}
}

/** Complete contract for one registered integration kind. */
export interface IntegrationDefinition<S extends z.ZodType = z.ZodType> {
	/** Registry discriminator. Stable forever; a rename is a migration. */
	kind: string;
	title: string;
	description: string;
	category: IntegrationCategory;
	/** Vendor icon and color for docs and UI chrome. */
	brand: KindBrand;
	/**
	 * Version of the config *shape*. Bump on an incompatible schema change and
	 * provide `migrate` for stored configs — a live old version without a migrate
	 * path fails loudly at render, never silently.
	 */
	schemaVersion: number;
	/** Source of truth for validation, JSON Schema, forms, and secret paths. */
	configSchema: S;
	/** Presentation hints keyed by dotted config paths. */
	uiHints?: UiHints;
	/**
	 * Informational only: sandboxes do not preflight or install these packages.
	 */
	requirements?: string[];
	/** Resolves the packages needed by the selected config branches. */
	resolveRequirements?(config: z.infer<S>): string[];
	/** Process-wide environment names this kind can claim outside its instance prefix. */
	environmentVariables?: readonly string[];
	/**
	 * Pure and synchronous: same input → byte-identical output. No clock, RNG,
	 * network, or storage — anything session-specific arrives via the input.
	 */
	render(input: RenderInput<z.infer<S>>): RenderOutput;
	/**
	 * Optional write-time check for rules Zod cannot express in JSON Schema
	 * (reserved names, cross-field constraints). Runs after schema validation
	 * with secret values replaced by placeholders — never inspect them here.
	 * Throw `ValidationError` to reject.
	 */
	validate?(config: z.infer<S>): void;
	/**
	 * Optional connectivity probe behind the UI's "Test" button. Runs server-side
	 * with the (resolved) config; the result must never echo secret material —
	 * `defineIntegration` redacts details that quote a schema-marked value.
	 * ALL network access goes through `probe` (never ambient `fetch`) — it is the
	 * deployment's egress-policy boundary, and testing is disabled when none is
	 * wired. Any throw that is not a `DomainError` becomes a generic failure
	 * result and its message is discarded, so report failures by returning one.
	 */
	testConnection?(config: z.infer<S>, probe: IntegrationProbe): Promise<TestResult>;
	/**
	 * Optional read-only catalog browsing (namespaces → tables → schema).
	 * `defineIntegration` wraps every op so a thrown transport error is replaced
	 * by a generic failure and a `DomainError` that quotes secret material is
	 * degraded to a generic one — the same posture as `testConnection`.
	 */
	browse?: BrowseCapability<z.infer<S>>;
	objectBrowse?: ObjectBrowseDefinition<z.infer<S>>;
	preview?: {
		available(
			config: z.infer<S>,
		): { ok: true; programs: PreviewProgramAvailability } | { ok: false; reason: string };
		programs(input: PreviewProgramInput<z.infer<S>>): PreviewPrograms;
	};
	query?: {
		available(config: z.infer<S>): { ok: true } | { ok: false; reason: string };
		plan(input: { config: z.infer<S>; integration: IntegrationVersionPin }): DataQueryPlan;
	};
	/**
	 * Upgrade a stored config from an older `schemaVersion`. Chainable per step.
	 * Operates on the STORED shape (secret fields are `{ $secret: … }` boxes) and
	 * must carry those boxes through untouched. It may NOT move a `zSecret` field
	 * to a different path: envelopes are cryptographically bound to their field
	 * path, so a moved box fails to decrypt (and one left behind is rejected by
	 * the stray-box guard). Renaming a secret path needs a decrypt-and-reseal
	 * migration helper — deliberately not built until a kind needs it.
	 */
	migrate?(stored: unknown, fromVersion: number): unknown;
	/** Human-readable inventory of each migration step exposed in the generated contract. */
	migrations?: readonly { from: number; to: number; description: string }[];
}

/**
 * Preserves schema inference across a complete integration definition, and wraps
 * `testConnection` and `browse` in the secret guards below.
 */
export function defineIntegration<S extends z.ZodType>(
	def: IntegrationDefinition<S>,
): IntegrationDefinition<S> {
	const testConnection = def.testConnection?.bind(def);
	if (!testConnection && !def.browse && !def.objectBrowse && !def.preview && !def.query) return def;
	let paths: SecretPath[] | undefined;
	const pathsOf = () =>
		(paths ??= secretPaths(
			z.toJSONSchema(def.configSchema, { io: 'input' }) as Record<string, unknown>,
		));
	return {
		...def,
		...(testConnection
			? {
					async testConnection(config, probe) {
						let result: TestResult;
						try {
							result = await testConnection(config, probe);
						} catch (err) {
							// A throw means the kind never reached its own sanitizer, so its text is
							// untrusted wholesale — it can quote material this schema never marked (a
							// probe URL with userinfo, a closed-over token) that the echo guard below
							// would not catch. Drop it and report the generic failure.
							//
							// `DomainError` stays the deliberate rejection path (`ValidationError` →
							// 422, a budget → 429): converting one would answer 200 with a failure
							// detail for a request the API meant to refuse. Their messages are ours,
							// not a transport's.
							if (err instanceof DomainError) throw err;
							result = { ok: false, details: probeErrorDetails(err, true) };
						}
						return withoutSecretEcho(result, config, pathsOf());
					},
				}
			: {}),
		...(def.browse ? { browse: guardedBrowse(def.browse, pathsOf) } : {}),
		...(def.objectBrowse ? { objectBrowse: guardedObjectBrowse(def.objectBrowse, pathsOf) } : {}),
		...(def.preview ? { preview: guardedPreview(def.preview, pathsOf) } : {}),
		...(def.query ? { query: guardedQuery(def.query, pathsOf) } : {}),
	};
}

function guardedQuery<C>(
	query: NonNullable<IntegrationDefinition<z.ZodType<C>>['query']>,
	pathsOf: () => SecretPath[],
): NonNullable<IntegrationDefinition<z.ZodType<C>>['query']> {
	const available = query.available.bind(query);
	return {
		available(config) {
			let verdict: ReturnType<typeof available>;
			try {
				verdict = available(config);
			} catch (err) {
				if (err instanceof DomainError && !echoesSecret(err.message, config, pathsOf())) {
					throw err;
				}
				return { ok: false, reason: 'this instance cannot run SQL from the hub' };
			}
			if (!verdict.ok && echoesSecret(verdict.reason, config, pathsOf())) {
				return { ok: false, reason: 'this instance cannot run SQL from the hub' };
			}
			return verdict;
		},
		plan(input) {
			try {
				return query.plan(input);
			} catch (err) {
				if (err instanceof DomainError && !echoesSecret(err.message, input.config, pathsOf())) {
					throw err;
				}
				throw new ValidationError('The integration query plan could not be created.');
			}
		},
	};
}

function guardedObjectBrowse<C>(
	objectBrowse: ObjectBrowseDefinition<C>,
	pathsOf: () => SecretPath[],
): ObjectBrowseDefinition<C> {
	switch (objectBrowse.provider) {
		case 's3':
			return guardedObjectBrowseProvider(objectBrowse, pathsOf);
		case 'gcs':
			return guardedObjectBrowseProvider(objectBrowse, pathsOf);
		case 'azure_blob':
			return guardedObjectBrowseProvider(objectBrowse, pathsOf);
	}
}

function guardedObjectBrowseProvider<C, P extends ObjectStoreProvider>(
	objectBrowse: {
		provider: P;
		source(config: C): ObjectStoreSourceFor<P>;
		snippet(instanceName: string, bucket: string, key: string): string;
	},
	pathsOf: () => SecretPath[],
) {
	return {
		provider: objectBrowse.provider,
		source(config: C) {
			try {
				const source = objectBrowse.source(config);
				if (source.provider !== objectBrowse.provider) {
					throw new ProviderMismatchError();
				}
				return source;
			} catch (err) {
				if (err instanceof ProviderMismatchError) {
					throw new UnavailableError('The object-store provider does not match its integration.');
				}
				if (err instanceof DomainError && !echoesSecret(err.message, config, pathsOf())) {
					throw err;
				}
				throw new UnavailableError('The object-store request failed.');
			}
		},
		snippet: objectBrowse.snippet.bind(objectBrowse),
	};
}

class ProviderMismatchError extends Error {
	override readonly name = 'ProviderMismatchError';
}

function guardedPreview<C>(
	preview: NonNullable<IntegrationDefinition<z.ZodType<C>>['preview']>,
	pathsOf: () => SecretPath[],
): NonNullable<IntegrationDefinition<z.ZodType<C>>['preview']> {
	const available = preview.available.bind(preview);
	return {
		available(config) {
			const verdict = available(config);
			if (!verdict.ok && echoesSecret(verdict.reason, config, pathsOf())) {
				return { ok: false, reason: 'this instance cannot be previewed from the hub' };
			}
			return verdict;
		},
		programs(input) {
			try {
				return preview.programs(input);
			} catch (err) {
				if (err instanceof DomainError && !echoesSecret(err.message, input.config, pathsOf()))
					throw err;
				throw new ValidationError('The integration preview program could not be created.');
			}
		},
	};
}

/**
 * The browse counterpart of the `testConnection` guard: ops return data or
 * throw, so the boundary sits on the error path. A non-`DomainError` throw is a
 * transport's own text (untrusted wholesale) and becomes a generic failure; a
 * `DomainError` is kind-authored, but its message is still checked against the
 * config's secret values before it may cross to a response. `available`'s
 * `reason` reaches responses too, so it gets the same echo check; `snippet`
 * never sees the config and needs none.
 */
function guardedBrowse<C>(browse: BrowseCapability<C>, pathsOf: () => SecretPath[]) {
	const available = browse.available.bind(browse);
	const guard = <A extends unknown[], R>(
		op: (config: C, probe: IntegrationProbe, ...args: A) => Promise<R>,
	) => {
		return async (config: C, probe: IntegrationProbe, ...args: A): Promise<R> => {
			try {
				return await op(config, probe, ...args);
			} catch (err) {
				if (err instanceof DomainError && !echoesSecret(err.message, config, pathsOf())) {
					throw err;
				}
				throw new UnavailableError('The catalog request failed.');
			}
		};
	};
	return {
		available(config) {
			const verdict = available(config);
			if (!verdict.ok && echoesSecret(verdict.reason, config, pathsOf())) {
				// No terminal punctuation: reasons get embedded in sentences
				// ("… cannot be browsed: <reason>.") by the store and the API.
				return { ok: false, reason: 'this instance cannot be browsed from the hub' };
			}
			return verdict;
		},
		snippet: browse.snippet.bind(browse),
		listNamespaces: guard(browse.listNamespaces.bind(browse)),
		listTables: guard(browse.listTables.bind(browse)),
		getTableSchema: guard(browse.getTableSchema.bind(browse)),
		...(browse.previewRows ? { previewRows: guard(browse.previewRows.bind(browse)) } : {}),
	} satisfies BrowseCapability<C>;
}

/**
 * A kind's own view of where its secrets live is not the boundary: configs carry
 * secret material outside the auth block (Trino custom headers and extra
 * credentials, storage credentials), so an `auth: none` test whose transport
 * quotes the offending header would echo it through `err.message`. Enforce the
 * contract centrally against the schema-marked paths instead.
 */
function withoutSecretEcho(result: TestResult, config: unknown, paths: SecretPath[]): TestResult {
	const { details } = result;
	if (details === undefined || details === '') return result;
	if (!echoesSecret(details, config, paths)) return result;
	// The substring match stays deliberately blunt (a short secret matches an
	// innocuous detail by chance), so the replacement tracks the result's own
	// `ok` instead of asserting failure: a false positive then costs detail, not
	return { ...result, details: result.ok ? 'connected' : 'request failed' };
}

/** Whether `text` quotes any schema-marked secret value, in any transport form. */
function echoesSecret(text: string, config: unknown, paths: SecretPath[]): boolean {
	return collectSecretValues(config, paths).some((value) =>
		secretForms(value).some((form) => text.includes(form)),
	);
}

/**
 * Shapes a secret can take on the way into a transport error message. The
 * JSON-escaped body matters because a message built from `JSON.stringify` of the
 * request turns a quote, backslash, newline, tab, or control character into an
 * escape sequence that the raw substring no longer matches. A value without
 * those characters encodes to itself, so this never widens the match.
 *
 * `encodeURIComponent` throws on a lone surrogate, which a JSON config can carry
 * (`"\ud800"`). Dropping just that form keeps the guard working instead of
 * letting a URIError escape `testConnection` as a 500.
 */
function secretForms(value: string): string[] {
	const forms = [value, JSON.stringify(value).slice(1, -1)];
	try {
		forms.push(encodeURIComponent(value));
	} catch {
		// Not URL-encodable, so no transport can echo it in that form either.
	}
	return forms;
}

/** Plaintext values sitting at the kind's schema-marked secret paths. */
function collectSecretValues(config: unknown, paths: SecretPath[]): string[] {
	const marked = new Set(paths.map((path) => path.join('.')));
	const values: string[] = [];
	const walk = (value: unknown, path: string[]): void => {
		if (typeof value === 'string') {
			if (marked.has(path.join('.'))) values.push(value);
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item, [...path, '*']);
		} else if (typeof value === 'object' && value !== null) {
			for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
		}
	};
	walk(config, []);
	return values;
}

export function envSegment(instanceName: string): string {
	return instanceName.toUpperCase().replaceAll('-', '_');
}

/**
 * Bare hostname (or IP literal) — no scheme, port, path, userinfo, or spaces —
 * so a host interpolated into a rendered URL cannot smuggle extra URL structure.
 */
export const HOSTNAME_REGEX = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * `Authorization: Basic` value via UTF-8 → base64 (bare `btoa` throws on
 * non-Latin-1 credentials, which would surface as a 500 instead of a result).
 */
export function basicAuthHeader(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

/**
 * `containsSecrets` is the kind's own fast path for a request it knows carried
 * credentials; secrets living elsewhere in the config are caught by
 * `defineIntegration`'s guard, so never treat this flag as the whole boundary.
 */
export function probeErrorDetails(err: unknown, containsSecrets: boolean): string {
	if (containsSecrets) return 'request failed';
	return err instanceof Error ? err.message : 'request failed';
}

/**
 * A one-request connectivity probe with the envelope every kind needs: latency
 * measurement, `HTTP <status>` for a non-2xx, and a transport error rendered
 * through {@link probeErrorDetails} so it cannot quote the credentials the
 * request carried.
 *
 * `describe` turns a successful response into the detail shown to the user. It
 * receives the parsed JSON body, which is `undefined` when the response was not
 * JSON, so a kind that only cares about reachability can ignore it.
 */
export async function probeEndpoint(options: {
	probe: IntegrationProbe;
	url: string;
	init?: ProbeRequestInit;
	/** Whether this request carried a credential. */
	carriesSecrets: boolean;
	describe(body: unknown): string;
}): Promise<TestResult> {
	const start = performance.now();
	const elapsed = () => Math.round(performance.now() - start);
	try {
		const res = await options.probe.fetch(options.url, options.init);
		if (!res.ok) return { ok: false, latency_ms: elapsed(), details: `HTTP ${res.status}` };
		return { ok: true, latency_ms: elapsed(), details: options.describe(await res.json()) };
	} catch (err) {
		return {
			ok: false,
			latency_ms: elapsed(),
			details: probeErrorDetails(err, options.carriesSecrets),
		};
	}
}
