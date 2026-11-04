import { describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { ACTOR } from '@marimo-hub/core/testing';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { TurnCheckpoint, TurnContext } from '@marimo-hub/core/chat';
import { createInitializedBucket, createTestApi, expectOk } from '../testing';
import { openToolSession } from './tools';

const principal: AuthenticatedPrincipal = {
	id: ACTOR,
	email: 'actor@example.com',
	credential: { kind: 'development' },
};

async function session() {
	const bucket = await createInitializedBucket();
	const api = createTestApi({ bucket });
	const created = await expectOk<{ id: string }>(
		await api.request('POST', '/projects', { name: 'Sales', description: 'd' }),
		201,
	);
	const project = await api.deps.services.projects.getProject(created.id as never);
	const tools = await openToolSession(api.deps, principal, project, {
		method: 'POST',
		path: '/test',
		hostname: 'localhost',
		appBaseUrl: '',
	});
	const checkpoints: TurnCheckpoint[] = [];
	const chunks: UIMessageChunk[] = [];
	const turn: TurnContext = {
		assistantMessageId: 'a',
		stopSignal: new AbortController().signal,
		saveParts: vi.fn(async () => {}),
		checkpoint: async (event) => {
			checkpoints.push(event);
		},
	};
	const built = tools.buildTools({
		turn,
		conversationId: 'c',
		canPrompt: false,
		signal: new AbortController().signal,
		emit: (chunk) => chunks.push(chunk),
	});
	const call = (name: string, input: Record<string, unknown>) =>
		built[name].execute!(input, {
			toolCallId: `call-${name}`,
			messages: [],
		} as never) as Promise<Record<string, unknown>>;
	return { api, tools, built, call, checkpoints, chunks, project };
}

describe('chat tool session', () => {
	it('exposes the hub tools without the project selector and marks read-only ones', async () => {
		const { tools } = await session();
		const catalog = tools.definitions.find((tool) => tool.name === 'list_catalog')!;
		expect(catalog.readOnly).toBe(true);
		expect(tools.readOnlyToolNames.has('list_catalog')).toBe(true);
		expect(tools.readOnlyToolNames.has('create_notebook')).toBe(false);
		expect(Object.keys(catalog.inputSchema.properties as object)).not.toContain('project');
		expect(catalog.inputSchema.required).not.toContain('project');
		await tools.close();
	});

	it('runs a read-only call without consent and without an unresolved checkpoint', async () => {
		const { call, checkpoints, chunks, tools } = await session();
		const output = await call('list_catalog', {});
		expect(output).toHaveProperty('projects');
		expect(checkpoints.map((c) => c.type)).toEqual(['tool_completed']);
		expect(chunks).toEqual([]);
		await tools.close();
	});

	it('skips a gated call it cannot ask about, keeps the budget, and tells the model', async () => {
		const { call, checkpoints, chunks, tools, api, project } = await session();
		const output = await call('create_notebook', { title: 'Nope', code: 'import marimo' });
		expect(output).toMatchObject({ permission: 'unavailable' });
		expect(checkpoints.map((c) => c.type)).toEqual(['tool_started', 'tool_completed']);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ type: 'data-permission', data: { status: 'unavailable' } });
		expect(tools.state.calls).toBe(0);
		const notebooks = await api.deps.services.notebooks.listNotebooks(project.id);
		expect(notebooks).toEqual([]);
		await tools.close();
	});

	it('refuses to act on another project', async () => {
		const { call, tools } = await session();
		await expect(call('list_catalog', { project: 'proj-0000000000000000' })).rejects.toThrow(
			/scoped to the current project/,
		);
		await tools.close();
	});

	it('returns a tool budget message once the per-turn cap is reached', async () => {
		const { call, tools } = await session();
		tools.state.calls = 24;
		expect(await call('list_catalog', {})).toMatchObject({ code: 'TOOL_LIMIT' });
		expect(tools.state.toolLimit).toBe(true);
		await tools.close();
	});
});
