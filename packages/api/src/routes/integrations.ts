import { createRoute, z } from '@hono/zod-openapi';
import {
	INTEGRATION_CATEGORIES,
	IntegrationId,
	NotFoundError,
	ProjectId,
	requireRole,
	ResourceExhaustedError,
	ValidationError,
} from '@marimo-hub/core';
import type {
	IntegrationDetail,
	IntegrationEntry,
	ProjectIntegrationsService,
	OrgIntegrationsService,
	TestIntegrationRequest,
} from '@marimo-hub/core';
import {
	assertProjectRole,
	assertSuperAdmin,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	IfMatchHeader,
	ifMatchToken,
	jsonBody,
	jsonContent,
	loadVisibleProject,
	ProjectIdParam,
	SuccessResponseSchema,
} from '../shared';
import type { ApiDeps } from '../shared';
import {
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
	pageSchema,
	paginate,
	PaginationQuery,
} from '../pagination';
import { appendAudit } from '../log';

const IntegrationIdSchema = z.string().regex(IntegrationId.regex).refine(IntegrationId.is);
const IntegrationNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

const IidParam = z
	.string()
	.regex(IntegrationId.regex)
	.refine(IntegrationId.is)
	.openapi({ param: { name: 'iid', in: 'path' }, example: 'intg-7h2k9qm4xz7rp3w8' });

const IntegrationIdParam = ProjectIdParam.extend({ iid: IidParam });

const OrgIntegrationIdParam = z.object({ iid: IidParam });

// Per-kind config shapes are dynamic (each kind owns a Zod schema, serialized to
// clients as `KindDescriptor.json_schema`), so the route layer types config as an
// open object and the store validates it against the kind's schema (→ 422).
const ConfigSchema = z.record(z.string(), z.unknown());

const KindDescriptorSchema = z
	.object({
		kind: z.string().min(1).openapi({ example: 'postgres' }),
		title: z.string(),
		description: z.string(),
		category: z.enum(INTEGRATION_CATEGORIES),
		brand: z.object({
			icon: z.string().min(1).optional().openapi({ example: 'postgresql' }),
			color: z
				.string()
				.regex(/^#[0-9A-Fa-f]{6}$/)
				.openapi({ example: '#4169E1' }),
		}),
		schema_version: z.number().int().positive(),
		json_schema: z.record(z.string(), z.unknown()),
		ui_hints: z.record(
			z.string(),
			z.object({
				widget: z
					.enum(['text', 'password', 'textarea', 'select', 'toggle', 'number', 'kv-pairs'])
					.optional(),
				placeholder: z.string().optional(),
				group: z.string().optional(),
				order: z.number().optional(),
				advanced: z.boolean().optional(),
				docs_url: z.string().optional(),
			}),
		),
		supports_test: z.boolean(),
		supports_browse: z.boolean(),
		secret_sources: z.object({
			inline: z.boolean(),
			references: z.array(
				z.object({
					backend: z.string().min(1).openapi({ example: 'aws-sm' }),
					title: z.string().min(1).openapi({ example: 'AWS Secrets Manager' }),
					locator_placeholder: z.string().min(1),
					locator_help: z.string().min(1),
					docs_url: z.url().optional(),
				}),
			),
		}),
		/** Informational package requirements for the rendered sandbox contract. */
		requirements: z.array(z.string()),
	})
	.openapi('IntegrationKind');

const IntegrationEntrySchema = z
	.object({
		id: IntegrationIdSchema,
		kind: z.string().min(1),
		name: IntegrationNameSchema,
		enabled: z.boolean(),
		current_version: z.number().int().positive(),
		created_by: z.string().min(1),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		scope: z.enum(['project', 'org']),
		/** Org entries in a project listing: a same-name project integration overrides this one. */
		shadowed: z.boolean().optional(),
	})
	.openapi('IntegrationEntry');

// `config` never contains plaintext or ciphertext. Inline values are redacted;
// external references retain their backend and locator metadata.
const IntegrationDetailSchema = IntegrationEntrySchema.extend({
	config: ConfigSchema,
	change_note: z.string().optional(),
}).openapi('IntegrationDetail');

const IntegrationVersionSchema = z
	.object({
		version: z.number().int().positive(),
		kind_schema_version: z.number().int().positive(),
		created_by: z.string().min(1),
		created_at: z.iso.datetime(),
		change_note: z.string().optional(),
	})
	.openapi('IntegrationVersion');

const TestResultSchema = z
	.object({
		ok: z.boolean(),
		latency_ms: z.number().nonnegative().optional(),
		/** User-safe probe details; never secret material. */
		details: z.string().optional(),
	})
	.openapi('IntegrationTestResult');

const CreateIntegrationBody = z
	.object({
		kind: z.string().min(1),
		name: IntegrationNameSchema.openapi({ example: 'prod' }),
		config: ConfigSchema,
		change_note: z.string().max(500).optional(),
	})
	.strict();

const UpdateIntegrationBody = z
	.object({
		name: IntegrationNameSchema.optional(),
		enabled: z.boolean().optional(),
		/** When present, appends a config version and preserves untouched secrets. */
		config: ConfigSchema.optional(),
		change_note: z.string().max(500).optional(),
	})
	.refine(
		(body) => body.name !== undefined || body.enabled !== undefined || body.config !== undefined,
		'At least one of name, enabled, or config is required.',
	)
	// A note without a config would be silently dropped (notes ride version records).
	.refine(
		(body) => body.change_note === undefined || body.config !== undefined,
		'change_note requires config.',
	)
	.strict();

const TestIntegrationBody = z
	.discriminatedUnion('source', [
		z
			.object({
				source: z.literal('draft'),
				kind: z.string().min(1),
				config: ConfigSchema,
				id: IntegrationIdSchema.optional(),
			})
			.strict(),
		z.object({ source: z.literal('stored'), id: IntegrationIdSchema }).strict(),
	])
	.openapi('IntegrationTestRequest');

const CopyIntegrationBody = z
	.object({
		source_project_id: z
			.string()
			.regex(ProjectId.regex)
			.refine(ProjectId.is)
			.openapi({ example: 'proj-7h2k9qm4xz7rp3w8' }),
		source_integration_id: z
			.string()
			.regex(IntegrationId.regex)
			.refine(IntegrationId.is)
			.openapi({ example: 'intg-7h2k9qm4xz7rp3w8' }),
		/** Name for the copy; defaults to the source instance's name. */
		name: IntegrationNameSchema.optional(),
	})
	.strict()
	.openapi('IntegrationCopyRequest');

const listKinds = createRoute({
	method: 'get',
	path: '/integrations/kinds',
	tags: ['Integrations'],
	summary: 'List available integration kinds (schemas drive the config forms)',
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(KindDescriptorSchema) }),
			'Registered integration kinds',
		),
		...commonErrors(),
	},
});

