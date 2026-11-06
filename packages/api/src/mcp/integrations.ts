import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IntegrationId, NotFoundError, withAbortSignal } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, ProjectId } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import {
	CATALOG_PAGE_LIMIT,
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
		action: 'integration.read' | 'integration.use',
		handler: (input: Input, context: Omit<IntegrationBrowseContext, 'iid'>) => Promise<object>,
	) {
		server.registerTool(
			name,
			{
				description,
				inputSchema,
				annotations: action === 'integration.use' ? READ_UPSTREAM : READ_HUB,
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

	function browse<Input extends z.infer<typeof IntegrationSelector>>(
		name: string,
		description: string,
		schema: z.ZodType<Input>,
		handler: (context: IntegrationBrowseContext, input: Input) => Promise<object>,
	) {
		register(
			name,
			`${description} Requires integration.use (editor or above).`,
			schema,
			'integration.use',
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

	browse(
		'list_namespaces',
		'List catalog namespaces, optionally beneath a parent. Returns namespace parts and next_cursor.',
		IntegrationSelector.extend({ ...page(CATALOG_PAGE_LIMIT), parent: Namespace.optional() }),
		listIntegrationNamespaces,
	);
	browse(
		'list_tables',
		'List tables in a namespace. Returns table names and next_cursor.',
		IntegrationSelector.extend({ ...page(CATALOG_PAGE_LIMIT), namespace: Namespace }),
		listIntegrationTables,
	);
	browse(
		'get_table_schema',
		'Read column names, types, partitioning, and an available notebook loading snippet.',
		IntegrationSelector.extend(Table),
		getIntegrationTableSchema,
	);
	if (deps.dataBrowser.preview) {
		browse(
			'preview_table',
			'Read a bounded row sample without creating a notebook. May start temporary preview compute.',
			IntegrationSelector.extend({ ...Table, limit: PreviewRowLimit }),
			previewIntegrationTable,
		);
	}
	if (!deps.dataBrowser.objectBrowser) return;
	browse(
		'list_object_buckets',
		'List buckets or containers accessible through an integration. Returns next_cursor for pagination.',
		IntegrationSelector.extend(page(OBJECT_PAGE_LIMIT)),
		listIntegrationObjectBuckets,
	);
	browse(
		'list_objects',
		'List direct object and prefix children in a bucket or container. Pass a returned prefix to descend; this is not recursive search.',
		IntegrationSelector.extend({
			...page(OBJECT_PAGE_LIMIT),
			bucket: Bucket,
			prefix: ObjectPrefixValue.optional(),
		}),
		listIntegrationObjects,
	);
	browse(
		'get_object_metadata',
		'Read object size, content type, metadata, tags, and an available loading snippet without downloading its body.',
		IntegrationSelector.extend(ObjectIdentity),
		getIntegrationObjectMetadata,
	);
	browse(
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
