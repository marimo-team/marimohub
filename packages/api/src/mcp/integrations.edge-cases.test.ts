import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectBrowseError, UnavailableError, UserId } from '@marimo-hub/core';
import type { BrowsePage, ObjectPreview } from '@marimo-hub/core';
import { makeTestWif } from '../testing';
import { discoveryToolNames, setupDiscovery } from '../testing/integrationDiscovery';
import { connectMcpClient, mcpPrincipal, mcpRequest } from '../testing/mcp';

afterEach(() => vi.restoreAllMocks());

describe('MCP discovery edge cases', () => {
	it('returns empty terminal pages and empty previews without treating them as errors', async () => {
		const { call, deps, listNamespaces, listTables, previewRows, objectBrowser, objects } =
			await setupDiscovery();
		const empty = await deps.services.projects.createProject(
			{ name: 'Empty', description: '' },
			mcpPrincipal.id,
		);
		expect(await call('list_integrations', { project: empty.id })).toMatchObject({
			structuredContent: { items: [], next_cursor: null },
		});
		listNamespaces.mockResolvedValue({ items: [], next_cursor: null });
		listTables.mockResolvedValue({ items: [], next_cursor: null });
		previewRows.mockResolvedValue({ columns: ['id'], rows: [] });
		vi.mocked(objectBrowser.listObjects).mockResolvedValue({ items: [], next_cursor: null });
		for (const [name, input] of [
			['list_namespaces', {}],
			['list_tables', { namespace: ['empty'] }],
			['list_objects', { integration_id: objects.id, bucket: 'lake', prefix: '' }],
		] as const) {
			const response = await call(name, input);
			expect(response.isError).not.toBe(true);
			expect(response.structuredContent).toEqual({ items: [], next_cursor: null });
		}
		expect(await call('preview_table', { namespace: ['empty'], table: 'empty' })).toMatchObject({
			structuredContent: { columns: ['id'], rows: [] },
		});
	});

	it.each(['not-base64!', btoa('{}'), btoa('[1,"id"]')])(
		'rejects malformed integration cursor %s',
		async (cursor) => {
			const { call } = await setupDiscovery();
			expect(await call('list_integrations', { cursor })).toMatchObject({
				isError: true,
				structuredContent: { code: 'BAD_REQUEST', message: 'Invalid pagination cursor' },
			});
		},
	);

	it('accepts exact UTF-8 key and version limits without rewriting the object identity', async () => {
		const { call, objects, objectBrowser } = await setupDiscovery();
		const key = 'é'.repeat(512);
		const version_id = 'v'.repeat(2048);
		const response = await call('get_object_metadata', {
			integration_id: objects.id,
			bucket: 'lake',
			key,
			version_id,
		});
		expect(response.isError).not.toBe(true);
		expect(objectBrowser.headObject).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
			bucket: 'lake',
			key,
			version_id,
		});
	});

	it.each([1, 100])('accepts the boundary list and preview limit %i', async (limit) => {
		const { call, listNamespaces, previewRows, objectBrowser, objects } = await setupDiscovery();
		expect((await call('list_namespaces', { limit })).isError).not.toBe(true);
		expect(listNamespaces).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ limit }),
		);
		expect(
			(await call('preview_table', { namespace: ['sales'], table: 'orders', limit })).isError,
		).not.toBe(true);
		expect(previewRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			['sales'],
			'orders',
			expect.objectContaining({ limit }),
		);
		expect(
			(
				await call('preview_object', {
					integration_id: objects.id,
					bucket: 'lake',
					key: 'file.txt',
					limit,
				})
			).isError,
		).not.toBe(true);
		expect(objectBrowser.previewObject).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ limit }),
		);
	});

	it.each([
		['list_namespaces', { integration_id: 'invalid' }],
		['list_namespaces', { limit: 0 }],
		['list_namespaces', { limit: -1 }],
		['list_tables', { namespace: ['sales'], limit: 1.5 }],
		['list_namespaces', { parent: ['sales\u001feu'] }],
		['list_namespaces', { fresh: 'true' }],
		['get_table_schema', { namespace: ['sales'], table: '' }],
		['preview_table', { namespace: ['sales'], table: 'orders', limit: '20' }],
		['list_object_buckets', { limit: 101 }],
		['list_objects', { bucket: '' }],
		['list_objects', { bucket: 'b'.repeat(256) }],
		['get_object_metadata', { bucket: 'lake', key: '' }],
		['get_object_metadata', { bucket: 'lake', key: `${'é'.repeat(512)}x` }],
		['preview_object', { bucket: 'lake', key: 'file', version_id: '' }],
		['preview_object', { bucket: 'lake', key: 'file', version_id: 'v'.repeat(2049) }],
	])(
		'rejects invalid %s arguments before resolving credentials or calling a provider',
		async (name, input) => {
			const {
				call,
				integrations,
				listNamespaces,
				listTables,
				getTableSchema,
				previewRows,
				objectBrowser,
			} = await setupDiscovery();
			const capability = vi.spyOn(integrations, 'browseCapability');
			expect((await call(name, input)).isError).toBe(true);
			for (const provider of [
				capability,
				listNamespaces,
				listTables,
				getTableSchema,
				previewRows,
				objectBrowser.listBuckets,
				objectBrowser.listObjects,
				objectBrowser.headObject,
				objectBrowser.previewObject,
			]) {
				expect(provider).not.toHaveBeenCalled();
			}
		},
	);

	it.each(discoveryToolNames.slice(1))(
		'returns NOT_FOUND from %s for a deleted integration',
		async (name) => {
			const { call, integrations, project, catalog, listNamespaces, objectBrowser } =
				await setupDiscovery();
			await integrations.delete(project.id, catalog.id);
			expect(
				await call(name, {
					namespace: ['sales'],
					table: 'orders',
					bucket: 'lake',
					key: 'file.txt',
				}),
			).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
			expect(listNamespaces).not.toHaveBeenCalled();
			expect(objectBrowser.listBuckets).not.toHaveBeenCalled();
			expect(objectBrowser.previewObject).not.toHaveBeenCalled();
		},
	);

	it('rejects calls to unregistered preview tools', async () => {
		const { deps, project, catalog, objects, previewRows, objectBrowser } = await setupDiscovery();
		const client = await connectMcpClient(
			{ ...deps, dataBrowser: { preview: false } },
			mcpPrincipal,
		);
		for (const name of ['preview_table', 'preview_object']) {
			expect(
				(
					await client.callTool({
						name,
						arguments: {
							project: project.id,
							integration_id: name === 'preview_table' ? catalog.id : objects.id,
							namespace: ['sales'],
							table: 'orders',
							bucket: 'lake',
							key: 'file.txt',
						},
					})
				).isError,
			).toBe(true);
		}
		expect(previewRows).not.toHaveBeenCalled();
		expect(objectBrowser.previewObject).not.toHaveBeenCalled();
	});

	it('rejects unsupported browse surfaces without reaching either provider', async () => {
		const { call, catalog, objects, listNamespaces, objectBrowser } = await setupDiscovery();
		expect(await call('list_namespaces', { integration_id: objects.id })).toMatchObject({
			isError: true,
			structuredContent: { code: 'VALIDATION_ERROR' },
		});
		expect(await call('list_object_buckets', { integration_id: catalog.id })).toMatchObject({
			isError: true,
			structuredContent: { code: 'VALIDATION_ERROR' },
		});
		expect(listNamespaces).not.toHaveBeenCalled();
		expect(objectBrowser.listBuckets).not.toHaveBeenCalled();
	});

	it('rejects unavailable object previews without a success audit or download', async () => {
		const { call, objects, objectBrowser, deps } = await setupDiscovery();
		const capability = objectBrowser.capability;
		vi.spyOn(objectBrowser, 'capability').mockImplementation(async (source, context) => ({
			...(await capability(source, context)),
			preview: false,
		}));
		const audit = vi.spyOn(deps.services.events, 'append');
		expect(
			await call('preview_object', { integration_id: objects.id, bucket: 'lake', key: 'file.txt' }),
		).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
		expect(objectBrowser.previewObject).not.toHaveBeenCalled();
		expect(objectBrowser.openObject).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});

	it.each([
		{
			kind: 'unsupported',
			reason: 'Binary format is unsupported',
			detected_type: 'application/octet-stream',
			total_bytes: 4096,
		},
		{
			kind: 'tabular',
			format: 'csv',
			columns: [{ name: 'value' }],
			rows: [[null], ['é']],
			truncated: true,
			bytes_read: 128,
			total_bytes: 4096,
			warnings: ['Preview byte limit reached'],
		},
	] satisfies ObjectPreview[])(
		'preserves $kind preview results without downloading the object',
		async (preview) => {
			const { call, objects, objectBrowser } = await setupDiscovery();
			vi.mocked(objectBrowser.previewObject).mockResolvedValue(preview);
			const response = await call('preview_object', {
				integration_id: objects.id,
				bucket: 'lake',
				key: 'file.bin',
			});
			expect(response.isError).not.toBe(true);
			expect(response.structuredContent).toEqual(preview);
			expect(objectBrowser.openObject).not.toHaveBeenCalled();
		},
	);

	it.each([
		['access_denied', 'FORBIDDEN'],
		['not_found', 'NOT_FOUND'],
		['invalid_cursor', 'VALIDATION_ERROR'],
		['unsupported', 'VALIDATION_ERROR'],
		['precondition_failed', 'PRECONDITION_FAILED'],
		['unavailable', 'SERVICE_UNAVAILABLE'],
	] as const)(
		'maps provider %s failures without retrying or recording a success audit',
		async (providerCode, expectedCode) => {
			const { call, objects, objectBrowser, deps } = await setupDiscovery();
			vi.mocked(objectBrowser.previewObject).mockRejectedValue(
				new ObjectBrowseError(providerCode, 'Provider refused this request'),
			);
			const audit = vi.spyOn(deps.services.events, 'append');
			expect(
				await call('preview_object', {
					integration_id: objects.id,
					bucket: 'lake',
					key: 'file.txt',
				}),
			).toMatchObject({ isError: true, structuredContent: { code: expectedCode } });
			expect(objectBrowser.previewObject).toHaveBeenCalledOnce();
			expect(audit).not.toHaveBeenCalled();
		},
	);

	it.each(['table', 'object'])(
		'redacts unexpected %s preview failures from results and logs',
		async (kind) => {
			const { call, objects, previewRows, objectBrowser, deps } = await setupDiscovery();
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const audit = vi.spyOn(deps.services.events, 'append');
			const error = new Error('private-provider-credential-fixture', {
				cause: new Error('private-cause-fixture'),
			});
			if (kind === 'table') previewRows.mockRejectedValue(error);
			else vi.mocked(objectBrowser.previewObject).mockRejectedValue(error);
			const response = await call(
				kind === 'table' ? 'preview_table' : 'preview_object',
				kind === 'table'
					? { namespace: ['sales'], table: 'orders' }
					: { integration_id: objects.id, bucket: 'lake', key: 'file.txt' },
			);
			expect(response).toMatchObject({
				isError: true,
				structuredContent: { code: 'SERVICE_UNAVAILABLE' },
			});
			expect(JSON.stringify([response, log.mock.calls])).not.toMatch(
				/private-provider|private-cause/,
			);
			expect(audit).not.toHaveBeenCalled();
		},
	);

	it.each(['tables', 'objects'])(
		'does not cache or automatically retry failed %s listings',
		async (kind) => {
			const { call, objects, listTables, objectBrowser } = await setupDiscovery();
			const provider = kind === 'tables' ? listTables : vi.mocked(objectBrowser.listObjects);
			provider.mockRejectedValueOnce(new UnavailableError('Temporary outage'));
			const name = kind === 'tables' ? 'list_tables' : 'list_objects';
			const input =
				kind === 'tables'
					? { namespace: ['sales'] }
					: { integration_id: objects.id, bucket: 'lake' };
			expect(await call(name, input)).toMatchObject({
				isError: true,
				structuredContent: { code: 'SERVICE_UNAVAILABLE' },
			});
			expect(provider).toHaveBeenCalledOnce();
			const recovered = await call(name, input);
			expect(recovered.isError).not.toBe(true);
			expect(provider).toHaveBeenCalledTimes(2);
			expect((await call(name, input)).structuredContent).toEqual(recovered.structuredContent);
			expect(provider).toHaveBeenCalledTimes(2);
		},
	);

	it.each([false, true])(
		'does not fall back to ambient credentials when access is unavailable (WIF: %s)',
		async (wif) => {
			const { deps, integrations, project, call, objectBrowser } = await setupDiscovery();
			const exchange = vi.fn(async () => {
				throw new Error('private-broker-credential-fixture');
			});
			if (wif) deps.wif = makeTestWif({ defaultEnabled: true, exchange });
			const ambient = await integrations.create(
				project.id,
				{ kind: 's3', name: 'ambient', config: { bucket: 'lake', auth: { method: 'ambient' } } },
				mcpPrincipal.id,
			);
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const response = await call('list_object_buckets', { integration_id: ambient.id });
			expect(response.isError).toBe(true);
			expect(JSON.stringify([response, log.mock.calls])).not.toContain(
				'private-broker-credential-fixture',
			);
			expect(exchange).toHaveBeenCalledTimes(wif ? 1 : 0);
			expect(objectBrowser.listBuckets).not.toHaveBeenCalled();
		},
	);

	it('rechecks project permissions before serving cached metadata', async () => {
		const { deps, project, catalog, listNamespaces } = await setupDiscovery();
		const editor = { ...mcpPrincipal, id: UserId.parse('editor'), email: 'editor@example.com' };
		await deps.services.projects.addMember(
			project.id,
			{ user_id: editor.id },
			'editor',
			mcpPrincipal.id,
		);
		const client = await connectMcpClient(deps, editor);
		const request = {
			name: 'list_namespaces',
			arguments: { project: project.id, integration_id: catalog.id },
		};
		expect((await client.callTool(request)).isError).not.toBe(true);
		await deps.services.projects.updateMemberRole(project.id, editor.id, 'viewer', mcpPrincipal.id);
		expect(await client.callTool(request)).toMatchObject({
			isError: true,
			structuredContent: { code: 'FORBIDDEN' },
		});
		expect(listNamespaces).toHaveBeenCalledOnce();
	});

	it('does not share caller-specific catalog results between users', async () => {
		const { call, deps, project, catalog, listNamespaces } = await setupDiscovery();
		const editor = { ...mcpPrincipal, id: UserId.parse('editor'), email: 'editor@example.com' };
		await deps.services.projects.addMember(
			project.id,
			{ user_id: editor.id },
			'editor',
			mcpPrincipal.id,
		);
		listNamespaces.mockResolvedValueOnce({ items: [['owner-only']], next_cursor: null });
		expect(await call('list_namespaces')).toMatchObject({
			structuredContent: { items: [['owner-only']] },
		});
		const client = await connectMcpClient(deps, editor);
		expect(
			await client.callTool({
				name: 'list_namespaces',
				arguments: { project: project.id, integration_id: catalog.id },
			}),
		).toMatchObject({ structuredContent: { items: [['sales', 'eu.central']] } });
		expect(listNamespaces).toHaveBeenCalledTimes(2);
		expect(listNamespaces).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ query_user: editor.email }),
		);
	});

	it('invalidates warm organization metadata when a disabled project override shadows it', async () => {
		const { call, orgIntegrations, integrations, project, listNamespaces } = await setupDiscovery();
		const inherited = await orgIntegrations.create(
			{ kind: 'test_catalog', name: 'inherited', config: { token: 'fixture' } },
			mcpPrincipal.id,
		);
		await call('list_namespaces', { integration_id: inherited.id });
		const override = await integrations.create(
			project.id,
			{ kind: 'test_catalog', name: 'inherited', config: { token: 'fixture' } },
			mcpPrincipal.id,
		);
		await integrations.update(project.id, override.id, { enabled: false }, mcpPrincipal.id);
		expect(await call('list_namespaces', { integration_id: inherited.id })).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
		expect(listNamespaces).toHaveBeenCalledOnce();
	});

	it('enforces the independent object preview budget before provider calls and success audits', async () => {
		const { call, objects, objectBrowser, deps } = await setupDiscovery();
		const audit = vi.spyOn(deps.services.events, 'append');
		const input = { integration_id: objects.id, bucket: 'lake', key: 'file.txt' };
		for (let index = 0; index < 10; index++)
			expect((await call('preview_object', input)).isError).not.toBe(true);
		expect(await call('preview_object', input)).toMatchObject({
			isError: true,
			structuredContent: { code: 'RESOURCE_EXHAUSTED' },
		});
		expect(objectBrowser.previewObject).toHaveBeenCalledTimes(10);
		expect(audit).toHaveBeenCalledTimes(10);
		expect((await call('list_object_buckets', { integration_id: objects.id })).isError).not.toBe(
			true,
		);
	});

	it('does no provider work for an already cancelled request', async () => {
		const { deps, project, catalog, integrations, previewRows } = await setupDiscovery();
		const capability = vi.spyOn(integrations, 'browseCapability');
		const client = await connectMcpClient(deps, mcpPrincipal, {
			...mcpRequest,
			signal: AbortSignal.abort(),
		});
		expect(
			await client.callTool({
				name: 'preview_table',
				arguments: {
					project: project.id,
					integration_id: catalog.id,
					namespace: ['sales'],
					table: 'orders',
				},
			}),
		).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_CANCELLED' } });
		expect(capability).not.toHaveBeenCalled();
		expect(previewRows).not.toHaveBeenCalled();
	});

	it('cancels one metadata caller without poisoning a coalesced lookup or its cache', async () => {
		const { deps, project, catalog, integrations, listNamespaces, call } = await setupDiscovery();
		const pending = Promise.withResolvers<BrowsePage<string[]>>();
		listNamespaces.mockImplementation(() => pending.promise);
		const capability = vi.spyOn(integrations, 'browseCapability');
		const controller = new AbortController();
		const client = await connectMcpClient(deps, mcpPrincipal, {
			...mcpRequest,
			signal: controller.signal,
		});
		const cancelled = client.callTool({
			name: 'list_namespaces',
			arguments: { project: project.id, integration_id: catalog.id },
		});
		const other = call('list_namespaces');
		try {
			await vi.waitFor(() => {
				expect(capability).toHaveBeenCalledTimes(2);
				expect(listNamespaces).toHaveBeenCalledOnce();
			});
			controller.abort();
			expect(await cancelled).toMatchObject({
				isError: true,
				structuredContent: { code: 'REQUEST_CANCELLED' },
			});
		} finally {
			pending.resolve({ items: [['shared']], next_cursor: null });
			await Promise.all([cancelled, other]);
		}
		expect(await other).toMatchObject({ structuredContent: { items: [['shared']] } });
		expect(await call('list_namespaces')).toMatchObject({
			structuredContent: { items: [['shared']] },
		});
		expect(listNamespaces).toHaveBeenCalledOnce();
	});
});