const listIntegrations = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations',
	tags: ['Integrations'],
	summary: "List a project's integrations",
	request: { params: ProjectIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationEntrySchema, 'IntegrationPage'),
			}),
			'Integration instances (no config)',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const createIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations',
	tags: ['Integrations'],
	summary: 'Create an integration (manager only)',
	request: { params: ProjectIdParam, body: jsonBody(CreateIntegrationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration created (config redacted)',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const getIntegration = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}',
	tags: ['Integrations'],
	summary: 'Get an integration with its redacted config',
	request: { params: IntegrationIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration detail (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const updateIntegration = createRoute({
	method: 'patch',
	path: '/projects/{pid}/integrations/{iid}',
	tags: ['Integrations'],
	summary: 'Update an integration (manager only); a config change appends a version',
	request: {
		params: IntegrationIdParam,
		headers: IfMatchHeader,
		body: jsonBody(UpdateIntegrationBody),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration updated (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const deleteIntegration = createRoute({
	method: 'delete',
	path: '/projects/{pid}/integrations/{iid}',
	tags: ['Integrations'],
	summary: 'Delete an integration and its version history (manager only)',
	request: { params: IntegrationIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Integration deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const listIntegrationVersions = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/versions',
	tags: ['Integrations'],
	summary: "List an integration's config versions (metadata only)",
	request: { params: IntegrationIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationVersionSchema, 'IntegrationVersionPage'),
			}),
			'Version history, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const copyIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/copy',
	tags: ['Integrations'],
	summary: 'Copy an integration from another project (manager of both projects)',
	request: { params: ProjectIdParam, body: jsonBody(CopyIntegrationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration copied (inline secrets re-encrypted; external references preserved)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const testIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/test',
	tags: ['Integrations'],
	summary: 'Probe connectivity for an unsaved config or a stored instance (manager only)',
	request: { params: ProjectIdParam, body: jsonBody(TestIntegrationBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: TestResultSchema }),
			'Probe outcome (never secret material)',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

// --- Data browser (read-only catalog metadata over an integration) ---

/**
 * Multi-part namespaces ride in one query param, parts joined by U+001F — the
 * Iceberg REST unit separator, which cannot appear in an identifier — so parts
 * containing dots round-trip.
 */
const NAMESPACE_JOINER = '\u001f';

const NamespaceQueryValue = z
	.string()
	.min(1)
	// A leading/trailing/doubled joiner splits into empty identifier parts,
	// which no catalog can hold — refuse here (422) instead of spending a probe
	// call on a guaranteed upstream 404.
	.refine((value) => value.split(NAMESPACE_JOINER).every((part) => part !== ''), {
		message: 'Namespace parts must be non-empty.',
	})
	.openapi({
		param: { name: 'namespace', in: 'query' },
		description: 'Namespace parts joined by U+001F (percent-encoded as %1F).',
		example: 'sales',
	});

const BrowsePageQuery = z.object({
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(500)
		.default(100)
		.openapi({ param: { name: 'limit', in: 'query' }, example: 100 }),
	/** Opaque upstream pagination token from the previous page's `next_cursor`. */
	cursor: z
		.string()
		.optional()
		.openapi({ param: { name: 'cursor', in: 'query' } }),
	/**
	 * Bypass the replica's metadata cache for this lookup (the result still
	 * refreshes it). Fresh lookups always spend browse budget, so the cap
	 * bounds abuse.
	 */
	fresh: z
		.enum(['true', 'false'])
		.optional()
		.openapi({ param: { name: 'fresh', in: 'query' }, example: 'false' }),
});

const BrowseCapabilitySchema = z
	.object({
		/** Whether namespace/table/schema browsing works for this instance. */
		metadata: z.boolean(),
		/** Whether row preview is available (always false until preview ships). */
		preview: z.boolean(),
		reason: z.string().optional(),
	})
	.openapi('IntegrationBrowseCapability');

const BrowseNamespacePageSchema = z
	.object({
		/** Each namespace as its parts, e.g. `["sales", "eu"]`. */
		items: z.array(z.array(z.string())),
		next_cursor: z.string().nullable(),
	})
	.openapi('IntegrationBrowseNamespacePage');

const BrowseTablePageSchema = z
	.object({
		items: z.array(z.string()),
		next_cursor: z.string().nullable(),
	})
	.openapi('IntegrationBrowseTablePage');

const BrowseTableSchemaSchema = z
	.object({
		columns: z.array(
			z.object({
				name: z.string(),
				type: z.string(),
				nullable: z.boolean(),
				comment: z.string().optional(),
			}),
		),
		partitioning: z.array(z.string()).optional(),
		/** Ready-to-paste notebook code that loads this table via the integration. */
		snippet: z.string().optional(),
		/** Table root location, e.g. `s3://warehouse/sales/orders`. */
		location: z.string().optional(),
		format_version: z.number().int().optional(),
		/** Facts from the table's current snapshot, when the catalog reports one. */
		current_snapshot: z
			.object({
				committed_at: z.iso.datetime().optional(),
				total_records: z.number().optional(),
				total_data_size_bytes: z.number().optional(),
			})
			.optional(),
	})
	.openapi('IntegrationTableSchema');

const browseCapability = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse',
	tags: ['Integrations'],
	summary: 'Whether this integration instance can be browsed (editor or above)',
	description:
		'Browse routes resolve the id against the project tier first, then the inherited org ' +
		'tier; a shadowed org instance reads as absent. All browse operations are strictly ' +
		'read-only against the upstream.',
	request: { params: IntegrationIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: BrowseCapabilitySchema }),
			'Instance browse capability',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const browseNamespaces = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/namespaces',
	tags: ['Integrations'],
	summary: 'List catalog namespaces (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: BrowsePageQuery.extend({
			parent: NamespaceQueryValue.optional().openapi({ param: { name: 'parent', in: 'query' } }),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: BrowseNamespacePageSchema }),
			'Namespaces, with upstream pagination passed through',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 429),
	},
});

const browseTables = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/tables',
	tags: ['Integrations'],
	summary: 'List tables in a namespace (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: BrowsePageQuery.extend({ namespace: NamespaceQueryValue }),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: BrowseTablePageSchema }),
			'Table names, with upstream pagination passed through',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 429),
	},
});

