import { onTestFinished } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
