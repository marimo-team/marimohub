import {
	requireDataBrowser,
	resolveObjectAccess,
	requireObjectCapability,
	resolveAuthorizedObjectAccess,
	requireAuthorizedObjectAccess,
	assertIntegrationBudget,
	consumeIntegrationBudget,
	clearBrowseStateForTests,
	listIntegrationNamespaces,
	listIntegrationTables,
	getIntegrationTableSchema,
	previewIntegrationTable,
	listIntegrationObjectBuckets,
	listIntegrationObjects,
	getIntegrationObjectMetadata,
	previewIntegrationObject,
	CATALOG_PAGE_LIMIT,
	OBJECT_PAGE_LIMIT,
	PreviewRowLimit,
	NAMESPACE_JOINER,
	NamespaceParts,
	NamespaceValue,
	ObjectBucketValue,
	ObjectPrefixValue,
	ObjectKeyValue,
	ObjectVersionIdValue,
} from '../integrations/browse';
import type { IntegrationBrowseContext } from '../integrations/browse';
import type { Context } from 'hono';
import type { HonoEnv } from '../context';
import { utcTimestamp } from '@marimo-hub/core/string-formats';
import { UploadPartBody, UploadResponseSchema } from '../uploads';
import { createRoute, z } from '@hono/zod-openapi';
import {
	ResumableUploads,
	paths,
	uploadStatus,
	MAX_UPLOAD_BYTES,
	ForbiddenError,
	ConflictError,
	IntegrationId,
	MAX_DATA_QUERY_SQL_BYTES,
	NotFoundError,
	ValidationError,
	assertValidDataQuerySql,
	createSessionId,
	StaleWhileRevalidateCache,
} from '@marimo-hub/core';
import type { AuthUser, ProjectId, ProjectIntegrationsService } from '@marimo-hub/core';
import {
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	extensibleResponseEnum,
	jsonBody,
	jsonContent,
	ProjectIdParam,
} from '../shared';
import type { ApiDeps } from '../shared';
import { appendAudit, logEvent } from '../log';
import { objectContentDisposition } from '../contentDisposition';
import { runObjectBrowse } from '../integrations/objectBrowseContext';
import {
	acquireDownload,
	safeObjectContentType,
	streamObjectBody,
	validRangeHeader,
} from './objectBrowse';

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const IidParam = z
	.string()
	.regex(IntegrationId.regex)
	.refine(IntegrationId.is)
	.openapi({ param: { name: 'iid', in: 'path' }, example: 'intg-7h2k9qm4xz7rp3w8' });
const IntegrationIdParam = ProjectIdParam.extend({ iid: IidParam });

// --- Data browser (read-only catalog metadata over an integration) ---

const NamespaceQueryValue = NamespaceValue.openapi({
	param: { name: 'namespace', in: 'query' },
	description: 'Namespace parts joined by U+001F (percent-encoded as %1F).',
	example: 'sales',
});

const BrowsePageQuery = z.object({
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(CATALOG_PAGE_LIMIT.max)
		.default(CATALOG_PAGE_LIMIT.default)
		.openapi({ param: { name: 'limit', in: 'query' }, example: CATALOG_PAGE_LIMIT.default }),
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
					provider: extensibleResponseEnum(['s3', 'gcs', 'azure_blob'], 's3'),
					root_kind: extensibleResponseEnum(['bucket', 'container'], 'bucket'),
					uri_scheme: extensibleResponseEnum(['s3', 'gs', 'az'], 's3'),
					available: z.boolean(),
					preview: z.boolean(),
					download: z.boolean(),
					write: z.boolean().optional(),
					search: extensibleResponseEnum(['none', 'bounded-key-name'], 'bounded-key-name'),
					versions: z.boolean(),
					preview_formats: z.array(z.string()),
					reason: z.string().optional(),
				})
				.optional(),
			query: z
				.object({
					available: z.boolean(),
					dialect: extensibleResponseEnum(['duckdb', 'postgresql'], 'duckdb'),
					reason: z.string().optional(),
				})
				.optional(),
		}),
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
				committed_at: utcTimestamp().optional(),
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
	namespace: NamespaceParts,
	table: z.string().min(1),
	limit: PreviewRowLimit,
});

const DataQueryBody = z
	.object({
		sql: z
			.string()
			.min(1)
			.refine((value) => utf8ByteLength(value) <= MAX_DATA_QUERY_SQL_BYTES, {
				message: `SQL exceeds the ${MAX_DATA_QUERY_SQL_BYTES}-byte limit.`,
			}),
	})
	.strict();

const DataQueryResultSchema = z
	.object({
		columns: z.array(z.string()),
		rows: z.array(z.array(z.unknown())),
		truncated: z.boolean(),
		execution_ms: z.number().int().nonnegative(),
	})
	.openapi('IntegrationDataQueryResult');

