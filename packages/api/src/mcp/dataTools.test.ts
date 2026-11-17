import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDiscovery } from '../testing/integrationDiscovery';
import { connectMcpClient, mcpPrincipal, mcpRequest } from '../testing/mcp';
import { queryIntegrationData } from '../integrations/browse';
import { isGated, permissionRequest } from '../chat/permissions/policies';

afterEach(() => vi.restoreAllMocks());

async function setupQuery(query?: { available: boolean; reason?: string }) {
	const fixture = await setupDiscovery();
	const { integrations, project, catalog } = fixture;
	const deps = { ...fixture.deps, dataBrowser: { ...fixture.deps.dataBrowser!, query: true } };
	if (query) {
		const capability = await integrations.browseCapability(project.id, catalog.id);
		vi.spyOn(integrations, 'browseCapability').mockResolvedValue({
			...capability,
			surfaces: { ...capability.surfaces, query: { dialect: 'duckdb', ...query } },
		});
	}
	return {
		...fixture,
		deps,
		args: { project: project.id, integration: catalog.id, sql: 'select 1' },
		run: vi.spyOn(integrations, 'runDataQuery'),
		connect: (principal = mcpPrincipal, request = mcpRequest) =>
			connectMcpClient(deps, principal, request),
	};
}

describe('MCP data tools', () => {
	it('searches paged tables and reports cyclic pagination as incomplete', async () => {
		const { call, listTables } = await setupDiscovery();
		listTables.mockResolvedValueOnce({ items: ['orders', 'users'], next_cursor: 'next' });
		listTables.mockResolvedValueOnce({ items: ['old_orders'], next_cursor: null });
		const response = await call('search_tables', { q: 'orders', namespace: ['sales'] });
		expect(response.structuredContent).toMatchObject({
			items: [{ table: 'orders' }, { table: 'old_orders' }],
			coverage: { complete: true },
		});
		expect((await call('search_tables', { q: 'orders' })).structuredContent).toMatchObject({
			coverage: { complete: false },
		});
	});

	it('profiles bounded samples without returning cell values', async () => {
		const { call, previewRows } = await setupDiscovery();
		previewRows.mockResolvedValue({ columns: ['id'], rows: [[null], [1], [1], [2]] });
		expect(
			(await call('profile_table', { namespace: ['sales'], table: 'orders', sample_rows: 4 }))
				.structuredContent,
		).toMatchObject({
			rows_sampled: 4,
			columns: [{ name: 'id', null_count: 1, distinct_count: 2 }],
		});
		expect(
			await call('profile_table', { namespace: ['sales'], table: 'orders', columns: ['missing'] }),
		).toMatchObject({ isError: true });
	});

	it('shares the REST query operation, capability gate, and cancellation signal', async () => {
		const { deps, project, catalog, run, connect, args } = await setupQuery({ available: true });
		run.mockResolvedValue({ columns: ['id'], rows: [[1]], truncated: false, execution_ms: 3 });
		const client = await connect();
		const reply = await client.callTool({
			name: 'run_query',
			arguments: { ...args, integration: 'warehouse' },
		});
		const rest = await queryIntegrationData(
			{
				deps,
				pid: project.id,
				iid: catalog.id,
				user: mcpPrincipal,
				request: { method: 'POST', path: '/query' },
			},
			args,
		);
		expect(reply.structuredContent).toEqual(rest);
		expect(run.mock.calls[0][5]).toBeInstanceOf(AbortSignal);
		expect(
			await client.callTool({ name: 'run_query', arguments: { ...args, integration: 'missing' } }),
		).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
		expect(
			await client.callTool({ name: 'run_query', arguments: { ...args, sql: 'x'.repeat(32769) } }),
		).toMatchObject({ isError: true });
	});

	it('rejects SQL without integration.manage before contacting the integration', async () => {
		const { project, run, connect, args } = await setupQuery();
		const client = await connect({
			...mcpPrincipal,
			credential: {
				kind: 'personal-access-token',
				id: 'browse-only',
				grant: { actions: ['integration.use'], projects: [project.id] },
			},
		});
		expect(
			await client.callTool({
				name: 'run_query',
				arguments: args,
			}),
		).toMatchObject({ isError: true });
		expect(run).not.toHaveBeenCalled();
	});

	it('returns actionable errors for disabled browsing and unavailable SQL', async () => {
		const { project, catalog, integrations, call, connect, args } = await setupQuery();
		await integrations.update(project.id, catalog.id, { enabled: false }, mcpPrincipal.id);
		expect(await call('search_tables', { q: 'orders' })).toMatchObject({ isError: true });
		expect(await call('profile_table', { namespace: ['sales'], table: 'orders' })).toMatchObject({
			isError: true,
		});
		const client = await connect();
		expect(
			await client.callTool({
				name: 'run_query',
				arguments: args,
			}),
		).toMatchObject({ isError: true });
	});

	it('requires SQL consent every time and gates profiling', () => {
		const sql = { name: 'run_query', annotations: { readOnlyHint: true } };
		expect(permissionRequest(sql, { sql: 'select 1' })).toMatchObject({
			can_remember: false,
			details: [{ label: 'SQL', value: 'select 1' }],
		});
		expect(isGated({ ...sql, name: 'profile_table' })).toBe(true);
	});
});

