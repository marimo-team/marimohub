import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { makeTestWif } from '../testing';
import { discoveryToolNames, setupDiscovery } from '../testing/integrationDiscovery';
import { createApp } from '../shared';
import integrationBrowseRoutes from '../routes/integrationBrowse';
import { connectMcpClient, mcpPrincipal, mcpRequest } from '../testing/mcp';
import { openToolSession } from '../chat/tools';

afterEach(() => vi.restoreAllMocks());

describe('MCP data discovery', () => {
	it('registers only enabled tool families, all read-only', async () => {
		const { deps, client } = await setupDiscovery();
		const listed = (await client.listTools()).tools.filter((tool) =>
			discoveryToolNames.includes(tool.name),
		);
		expect(listed.map((tool) => tool.name)).toEqual(discoveryToolNames);
		expect(listed.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
		for (const [overrides, expected] of [
			[{ integrations: undefined }, []],
			[{ dataBrowser: undefined }, ['list_integrations']],
			[{ dataBrowser: { preview: false } }, discoveryToolNames.slice(0, 4)],
		] as const) {
			const disabled = await connectMcpClient({ ...deps, ...overrides }, mcpPrincipal);
			expect(
				(await disabled.listTools()).tools
					.filter((tool) => discoveryToolNames.includes(tool.name))
					.map((tool) => tool.name),
			).toEqual(expected);
		}
	});

	it('lists paginated metadata, including inherited and shadowed entries, without secrets', async () => {
		const { call, orgIntegrations } = await setupDiscovery();
		const inherited = await orgIntegrations.create(
			{ kind: 'test_catalog', name: 'inherited', config: { token: 'private-org-fixture' } },
			mcpPrincipal.id,
		);
		const shadowed = await orgIntegrations.create(
			{ kind: 'test_catalog', name: 'warehouse', config: { token: 'private-shadow-fixture' } },
			mcpPrincipal.id,
		);
		const items: Record<string, unknown>[] = [];
		let cursor: unknown;
		do {
			const response = await call('list_integrations', { limit: 1, cursor });
			expect(response.isError).not.toBe(true);
			const page = response.structuredContent as {
				items: Record<string, unknown>[];
				next_cursor: string | null;
			};
			expect(page.items).toHaveLength(1);
			items.push(...page.items);
			cursor = page.next_cursor;
		} while (cursor);
		expect(items).toHaveLength(4);
		expect(items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: inherited.id, scope: 'org', shadowed: false }),
				expect.objectContaining({ id: shadowed.id, scope: 'org', shadowed: true }),
			]),
		);
		expect(JSON.stringify(items)).not.toMatch(/private-|config|token|access_key/);
		expect(await call('list_namespaces', { integration_id: inherited.id })).toMatchObject({
			structuredContent: { items: [['sales', 'eu.central']] },
		});
		expect(await call('list_namespaces', { integration_id: shadowed.id })).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
	});

	it('preserves multipart namespaces, pagination, snippets, and preview audit events', async () => {
		const { call, deps, project, catalog, listNamespaces, listTables, previewRows } =
			await setupDiscovery();
		const audit = vi.spyOn(deps.services.events, 'append');
		expect(
			await call('list_namespaces', {
				project: 'discovery',
				parent: ['sales', 'eu.central'],
				limit: 7,
				cursor: 'cursor',
			}),
		).toMatchObject({ structuredContent: { next_cursor: 'ns-next' } });
		expect(listNamespaces).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				parent: ['sales', 'eu.central'],
				limit: 7,
				cursor: 'cursor',
				query_user: mcpPrincipal.email,
			}),
		);
		const target = { namespace: ['sales', 'eu.central'], table: 'orders' };
		expect(await call('list_tables', { ...target, limit: 3, cursor: 'next' })).toMatchObject({
			structuredContent: { items: ['orders'], next_cursor: 'table-next' },
		});
		expect(listTables).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			target.namespace,
			expect.objectContaining({ limit: 3, cursor: 'next' }),
		);
		expect(await call('get_table_schema', target)).toMatchObject({
			structuredContent: {
				columns: [{ name: 'id', type: 'long', nullable: false }],
				snippet: "load('warehouse', 'sales.eu.central', 'orders')",
			},
		});
		expect(await call('preview_table', { ...target, limit: 2 })).toMatchObject({
			structuredContent: { columns: ['id'], rows: [[1]] },
		});
		expect(previewRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			target.namespace,
			'orders',
			expect.objectContaining({
				limit: 2,
				query_user: mcpPrincipal.email,
				signal: expect.any(AbortSignal),
			}),
		);
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'integration.preview',
				actor: mcpPrincipal.id,
				project_id: project.id,
				integration_id: catalog.id,
				row_limit: 2,
			}),
		);
	});

	it('lists objects and reads metadata and bounded previews through the credential context', async () => {
		const { call, objects, objectBrowser, deps, project } = await setupDiscovery();
		const audit = vi.spyOn(deps.services.events, 'append');
		const target = {
			integration_id: objects.id,
			bucket: 'lake',
			key: 'daily/file.txt',
			version_id: 'v1',
		};
		expect(
			await call('list_object_buckets', { integration_id: objects.id, limit: 4, cursor: 'bc' }),
		).toMatchObject({ structuredContent: { items: [{ name: 'lake' }], next_cursor: 'b-next' } });
		expect(
			await call('list_objects', { ...target, prefix: 'daily/', cursor: 'oc', limit: 3 }),
		).toMatchObject({
			structuredContent: { items: [{ key: 'daily/file.txt' }], next_cursor: 'o-next' },
		});
		expect(objectBrowser.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				auth: {
					method: 'static',
					access_key_id: 'fixture-access',
					secret_access_key: 'private-object-fixture',
				},
			}),
			expect.objectContaining({
				project_id: project.id,
				user_id: mcpPrincipal.id,
				signal: expect.any(AbortSignal),
			}),
			{ bucket: 'lake', prefix: 'daily/', cursor: 'oc', limit: 3 },
		);
		expect(await call('get_object_metadata', target)).toMatchObject({
			structuredContent: {
				bucket: 'lake',
				key: 'daily/file.txt',
				version_id: 'v1',
				size: 5,
				content_type: 'text/plain',
			},
		});
		const preview = await call('preview_object', { ...target, limit: 2 });
		expect(preview).toMatchObject({
			structuredContent: { kind: 'text', text: 'hello', truncated: false },
		});
		expect(JSON.stringify(preview)).not.toContain('private-object-fixture');
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'integration.object.preview',
				bucket: 'lake',
				key: 'daily/file.txt',
				version_id: 'v1',
				bytes: 5,
			}),
		);
		expect(objectBrowser.openObject).not.toHaveBeenCalled();
	});

	it('returns an authenticated image URL with the deployment prefix and encoded object identity', async () => {
		const { deps, objects, project } = await setupDiscovery();
		const client = await connectMcpClient(deps, mcpPrincipal, {
			...mcpRequest,
			appBaseUrl: 'https://hub.example.com/hub/',
		});
		const response = await client.callTool({
			name: 'preview_object',
			arguments: {
				project: project.id,
				integration_id: objects.id,
				bucket: 'lake',
				key: 'a b/#file.png',
				version_id: 'v+1',
			},
		});
		const data = response.structuredContent as { kind: string; content_url: string };
		expect(data.kind).toBe('image');
		const url = new URL(data.content_url);
		expect(url.pathname).toBe(
			`/hub/api/v1/projects/${project.id}/integrations/${objects.id}/browse/objects/content`,
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			bucket: 'lake',
			key: 'a b/#file.png',
			inline: 'true',
			version_id: 'v+1',
		});
	});

	it('uses federated credentials when an ambient S3 integration requires them', async () => {
		const { deps, integrations, project, call, objectBrowser } = await setupDiscovery();
		const exchange = vi.fn(async () => ({
			accessKeyId: 'federated-id',
			secretAccessKey: 'federated-secret',
		}));
		deps.wif = makeTestWif({ defaultEnabled: true, exchange });
		const ambient = await integrations.create(
			project.id,
			{ kind: 's3', name: 'ambient', config: { bucket: 'lake', auth: { method: 'ambient' } } },
			mcpPrincipal.id,
		);
		expect(await call('list_object_buckets', { integration_id: ambient.id })).toMatchObject({
			structuredContent: { items: [{ name: 'lake' }] },
		});
		expect(exchange).toHaveBeenCalledOnce();
		expect(objectBrowser.listBuckets).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				federation: expect.objectContaining({ provider: 's3' }),
				allow_server_ambient: expect.objectContaining({ s3: false }),
			}),
			expect.anything(),
		);
	});

	it('allows viewers to list metadata but denies every data browse before provider access', async () => {
		const { deps, project, catalog, objects, listNamespaces, objectBrowser } =
			await setupDiscovery();
		const viewer: AuthenticatedPrincipal = { ...mcpPrincipal, id: UserId.parse('viewer') };
		await deps.services.projects.addMember(
			project.id,
			{ user_id: viewer.id },
			'viewer',
			mcpPrincipal.id,
		);
		const client = await connectMcpClient(deps, viewer);
		expect(
			(await client.callTool({ name: 'list_integrations', arguments: { project: project.id } }))
				.isError,
		).not.toBe(true);
		for (const name of discoveryToolNames.slice(1)) {
			const response = await client.callTool({
				name,
				arguments: {
					project: project.id,
					integration_id: name.includes('object') ? objects.id : catalog.id,
					namespace: ['sales'],
					table: 'orders',
					bucket: 'lake',
					key: 'file.txt',
				},
			});
			expect(response).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
		}
		expect(listNamespaces).not.toHaveBeenCalled();
		expect(objectBrowser.listBuckets).not.toHaveBeenCalled();
	});

	it('enforces token action and project grants for an otherwise authorized owner', async () => {
		const { deps, project, catalog, listNamespaces } = await setupDiscovery();
		const restricted = await connectMcpClient(deps, {
			...mcpPrincipal,
			credential: {
				kind: 'personal-access-token',
				id: 'restricted',
				grant: { actions: ['project.read', 'integration.read'], projects: [project.id] },
			},
		});
		expect(
			(await restricted.callTool({ name: 'list_integrations', arguments: { project: project.id } }))
				.isError,
		).not.toBe(true);
		expect(
			await restricted.callTool({
				name: 'list_namespaces',
				arguments: { project: project.id, integration_id: catalog.id },
			}),
		).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
		const other = await deps.services.projects.createProject(
			{ name: 'Other', description: '' },
			mcpPrincipal.id,
		);
		expect(
			(await restricted.callTool({ name: 'list_integrations', arguments: { project: other.id } }))
				.isError,
		).toBe(true);
		expect(listNamespaces).not.toHaveBeenCalled();
	});

	it.each(['id', 'name'])(
		'accepts integration-only token grants with a project %s selector',
		async (selector) => {
			const { deps, project, catalog } = await setupDiscovery();
			const client = await connectMcpClient(deps, {
				...mcpPrincipal,
				credential: {
					kind: 'personal-access-token',
					id: 'integration-only',
					grant: { actions: ['integration.read', 'integration.use'], projects: [project.id] },
				},
			});
			const selected = selector === 'id' ? project.id : project.name;
			expect(
				(await client.callTool({ name: 'list_integrations', arguments: { project: selected } }))
					.isError,
			).not.toBe(true);
			expect(
				await client.callTool({
					name: 'list_namespaces',
					arguments: { project: selected, integration_id: catalog.id },
				}),
			).toMatchObject({
				structuredContent: { items: [['sales', 'eu.central']] },
			});
		},
	);

	it('rechecks disabled integrations before serving cached metadata', async () => {
		const { call, integrations, project, catalog, listNamespaces } = await setupDiscovery();
		await call('list_namespaces');
		await integrations.update(project.id, catalog.id, { enabled: false }, mcpPrincipal.id);
		expect(await call('list_namespaces')).toMatchObject({
			isError: true,
			structuredContent: { code: 'VALIDATION_ERROR' },
		});
		expect(listNamespaces).toHaveBeenCalledOnce();
	});

	it('does not resolve integration IDs from another project', async () => {
		const { call, deps, integrations, listNamespaces } = await setupDiscovery();
		const other = await deps.services.projects.createProject(
			{ name: 'Other', description: '' },
			mcpPrincipal.id,
		);
		const foreign = await integrations.create(
			other.id,
			{
				kind: 'test_catalog',
				name: 'foreign',
				config: { token: 'foreign-fixture' },
			},
			mcpPrincipal.id,
		);
		expect(await call('list_namespaces', { integration_id: foreign.id })).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
		expect(listNamespaces).not.toHaveBeenCalled();
	});

	it('cancels an in-flight preview and forwards cancellation to the provider', async () => {
		const { deps, project, catalog, integrations } = await setupDiscovery();
		const controller = new AbortController();
		const started = Promise.withResolvers<AbortSignal>();
		vi.spyOn(integrations, 'browseTablePreview').mockImplementation(
			async (_pid, _iid, _principal, _session, _namespace, _table, input) => {
				const signal = input.signal!;
				started.resolve(signal);
				return new Promise((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => reject(new DOMException('Cancelled', 'AbortError')),
						{ once: true },
					);
				});
			},
		);
		const client = await connectMcpClient(deps, mcpPrincipal, {
			...mcpRequest,
			signal: controller.signal,
		});
		const response = client.callTool({
			name: 'preview_table',
			arguments: {
				project: project.id,
				integration_id: catalog.id,
				namespace: ['sales'],
				table: 'orders',
			},
		});
		const signal = await started.promise;
		controller.abort();
		expect(await response).toMatchObject({
			isError: true,
			structuredContent: { code: 'REQUEST_CANCELLED' },
		});
		expect(signal.aborted).toBe(true);
	});

	it('shares metadata cache and browse budget with HTTP routes', async () => {
		const { deps, project, catalog, call, listNamespaces } = await setupDiscovery();
		const api = createApp();
		api.use('*', async (c, next) => {
			c.set('deps', deps);
			c.set('user', mcpPrincipal);
			await next();
		});
		api.route('/', integrationBrowseRoutes);
		const path = `/projects/${project.id}/integrations/${catalog.id}/browse/namespaces?limit=50`;
		expect((await api.request(path)).status).toBe(200);
		await call('list_namespaces');
		expect(listNamespaces).toHaveBeenCalledOnce();
		for (let index = 0; index < 19; index++) {
			expect((await call('list_namespaces', { fresh: true })).isError).not.toBe(true);
		}
		expect(await call('list_namespaces', { fresh: true })).toMatchObject({
			isError: true,
			structuredContent: { code: 'RESOURCE_EXHAUSTED' },
		});
	});

	it.each([
		['list_namespaces', { limit: 101 }],
		['list_tables', { namespace: [] }],
		['get_table_schema', { namespace: [''], table: 'orders' }],
		['preview_table', { namespace: ['sales'], table: 'orders', limit: 101 }],
		['list_objects', { bucket: 'lake', prefix: 'é'.repeat(513) }],
		['preview_object', { bucket: 'lake', key: 'file', limit: 101 }],
	])('rejects invalid %s inputs before browsing', async (name, args) => {
		const { call, listNamespaces, previewRows, objectBrowser } = await setupDiscovery();
		expect((await call(name, args)).isError).toBe(true);
		expect(listNamespaces).not.toHaveBeenCalled();
		expect(previewRows).not.toHaveBeenCalled();
		expect(objectBrowser.listObjects).not.toHaveBeenCalled();
	});

	it('makes discovery available to chat without consent and pins it to the current project', async () => {
		const { deps, project, catalog, listNamespaces } = await setupDiscovery();
		const session = await openToolSession(deps, mcpPrincipal, project, mcpRequest);
		onTestFinished(() => session.close());
		const emit = vi.fn();
		const tools = session.buildTools({
			turn: {
				assistantMessageId: 'assistant',
				stopSignal: new AbortController().signal,
				saveParts: vi.fn(),
				checkpoint: vi.fn(),
			},
			conversationId: 'conversation',
			canPrompt: false,
			signal: new AbortController().signal,
			emit,
		});
		for (const name of discoveryToolNames) {
			const definition = session.definitions.find((entry) => entry.name === name)!;
			expect(definition.readOnly).toBe(true);
			expect(definition.inputSchema.properties).not.toHaveProperty('project');
		}
		const options = { toolCallId: 'call', messages: [], context: undefined };
		await tools.list_namespaces.execute!({ integration_id: catalog.id }, options);
		expect(listNamespaces).toHaveBeenCalledOnce();
		expect(emit).not.toHaveBeenCalled();
		await expect(
			tools.list_integrations.execute!({ project: 'another-project' }, options),
		).rejects.toThrow(/scoped to the current project/);
	});
});