const QuerySchemaSchema = z
	.object({
		tables: z.array(
			z.object({
				namespace: z.array(z.string()),
				name: z.string(),
				columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean() })),
			}),
		),
		truncated: z.object({ tables: z.boolean(), columns: z.boolean(), bytes: z.boolean() }),
		counts: z.object({
			tables: z.number().int().nonnegative(),
			// Lower bound on catalog size: tables discovered before a limit tripped.
			discovered_tables: z.number().int().nonnegative(),
			columns: z.number().int().nonnegative(),
			discovery_complete: z.boolean(),
		}),
	})
	.openapi('IntegrationQuerySchema');

const GenerateSqlBody = z
	.object({
		mode: z.enum(['generate', 'revise']),
		instruction: z.string().trim().min(1).max(4_000),
		sql: z
			.string()
			.refine((value) => utf8ByteLength(value) <= MAX_DATA_QUERY_SQL_BYTES, {
				message: `SQL exceeds the ${MAX_DATA_QUERY_SQL_BYTES}-byte limit.`,
			})
			.optional(),
	})
	.strict();

const browseCapability = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse',
	operationId: 'integrations.project.browse.get',
	tags: ['Integrations'],
	summary: 'Whether this integration instance can be browsed (editor or above)',
	description:
		'Browse routes resolve the id against the project tier first, then the inherited org ' +
		'tier; a shadowed org instance reads as absent. Object uploads require explicit write access.',
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
	operationId: 'integrations.project.browse.namespaces',
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
	operationId: 'integrations.project.browse.tables',
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
	operationId: 'integrations.project.browse.schema',
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
	operationId: 'integrations.project.browse.preview',
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

const runDataQuery = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/{iid}/browse/query',
	operationId: 'integrations.project.browse.query',
	tags: ['Integrations'],
	summary: 'Run SQL against one integration (manager or above)',
	description:
		'SQL execution gated by deployment configuration. Each request uses a fresh ' +
		'isolated worker with hard execution, row, and byte limits.',
	request: { params: IntegrationIdParam, body: jsonBody(DataQueryBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: DataQueryResultSchema }),
			'Bounded query result',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const getDataQuerySchema = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/query/schema',
	operationId: 'integrations.project.browse.query-schema',
	tags: ['Integrations'],
	summary: 'Get bounded SQL completion schema (manager or above)',
	request: {
		params: IntegrationIdParam,
		query: z.object({
			focus_namespace: z.string().min(1).optional(),
			focus_table: z.string().min(1).optional(),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: QuerySchemaSchema }),
			'Bounded table and column schema for SQL tools',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const generateDataQuerySql = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/{iid}/browse/query/generate',
	operationId: 'integrations.project.browse.generate-query',
	tags: ['Integrations'],
	summary: 'Generate or revise SQL with managed AI (manager or above)',
	request: { params: IntegrationIdParam, body: jsonBody(GenerateSqlBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.object({ sql: z.string() }) }),
			'Generated DuckDB SQL',
		),
		...commonErrors(),
		...errorResponses(404, 429),
	},
});

const ObjectBucketQuery = ObjectBucketValue.openapi({
	param: { name: 'bucket', in: 'query' },
	example: 'analytics-lake',
});
const ObjectPrefixQuery = ObjectPrefixValue.openapi({
	param: { name: 'prefix', in: 'query' },
	example: 'events/2026/',
});
const ObjectKeyQuery = ObjectKeyValue.openapi({
	param: { name: 'key', in: 'query' },
	example: 'events/2026/part-001.jsonl',
});
const ObjectVersionValue = ObjectVersionIdValue.optional().openapi({
	param: { name: 'version_id', in: 'query' },
});
const ObjectPageQuery = z.object({
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(OBJECT_PAGE_LIMIT.max)
		.default(OBJECT_PAGE_LIMIT.default)
		.openapi({ param: { name: 'limit', in: 'query' }, example: OBJECT_PAGE_LIMIT.default }),
	cursor: BrowsePageQuery.shape.cursor,
	fresh: BrowsePageQuery.shape.fresh,
});
const ObjectIdentityQuery = z.object({
	bucket: ObjectBucketQuery,
	key: ObjectKeyQuery,
	version_id: ObjectVersionValue,
});

const ObjectBucketSchema = z
	.object({
		name: z.string(),
		created_at: utcTimestamp().optional(),
		configured: z.boolean(),
	})
	.openapi('IntegrationObjectBucket');
