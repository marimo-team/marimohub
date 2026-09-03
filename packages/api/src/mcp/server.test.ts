import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogService, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing';
import { makeTestDeps } from '../testing';
import { createMcpServer, MAX_EXECUTE_CODE_BYTES } from './server';

const PRINCIPAL: AuthenticatedPrincipal = {
	id: UserId.parse('oauth-user'),
	email: 'oauth@example.com',
	credential: { kind: 'personal-access-token', id: 'tok-oauth' },
};

async function connect(deps: ReturnType<typeof makeTestDeps>) {
	const server = createMcpServer(deps, PRINCIPAL, {
		requestId: 'request-123',
		method: 'POST',
		path: '/mcp',
		hostname: 'hub.example.com',
		appBaseUrl: 'https://hub.example.com',
	});
	const client = new Client({ name: 'test', version: '1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('MCP tool boundaries', () => {
	it('loads each project catalog and its active sessions concurrently', async () => {
		const bucket = new MemoryBucket();
		await new CatalogService(bucket).initialize(PRINCIPAL.id);
		const deps = makeTestDeps(bucket);
		await deps.services.projects.createProject({ name: 'Project', description: '' }, PRINCIPAL.id);
		let releaseNotebooks!: () => void;
		const notebooksPending = new Promise<void>((resolve) => {
			releaseNotebooks = resolve;
		});
		const listNotebooks = vi
			.spyOn(deps.services.notebooks, 'listNotebooks')
			.mockImplementation(async () => {
				await notebooksPending;
				return [];
			});
		const listActive = vi
			.spyOn(deps.services.sessions, 'listActiveByProject')
			.mockResolvedValue([]);
		const { client, server } = await connect(deps);

		const loading = client.callTool({ name: 'list_catalog', arguments: {} });
		await vi.waitFor(() => expect(listNotebooks).toHaveBeenCalledOnce());
		expect(listActive).toHaveBeenCalledOnce();
		releaseNotebooks();
		await loading;
		await client.close();
		await server.close();
	});

	it('loads the editor claim and active sessions concurrently', async () => {
		const bucket = new MemoryBucket();
		await new CatalogService(bucket).initialize(PRINCIPAL.id);
		const deps = makeTestDeps(bucket);
		const project = await deps.services.projects.createProject(
			{ name: 'Project', description: '' },
			PRINCIPAL.id,
		);
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: 'import marimo as mo' },
			PRINCIPAL.id,
		);
		let releaseClaim!: () => void;
		const claimPending = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		const loadEditorClaim = deps.services.sessions.getEditorClaim.bind(deps.services.sessions);
		const getEditorClaim = vi
			.spyOn(deps.services.sessions, 'getEditorClaim')
			.mockImplementation(async (...args) => {
				await claimPending;
				return loadEditorClaim(...args);
			});
		const listActive = vi
			.spyOn(deps.services.sessions, 'listActiveByProject')
			.mockResolvedValue([]);
		const { client, server } = await connect(deps);

		const loading = client.callTool({
			name: 'execute_code',
			arguments: { project: project.id, notebook: notebook.id, code: '1 + 1' },
		});
		await vi.waitFor(() => expect(getEditorClaim).toHaveBeenCalledOnce());
		expect(listActive).toHaveBeenCalledOnce();
		releaseClaim();
		await loading;
		await client.close();
		await server.close();
	});

	it('sanitizes unexpected tool errors and logs safe diagnostic metadata', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		vi.spyOn(deps.services.projects, 'listProjects').mockRejectedValue(
			new Error('kernel URL contains secret-routing-token'),
		);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { client, server } = await connect(deps);

		const response = await client.callTool({ name: 'list_catalog', arguments: {} });
		await client.close();
		await server.close();

		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'INTERNAL_ERROR', message: 'Internal error' },
		});
		expect(JSON.stringify(response)).not.toContain('secret-routing-token');
		const event = log.mock.calls
			.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
			.find((entry) => entry.event === 'mcp_tool_error');
		expect(event).toMatchObject({
			request_id: 'request-123',
			user: PRINCIPAL.id,
			tool: 'list_catalog',
			error: { error_name: 'Error' },
		});
		expect(JSON.stringify(event)).not.toContain('secret-routing-token');
	});

	it('rejects execute_code input over its UTF-8 byte limit before loading a project', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		const listProjects = vi.spyOn(deps.services.projects, 'listProjects');
		const { client, server } = await connect(deps);

		const response = await client.callTool({
			name: 'execute_code',
			arguments: {
				project: 'My Projects',
				session_id: 'sess-00000000000000000000000000',
				code: '😀'.repeat(MAX_EXECUTE_CODE_BYTES / 4 + 1),
			},
		});
		await client.close();
		await server.close();

		expect(response.isError).toBe(true);
		expect(JSON.stringify(response)).toContain(
			`Code exceeds the ${MAX_EXECUTE_CODE_BYTES}-byte limit`,
		);
		expect(listProjects).not.toHaveBeenCalled();
	});

	it('bounds kernel discovery and does not execute code after it times out', async () => {
		const bucket = new MemoryBucket();
		await new CatalogService(bucket).initialize(PRINCIPAL.id);
		let discoverySignal: AbortSignal | undefined;
		const proxy = vi.fn(async (request: Request) => {
			discoverySignal = request.signal;
			return new Promise<Response | null>(() => {});
		});
		const deps = makeTestDeps(bucket, {
			compute: {
				create: () => {
					throw new Error('not used');
				},
				proxy,
			},
		});
		const project = await deps.services.projects.createProject(
			{ name: 'Project', description: '' },
			PRINCIPAL.id,
		);
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: 'import marimo as mo' },
			PRINCIPAL.id,
		);
		const created = await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: PRINCIPAL.id,
		});
		const session = await deps.services.sessions.setRunning(
			project.id,
			created.session_id,
			'https://kernel.example',
		);
		const { client, server } = await connect(deps);

		const response = await client.callTool({
			name: 'execute_code',
			arguments: {
				project: project.id,
				session_id: session.session_id,
				code: '1 + 1',
				timeout_seconds: 1,
			},
		});
		await client.close();
		await server.close();

		expect(response).toMatchObject({
			isError: true,
			structuredContent: {
				code: 'KERNEL_DISCOVERY_TIMEOUT',
				timedOut: true,
			},
		});
		expect(proxy).toHaveBeenCalledOnce();
		expect(new URL(proxy.mock.calls[0][0].url).pathname).toBe('/api/sessions');
		expect(discoverySignal?.aborted).toBe(true);
	});
});
