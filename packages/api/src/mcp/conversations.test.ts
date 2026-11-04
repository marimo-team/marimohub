import { describe, expect, it } from 'vitest';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { createTestApi, expectOk, makeTestDeps } from '../testing';
import { chatAi, chatModel, textStream } from '../testing/chat';
import { connectMcpClient } from '../testing/mcp';
import { registerConversationTools } from './conversations';
import { createMcpServer } from './server';
import type { StartRequestContext } from './server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const principal: AuthenticatedPrincipal = {
	id: ACTOR,
	email: 'actor@example.com',
	credential: { kind: 'personal-access-token' },
};
const request: StartRequestContext = {
	requestId: 'mcp-test',
	method: 'POST',
	path: '/mcp',
	hostname: 'hub.example.com',
	appBaseUrl: 'https://hub.example.com',
};

async function connectWithChat(deps: ReturnType<typeof makeTestDeps>, who = principal) {
	const server = createMcpServer(deps, who, request);
	registerConversationTools(server, deps, who, request);
	const client = new Client({ name: 'test', version: '1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return client;
}

describe('project_conversations MCP tool', () => {
	it('is not offered to the chat model itself', async () => {
		const deps = makeTestDeps(new MemoryBucket(), chatAi(chatModel(textStream('hi'))));
		const client = await connectMcpClient(deps, principal, request);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).not.toContain('project_conversations');
	});

	it('creates, sends, reads, and deletes a private conversation through MCP', async () => {
		const bucket = new MemoryBucket();
		const api = createTestApi({
			bucket,
			deps: chatAi(chatModel(textStream('Three notebooks.'))),
		});
		const project = await expectOk<{ id: string }>(
			await api.request('POST', '/projects', { name: 'Sales', description: 'd' }),
			201,
		);
		const client = await connectWithChat(api.deps);
		const call = async (action: Record<string, unknown>) => {
			const reply = await client.callTool({
				name: 'project_conversations',
				arguments: { project: project.id, request: action },
			});
			return reply.structuredContent as Record<string, unknown>;
		};
		const created = await call({ action: 'create', title: 'From MCP' });
		const conversation = created.conversation as { id: string; title: string };
		expect(conversation.title).toBe('From MCP');
		const sent = await call({ action: 'send', conversation: conversation.id, content: 'count' });
		expect(sent.message).toMatchObject({ role: 'assistant', text: 'Three notebooks.' });
		const read = await call({ action: 'get', conversation: conversation.id });
		expect((read.messages as unknown[]).length).toBe(2);
		const listed = await call({ action: 'list' });
		expect(listed.total_conversations).toBe(1);
		// The HTTP API sees the same private record.
		const viaHttp = await expectOk<{ conversation: { messages: unknown[] } }>(
			await api.request('GET', `/projects/${project.id}/conversations/${conversation.id}`),
		);
		expect(viaHttp.conversation.messages).toHaveLength(2);
		expect(await call({ action: 'permissions' })).toEqual({ grants: [], has_more: false });
		expect(await call({ action: 'delete', conversation: conversation.id })).toEqual({
			deleted: true,
		});
		const gone = await client.callTool({
			name: 'project_conversations',
			arguments: { project: project.id, request: { action: 'get', conversation: conversation.id } },
		});
		expect(gone.isError).toBe(true);
	});

	it('refuses machine identities', async () => {
		const deps = makeTestDeps(new MemoryBucket(), chatAi(chatModel(textStream('hi'))));
		const machine = { ...principal, credential: { kind: 'service-account' as const } };
		const client = await connectWithChat(deps, machine);
		const reply = await client.callTool({
			name: 'project_conversations',
			arguments: { project: 'any', request: { action: 'list' } },
		});
		expect(reply.isError).toBe(true);
		expect(reply.structuredContent).toMatchObject({ code: 'FORBIDDEN' });
	});
});