const ObjectEntrySchema = z
	.object({
		kind: z.enum(['prefix', 'object']),
		name: z.string(),
		key: z.string(),
		size: z.number().nonnegative().optional(),
		last_modified: utcTimestamp().optional(),
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
		last_modified: utcTimestamp().optional(),
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
		last_modified: utcTimestamp().optional(),
		size: z.number().nonnegative().optional(),
		etag: z.string().optional(),
		storage_class: z.string().optional(),
		owner: z.object({ id: z.string().optional(), display_name: z.string().optional() }).optional(),
	})
	.openapi('IntegrationObjectVersion');
const TabularObjectPreviewSchema = z.object({
	kind: z.literal('tabular'),
	format: extensibleResponseEnum(['table', 'csv', 'tsv', 'json', 'jsonl', 'parquet'], 'csv'),
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
			format: extensibleResponseEnum(['text', 'markdown', 'code', 'log', 'json'], 'text'),
			text: z.string(),
			truncated: z.boolean(),
			bytes_read: z.number().nonnegative(),
			total_bytes: z.number().nonnegative(),
			warnings: z.array(z.string()),
		}),
		z.object({
			kind: z.literal('image'),
			format: extensibleResponseEnum(['png', 'jpeg', 'gif', 'webp'], 'png'),
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
	operationId: 'integrations.project.browse.object-buckets',
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
	operationId: 'integrations.project.browse.objects',
	tags: ['Integrations'],
	summary: 'List direct object-store children (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: ObjectPageQuery.extend({
			bucket: ObjectBucketQuery,
			prefix: ObjectPrefixQuery.optional(),
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
	operationId: 'integrations.project.browse.search-objects',
	tags: ['Integrations'],
	summary: 'Run a bounded object-key search (editor or above)',
	request: {
		params: IntegrationIdParam,
		query: ObjectPageQuery.omit({ fresh: true }).extend({
			bucket: ObjectBucketQuery,
			prefix: ObjectPrefixQuery.optional(),
			query: z.string().trim().min(2).max(1024),
			formats: z.string().optional(),
			modified_after: utcTimestamp().optional(),
			modified_before: utcTimestamp().optional(),
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
	operationId: 'integrations.project.browse.object-head',
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
	operationId: 'integrations.project.browse.object-versions',
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
	operationId: 'integrations.project.browse.preview-object',
	tags: ['Integrations'],
	summary: 'Preview bounded object content (editor or above)',
	request: {
		params: IntegrationIdParam,
		body: jsonBody(
			z.object({
				bucket: ObjectBucketValue,
				key: ObjectKeyValue,
				version_id: ObjectVersionIdValue.optional(),
				limit: PreviewRowLimit,
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

const ObjectContentBinary = z.string().openapi({ format: 'binary' });

const browseObjectContent = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/browse/objects/content',
	operationId: 'integrations.project.browse.object-content',
	tags: ['Integrations'],
	summary: 'Stream object content (editor or above)',
	description:
		'Streams the object bytes raw — the target of the `content_url` embedded in preview ' +
		'responses. `inline=true` serves a sandboxed inline rendering (CSP forces an opaque ' +
		'origin); otherwise the response is a download (`Content-Disposition: attachment`). ' +
		'Supports single-part `Range` requests and an `etag` precondition (412 on mismatch).',
	request: {
		params: IntegrationIdParam,
		query: ObjectIdentityQuery.extend({
			inline: z.enum(['true', 'false']).default('false'),
			etag: z.string().max(1024).optional(),
		}),
		headers: z.object({
			range: z
				.string()
				.optional()
				.openapi({ param: { name: 'range', in: 'header' }, example: 'bytes=0-1023' }),
		}),
	},
	responses: {
		200: {
			content: { 'application/octet-stream': { schema: ObjectContentBinary } },
			description: 'The object bytes, streamed',
		},
		206: {
			content: { 'application/octet-stream': { schema: ObjectContentBinary } },
			description: 'The requested byte range (`Content-Range` identifies it)',
		},
		...commonErrors(),
		...errorResponses(403, 404, 412, 416, 429),
	},
});

function browseContext(
	c: Context<HonoEnv>,
	params: { pid: ProjectId; iid: IntegrationId },
): IntegrationBrowseContext {
	return {
		deps: c.get('deps'),
		user: c.get('user'),
		...params,
		signal: c.req.raw.signal,
		request: { requestId: c.get('requestId'), method: c.req.method, path: c.req.path },
	};
}

function splitNamespace(value: string): string[] {
	return value.split(NAMESPACE_JOINER);
}

const QUERY_SCHEMA_MAX_TABLES = 128;
const QUERY_SCHEMA_MAX_COLUMNS = 2_048;
const QUERY_SCHEMA_MAX_BYTES = 256 * 1024;
const QUERY_SCHEMA_TIMEOUT_MS = 15_000;

async function collectQuerySchema(
	integrations: ProjectIntegrationsService,
	projectId: ProjectId,
	integrationId: IntegrationId,
	queryUser: string,
	focus: { focus_namespace?: string; focus_table?: string },
	chargeWork: () => boolean,
) {
	const deadline = Date.now() + QUERY_SCHEMA_TIMEOUT_MS;
	const namespaces: string[][] = [];
	const queue: string[][] = [[]];
	const seen = new Set<string>();
	let namespaceTraversalTruncated = false;
	let workLimitReached = false;
	const focusNamespace = focus.focus_namespace ? splitNamespace(focus.focus_namespace) : undefined;
	if (focusNamespace) {
		const key = focusNamespace.join(NAMESPACE_JOINER);
		seen.add(key);
		namespaces.push(focusNamespace);
		queue.unshift(focusNamespace);
	}
	namespaceTraversal: while (queue.length > 0 && namespaces.length < 256 && Date.now() < deadline) {
		const parent = queue.shift()!;
		let cursor: string | undefined;
		const cursors = new Set<string>();
		do {
			if (!chargeWork()) {
				workLimitReached = true;
				break namespaceTraversal;
			}
			const page = await integrations.browseNamespaces(projectId, integrationId, {
				limit: 100,
				parent: parent.length > 0 ? parent : undefined,
				cursor,
				query_user: queryUser,
			});
			for (const namespace of page.items) {
				const key = namespace.join(NAMESPACE_JOINER);
				if (seen.has(key)) continue;
				if (namespaces.length >= 256) break;
				seen.add(key);
				namespaces.push(namespace);
				queue.push(namespace);
			}
			const nextCursor = page.next_cursor ?? undefined;
			if (nextCursor && cursors.has(nextCursor)) namespaceTraversalTruncated = true;
			cursor = nextCursor && !cursors.has(nextCursor) ? nextCursor : undefined;
			if (cursor) cursors.add(cursor);
		} while (cursor && namespaces.length < 256 && Date.now() < deadline);
	}
	const namespaceLimitReached =
		namespaceTraversalTruncated ||
		queue.length > 0 ||
		namespaces.length >= 256 ||
		Date.now() >= deadline;
	namespaces.sort((left, right) => {
		const focused = (value: string[]) =>
			focusNamespace && value.join(NAMESPACE_JOINER) === focusNamespace.join(NAMESPACE_JOINER)
				? 0
				: 1;
		return focused(left) - focused(right) || left.join('.').localeCompare(right.join('.'));
	});
	const tableRefs: { namespace: string[]; name: string }[] = [];
	let tableLimitReached = false;
	tableTraversal: for (const namespace of namespaces) {
		let cursor: string | undefined;
		const cursors = new Set<string>();
		do {
			if (!chargeWork()) {
				workLimitReached = true;
				break tableTraversal;
			}
			const page = await integrations.browseTables(projectId, integrationId, namespace, {
				limit: Math.min(100, QUERY_SCHEMA_MAX_TABLES - tableRefs.length),
				cursor,
				query_user: queryUser,
			});
			tableRefs.push(...page.items.map((name) => ({ namespace, name })));
			const nextCursor = page.next_cursor ?? undefined;
			if (nextCursor && cursors.has(nextCursor)) tableLimitReached = true;
			cursor = nextCursor && !cursors.has(nextCursor) ? nextCursor : undefined;
			if (cursor) cursors.add(cursor);
			if (tableRefs.length >= QUERY_SCHEMA_MAX_TABLES) {
				tableLimitReached = tableLimitReached || Boolean(cursor) || namespaces.at(-1) !== namespace;
				break;
			}
		} while (cursor && Date.now() < deadline);
		if (tableRefs.length >= QUERY_SCHEMA_MAX_TABLES || Date.now() >= deadline) break;
	}
	tableRefs.sort((left, right) => {
		const focused = (value: { namespace: string[]; name: string }) =>
			focusNamespace &&
			focus.focus_table === value.name &&
			value.namespace.join(NAMESPACE_JOINER) === focusNamespace.join(NAMESPACE_JOINER)
				? 0
				: 1;
		return (
			focused(left) - focused(right) ||
			[...left.namespace, left.name]
				.join('.')
				.localeCompare([...right.namespace, right.name].join('.'))
		);
	});
	const tables: {
		namespace: string[];
		name: string;
		columns: { name: string; type: string; nullable: boolean }[];
	}[] = [];
	let columnCount = 0;
	let columnLimitReached = false;
	let byteLimitReached = false;
	for (const table of tableRefs) {
		if (Date.now() >= deadline) break;
		if (!chargeWork()) {
			workLimitReached = true;
			break;
		}
		const schema = await integrations.browseTableSchema(
			projectId,
			integrationId,
			table.namespace,
			table.name,
			{ query_user: queryUser },
		);
		const remaining = QUERY_SCHEMA_MAX_COLUMNS - columnCount;
		const columns = schema.columns.slice(0, Math.max(0, remaining)).map((column) => ({
			name: column.name,
			type: column.type,
			nullable: column.nullable,
		}));
		if (columns.length < schema.columns.length) columnLimitReached = true;
		const next = { ...table, columns };
		const candidate = [...tables, next];
		if (
			utf8ByteLength(
				JSON.stringify({
					tables: candidate,
					truncated: { tables: true, columns: true, bytes: true },
					// Worst-case envelope so appending the real counts later cannot
					// push the response past the byte limit.
					counts: {
						tables: Number.MAX_SAFE_INTEGER,
						discovered_tables: Number.MAX_SAFE_INTEGER,
						columns: Number.MAX_SAFE_INTEGER,
						discovery_complete: false,
					},
				}),
			) > QUERY_SCHEMA_MAX_BYTES
		) {
			byteLimitReached = true;
			break;
		}
		tables.push(next);
		columnCount += columns.length;
		if (columnCount >= QUERY_SCHEMA_MAX_COLUMNS) break;
	}
	const discoveryComplete = !(
		workLimitReached ||
		namespaceLimitReached ||
		tableLimitReached ||
		Date.now() >= deadline
	);
	return {
		tables,
		truncated: {
			tables: !discoveryComplete || tables.length < tableRefs.length,
			columns: columnLimitReached,
			bytes: byteLimitReached,
		},
		counts: {
			tables: tables.length,
			discovered_tables: tableRefs.length,
			columns: columnCount,
			discovery_complete: discoveryComplete,
		},
	};
}

function quoteSqlIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

const QUERY_SCHEMA_CACHE_TTL_MS = 300_000;
const QUERY_SCHEMA_CACHE_MAX_ENTRIES = 128;

const querySchemaCache = new StaleWhileRevalidateCache<string, unknown>({
	ttl: () => ({ freshForMs: QUERY_SCHEMA_CACHE_TTL_MS, staleForMs: 0 }),
	maxSize: QUERY_SCHEMA_CACHE_MAX_ENTRIES,
});

async function cachedQuerySchema<T>(key: string, load: () => Promise<T>): Promise<T> {
	return (await querySchemaCache.get(key, load)) as T;
}

export function clearIntegrationBrowseStateForTests(): void {
	clearBrowseStateForTests();
	querySchemaCache.clear();
}

const app = createApp();

const objectUploadsPath = '/projects/{pid}/integrations/{iid}/browse/objects/uploads';
const ObjectUploadParams = IntegrationIdParam.extend({ uploadId: z.uuid() });
const ObjectUploadResultSchema = z.object({
	bucket: z.string(),
	key: z.string(),
	size: z.number(),
});
function objectUploads(deps: ApiDeps, pid: ProjectId) {
	return new ResumableUploads(deps.bucket, paths.project(pid).objectUploadsPrefix);
}
async function objectWriteAccess(
	deps: ApiDeps,
	user: AuthUser,
	pid: ProjectId,
	iid: IntegrationId,
	signal?: AbortSignal,
) {
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.write', deps);
	const access = await requireAuthorizedObjectAccess(deps, user, integrations, pid, iid, signal);
	if (!access.capability.write || !integrations.putObject)
		throw new ForbiddenError('Object uploads are not enabled for this integration');
	return { ...access, integrations };
}
async function authorizeObjectUpload(
	deps: ApiDeps,
	user: AuthUser,
	pid: ProjectId,
	iid: IntegrationId,
	id: string,
	options: { signal?: AbortSignal } = {},
) {
	const uploads = objectUploads(deps, pid);
	const record = await uploads.get(id, user.id);
	if (record.context.integration_id !== iid) throw new NotFoundError('Upload not found');
	if (record.status === 'complete') {
		await assertProjectRole(deps.services.projects, pid, user, 'integration.use', deps);
		return { access: null, uploads, record };
	}
	const access = await objectWriteAccess(deps, user, pid, iid, options.signal);
	if (record.context.state !== access.stateToken)
		throw new ConflictError('The integration changed; start a new upload');
	return { access, uploads, record };
}
app.openapi(
	createRoute({
		method: 'post',
		path: objectUploadsPath,
		operationId: 'startObjectUpload',
		tags: ['Integrations'],
		summary: 'Start an object upload',
		request: {
			params: IntegrationIdParam,
			body: jsonBody(
				z.object({
					bucket: z.string().min(1).max(256),
					path: z
						.string()
						.min(1)
						.max(1024)
						.refine((value) => utf8ByteLength(value) <= 1024, {
							message: 'Object key exceeds the 1,024-byte UTF-8 limit',
						}),
					size: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
					content_type: z
						.string()
						.max(256)
						.regex(/^[^\r\n]*$/)
						.optional(),
				}),
			),
		},
		responses: {
			201: jsonContent(UploadResponseSchema, 'Upload created'),
			...errorResponses(400, 401, 403, 404, 429),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const { pid, iid } = c.req.valid('param');
		const access = await objectWriteAccess(deps, user, pid, iid, c.req.raw.signal);
		const input = c.req.valid('json');
		const data = await objectUploads(deps, pid).start(
			{
				path: input.path,
				size: input.size,
				create_only: false,
				content_type: input.content_type || 'application/octet-stream',
			},
			user.id,
			MAX_UPLOAD_BYTES,
			{ integration_id: iid, bucket: input.bucket, state: access.stateToken },
		);
		return c.json({ success: true as const, data }, 201);
	},
);
app.openapi(
	createRoute({
		method: 'get',
		path: `${objectUploadsPath}/{uploadId}`,
		operationId: 'getObjectUpload',
		tags: ['Integrations'],
		summary: 'Get object upload progress',
		request: { params: ObjectUploadParams },
		responses: {
			200: jsonContent(UploadResponseSchema, 'Upload progress'),
			...errorResponses(401, 403, 404, 409),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const { pid, iid, uploadId } = c.req.valid('param');
		const { record } = await authorizeObjectUpload(deps, user, pid, iid, uploadId, {
			signal: c.req.raw.signal,
		});
		return c.json({ success: true as const, data: uploadStatus(record) }, 200);
	},
);
app.openapi(
	createRoute({
		method: 'put',
		path: `${objectUploadsPath}/{uploadId}/parts/{part}`,
		operationId: 'putObjectUploadPart',
		tags: ['Integrations'],
		summary: 'Upload one object part',
		request: {
			params: ObjectUploadParams.extend({ part: z.coerce.number().int().positive() }),
			body: UploadPartBody,
		},
		responses: {
			200: jsonContent(UploadResponseSchema, 'Part stored'),
			...errorResponses(400, 401, 403, 404, 409, 413),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const { pid, iid, uploadId, part } = c.req.valid('param');
		const { uploads } = await authorizeObjectUpload(deps, user, pid, iid, uploadId, {
			signal: c.req.raw.signal,
		});
		const data = await uploads.putPart(
			uploadId,
			part,
			new Uint8Array(await c.req.raw.arrayBuffer()),
			user.id,
		);
		return c.json({ success: true as const, data }, 200);
	},
);
app.openapi(
	createRoute({
		method: 'post',
		path: `${objectUploadsPath}/{uploadId}/complete`,
		operationId: 'completeObjectUpload',
		tags: ['Integrations'],
		summary: 'Publish an object upload',
		request: { params: ObjectUploadParams },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: ObjectUploadResultSchema,
				}),
				'Object published',
			),
			...errorResponses(401, 403, 404, 409, 429),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const { pid, iid, uploadId } = c.req.valid('param');
		const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60 * 60 * 1000)]);
		const { access, uploads } = await authorizeObjectUpload(deps, user, pid, iid, uploadId, {
			signal,
		});
		const result = await uploads.complete(uploadId, user.id, async (record) => {
			if (!access) throw new ConflictError('Upload has no completion result');
			return async () => {
				const iterator = uploads.chunks(record);
				const body = new ReadableStream<Uint8Array>({
					async pull(controller) {
						try {
							const next = await iterator.next();
							if (next.done) controller.close();
							else controller.enqueue(next.value);
						} catch (error) {
							controller.error(error);
						}
					},
					async cancel() {
						await iterator.return(undefined);
					},
				});
				await runObjectBrowse(() =>
					access.integrations.putObject!(
						pid,
						iid,
						{ ...access.context, expected_integration_state: access.stateToken },
						{
							bucket: record.context.bucket,
							key: record.path,
							size: record.size,
							contentType: record.content_type,
							body,
						},
					),
				);
				await appendAudit(
					deps,
					{
						requestId: c.get('requestId'),
						method: c.req.method,
						path: c.req.path,
						userId: user.id,
					},
					'integration.object.put',
					() =>
						deps.services.events.append({
							event: 'integration.object.put',
							actor: user.id,
							project_id: pid,
							integration_id: iid,
							bucket: record.context.bucket,
							key: record.path,
							bytes: record.size,
							request_id: c.get('requestId'),
						}),
				);
				return { bucket: record.context.bucket, key: record.path, size: record.size };
			};
		});
		const data = ObjectUploadResultSchema.parse(result);
		return c.json({ success: true as const, data }, 200);
	},
);
app.openapi(
	createRoute({
		method: 'delete',
		path: `${objectUploadsPath}/{uploadId}`,
		operationId: 'cancelObjectUpload',
		tags: ['Integrations'],
		summary: 'Cancel an object upload',
		request: { params: ObjectUploadParams },
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: z.object({}) }),
				'Upload cancelled',
			),
			...errorResponses(401, 403, 404, 409),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const { pid, iid, uploadId } = c.req.valid('param');
		await assertProjectRole(deps.services.projects, pid, user, 'integration.write', deps);
		const uploads = objectUploads(deps, pid);
		const record = await uploads.get(uploadId, user.id);
		if (record.context.integration_id !== iid) throw new NotFoundError('Upload not found');
		await uploads.cancel(uploadId, user.id);
		return c.json({ success: true as const, data: {} }, 200);
	},
);

// Editors can already read integration data through a session; viewers cannot.
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
	const querySurface = capability.surfaces.query;
	if (deps.dataBrowser?.query === true && querySurface?.available === false) {
		logEvent({
			level: 'warn',
			event: 'integration_query_unavailable',
			request_id: c.get('requestId') ?? null,
			project_id: pid,
			integration_id: iid,
			integration_kind: capability.integration_kind,
			surface: 'query',
			reason: querySurface.reason ?? 'No reason provided.',
		});
	}
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
					...(capability.surfaces.query ? { query: capability.surfaces.query } : {}),
				},
			},
		},
		200,
	);
});