const browseTableSchema = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/schema',
	tags: ['Integrations'],
	summary: "Get a table's schema (editor or above)",
	request: {
		params: IntegrationIdParam,
		query: z.object({
			namespace: NamespaceQueryValue,
			table: z
				.string()
				.min(1)
				.openapi({ param: { name: 'table', in: 'query' }, example: 'orders' }),
			fresh: BrowsePageQuery.shape.fresh,
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: BrowseTableSchemaSchema }),
			'Column names, types, and partitioning',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

// Org-scoped (deployment-wide) instances, inherited by every project. All
// management is super-admin only — org integrations render into every
// project's sessions, so no project role can be sufficient.
const listOrgIntegrations = createRoute({
	method: 'get',
	path: '/org/integrations',
	tags: ['Integrations'],
	summary: 'List org-wide integrations (super admin only)',
	request: { query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationEntrySchema, 'IntegrationPage'),
			}),
			'Org integration instances (no config)',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const createOrgIntegration = createRoute({
	method: 'post',
	path: '/org/integrations',
	tags: ['Integrations'],
	summary: 'Create an org-wide integration (super admin only)',
	request: { body: jsonBody(CreateIntegrationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration created (config redacted)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const getOrgIntegration = createRoute({
	method: 'get',
	path: '/org/integrations/{iid}',
	tags: ['Integrations'],
	summary: 'Get an org-wide integration with its redacted config (super admin only)',
	request: { params: OrgIntegrationIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration detail (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const updateOrgIntegration = createRoute({
	method: 'patch',
	path: '/org/integrations/{iid}',
	tags: ['Integrations'],
	summary: 'Update an org-wide integration (super admin only)',
	request: {
		params: OrgIntegrationIdParam,
		headers: IfMatchHeader,
		body: jsonBody(UpdateIntegrationBody),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration updated (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const deleteOrgIntegration = createRoute({
	method: 'delete',
	path: '/org/integrations/{iid}',
	tags: ['Integrations'],
	summary: 'Delete an org-wide integration and its version history (super admin only)',
	request: { params: OrgIntegrationIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Integration deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const listOrgIntegrationVersions = createRoute({
	method: 'get',
	path: '/org/integrations/{iid}/versions',
	tags: ['Integrations'],
	summary: "List an org-wide integration's config versions (super admin only)",
	request: { params: OrgIntegrationIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationVersionSchema, 'IntegrationVersionPage'),
			}),
			'Version history, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const testOrgIntegration = createRoute({
	method: 'post',
	path: '/org/integrations/test',
	tags: ['Integrations'],
	summary: 'Probe connectivity for an unsaved or stored org config (super admin only)',
	request: { body: jsonBody(TestIntegrationBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: TestResultSchema }),
			'Probe outcome (never secret material)',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

function requireIntegrations(deps: ApiDeps): ProjectIntegrationsService {
	if (!deps.integrations) {
		throw new NotFoundError('Integrations are not enabled on this deployment');
	}
	return deps.integrations;
}

function requireDataBrowser(deps: ApiDeps): {
	integrations: ProjectIntegrationsService;
	preview: boolean;
} {
	if (!deps.dataBrowser) {
		throw new NotFoundError('The data browser is not enabled on this deployment');
	}
	return { integrations: requireIntegrations(deps), preview: deps.dataBrowser.preview };
}

function splitNamespace(value: string): string[] {
	return value.split(NAMESPACE_JOINER);
}

const BROWSE_LIST_TTL_MS = 60_000;
const BROWSE_SCHEMA_TTL_MS = 300_000;
const BROWSE_CACHE_MAX_ENTRIES = 1024;

/**
 * A cache entry must not outlive the integration state it was computed from,
 * so every metadata request re-runs resolution (project-then-org, shadowing),
 * the enablement check, and the instance verdict BEFORE the cache is
 * consulted: a shadowed org head 404s and a disabled instance 422s even while
 * a hit is warm. The returned token keys the entry on the config version AND
 * `updated_at` — a rename bumps only the head, yet changes the snippet a
 * schema response embeds. Only the upstream catalog traffic is cached.
 */
async function assertBrowsable(
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
): Promise<string> {
	const capability = await integrations.browseCapability(pid, iid);
	if (!capability.metadata) {
		throw new ValidationError(capability.reason ?? 'This integration cannot be browsed.');
	}
	return `${capability.current_version}:${capability.updated_at}`;
}

/**
 * Per-replica TTL cache over successful browse results, so tree navigation
 * does not re-spend probe budget on every expansion. Bounded: expired entries
 * are dropped when full, then oldest-inserted. Only cache misses consume the
 * caller's browse budget, and concurrent misses for one key share a single
 * in-flight load (and its one budget charge) — a lazy tree expansion fans in
 * identical lookups faster than the first can populate the cache.
 */
const browseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inflightBrowse = new Map<string, Promise<unknown>>();

async function cachedBrowse<T>(
	key: string,
	ttlMs: number,
	fresh: boolean,
	load: () => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const hit = fresh ? undefined : browseCache.get(key);
	if (hit && hit.expiresAt > now) return hit.value as T;
	const pending = fresh ? undefined : inflightBrowse.get(key);
	if (pending) return pending as Promise<T>;
	const promise = (async () => {
		const value = await load();
		if (browseCache.size >= BROWSE_CACHE_MAX_ENTRIES) {
			for (const [cachedKey, entry] of browseCache) {
				if (entry.expiresAt <= now) browseCache.delete(cachedKey);
			}
			while (browseCache.size >= BROWSE_CACHE_MAX_ENTRIES) {
				const oldest = browseCache.keys().next().value;
				if (oldest === undefined) break;
				browseCache.delete(oldest);
			}
		}
		browseCache.set(key, { expiresAt: Date.now() + ttlMs, value });
		return value;
	})();
	inflightBrowse.set(key, promise);
	try {
		return await promise;
	} finally {
		inflightBrowse.delete(key);
	}
}

function requireOrgIntegrations(deps: ApiDeps): OrgIntegrationsService {
	if (!deps.orgIntegrations) {
		throw new NotFoundError('Integrations are not enabled on this deployment');
	}
	return deps.orgIntegrations;
}

function entryResponse(e: IntegrationEntry) {
	return {
		id: e.id,
		kind: e.kind,
		name: e.name,
		enabled: e.enabled,
		current_version: e.current_version,
		created_by: e.created_by,
		created_at: e.created_at,
		updated_at: e.updated_at,
		scope: e.scope,
		...(e.shadowed !== undefined ? { shadowed: e.shadowed } : {}),
	};
}

function detailResponse(d: IntegrationDetail) {
	return {
		...entryResponse(d),
		config: d.config,
		...(d.change_note ? { change_note: d.change_note } : {}),
	};
}

const app = createApp();

app.openapi(listKinds, (c) => {
	const integrations = requireIntegrations(c.get('deps'));
	return c.json({ success: true as const, data: integrations.listKinds() }, 200);
});

app.openapi(listIntegrations, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const query = c.req.valid('query');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'viewer', deps.policy);
	const data = paginate((await integrations.list(pid)).map(entryResponse), query, {
		key: (entry) => entry.updated_at,
		tiebreak: (entry) => entry.id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(createIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.create(pid, body, user.id);
	// Audit trail (kind/name only — never config). Best-effort; never fail the write.
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.create',
		() =>
			deps.services.events.append({
				event: 'integration.create',
				actor: user.id,
				project_id: pid,
				integration_scope: 'project',
				integration_id: detail.id,
				integration_kind: detail.kind,
				integration_name: detail.name,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 201);
});

app.openapi(getIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'viewer', deps.policy);
	const detail = await integrations.get(pid, iid);
	c.header('ETag', etagFor(detail.updated_at));
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(updateIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.update(pid, iid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(detail.updated_at));
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.update',
		() =>
			deps.services.events.append({
				event: 'integration.update',
				actor: user.id,
				project_id: pid,
				integration_scope: 'project',
				integration_id: iid,
				integration_kind: detail.kind,
				integration_name: detail.name,
				config_changed: body.config !== undefined,
				current_version: detail.current_version,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(deleteIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	// A no-op delete (already gone, or an id from the org tier) still succeeds
	// but must not fabricate an audit-trail deletion.
	const deleted = await integrations.delete(pid, iid, ifMatchToken(c));
	if (deleted) {
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'integration.delete',
			() =>
				deps.services.events.append({
					event: 'integration.delete',
					actor: user.id,
					project_id: pid,
					integration_scope: 'project',
					integration_id: iid,
				}),
		);
	}
	return c.json({ success: true }, 200);
});

app.openapi(listIntegrationVersions, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const query = c.req.valid('query');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'viewer', deps.policy);
	// Paged in the store rather than by `paginate`: it reads only this page's
	// records, never the whole (unbounded) history.
	const page = await integrations.listVersions(pid, iid, {
		limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		cursor: query.cursor,
	});
	return c.json({ success: true, data: page }, 200);
});

// The probe is a server-side request forger by construction, so beside the
// probe's own global cap, each USER gets a sliding-window budget — one manager
// cannot starve every other tenant on the replica.
const BUDGET_WINDOW_MS = 60_000;

/**
 * Per-user sliding-window budget. Expired users are forgotten on request
 * traffic, amortized to once per window, so the map tracks concurrent users
 * rather than every user the replica has ever served — an interval would keep
 * a timer (and this module's state) alive with no request behind it, in tests
 * and on Workers alike.
 */
function slidingWindowBudget(perMinute: number, message: string) {
	const recentByUser = new Map<string, number[]>();
	let lastSweptAt = 0;
	return {
		assert(userId: string): void {
			const now = Date.now();
			if (now - lastSweptAt >= BUDGET_WINDOW_MS) {
				lastSweptAt = now;
				for (const [user, timestamps] of recentByUser) {
					if (timestamps.every((t) => now - t >= BUDGET_WINDOW_MS)) recentByUser.delete(user);
				}
			}
			const recent = (recentByUser.get(userId) ?? []).filter((t) => now - t < BUDGET_WINDOW_MS);
			if (recent.length >= perMinute) throw new ResourceExhaustedError(message);
			recent.push(now);
			recentByUser.set(userId, recent);
		},
		tracked(): number {
			return recentByUser.size;
		},
	};
}

const testBudget = slidingWindowBudget(10, 'Too many connection tests — try again in a minute.');
// Sized against the browse probe's process-wide cap (240/min): one op spends
// up to 3 probe requests (config handshake + metadata + OAuth token), so a
// single user can hold at most ~90 of it — never the whole allowance.
const browseBudget = slidingWindowBudget(30, 'Too many browse requests — try again in a minute.');

function assertTestBudget(userId: string): void {
	testBudget.assert(userId);
}

export function trackedTestBudgets(): number {
	return testBudget.tracked();
}

app.openapi(copyIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	const body = c.req.valid('json');
	// The copy moves decrypted secret material across the project boundary, so
	// the caller must hold manager on BOTH sides (a super admin is admin
	// everywhere). Destination first: its 404/403 must not confirm the source.
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	// Visibility before role for the SOURCE: any destination manager can probe an
	// arbitrary id here, so a project the caller cannot see answers the same 404
	// as one that does not exist; 403 is reserved for projects they can see.
	const source = await loadVisibleProject(
		deps.services.projects,
		body.source_project_id,
		user,
		deps.policy,
	);
	requireRole(source, user, 'manager', deps.policy);
	const detail = await integrations.copy(
		body.source_project_id,
		body.source_integration_id,
		pid,
		{ name: body.name },
		user.id,
	);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.copy',
		() =>
			deps.services.events.append({
				event: 'integration.copy',
				actor: user.id,
				project_id: pid,
				integration_scope: 'project',
				integration_id: detail.id,
				integration_kind: detail.kind,
				integration_name: detail.name,
				source_project_id: body.source_project_id,
				source_integration_id: body.source_integration_id,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 201);
});

app.openapi(testIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	assertTestBudget(user.id);
	const body = c.req.valid('json') as TestIntegrationRequest;
	return c.json({ success: true, data: await integrations.test(pid, body) }, 200);
});

// Browse is editor+ (not viewer, not manager): an editor can already read all
// of this data by starting a session, so browse adds zero new reach; a viewer
// cannot run code, so metadata would be a genuinely new disclosure.
app.openapi(browseCapability, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { integrations, preview } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'editor', deps.policy);
	const capability = await integrations.browseCapability(pid, iid);
	return c.json(
		{
			success: true,
			data: {
				metadata: capability.metadata,
				preview: preview && capability.metadata,
				...(capability.reason !== undefined ? { reason: capability.reason } : {}),
			},
		},
		200,
	);
});

app.openapi(browseNamespaces, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { limit, cursor, parent, fresh } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'editor', deps.policy);
	const stateToken = await assertBrowsable(integrations, pid, iid);
	const request = {
		limit,
		...(cursor !== undefined ? { cursor } : {}),
		...(parent !== undefined ? { parent: splitNamespace(parent) } : {}),
	};
	const data = await cachedBrowse(
		JSON.stringify([pid, iid, stateToken, 'namespaces', request]),
		BROWSE_LIST_TTL_MS,
		fresh === 'true',
		() => {
			browseBudget.assert(user.id);
			return integrations.browseNamespaces(pid, iid, request);
		},
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseTables, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { limit, cursor, namespace, fresh } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'editor', deps.policy);
	const stateToken = await assertBrowsable(integrations, pid, iid);
	const request = { limit, ...(cursor !== undefined ? { cursor } : {}) };
	const data = await cachedBrowse(
		JSON.stringify([pid, iid, stateToken, 'tables', namespace, request]),
		BROWSE_LIST_TTL_MS,
		fresh === 'true',
		() => {
			browseBudget.assert(user.id);
			return integrations.browseTables(pid, iid, splitNamespace(namespace), request);
		},
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseTableSchema, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { namespace, table, fresh } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'editor', deps.policy);
	const stateToken = await assertBrowsable(integrations, pid, iid);
	const data = await cachedBrowse(
		JSON.stringify([pid, iid, stateToken, 'schema', namespace, table]),
		BROWSE_SCHEMA_TTL_MS,
		fresh === 'true',
		() => {
			browseBudget.assert(user.id);
			return integrations.browseTableSchema(pid, iid, splitNamespace(namespace), table);
		},
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(listOrgIntegrations, async (c) => {
	const deps = c.get('deps');
	const integrations = requireOrgIntegrations(deps);
	assertSuperAdmin(c.get('user'), deps.policy);
	const query = c.req.valid('query');
	const data = paginate((await integrations.list()).map(entryResponse), query, {
		key: (entry) => entry.updated_at,
		tiebreak: (entry) => entry.id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(createOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const integrations = requireOrgIntegrations(deps);
	assertSuperAdmin(user, deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.create(body, user.id);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.create',
		() =>
			deps.services.events.append({
				event: 'integration.create',
				actor: user.id,
				integration_scope: 'org',
				integration_id: detail.id,
				integration_kind: detail.kind,
				integration_name: detail.name,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 201);
});

app.openapi(getOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const { iid } = c.req.valid('param');
	const integrations = requireOrgIntegrations(deps);
	assertSuperAdmin(c.get('user'), deps.policy);
	const detail = await integrations.get(iid);
	c.header('ETag', etagFor(detail.updated_at));
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(updateOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { iid } = c.req.valid('param');
	const integrations = requireOrgIntegrations(deps);
	assertSuperAdmin(user, deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.update(iid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(detail.updated_at));
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.update',
		() =>
			deps.services.events.append({
				event: 'integration.update',
				actor: user.id,
				integration_scope: 'org',
				integration_id: iid,
				integration_kind: detail.kind,
				integration_name: detail.name,
				config_changed: body.config !== undefined,
				current_version: detail.current_version,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(deleteOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { iid } = c.req.valid('param');
	const integrations = requireOrgIntegrations(deps);
	assertSuperAdmin(user, deps.policy);
	const deleted = await integrations.delete(iid, ifMatchToken(c));
	if (deleted) {
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'integration.delete',
			() =>
				deps.services.events.append({
					event: 'integration.delete',
					actor: user.id,
					integration_scope: 'org',
					integration_id: iid,
				}),
		);
	}
	return c.json({ success: true }, 200);
});

app.openapi(listOrgIntegrationVersions, async (c) => {
	const deps = c.get('deps');
	const { iid } = c.req.valid('param');
	const query = c.req.valid('query');
	const integrations = requireOrgIntegrations(deps);
	assertSuperAdmin(c.get('user'), deps.policy);
	const page = await integrations.listVersions(iid, {
		limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		cursor: query.cursor,
	});
	return c.json({ success: true, data: page }, 200);
});

app.openapi(testOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const integrations = requireOrgIntegrations(deps);
	assertSuperAdmin(user, deps.policy);
	assertTestBudget(user.id);
	const body = c.req.valid('json') as TestIntegrationRequest;
	return c.json({ success: true, data: await integrations.test(body) }, 200);
});

export default app;
