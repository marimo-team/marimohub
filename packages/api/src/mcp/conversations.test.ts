import { describe, expect, it } from 'vitest';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { createTestApi, expectOk, makeTestDeps } from '../testing';
import { chatAi, chatModel, textStream } from '../testing/chat';
import { connectMcpClient, mcpRequest, postMcp, readMcpResult } from '../testing/mcp';
import { createApi } from '../createApi';
import { registerConversationTools } from './conversations';

const principal: AuthenticatedPrincipal = {
	id: ACTOR,
	email: 'actor@example.com',
	credential: {
		kind: 'personal-access-token',
		id: 'token',
		oauth: { clientId: 'client', resource: `${mcpRequest.appBaseUrl}/mcp`, scopes: ['mcp:tools'] },
	},
};

function connectWithChat(deps: ReturnType<typeof makeTestDeps>, who = principal) {
	return connectMcpClient(deps, who, mcpRequest, (server) =>
		registerConversationTools(server, deps, who, mcpRequest),
	);
}

describe('project_conversations MCP tool', () => {
	it('is offered over HTTP when chat is on, but not to the chat model itself', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			...chatAi(chatModel(textStream('hi'))),
			mcp: { publicBaseUrl: mcpRequest.appBaseUrl },
			authenticator: { authenticate: async () => principal },
		});
		const client = await connectMcpClient(deps, principal);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).not.toContain('project_conversations');
		const listed = await readMcpResult<{ tools: { name: string }[] }>(
			await postMcp(createApi(deps), { method: 'tools/list' }, { Authorization: 'Bearer t' }),
		);
		expect(listed.tools.map((tool) => tool.name)).toContain('project_conversations');
		const off = makeTestDeps(new MemoryBucket(), {
			...chatAi(chatModel(textStream('hi')), { chat: undefined }),
			mcp: { publicBaseUrl: mcpRequest.appBaseUrl },
			authenticator: { authenticate: async () => principal },
		});
		const withoutChat = await readMcpResult<{ tools: { name: string }[] }>(
			await postMcp(createApi(off), { method: 'tools/list' }, { Authorization: 'Bearer t' }),
		);
		expect(withoutChat.tools.map((tool) => tool.name)).not.toContain('project_conversations');
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
		// Nothing runs and nothing is paused, so both controls are no-ops that still answer.
		expect(await call({ action: 'stop', conversation: conversation.id })).toEqual({
			stopped: false,
		});
		const dismissed = await call({ action: 'dismiss_continuation', conversation: conversation.id });
		expect(dismissed.conversation).toMatchObject({ id: conversation.id });
		expect(await call({ action: 'delete', conversation: conversation.id })).toEqual({
			deleted: true,
		});
		const gone = await client.callTool({
			name: 'project_conversations',
			arguments: { project: project.id, request: { action: 'get', conversation: conversation.id } },
		});
		expect(gone.isError).toBe(true);
		expect(gone.structuredContent).toMatchObject({ code: 'NOT_FOUND' });
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
