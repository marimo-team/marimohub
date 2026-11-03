import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { MemorySearchIndex } from '@marimo-hub/core/testing/search';
import { NotebookSource, SearchService, SearchIndexer } from '@marimo-hub/core/search';
import { createInitializedBucket, createTestApi, expectOk, expectError } from '../testing';
import { connectMcpClient } from '../testing/mcp';
import { SEARCH_QUERIES_PER_MINUTE } from '../search/operations';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function fixture() {
	const bucket = await createInitializedBucket();
	const api = createTestApi({ bucket });
	const { services } = api.deps;
	const project = await services.projects.createProject({ name: 'Search', description: '' }, ACTOR);
	await services.notebooks.createNotebook(
		project.id,
		{ title: 'Revenue', description: 'Annual revenue', code: 'net_revenue = 42' },
		ACTOR,
	);
	const index = new MemorySearchIndex();
	const authz = new AuthorizationService(api.deps.policy);
	const source = new NotebookSource(bucket, services.catalog, services.notebooks, authz);
	const indexer = new SearchIndexer(bucket, index, [source], services.catalog, services.projects);
	api.deps.search = {
		service: new SearchService(index, [source], services.catalog, services.projects, authz),
		indexer,
	};
	await indexer.step(project.id, source, new AbortController().signal);
	const configured = createTestApi({ bucket, deps: { search: api.deps.search } });
	const client = await connectMcpClient(configured.deps, {
		id: ACTOR,
		email: `${ACTOR}@example.com`,
		credential: { kind: 'development' },
	});
	return { api: configured, project, client, index };
}
describe('search REST/MCP parity', () => {
	it('advertises only configured search sources and modes', async () => {
		const { api } = await fixture();
		const capabilities = await expectOk(await api.request('GET', '/capabilities'));
		expect(capabilities.search).toEqual({
			available: true,
			semantic: false,
			kinds: ['notebook', 'code', 'output'],
		});
		const disabled = createTestApi({ bucket: await createInitializedBucket() });
		expect((await expectOk(await disabled.request('GET', '/capabilities'))).search).toEqual({
			available: false,
			semantic: false,
			kinds: [],
		});
	});
	it('shares results, filters, snippets, ranking, and resource references', async () => {
		const { api, project, client } = await fixture();
		const query = { q: 'net_revenue', project_id: project.id, kinds: ['code'], limit: 5 };
		const response = await api.request(
			'GET',
			`/search?${new URLSearchParams({ ...query, kinds: 'code', limit: '5' })}`,
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const data = await expectOk(response);
		const mcp = await client.callTool({ name: 'search_workspace', arguments: query });
		expect(mcp.structuredContent).toEqual({
			...data,
			items: data.items.map((item: { href: string }) => ({
				...item,
				href: expect.stringMatching(
					new RegExp(`^https?://[^/]+${item.href.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
				),
			})),
		});
		expect(data.items).toHaveLength(1);
	});
	it.each([
		{ q: '' },
		{ q: '   ' },
		{ q: 'x'.repeat(257) },
		{ q: 'test', limit: 0 },
		{ q: 'test', limit: 51 },
		{ q: 'test', limit: 1.5 },
		{ q: 'test', kinds: ['secret'] },
		{ q: 'test', kinds: [] },
		{ q: 'test', project_id: '../bad' },
		{ q: 'test', mode: 'unknown' },
	])('rejects invalid requests through both transports (%j)', async (query) => {
		const { api, client } = await fixture();
		const params = new URLSearchParams(
			Object.entries(query).map(([key, value]) => [key, String(value)]),
		);
		await expectError(await api.request('GET', `/search?${params}`), 422);
		expect(await client.callTool({ name: 'search_workspace', arguments: query })).toMatchObject({
			isError: true,
		});
	});
	it('returns the same partial coverage without upstream error details through both transports', async () => {
		const { api, client, project, index } = await fixture();
		vi.spyOn(index, 'candidates').mockRejectedValue(new Error('credential=private-value'));
		const query = { q: 'revenue', project_id: project.id };
		const response = await api.request('GET', `/search?${new URLSearchParams(query)}`);
		const data = await expectOk(response);
		const mcp = await client.callTool({ name: 'search_workspace', arguments: query });
		expect(mcp.structuredContent).toEqual(data);
		expect(data).toEqual({
			items: [],
			partial: true,
			coverage: [
				{
					source: 'notebooks',
					project_id: project.id,
					status: 'unavailable',
				},
			],
		});
		expect(JSON.stringify(mcp)).not.toContain('private-value');
	});
	it('limits each user to 30 queries per minute across both transports', async () => {
		const { api, client, project } = await fixture();
		vi.useFakeTimers({ toFake: ['Date'] });
		const query = { q: 'revenue', project_id: project.id };
		const path = `/search?${new URLSearchParams(query)}`;
		for (let i = 1; i < SEARCH_QUERIES_PER_MINUTE; i++)
			await expectOk(await api.request('GET', path));
		expect(await client.callTool({ name: 'search_workspace', arguments: query })).not.toMatchObject(
			{ isError: true },
		);
		const limited = await api.request('GET', path);
		expect(limited.headers.get('retry-after')).toBeTruthy();
		await expectError(limited, 429, 'RESOURCE_EXHAUSTED');
		expect(await client.callTool({ name: 'search_workspace', arguments: query })).toMatchObject({
			isError: true,
			structuredContent: { code: 'RESOURCE_EXHAUSTED' },
		});
		const other = await connectMcpClient(api.deps, {
			id: uid('other-user'),
			email: 'other-user@example.com',
			credential: { kind: 'development' },
		});
		expect(await other.callTool({ name: 'search_workspace', arguments: query })).not.toMatchObject({
			structuredContent: { code: 'RESOURCE_EXHAUSTED' },
		});
		vi.setSystemTime(Date.now() + 60_000);
		await expectOk(await api.request('GET', path));
	});
	it('does not spend the query budget on invalid requests', async () => {
		const { api } = await fixture();
		for (let i = 0; i <= SEARCH_QUERIES_PER_MINUTE; i++)
			await expectError(await api.request('GET', '/search?q='), 422);
		await expectOk(await api.request('GET', '/search?q=revenue'));
	});
	it('reports disabled search through both transports', async () => {
		const api = createTestApi({ bucket: await createInitializedBucket() });
		const client = await connectMcpClient(api.deps, {
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			credential: { kind: 'development' },
		});
		await expectError(await api.request('GET', '/search?q=revenue'), 404);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).not.toContain('search_workspace');
	});
});
