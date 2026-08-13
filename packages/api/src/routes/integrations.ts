import { createRoute, z } from '@hono/zod-openapi';
import {
	INTEGRATION_CATEGORIES,
	IntegrationId,
	createSessionId,
	exchangeFederatedStorageEnv,
	NotFoundError,
	ProjectId,
	requireRole,
	ResourceExhaustedError,
	ValidationError,
	createSlidingWindowBudget,
} from '@marimo-hub/core';
import type {
	AuthUser,
	IntegrationDetail,
	IntegrationEntry,
	Project,
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
import {
	acquireDownload,
	makeObjectBrowseContext,
	objectContentDisposition,
	runObjectBrowse,
	safeObjectContentType,
	streamObjectBody,
	validRangeHeader,
} from './objectBrowse';

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
		browse_surfaces: z.array(z.enum(['tables', 'objects'])),
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
		surfaces: z.object({
			tables: z
				.object({
					available: z.boolean(),
					preview: z.boolean(),
					reason: z.string().optional(),
				})
				.optional(),
			objects: z
				.object({
					available: z.boolean(),
					preview: z.boolean(),
					download: z.boolean(),
					search: z.enum(['none', 'bounded-key-name']),
					versions: z.boolean(),
					preview_formats: z.array(z.string()),
					reason: z.string().optional(),
				})
				.optional(),
		}),
		/** Whether namespace/table/schema browsing works for this instance. */
		metadata: z.boolean(),
		/** Whether row preview is available for this instance. */
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

const BrowsePreviewSchema = z
	.object({
		columns: z.array(z.string()),
		rows: z.array(z.array(z.unknown())),
	})
	.openapi('IntegrationTablePreview');

const BrowsePreviewBody = z.object({
	namespace: z.array(z.string().min(1)).min(1),
	table: z.string().min(1),
	limit: z.number().int().positive().max(100).default(20),
});

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

const browseTablePreview = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/{iid}/browse/preview',
	tags: ['Integrations'],
	summary: "Preview a table's rows (editor or above)",
	description:
		'Runs a bounded read-only scan. HTTP-native integrations execute through the guarded ' +
		'browse probe; other integrations use a fresh, isolated preview sandbox.',
	request: { params: IntegrationIdParam, body: jsonBody(BrowsePreviewBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: BrowsePreviewSchema }),
			'Column names and a bounded row sample',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const ObjectBucketValue = z
	.string()
	.min(1)
	.max(255)
	.openapi({ param: { name: 'bucket', in: 'query' }, example: 'analytics-lake' });
const ObjectPrefixValue = z
	.string()
	.refine((value) => new TextEncoder().encode(value).byteLength <= 1024, {
		message: "Prefix exceeds S3's 1,024-byte UTF-8 limit.",
	})
	.openapi({ param: { name: 'prefix', in: 'query' }, example: 'events/2026/' });
const ObjectKeyValue = z
	.string()
	.min(1)
	.refine((value) => new TextEncoder().encode(value).byteLength <= 1024, {
		message: "Key exceeds S3's 1,024-byte UTF-8 limit.",
	})
	.openapi({ param: { name: 'key', in: 'query' }, example: 'events/2026/part-001.jsonl' });
const ObjectVersionIdValue = z.string().min(1).max(2048);
const ObjectVersionValue = ObjectVersionIdValue.optional().openapi({
	param: { name: 'version_id', in: 'query' },
});
const ObjectPageQuery = z.object({
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(100)
		.default(50)
		.openapi({ param: { name: 'limit', in: 'query' }, example: 50 }),
	cursor: BrowsePageQuery.shape.cursor,
	fresh: BrowsePageQuery.shape.fresh,
});
const ObjectIdentityQuery = z.object({
	bucket: ObjectBucketValue,
	key: ObjectKeyValue,
	version_id: ObjectVersionValue,
});

const ObjectBucketSchema = z
	.object({
		name: z.string(),
		created_at: z.iso.datetime().optional(),
		configured: z.boolean(),
	})
	.openapi('IntegrationObjectBucket');
const ObjectEntrySchema = z
	.object({
		kind: z.enum(['prefix', 'object']),
		name: z.string(),
		key: z.string(),
		size: z.number().nonnegative().optional(),
		last_modified: z.iso.datetime().optional(),
		etag: z.string().optional(),
		storage_class: z.string().optional(),
	})
	.openapi('IntegrationObjectEntry');
const ObjectDetailSchema = z
	.object({
		bucket: z.string(),
		key: z.string(),
		version_id: z.string().optional(),
		size: z.number().nonnegative(),
		last_modified: z.iso.datetime().optional(),
		etag: z.string().optional(),
		storage_class: z.string().optional(),
		content_type: z.string().optional(),
		content_encoding: z.string().optional(),
		cache_control: z.string().optional(),
		checksums: z.array(z.object({ algorithm: z.string(), value: z.string() })),
		metadata: z.record(z.string(), z.string()),
		tags: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
		tags_available: z.boolean(),
		snippet: z.string().optional(),
	})
	.openapi('IntegrationObjectDetail');
const ObjectVersionSchema = z
	.object({
		bucket: z.string(),
		key: z.string(),
		version_id: z.string().optional(),
		kind: z.enum(['version', 'delete-marker']),
		is_latest: z.boolean(),
		last_modified: z.iso.datetime().optional(),
		size: z.number().nonnegative().optional(),
		etag: z.string().optional(),
		storage_class: z.string().optional(),
		owner: z.object({ id: z.string().optional(), display_name: z.string().optional() }).optional(),
	})
	.openapi('IntegrationObjectVersion');
const TabularObjectPreviewSchema = z.object({
	kind: z.literal('tabular'),
	format: z.enum(['table', 'csv', 'tsv', 'json', 'jsonl', 'parquet']),
	columns: z.array(z.object({ name: z.string(), type: z.string().optional() })),
	rows: z.array(z.array(z.unknown())),
	truncated: z.boolean(),
	bytes_read: z.number().nonnegative().optional(),
	total_bytes: z.number().nonnegative().optional(),
	warnings: z.array(z.string()),
});
const ObjectPreviewSchema = z
	.discriminatedUnion('kind', [
		TabularObjectPreviewSchema,
		z.object({
			kind: z.literal('text'),
			format: z.enum(['text', 'markdown', 'code', 'log', 'json']),
			text: z.string(),
			truncated: z.boolean(),
			bytes_read: z.number().nonnegative(),
			total_bytes: z.number().nonnegative(),
			warnings: z.array(z.string()),
		}),
		z.object({
			kind: z.literal('image'),
			format: z.enum(['png', 'jpeg', 'gif', 'webp']),
			content_url: z.string(),
			width: z.number().int().positive().optional(),
			height: z.number().int().positive().optional(),
			total_bytes: z.number().nonnegative(),
			warnings: z.array(z.string()),
		}),
		z.object({
			kind: z.literal('unsupported'),
			reason: z.string(),
			detected_type: z.string().optional(),
			total_bytes: z.number().nonnegative(),
		}),
	])
	.openapi('IntegrationObjectPreview');

const browseObjectBuckets = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/objects/buckets',
	tags: ['Integrations'],
	summary: 'List object-store buckets (editor or above)',
	request: { params: IntegrationIdParam, query: ObjectPageQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ items: z.array(ObjectBucketSchema), next_cursor: z.string().nullable() }),
			}),
			'Buckets visible through the integration',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const browseObjects = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/objects',
	tags: ['Integrations'],
	summary: 'List direct object-store children (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: ObjectPageQuery.extend({
			bucket: ObjectBucketValue,
			prefix: ObjectPrefixValue.optional(),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ items: z.array(ObjectEntrySchema), next_cursor: z.string().nullable() }),
			}),
			'Direct prefixes and objects',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const searchObjects = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/objects/search',
	tags: ['Integrations'],
	summary: 'Run a bounded object-key search (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: ObjectPageQuery.omit({ fresh: true }).extend({
			bucket: ObjectBucketValue,
			prefix: ObjectPrefixValue.optional(),
			query: z.string().trim().min(2).max(1024),
			formats: z.string().optional(),
			modified_after: z.iso.datetime().optional(),
			modified_before: z.iso.datetime().optional(),
			min_size: z.coerce.number().nonnegative().optional(),
			max_size: z.coerce.number().nonnegative().optional(),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({
					items: z.array(ObjectEntrySchema),
					next_cursor: z.string().nullable(),
					scanned: z.number().int().nonnegative(),
					complete: z.boolean(),
				}),
			}),
			'Bounded object-key search results',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const browseObjectHead = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/objects/head',
	tags: ['Integrations'],
	summary: 'Read object metadata and tags (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: ObjectIdentityQuery,
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ObjectDetailSchema }),
			'Object metadata',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const browseObjectVersions = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/objects/versions',
	tags: ['Integrations'],
	summary: 'List object versions and delete markers (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: ObjectPageQuery.extend(ObjectIdentityQuery.shape),
	},
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ items: z.array(ObjectVersionSchema), next_cursor: z.string().nullable() }),
			}),
			'Object versions and delete markers',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const browseObjectPreview = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/{iid}/browse/objects/preview',
	tags: ['Integrations'],
	summary: 'Preview bounded object content (editor or above)',
	request: {
		params: IntegrationIdParam,
		body: jsonBody(
			z.object({
				bucket: ObjectBucketValue,
				key: ObjectKeyValue,
				version_id: ObjectVersionIdValue.optional(),
				limit: z.number().int().positive().max(100).default(20),
			}),
		),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ObjectPreviewSchema }),
			'Bounded object preview',
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
	return {
		integrations: requireIntegrations(deps),
		preview: deps.dataBrowser.preview,
	};
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

