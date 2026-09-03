import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { UserId } from '@marimo-hub/core';
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
});
