import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IntegrationId, withAbortSignal } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import {
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
import { paginate } from '../pagination';
import { assertProjectRole } from '../shared';
import { result, toolError } from './results';
import { PROJECT_REFERENCE_DESCRIPTION, resolveProject } from './selectors';
import type { StartRequestContext } from './server';

const ProjectSelector = z.object({
	project: z.string().min(1).describe(PROJECT_REFERENCE_DESCRIPTION),
});
const IntegrationSelector = ProjectSelector.extend({
	integration_id: z
		.string()
		.regex(IntegrationId.regex)
		.refine(IntegrationId.is)
		.describe('Integration ID from list_integrations. Use an enabled, unshadowed entry.'),
});
const Page = {
	limit: z.number().int().min(1).max(100).default(50),
	cursor: z.string().optional().describe('Opaque next_cursor from the previous page.'),
};
const Fresh = z
	.boolean()
	.default(false)
	.describe('Bypass cached metadata; consumes browse budget.');
const Namespace = z
	.array(
		z
			.string()
			.min(1)
			.refine((part) => !part.includes('\u001f')),
	)
	.min(1)
	.describe('Namespace parts from list_namespaces. Preserve dots inside each part.');
const Table = { namespace: Namespace, table: z.string().min(1) };
const PreviewLimit = z.number().int().min(1).max(100).default(20);
const Bucket = z
	.string()
	.min(1)
	.max(255)
	.describe('Bucket or container name from list_object_buckets.');
const ObjectPath = z
	.string()
	.refine((value) => new TextEncoder().encode(value).byteLength <= 1024, {
		message: 'Object paths must not exceed 1,024 UTF-8 bytes.',
	});
const ObjectIdentity = {
	bucket: Bucket,
	key: ObjectPath.refine((value) => value.length > 0).describe(
		'Exact object key from list_objects.',
	),
	version_id: z.string().min(1).max(2048).optional(),
};

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
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
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
		ProjectSelector.extend(Page),
		'integration.read',
		async (input, { pid, signal }) => {
			await assertProjectRole(deps.services.projects, pid, principal, 'integration.read', deps);
			const entries = await requireIntegrations(deps).list(pid, { signal, maxHeads: 500 });
			return paginate(
				entries.map((entry) => ({
					id: entry.id,
					name: entry.name,
					kind: entry.kind,
					scope: entry.scope,
					enabled: entry.enabled,
					shadowed: entry.shadowed ?? false,
					current_version: entry.current_version,
					updated_at: entry.updated_at,
				})),
				input,
				{ key: (entry) => entry.updated_at, tiebreak: (entry) => entry.id },
			);
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
			(input, context) =>
				handler({ ...context, iid: IntegrationId.parse(input.integration_id) }, input),
		);
	}

	browse(
		'list_namespaces',
		'List catalog namespaces, optionally beneath a parent. Returns namespace parts and next_cursor.',
		IntegrationSelector.extend({ ...Page, parent: Namespace.optional(), fresh: Fresh }),
		listIntegrationNamespaces,
	);
	browse(
		'list_tables',
		'List tables in a namespace. Returns table names and next_cursor.',
		IntegrationSelector.extend({ ...Page, namespace: Namespace, fresh: Fresh }),
		listIntegrationTables,
	);
	browse(
		'get_table_schema',
		'Read column names, types, partitioning, and an available notebook loading snippet.',
		IntegrationSelector.extend({ ...Table, fresh: Fresh }),
		getIntegrationTableSchema,
	);
	if (deps.dataBrowser.preview) {
		browse(
			'preview_table',
			'Read a bounded row sample without creating a notebook. May start temporary preview compute.',
			IntegrationSelector.extend({ ...Table, limit: PreviewLimit }),
			previewIntegrationTable,
		);
	}
	if (!deps.dataBrowser.objectBrowser) return;
	browse(
		'list_object_buckets',
		'List buckets or containers accessible through an integration. Returns next_cursor for pagination.',
		IntegrationSelector.extend({ ...Page, fresh: Fresh }),
		listIntegrationObjectBuckets,
	);
	browse(
		'list_objects',
		'List direct object and prefix children in a bucket or container. Pass a returned prefix to descend; this is not recursive search.',
		IntegrationSelector.extend({
			...Page,
			bucket: Bucket,
			prefix: ObjectPath.optional(),
			fresh: Fresh,
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
		'Preview bounded table rows or text from an object. Images return an authenticated content URL, not image bytes. Unsupported formats return a reason.',
		IntegrationSelector.extend({ ...ObjectIdentity, limit: PreviewLimit }),
		async (context, input) => {
			const data = await previewIntegrationObject(context, input);
			return data.kind === 'image'
				? { ...data, content_url: `${request.appBaseUrl.replace(/\/$/, '')}${data.content_url}` }
				: data;
		},
	);
}