async function resolveObjectAccess(
	deps: ApiDeps,
	project: Project,
	user: AuthUser,
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
	signal?: AbortSignal,
) {
	const wifEligible = Boolean(deps.wif && project.federation?.enabled);
	const base = await makeObjectBrowseContext(deps, project, user, signal, {
		integrationId: iid,
		includeFederated: false,
		allowServerAmbient: wifEligible
			? false
			: deps.dataBrowser?.objectBrowser?.allowServerAmbientCredentials,
	});
	const baseCapability = await runObjectBrowse(() => integrations.browseCapability(pid, iid, base));
	if (baseCapability.surfaces.objects?.available || !wifEligible) {
		return { context: base, capability: baseCapability };
	}
	const federated = await makeObjectBrowseContext(deps, project, user, signal, {
		integrationId: iid,
	});
	return {
		context: federated,
		capability: await runObjectBrowse(() => integrations.browseCapability(pid, iid, federated)),
	};
}

function requireObjectCapability(
	capability: Awaited<ReturnType<ProjectIntegrationsService['browseCapability']>>,
) {
	const objects = capability.surfaces.objects;
	if (!objects?.available) {
		throw new ValidationError(objects?.reason ?? 'This integration cannot browse objects.');
	}
	return {
		stateToken: `${capability.current_version}:${capability.updated_at}`,
		capability: objects,
	};
}

