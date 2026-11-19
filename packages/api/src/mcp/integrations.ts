import { searchIntegrationTables, profileIntegrationTable } from '../integrations/discovery';
import { searchWorkspace } from '../search/operations';
import { boundedData } from '../integrations/bounds';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IntegrationId, NotFoundError, withAbortSignal } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, ProjectId } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import {
	CATALOG_PAGE_LIMIT,
	DataQueryBody,
	queryIntegrationData,
	NamespaceParts,
	OBJECT_PAGE_LIMIT,
	ObjectBucketValue,
	ObjectKeyValue,
	ObjectPrefixValue,
	ObjectVersionIdValue,
	PreviewRowLimit,
	getIntegrationObjectMetadata,
	getIntegrationTableSchema,
	listIntegrationNamespaces,
	listIntegrationObjectBuckets,
	listIntegrationObjects,
	listIntegrationTables,
	previewIntegrationObject,
	previewIntegrationTable,
	requireIntegrations,
} from '../integrations/browse';
import type { IntegrationBrowseContext } from '../integrations/browse';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, paginate } from '../pagination';
import { entryResponse } from '../routes/integrations';
import { assertProjectRole } from '../shared';
import { result, toolError } from './results';
import { PROJECT_REFERENCE_DESCRIPTION, resolveProject } from './selectors';
import type { StartRequestContext } from './server';

const ProjectSelector = z.object({
	project: z.string().min(1).describe(PROJECT_REFERENCE_DESCRIPTION),
});
const IntegrationSelector = ProjectSelector.extend({
	integration: z
		.string()
		.min(1)
		.describe(
			'Integration ID or exact name from list_integrations. Use an enabled, unshadowed entry.',
		),
});
const LIST_HEADS = { maxHeads: 500 };
const cursor = z.string().optional().describe('Opaque next_cursor from the previous page.');
const page = (limits: { default: number; max: number }) => ({
	limit: z.number().int().min(1).max(limits.max).default(limits.default),
	cursor,
});
const Namespace = NamespaceParts.describe(
	'Namespace parts from list_namespaces. Preserve dots inside each part.',
);
const Table = { namespace: Namespace, table: z.string().min(1) };
const SearchLimit = z.number().int().min(1).max(50).default(20);
const Bucket = ObjectBucketValue.describe('Bucket or container name from list_object_buckets.');
const ObjectIdentity = {
	bucket: Bucket,
	key: ObjectKeyValue.describe('Exact object key from list_objects.'),
	version_id: ObjectVersionIdValue.optional(),
};

const READ_HUB = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;
const READ_UPSTREAM = { ...READ_HUB, openWorldHint: true } as const;