app.openapi(browseNamespaces, async (c) => {
	const input = c.req.valid('query');
	const data = await listIntegrationNamespaces(browseContext(c, c.req.valid('param')), {
		...input,
		fresh: input.fresh === 'true',
		parent: input.parent === undefined ? undefined : splitNamespace(input.parent),
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(browseTables, async (c) => {
	const input = c.req.valid('query');
	const data = await listIntegrationTables(browseContext(c, c.req.valid('param')), {
		...input,
		fresh: input.fresh === 'true',
		namespace: splitNamespace(input.namespace),
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(browseTableSchema, async (c) => {
	const input = c.req.valid('query');
	const data = await getIntegrationTableSchema(browseContext(c, c.req.valid('param')), {
		...input,
		fresh: input.fresh === 'true',
		namespace: splitNamespace(input.namespace),
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(browseTablePreview, async (c) => {
	c.header('Cache-Control', 'no-store');
	const input = c.req.valid('json');
	const data = await previewIntegrationTable(browseContext(c, c.req.valid('param')), input);
	return c.json({ success: true, data }, 200);
});

app.openapi(runDataQuery, async (c) => {
	c.header('Cache-Control', 'no-store');
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { sql } = c.req.valid('json');
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps);
	if (deps.dataBrowser?.query !== true) {
		throw new NotFoundError('Run SQL is not enabled on this deployment');
	}
	const capability = await integrations.browseCapability(pid, iid);
	if (capability.surfaces.query?.available !== true) {
		throw new NotFoundError(capability.surfaces.query?.reason ?? 'Run SQL is unavailable');
	}
	assertIntegrationBudget(deps, 'dataQuery', user.id);
	const data = await integrations.runDataQuery(
		pid,
		iid,
		{ userId: user.id, email: user.email },
		createSessionId(),
		sql,
		c.req.raw.signal,
	);
	await appendAudit(
		deps,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.query',
		() =>
			deps.services.events.append({
				event: 'integration.query',
				actor: user.id,
				project_id: pid,
				integration_id: iid,
				sql_bytes: utf8ByteLength(sql),
				row_count: data.rows.length,
				truncated: data.truncated,
			}),
	);
	return c.json({ success: true, data: { ...data, execution_ms: data.execution_ms ?? 0 } }, 200);
});

app.openapi(getDataQuerySchema, async (c) => {
	c.header('Cache-Control', 'private, max-age=300');
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const focus = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps);
	if (deps.dataBrowser?.query !== true) {
		throw new NotFoundError('Run SQL is not enabled on this deployment');
	}
	assertIntegrationBudget(deps, 'browse', user.id);
	const capability = await integrations.browseCapability(pid, iid);
	if (!capability.surfaces.query?.available || !capability.metadata) {
		throw new NotFoundError(capability.surfaces.query?.reason ?? 'Run SQL is unavailable');
	}
	const schemaKey = JSON.stringify([
		user.id,
		user.email,
		pid,
		iid,
		capability.current_version,
		capability.updated_at,
		focus.focus_namespace ?? null,
		focus.focus_table ?? null,
	]);
	const data = await cachedQuerySchema(schemaKey, () =>
		collectQuerySchema(integrations, pid, iid, user.email, focus, () =>
			consumeIntegrationBudget(deps, 'querySchemaWork', user.id),
		),
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(generateDataQuerySql, async (c) => {
	c.header('Cache-Control', 'no-store');
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const body = c.req.valid('json');
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps);
	const generateSql = deps.ai?.generateSql;
	if (deps.dataBrowser?.query !== true || !generateSql) {
		throw new NotFoundError('Managed AI SQL is not enabled on this deployment');
	}
	assertIntegrationBudget(deps, 'aiQuery', user.id);
	const capability = await integrations.browseCapability(pid, iid);
	if (!capability.surfaces.query?.available || !capability.metadata) {
		throw new NotFoundError(capability.surfaces.query?.reason ?? 'Run SQL is unavailable');
	}
	const schemaKey = JSON.stringify([
		user.id,
		user.email,
		pid,
		iid,
		capability.current_version,
		capability.updated_at,
		null,
		null,
	]);
	const snapshot = await cachedQuerySchema(schemaKey, () =>
		collectQuerySchema(integrations, pid, iid, user.email, {}, () =>
			consumeIntegrationBudget(deps, 'querySchemaWork', user.id),
		),
	);
	const schema = snapshot.tables
		.map(
			(table) =>
				`${[...table.namespace, table.name].map(quoteSqlIdentifier).join('.')} (${table.columns
					.map((column) => `${quoteSqlIdentifier(column.name)} ${column.type}`)
					.join(', ')})`,
		)
		.join('\n');
	const generated = await generateSql({
		...body,
		schema,
		dialect: capability.surfaces.query.dialect,
		signal: c.req.raw.signal,
	});
	const sql = generated
		.trim()
		.replace(/^```(?:sql)?\s*/i, '')
		.replace(/\s*```$/, '')
		.trim();
	if (sql.length === 0 || utf8ByteLength(sql) > MAX_DATA_QUERY_SQL_BYTES) {
		throw new ValidationError('Managed AI returned invalid SQL.');
	}
	try {
		assertValidDataQuerySql(sql, capability.integration_kind);
	} catch {
		throw new ValidationError('Managed AI returned invalid SQL.');
	}
	await appendAudit(
		deps,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.query.generate',
		() =>
			deps.services.events.append({
				event: 'integration.query.generate',
				actor: user.id,
				project_id: pid,
				integration_id: iid,
				mode: body.mode,
				schema_table_count: snapshot.tables.length,
			}),
	);
	return c.json({ success: true, data: { sql } }, 200);
});

app.openapi(browseObjectBuckets, async (c) => {
	const input = c.req.valid('query');
	const data = await listIntegrationObjectBuckets(browseContext(c, c.req.valid('param')), {
		...input,
		fresh: input.fresh === 'true',
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(browseObjects, async (c) => {
	const input = c.req.valid('query');
	const data = await listIntegrationObjects(browseContext(c, c.req.valid('param')), {
		...input,
		fresh: input.fresh === 'true',
	});
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
	assertIntegrationBudget(deps, 'objectSearch', user.id);
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
	const input = c.req.valid('query');
	const data = await getIntegrationObjectMetadata(browseContext(c, c.req.valid('param')), input);
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
	assertIntegrationBudget(deps, 'browse', user.id);
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
	const input = c.req.valid('json');
	const data = await previewIntegrationObject(browseContext(c, c.req.valid('param')), input);
	return c.json({ success: true, data }, 200);
});

app.openapi(browseObjectContent, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const { bucket, key, version_id, inline, etag } = c.req.valid('query');
	const { integrations } = requireDataBrowser(deps);
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'integration.use',
		deps,
	);
	const operation = inline === 'true' ? 'inline' : 'download';
	const release = acquireDownload(deps, user.id, operation);
	const controller = new AbortController();
	let cancellationRecorded = false;
	const recordCancellation = () => {
		if (cancellationRecorded) return;
		cancellationRecorded = true;
		deps.metrics?.increment('object_browser.download.cancellations', 1, { operation });
	};
	const abort = () => {
		recordCancellation();
		controller.abort();
	};
	c.req.raw.signal.addEventListener('abort', abort, { once: true });
	if (c.req.raw.signal.aborted) abort();
	const timeout = setTimeout(() => {
		deps.metrics?.increment('object_browser.download.timeouts', 1, { operation });
		controller.abort(new DOMException('The object download timed out.', 'TimeoutError'));
	}, deps.dataBrowser!.objectBrowser!.downloadTimeoutMs);
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
			deps,
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
		return new Response(
			streamObjectBody(object, release, finish, controller.signal, recordCancellation),
			{
				status: object.status,
				headers,
			},
		);
	} catch (error) {
		finish();
		release();
		throw error;
	}
});

export default app;