async function resolveAuthorizedObjectAccess(
	deps: ApiDeps,
	user: AuthUser,
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
	signal?: AbortSignal,
) {
	const project = await assertProjectRole(deps.services.projects, pid, user, 'editor', deps.policy);
	return resolveObjectAccess(deps, project, user, integrations, pid, iid, signal);
}

async function requireAuthorizedObjectAccess(
	deps: ApiDeps,
	user: AuthUser,
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
	signal?: AbortSignal,
) {
	const access = await resolveAuthorizedObjectAccess(deps, user, integrations, pid, iid, signal);
	return { context: access.context, ...requireObjectCapability(access.capability) };
}

/**
 * Per-replica TTL cache over successful browse results, so tree navigation
 * does not re-spend probe budget on every expansion. Bounded: expired entries
 * are dropped when full, then oldest-inserted. Concurrent misses for one key
 * share a single upstream load — a lazy tree expansion fans in identical
 * lookups faster than the first can populate the cache.
 */
const browseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inflightBrowse = new Map<string, Promise<unknown>>();

async function cachedBrowse<T>(
	key: string,
	ttlMs: number,
	fresh: boolean,
	charge: () => void,
	load: () => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const hit = fresh ? undefined : browseCache.get(key);
	if (hit && hit.expiresAt > now) return hit.value as T;
	// Every consumer of a miss pays its own budget BEFORE creating or joining
	// the shared load: an exhausted user 429s alone (never poisoning the shared
	// promise for others), and piggybacking on someone else's load is not free.
	charge();
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
		// A fresh load may have replaced this entry mid-flight; deleting blindly
		// would drop the newer promise and re-run its upstream fetch.
		if (inflightBrowse.get(key) === promise) inflightBrowse.delete(key);
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
const testBudget = createSlidingWindowBudget<string>({ limit: 10, windowMs: 60_000 });
// Sized against the browse probe's process-wide cap (360/min): a bounded Trino
// statement spends at most 12 probe requests, so one user can hold at most 240
// of the shared allowance.
const createBrowseBudget = () => createSlidingWindowBudget<string>({ limit: 20, windowMs: 60_000 });
const createObjectSearchBudget = () =>
	createSlidingWindowBudget<string>({ limit: 5, windowMs: 60_000 });
const createObjectPreviewBudget = () =>
	createSlidingWindowBudget<string>({ limit: 10, windowMs: 60_000 });
let browseBudget = createBrowseBudget();
let objectSearchBudget = createObjectSearchBudget();
let objectPreviewBudget = createObjectPreviewBudget();

function assertTestBudget(userId: string): void {
	if (!testBudget.consume(userId)) {
		throw new ResourceExhaustedError('Too many connection tests — try again in a minute.');
	}
}

function assertBrowseBudget(userId: string): void {
	if (!browseBudget.consume(userId)) {
		throw new ResourceExhaustedError('Too many browse requests — try again in a minute.');
	}
}

function assertObjectSearchBudget(userId: string): void {
	if (!objectSearchBudget.consume(userId)) {
		throw new ResourceExhaustedError('Too many object searches — try again in a minute.');
	}
}

function assertObjectPreviewBudget(userId: string): void {
	if (!objectPreviewBudget.consume(userId)) {
		throw new ResourceExhaustedError('Too many object previews — try again in a minute.');
	}
}

export function trackedTestBudgets(): number {
	return testBudget.tracked();
}

export function clearIntegrationBrowseStateForTests(): void {
	browseBudget = createBrowseBudget();
	objectSearchBudget = createObjectSearchBudget();
	objectPreviewBudget = createObjectPreviewBudget();
	browseCache.clear();
	inflightBrowse.clear();
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
	const { capability } = await resolveAuthorizedObjectAccess(
		deps,
		user,
		integrations,
		pid,
		iid,
		c.req.raw.signal,
	);
	const tablePreview = preview && capability.metadata && capability.hub_preview;
	return c.json(
		{
			success: true,
			data: {
				surfaces: {
					...(capability.surfaces.tables
						? {
								tables: {
									...capability.surfaces.tables,
									preview: tablePreview,
								},
							}
						: {}),
					...(capability.surfaces.objects ? { objects: capability.surfaces.objects } : {}),
				},
				metadata: capability.metadata,
				preview: tablePreview,
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
		query_user: user.email,
		...(cursor !== undefined ? { cursor } : {}),
		...(parent !== undefined ? { parent: splitNamespace(parent) } : {}),
	};
	const data = await cachedBrowse(
		JSON.stringify([pid, iid, user.id, stateToken, 'namespaces', request]),
		BROWSE_LIST_TTL_MS,
		fresh === 'true',
		() => assertBrowseBudget(user.id),
		() => integrations.browseNamespaces(pid, iid, request),
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
	const request = { limit, query_user: user.email, ...(cursor !== undefined ? { cursor } : {}) };
	const data = await cachedBrowse(
		JSON.stringify([pid, iid, user.id, stateToken, 'tables', namespace, request]),
		BROWSE_LIST_TTL_MS,
		fresh === 'true',
		() => assertBrowseBudget(user.id),
		() => integrations.browseTables(pid, iid, splitNamespace(namespace), request),
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
		JSON.stringify([pid, iid, user.id, user.email, stateToken, 'schema', namespace, table]),
		BROWSE_SCHEMA_TTL_MS,
		fresh === 'true',
		() => assertBrowseBudget(user.id),
		() =>
			integrations.browseTableSchema(pid, iid, splitNamespace(namespace), table, {
				query_user: user.email,
			}),
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseTablePreview, async (c) => {
	c.header('Cache-Control', 'no-store');
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { namespace, table, limit } = c.req.valid('json');
	const { integrations, preview } = requireDataBrowser(deps);
	const project = await assertProjectRole(deps.services.projects, pid, user, 'editor', deps.policy);
	const wif = deps.wif;
	if (!preview) throw new NotFoundError('Row preview is not enabled on this deployment');
	assertBrowseBudget(user.id);
	const capability = await integrations.browseCapability(pid, iid);
	if (!capability.metadata) {
		throw new ValidationError(capability.reason ?? 'This integration cannot be browsed.');
	}
	const sessionId = createSessionId();
	const data = await integrations.browseTablePreview(
		pid,
		iid,
		{ userId: user.id, email: user.email },
		sessionId,
		namespace,
		table,
		{ limit, query_user: user.email },
		wif && project.federation?.enabled
			? () => exchangeFederatedStorageEnv(wif.issuer, wif.issuerUrl, wif.target, pid, sessionId)
			: undefined,
	);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.preview',
		() =>
			deps.services.events.append({
				event: 'integration.preview',
				actor: user.id,
				project_id: pid,
				integration_id: iid,
				namespace,
				table,
				row_limit: limit,
			}),
	);
	return c.json({ success: true, data }, 200);
});

const OBJECT_METADATA_TTL_MS = 15_000;

app.openapi(browseObjectBuckets, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { limit, cursor, fresh } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	const { context, stateToken } = await requireAuthorizedObjectAccess(
		deps,
		user,
		integrations,
		pid,
		iid,
		c.req.raw.signal,
	);
	const request = { limit, ...(cursor ? { cursor } : {}) };
	const data = await cachedBrowse(
		JSON.stringify([pid, iid, user.id, stateToken, 'object-buckets', request]),
		OBJECT_METADATA_TTL_MS,
		fresh === 'true',
		() => assertBrowseBudget(user.id),
		() => runObjectBrowse(() => integrations.browseObjectBuckets(pid, iid, context, request)),
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseObjects, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { bucket, prefix, limit, cursor, fresh } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	const { context, stateToken } = await requireAuthorizedObjectAccess(
		deps,
		user,
		integrations,
		pid,
		iid,
		c.req.raw.signal,
	);
	const request = {
		bucket,
		limit,
		...(prefix !== undefined ? { prefix } : {}),
		...(cursor ? { cursor } : {}),
	};
	const data = await cachedBrowse(
		JSON.stringify([pid, iid, user.id, stateToken, 'objects', request]),
		OBJECT_METADATA_TTL_MS,
		fresh === 'true',
		() => assertBrowseBudget(user.id),
		() => runObjectBrowse(() => integrations.browseObjects(pid, iid, context, request)),
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(searchObjects, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const query = c.req.valid('query');
	if (
		query.min_size !== undefined &&
		query.max_size !== undefined &&
		query.min_size > query.max_size
	) {
		throw new ValidationError('min_size cannot exceed max_size.');
	}
	if (
		query.modified_after !== undefined &&
		query.modified_before !== undefined &&
		Date.parse(query.modified_after) > Date.parse(query.modified_before)
	) {
		throw new ValidationError('modified_after cannot be later than modified_before.');
	}
	const { integrations } = requireDataBrowser(deps);
	const { capability, context } = await requireAuthorizedObjectAccess(
		deps,
		user,
		integrations,
		pid,
		iid,
		c.req.raw.signal,
	);
	if (capability.search !== 'bounded-key-name') {
		throw new ValidationError('Object search is unavailable.');
	}
	assertObjectSearchBudget(user.id);
	const formats = query.formats
		?.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
	const data = await runObjectBrowse(() =>
		integrations.searchObjects(pid, iid, context, {
			bucket: query.bucket,
			query: query.query,
			limit: query.limit,
			...(query.prefix !== undefined ? { prefix: query.prefix } : {}),
			...(query.cursor ? { cursor: query.cursor } : {}),
			...(formats?.length ? { formats } : {}),
			...(query.modified_after ? { modified_after: query.modified_after } : {}),
			...(query.modified_before ? { modified_before: query.modified_before } : {}),
			...(query.min_size !== undefined ? { min_size: query.min_size } : {}),
			...(query.max_size !== undefined ? { max_size: query.max_size } : {}),
		}),
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseObjectHead, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { bucket, key, version_id } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	const { context } = await requireAuthorizedObjectAccess(
		deps,
		user,
		integrations,
		pid,
		iid,
		c.req.raw.signal,
	);
	const request = { bucket, key, ...(version_id ? { version_id } : {}) };
	assertBrowseBudget(user.id);
	const data = await runObjectBrowse(() =>
		integrations.browseObjectDetail(pid, iid, context, request),
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseObjectVersions, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { bucket, key, version_id, limit, cursor } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	const { capability, context } = await requireAuthorizedObjectAccess(
		deps,
		user,
		integrations,
		pid,
		iid,
		c.req.raw.signal,
	);
	if (!capability.versions) throw new ValidationError('Object versions are unavailable.');
	assertBrowseBudget(user.id);
	const data = await runObjectBrowse(() =>
		integrations.browseObjectVersions(pid, iid, context, {
			bucket,
			key,
			limit,
			...(version_id ? { version_id } : {}),
			...(cursor ? { cursor } : {}),
		}),
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseObjectPreview, async (c) => {
	c.header('Cache-Control', 'no-store');
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const body = c.req.valid('json');
	const { integrations } = requireDataBrowser(deps);
	const { capability, context } = await requireAuthorizedObjectAccess(
		deps,
		user,
		integrations,
		pid,
		iid,
		c.req.raw.signal,
	);
	if (!capability.preview) throw new NotFoundError('Object preview is not enabled.');
	assertObjectPreviewBudget(user.id);
	const contentParams = new URLSearchParams({ bucket: body.bucket, key: body.key, inline: 'true' });
	if (body.version_id) contentParams.set('version_id', body.version_id);
	const data = await runObjectBrowse(() =>
		integrations.browseObjectPreview(pid, iid, context, {
			...body,
			content_url: `/api/v1/projects/${pid}/integrations/${iid}/browse/objects/content?${contentParams}`,
		}),
	);
	if (data.kind !== 'image') {
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'integration.object.preview',
			() =>
				deps.services.events.append({
					event: 'integration.object.preview',
					actor: user.id,
					project_id: pid,
					integration_id: iid,
					bucket: body.bucket,
					key: body.key,
					...(body.version_id ? { version_id: body.version_id } : {}),
					format: data.kind === 'unsupported' ? data.detected_type : data.format,
					bytes: 'bytes_read' in data ? data.bytes_read : undefined,
					request_id: c.get('requestId'),
				}),
		);
	}
	return c.json({ success: true, data }, 200);
});

app.get('/projects/:pid/integrations/:iid/browse/objects/content', async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const parsedIds = IntegrationIdParam.safeParse({
		pid: c.req.param('pid'),
		iid: c.req.param('iid'),
	});
	if (!parsedIds.success) throw new NotFoundError('Integration not found.');
	const parsed = ObjectIdentityQuery.extend({
		inline: z.enum(['true', 'false']).default('false'),
		etag: z.string().max(1024).optional(),
	}).safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError('Invalid object content request.');
	const { pid, iid } = parsedIds.data;
	const { bucket, key, version_id, inline, etag } = parsed.data;
	const { integrations } = requireDataBrowser(deps);
	const project = await assertProjectRole(deps.services.projects, pid, user, 'editor', deps.policy);
	const release = acquireDownload(deps, user.id);
	const controller = new AbortController();
	const abort = () => controller.abort();
	c.req.raw.signal.addEventListener('abort', abort, { once: true });
	const timeout = setTimeout(abort, deps.dataBrowser!.objectBrowser!.downloadTimeoutMs);
	const finish = () => {
		clearTimeout(timeout);
		c.req.raw.signal.removeEventListener('abort', abort);
	};
	try {
		const access = await resolveObjectAccess(
			deps,
			project,
			user,
			integrations,
			pid,
			iid,
			controller.signal,
		);
		const { capability } = requireObjectCapability(access.capability);
		const context = access.context;
		if (!capability.download) throw new NotFoundError('Object downloads are not enabled.');
		const range = validRangeHeader(c.req.header('range'));
		const object = await runObjectBrowse(() =>
			integrations.openObject(pid, iid, context, {
				bucket,
				key,
				...(version_id ? { version_id } : {}),
				...(range ? { range } : {}),
				...(etag ? { if_match: etag } : {}),
				inline: inline === 'true',
			}),
		);
		const event = inline === 'true' ? 'integration.object.preview' : 'integration.object.download';
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			event,
			() =>
				deps.services.events.append({
					event,
					actor: user.id,
					project_id: pid,
					integration_id: iid,
					bucket,
					key,
					...(version_id ? { version_id } : {}),
					...(range ? { range } : {}),
					bytes: object.content_length,
					request_id: c.get('requestId'),
				}),
		);
		const headers = new Headers({
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'private, no-store',
			'Content-Disposition': objectContentDisposition(key, inline === 'true'),
			'Content-Length': String(object.content_length),
			'Content-Type': safeObjectContentType(object.content_type, inline === 'true'),
			'X-Content-Type-Options': 'nosniff',
		});
		if (inline === 'true') headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
		if (object.content_range) headers.set('Content-Range', object.content_range);
		if (object.etag) headers.set('ETag', object.etag);
		if (object.version_id) headers.set('X-Marimohub-Object-Version', object.version_id);
		return new Response(streamObjectBody(object, release, finish, controller.signal), {
			status: object.status,
			headers,
		});
	} catch (error) {
		finish();
		release();
		throw error;
	}
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