export function registerIntegrationTools(
	server: McpServer,
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext,
): void {
	function register<Input extends z.infer<typeof ProjectSelector>>(
		name: string,
		description: string,
		inputSchema: z.ZodType<Input>,
		action: 'integration.read' | 'integration.use' | 'integration.manage',
		handler: (input: Input, context: Omit<IntegrationBrowseContext, 'iid'>) => Promise<object>,
	) {
		server.registerTool(
			name,
			{
				description,
				inputSchema,
				annotations: action === 'integration.read' ? READ_HUB : READ_UPSTREAM,
			},
			async (input, extra) => {
				const signal = request.signal
					? AbortSignal.any([request.signal, extra.signal])
					: extra.signal;
				try {
					signal.throwIfAborted();
					const project = await withAbortSignal(
						resolveProject(deps, principal, input.project, action),
						signal,
					);
					signal.throwIfAborted();
					const data = await withAbortSignal(
						handler(input, {
							deps,
							user: principal,
							pid: project.id,
							signal,
							request,
						}),
						signal,
					);
					return result({ ...data });
				} catch (error) {
					return toolError(error, { ...request, signal, userId: principal.id, tool: name });
				}
			},
		);
	}

	register(
		'list_integrations',
		'List project and inherited organization integrations without credentials or configuration. Disabled and shadowed entries are included and marked; they cannot be browsed. Requires integration.read.',
		ProjectSelector.extend(page({ default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE })),
		'integration.read',
		async (input, { pid, signal }) => {
			await assertProjectRole(deps.services.projects, pid, principal, 'integration.read', deps);
			const entries = await requireIntegrations(deps).list(pid, { signal, ...LIST_HEADS });
			return paginate(entries.map(entryResponse), input, {
				key: (entry) => entry.updated_at,
				tiebreak: (entry) => entry.id,
			});
		},
	);
	if (!deps.dataBrowser) return;

	function registerBrowse<Input extends z.infer<typeof IntegrationSelector>>(
		name: string,
		description: string,
		schema: z.ZodType<Input>,
		handler: (context: IntegrationBrowseContext, input: Input) => Promise<object>,
		action: 'integration.use' | 'integration.manage' = 'integration.use',
	) {
		register(
			name,
			`${description} Requires ${action} (${action === 'integration.manage' ? 'manager' : 'editor'} or above).`,
			schema,
			action,
			async (input, context) =>
				handler(
					{
						...context,
						iid: await resolveIntegration(deps, context.pid, input.integration, context.signal),
					},
					input,
				),
		);
	}

	registerBrowse(
		'list_namespaces',
		'List catalog namespaces, optionally beneath a parent. Returns namespace parts and next_cursor.',
		IntegrationSelector.extend({ ...page(CATALOG_PAGE_LIMIT), parent: Namespace.optional() }),
		listIntegrationNamespaces,
	);
	registerBrowse(
		'list_tables',
		'List tables in a namespace. Returns table names and next_cursor.',
		IntegrationSelector.extend({ ...page(CATALOG_PAGE_LIMIT), namespace: Namespace }),
		listIntegrationTables,
	);
	registerBrowse(
		'get_table_schema',
		'Read column names, types, partitioning, and an available notebook loading snippet.',
		IntegrationSelector.extend(Table),
		getIntegrationTableSchema,
	);
	registerBrowse(
		'search_tables',
		'Find table names within one integration. Bounded traversal returns coverage and a reason when incomplete.',
		IntegrationSelector.extend({
			q: z.string().min(1).max(256),
			namespace: Namespace.optional(),
			limit: SearchLimit,
		}),
		searchIntegrationTables,
	);
	if (deps.search) {
		registerBrowse(
			'find_notebooks_using_table',
			'Find indexed notebook code that may reference a table. Matches are candidates, not verified integration bindings; index coverage may be incomplete.',
			IntegrationSelector.extend({ ...Table, limit: SearchLimit }),
			async (context, input) => {
				await getIntegrationTableSchema(context, input);
				const data = await searchWorkspace(
					deps,
					principal,
					{ project_id: context.pid, q: input.table, kinds: ['code'], limit: input.limit },
					context.signal,
				);
				return boundedData({ ...data, integration_binding: 'unverified' as const });
			},
		);
	}
	if (deps.dataBrowser.preview) {
		registerBrowse(
			'profile_table',
			'Summarize nulls and distinct primitive values in a bounded preview sample, not a whole-table estimate.',
			IntegrationSelector.extend({
				...Table,
				sample_rows: PreviewRowLimit,
				columns: z.array(z.string()).min(1).max(50).optional(),
			}),
			profileIntegrationTable,
		);
		registerBrowse(
			'preview_table',
			'Read a bounded row sample without creating a notebook. May start temporary preview compute.',
			IntegrationSelector.extend({ ...Table, limit: PreviewRowLimit }),
			previewIntegrationTable,
		);
	}
	if (deps.dataBrowser.query) {
		registerBrowse(
			'run_query',
			'Run read-only SQL against one integration with deployment row, byte, and time limits.',
			IntegrationSelector.extend(DataQueryBody.shape),
			queryIntegrationData,
			'integration.manage',
		);
	}
	if (!deps.dataBrowser.objectBrowser) return;
	registerBrowse(
		'list_object_buckets',
		'List buckets or containers accessible through an integration. Returns next_cursor for pagination.',
		IntegrationSelector.extend(page(OBJECT_PAGE_LIMIT)),
		listIntegrationObjectBuckets,
	);
	registerBrowse(
		'list_objects',
		'List direct object and prefix children in a bucket or container. Pass a returned prefix to descend; this is not recursive search.',
		IntegrationSelector.extend({
			...page(OBJECT_PAGE_LIMIT),
			bucket: Bucket,
			prefix: ObjectPrefixValue.optional(),
		}),
		listIntegrationObjects,
	);
	registerBrowse(
		'get_object_metadata',
		'Read object size, content type, metadata, tags, and an available loading snippet without downloading its body.',
		IntegrationSelector.extend(ObjectIdentity),
		getIntegrationObjectMetadata,
	);
	registerBrowse(
		'preview_object',
		'Preview bounded table rows or text from an object. Images return only their content type and size; open the Data page to view them. Unsupported formats return a reason.',
		IntegrationSelector.extend({ ...ObjectIdentity, limit: PreviewRowLimit }),
		async (context, input) => {
			const data = await previewIntegrationObject(context, input);
			// The image's content URL is a REST route, which rejects MCP tokens.
			return data.kind === 'image'
				? { kind: 'image', content_type: `image/${data.format}`, size: data.total_bytes }
				: data;
		},
	);
}

/** Integration ID, or the exact name of an unshadowed entry visible in the project. */
async function resolveIntegration(
	deps: ApiDeps,
	pid: ProjectId,
	value: string,
	signal?: AbortSignal,
): Promise<IntegrationId> {
	if (IntegrationId.is(value)) return value;
	const entries = await requireIntegrations(deps).list(pid, { signal, ...LIST_HEADS });
	const match = entries.find((entry) => entry.name === value && entry.shadowed !== true);
	if (!match) throw new NotFoundError(`Integration '${value}' not found`);
	return match.id;
}
