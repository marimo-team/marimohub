import { onTestFinished } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogService, UserId } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeTestDeps } from './index';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { createMcpServer } from '../mcp/server';
import type { StartRequestContext } from '../mcp/server';

export async function connectMcpClient(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext = {
		requestId: 'mcp-test',
		method: 'POST',
		path: '/mcp',
		hostname: 'hub.example.com',
		appBaseUrl: 'https://hub.example.com',
	},
) {
	const server = createMcpServer(deps, principal, request);
	const client = new Client({ name: 'test', version: '1' });
	onTestFinished(async () => {
		await client.close();
		await server.close();
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return client;
}

export const mcpPrincipal: AuthenticatedPrincipal = {
	id: UserId.parse('mcp-user'),
	email: 'mcp@example.com',
	credential: { kind: 'development' },
};

export async function createMcpSession(expiresAt?: string, overrides: Partial<ApiDeps> = {}) {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(mcpPrincipal.id);
	const deps = makeTestDeps(bucket, overrides);
	const project = await deps.services.projects.createProject(
		{ name: 'Project', description: '' },
		mcpPrincipal.id,
	);
	const notebook = await deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: '' },
		mcpPrincipal.id,
	);
	const created = await deps.services.sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.id,
		user_id: mcpPrincipal.id,
		authorization_expires_at: expiresAt,
	});
	const session = await deps.services.sessions.setRunning(
		project.id,
		created.session_id,
		'https://kernel.example',
	);
	return { deps, project, session };
}