it.each([
	['search_tables', { q: '' }],
	['search_tables', { q: 'orders', limit: 51 }],
	['search_tables', { q: 'orders', namespace: [] }],
	['profile_table', { namespace: ['sales'], table: 'orders', sample_rows: 101 }],
	['profile_table', { namespace: ['sales'], table: 'orders', sample_rows: 0 }],
	['profile_table', { namespace: ['sales'], table: 'orders', columns: [] }],
] as const)('rejects invalid %s arguments before upstream access', async (name, args) => {
	const { call, listNamespaces, listTables, previewRows } = await setupDiscovery();
	expect(await call(name, args)).toMatchObject({ isError: true });
	expect(listNamespaces).not.toHaveBeenCalled();
	expect(listTables).not.toHaveBeenCalled();
	expect(previewRows).not.toHaveBeenCalled();
});

it('rejects a shadowed organization ID for search and profiling', async () => {
	const { call, orgIntegrations, listNamespaces, previewRows } = await setupDiscovery();
	const hidden = await orgIntegrations.create(
		{ kind: 'test_catalog', name: 'warehouse', config: { token: 'hidden-secret' } },
		mcpPrincipal.id,
	);
	for (const [name, args] of [
		['search_tables', { q: 'orders' }],
		['profile_table', { namespace: ['sales'], table: 'orders' }],
	] as const) {
		const reply = await call(name, { ...args, integration: hidden.id });
		expect(reply).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
		expect(JSON.stringify(reply)).not.toContain('hidden-secret');
	}
	expect(listNamespaces).not.toHaveBeenCalled();
	expect(previewRows).not.toHaveBeenCalled();
});

it('rejects a query capability blocker without dispatching SQL', async () => {
	const { run, connect, args } = await setupQuery({
		available: false,
		reason: 'Configure the query executor.',
	});
	const client = await connect();
	expect(
		await client.callTool({
			name: 'run_query',
			arguments: args,
		}),
	).toMatchObject({
		isError: true,
		structuredContent: { code: 'NOT_FOUND', message: 'Configure the query executor.' },
	});
	expect(run).not.toHaveBeenCalled();
});

it('propagates cancellation to dispatched SQL and returns a cancelled tool result', async () => {
	const { run, connect, args } = await setupQuery({ available: true });
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let executionSignal: AbortSignal | undefined;
	run.mockImplementation((_pid, _iid, _user, _session, _sql, signal) => {
		executionSignal = signal;
		started();
		return new Promise((_resolve, reject) =>
			signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {
				once: true,
			}),
		);
	});
	const controller = new AbortController();
	const client = await connect(mcpPrincipal, { ...mcpRequest, signal: controller.signal });
	const pending = client.callTool({
		name: 'run_query',
		arguments: args,
	});
	await ready;
	controller.abort(new DOMException('Stopped', 'AbortError'));
	expect(await pending).toMatchObject({
		isError: true,
		structuredContent: { code: 'REQUEST_CANCELLED' },
	});
	expect(executionSignal?.aborted).toBe(true);
});

it('enforces SQL size in UTF-8 bytes before resolving an integration', async () => {
	const { integrations, connect, args } = await setupQuery();
	const capability = vi.spyOn(integrations, 'browseCapability');
	const client = await connect();
	expect(
		await client.callTool({
			name: 'run_query',
			arguments: { ...args, sql: '界'.repeat(10923) },
		}),
	).toMatchObject({ isError: true });
	expect(capability).not.toHaveBeenCalled();
});
