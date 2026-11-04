import { vi } from 'vitest';
import { z } from 'zod';
import {
	AesGcmSecretCodec,
	defaultRegistry,
	defineIntegration,
	Millis,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
	zSecret,
} from '@marimo-hub/core';
import type { BrowsePage, ObjectBrowser, TablePreview, TableSchema } from '@marimo-hub/core';
import { createInitializedBucket, makeTestDeps } from './index';
import { connectMcpClient, mcpPrincipal } from './mcp';

export const discoveryToolNames = [
	'list_integrations',
	'list_namespaces',
	'list_tables',
	'get_table_schema',
	'preview_table',
	'list_object_buckets',
	'list_objects',
	'get_object_metadata',
	'preview_object',
];

export async function setupDiscovery() {
	const bucket = await createInitializedBucket();
	const registry = defaultRegistry();
	const listNamespaces = vi.fn(
		async (): Promise<BrowsePage<string[]>> => ({
			items: [['sales', 'eu.central']],
			next_cursor: 'ns-next',
		}),
	);
	const listTables = vi.fn(
		async (): Promise<BrowsePage<string>> => ({ items: ['orders'], next_cursor: 'table-next' }),
	);
	const getTableSchema = vi.fn(
		async (): Promise<TableSchema> => ({
			columns: [{ name: 'id', type: 'long', nullable: false }],
		}),
	);
	const previewRows = vi.fn(async (): Promise<TablePreview> => ({ columns: ['id'], rows: [[1]] }));
	registry.register(
		defineIntegration({
			kind: 'test_catalog',
			title: 'Test catalog',
			description: '',
			category: 'catalog',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			browse: {
				available: () => ({ ok: true }),
				listNamespaces,
				listTables,
				getTableSchema,
				previewRows,
				snippet: (name, namespace, table) =>
					`load('${name}', '${namespace.join('.')}', '${table}')`,
			},
		}),
	);
	const objectBrowser: ObjectBrowser<'s3'> = {
		provider: 's3',
		capability: (source, context) => ({
			provider: 's3',
			root_kind: 'bucket',
			uri_scheme: 's3',
			available: source.auth.method === 'static' || context.federation !== undefined,
			preview: true,
			download: true,
			search: 'none',
			versions: false,
			preview_formats: ['text', 'png'],
		}),
		listBuckets: vi.fn(async () => ({
			items: [{ name: 'lake', configured: true }],
			next_cursor: 'b-next',
		})),
		listObjects: vi.fn<ObjectBrowser<'s3'>['listObjects']>(async () => ({
			items: [{ kind: 'object', key: 'daily/file.txt', name: 'file.txt', size: 5 }],
			next_cursor: 'o-next',
		})),
		searchObjects: vi.fn(),
		headObject: vi.fn(async (_source, _context, input) => ({
			...input,
			size: 5,
			content_type: 'text/plain',
			checksums: [],
			metadata: {},
			tags_available: false,
		})),
		listVersions: vi.fn(),
		previewObject: vi.fn<ObjectBrowser<'s3'>['previewObject']>(async (_source, _context, input) =>
			input.key.endsWith('.png')
				? {
						kind: 'image',
						format: 'png',
						content_url: input.content_url,
						total_bytes: 5,
						warnings: [],
					}
				: {
						kind: 'text',
						format: 'text',
						text: 'hello',
						truncated: false,
						bytes_read: 5,
						total_bytes: 5,
						warnings: [],
					},
		),
		openObject: vi.fn(),
	};
	const options = {
		bucket,
		registry,
		codec: new AesGcmSecretCodec({ kek: '/ECMzY/eM7nlHPPNu+OM2wv0lWiFuHUScSJxNmh64N8=' }),
		browseProbe: { connect: vi.fn(), fetch: vi.fn() },
		objectBrowsers: { s3: objectBrowser },
	};
	const integrations = new ProjectIntegrationsStore(options);
	const orgIntegrations = new OrgIntegrationsStore(options);
	const deps = makeTestDeps(bucket, {
		integrations,
		orgIntegrations,
		dataBrowser: {
			preview: true,
			objectBrowser: {
				allowServerAmbientCredentials: false,
				maxConcurrentDownloads: 4,
				maxConcurrentDownloadsPerUser: 1,
				downloadTimeoutMs: Millis.of(60_000),
			},
		},
	});
	const project = await deps.services.projects.createProject(
		{ name: 'Discovery', description: '' },
		mcpPrincipal.id,
	);
	const catalog = await integrations.create(
		project.id,
		{
			kind: 'test_catalog',
			name: 'warehouse',
			config: { token: 'private-catalog-fixture' },
		},
		mcpPrincipal.id,
	);
	const objects = await integrations.create(
		project.id,
		{
			kind: 's3',
			name: 'objects',
			config: {
				bucket: 'lake',
				auth: {
					method: 'static',
					access_key_id: 'fixture-access',
					secret_access_key: 'private-object-fixture',
				},
			},
		},
		mcpPrincipal.id,
	);
	const client = await connectMcpClient(deps, mcpPrincipal);
	const call = (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({
			name,
			arguments: { project: project.id, integration_id: catalog.id, ...args },
		});
	return {
		bucket,
		deps,
		project,
		catalog,
		objects,
		client,
		call,
		integrations,
		orgIntegrations,
		listNamespaces,
		listTables,
		getTableSchema,
		previewRows,
		objectBrowser,
	};
}
