import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogService, NotebookId, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, TokenGrant } from '@marimo-hub/core';
import { fakeComputeFrom, makeFakeSandbox, MemoryBucket } from '@marimo-hub/core/testing';
import { makeTestDeps } from '../testing';
import { createMcpServer } from './server';

const USER_ID = UserId.parse('oauth-user');
const PRINCIPAL: AuthenticatedPrincipal = {
	id: USER_ID,
	email: 'oauth@example.com',
	credential: { kind: 'personal-access-token', id: 'tok-oauth' },
};

function principalWithGrant(grant: TokenGrant): AuthenticatedPrincipal {
	return {
		...PRINCIPAL,
		credential: { kind: 'personal-access-token', id: 'tok-oauth', grant },
	};
}

async function setup(overrides: Parameters<typeof makeTestDeps>[1] = {}) {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(USER_ID);
	const deps = makeTestDeps(bucket, overrides);
	const project = await deps.services.projects.createProject(
		{ name: 'Myles workspace', description: '' },
		USER_ID,
	);
	return { deps, project };
}

async function connect(
	deps: ReturnType<typeof makeTestDeps>,
	principal: AuthenticatedPrincipal = PRINCIPAL,
) {
	const server = createMcpServer(deps, principal, {
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

describe('create_notebook MCP tool', () => {
	it('creates a notebook without a session when launch is omitted', async () => {
		const { deps, project } = await setup();
		const { client, server } = await connect(deps);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: {
				project: 'Myles workspace',
				title: 'Analysis',
				code: 'import marimo as mo',
				tags: ['mcp'],
			},
		});
		await client.close();
		await server.close();

		expect(response).toMatchObject({
			structuredContent: {
				project_id: project.id,
				title: 'Analysis',
				status: 'active',
				launched: false,
			},
		});
		const notebookId = NotebookId.parse(
			(response.structuredContent as { notebook_id: string }).notebook_id,
		);
		expect(await deps.services.notebooks.getNotebookContent(project.id, notebookId)).toBe(
			'import marimo as mo',
		);
		expect(await deps.services.sessions.listActiveByProject(project.id)).toEqual([]);
	});

	it('creates and launches an edit session when launch is true', async () => {
		const { instance } = makeFakeSandbox();
		const { deps, project } = await setup({ compute: fakeComputeFrom(instance) });
		deps.sandbox = { ...deps.sandbox, hostname: 'sandboxes.example.com' };
		const { client, server } = await connect(deps);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: {
				project: project.id,
				title: 'Live analysis',
				description: 'Created through MCP',
				code: 'print("ready")',
				launch: true,
			},
		});
		await client.close();
		await server.close();

		expect(response).toMatchObject({
			structuredContent: {
				project_id: project.id,
				title: 'Live analysis',
				launched: true,
				session: {
					project_id: project.id,
					status: 'running',
					mode: 'edit',
					sandbox_url: expect.any(String),
				},
			},
		});
		const data = response.structuredContent as {
			notebook_id: string;
			session: { notebook_id: string };
		};
		expect(data.session.notebook_id).toBe(data.notebook_id);
	});

	it('rejects creation when the token does not permit notebook writes', async () => {
		const { deps, project } = await setup();
		const principal = principalWithGrant({ actions: ['project.read'], projects: '*' });
		const { client, server } = await connect(deps, principal);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: 'Denied', code: '' },
		});
		await client.close();
		await server.close();

		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'FORBIDDEN' },
		});
		expect(await deps.services.notebooks.listNotebooks(project.id)).toEqual([]);
	});

	it('does not create a notebook when the requested launch is not permitted', async () => {
		const { deps, project } = await setup();
		const principal = principalWithGrant({
			actions: ['project.read', 'notebook.write'],
			projects: '*',
		});
		const { client, server } = await connect(deps, principal);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: 'No partial create', code: '', launch: true },
		});
		await client.close();
		await server.close();

		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'FORBIDDEN' },
		});
		expect(await deps.services.notebooks.listNotebooks(project.id)).toEqual([]);
	});

	it('rejects an empty title before it creates a notebook', async () => {
		const { deps, project } = await setup();
		const { client, server } = await connect(deps);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: '', code: '' },
		});
		await client.close();
		await server.close();

		expect(response).toMatchObject({ isError: true });
		expect(await deps.services.notebooks.listNotebooks(project.id)).toEqual([]);
	});
});
