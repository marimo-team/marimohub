import { onTestFinished } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { CatalogService, UserId } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeTestDeps } from './index';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { createMcpServer } from '../mcp/server';
import type { StartRequestContext } from '../mcp/server';

export const mcpRequest: StartRequestContext = {
	requestId: 'mcp-test',
	method: 'POST',
	path: '/mcp',
	hostname: 'hub.example.com',
	appBaseUrl: 'https://hub.example.com',
};

/** Connect an in-memory client; `configure` adds tools the app would register around the server. */
export async function connectMcpClient(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext = mcpRequest,
	configure?: (server: ReturnType<typeof createMcpServer>) => void,
) {
	const server = createMcpServer(deps, principal, request);
	configure?.(server);
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

interface RequestableApp {
	request(path: string, init?: RequestInit): Response | Promise<Response>;
}

export interface McpRequestBody {
	method: string;
	params?: unknown;
	id?: number | string;
}

export function postMcp(
	app: RequestableApp,
	body: McpRequestBody,
	headers: Record<string, string> = {},
	signal?: AbortSignal,
) {
	return app.request('/mcp', {
		method: 'POST',
		signal,
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...headers,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, params: {}, ...body }),
	});
}

/** Every JSON-RPC message in a Streamable HTTP response, SSE-framed or plain JSON. */
export async function readMcpMessages(response: Response): Promise<JSONRPCMessage[]> {
	const text = await response.text();
	const frames = text
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => line.slice(6));
	if (frames.length === 0 && text) frames.push(text);
	return frames.map((frame) => JSONRPCMessageSchema.parse(JSON.parse(frame)));
}

export function findMcpResult<T = Record<string, any>>(messages: JSONRPCMessage[]): T {
	const message = messages.find((item) => 'result' in item);
	if (!message || !('result' in message)) {
		throw new Error(`Missing MCP result: ${JSON.stringify(messages)}`);
	}
	return message.result as T;
}

export async function readMcpResult<T = Record<string, any>>(response: Response): Promise<T> {
	return findMcpResult<T>(await readMcpMessages(response));
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
