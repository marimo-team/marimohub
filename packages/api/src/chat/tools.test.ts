import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { UIMessageChunk } from 'ai';
import { ACTOR, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { CHAT_LIMITS, ChatPermissionStore } from '@marimo-hub/core/chat';
import type { TurnCheckpoint, TurnContext } from '@marimo-hub/core/chat';
import type { SearchIndexer, SearchService } from '@marimo-hub/core/search';
import type { ApiDeps } from '../context';
import { withRequestMemo } from '../requestMemo';
import { createInitializedBucket, createTestApi, expectOk } from '../testing';
import { openToolSession } from './tools';
import { workingBranchFixture } from '../testing/workingBranches';

const principal: AuthenticatedPrincipal = {
	id: ACTOR,
	email: 'actor@example.com',
	credential: { kind: 'development' },
};

async function session(overrides: Partial<ApiDeps> = {}, scope = (deps: ApiDeps) => deps) {
	const bucket = await createInitializedBucket();
	const api = createTestApi({ bucket, deps: overrides });
	const created = await expectOk<{ id: string }>(
		await api.request('POST', '/projects', { name: 'Sales', description: 'd' }),
		201,
	);
	const project = await api.deps.services.projects.getProject(created.id as never);
	const tools = await openToolSession(scope(api.deps), principal, project, {
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

	it('pins workspace search to the current project', async () => {
		const search = vi.fn<SearchService['search']>(async () => ({
			items: [],
			partial: false,
			coverage: [],
		}));
		const { call, tools, project } = await session({
			search: { service: { search } as unknown as SearchService, indexer: {} as SearchIndexer },
		});
		const definition = tools.definitions.find((tool) => tool.name === 'search_workspace')!;
		expect(Object.keys(definition.inputSchema.properties as object)).not.toContain('project_id');
		await call('search_workspace', { q: 'revenue' });
		const request = search.mock.calls[0].find(
			(argument) => typeof argument === 'object' && argument !== null && 'q' in argument,
		) as { project_id?: string };
		expect(request.project_id).toBe(project.id);
		await expect(
			call('search_workspace', { q: 'revenue', project_id: 'proj-0000000000000000' }),
		).rejects.toThrow(/scoped to the current project/);
		await tools.close();
	});

	it('refuses code too long to review instead of asking for consent', async () => {
		const { call, checkpoints, chunks, tools } = await session();
		const output = await call('create_notebook', {
			title: 'Big',
			code: 'x'.repeat(CHAT_LIMITS.consentDetailCharacters + 1),
		});
		expect(output).toMatchObject({ code: 'INPUT_TOO_LARGE' });
		expect(checkpoints).toEqual([]);
		expect(chunks).toEqual([]);
		expect(tools.state.calls).toBe(0);
		await tools.close();
	});

	it('refuses an oversized PR body before consent or provider calls', async () => {
		const env = await workingBranchFixture();
		const { call, checkpoints, chunks, tools } = await session({
			sourceControl: env.sourceControl,
		});
		try {
			const output = await call('open_change_request', {
				notebook: 'Working',
				body: 'x'.repeat(CHAT_LIMITS.consentDetailCharacters + 1),
			});
			expect(output).toMatchObject({ code: 'INPUT_TOO_LARGE' });
			expect(checkpoints).toEqual([]);
			expect(chunks).toEqual([]);
			expect(env.writer.openBranchChangeRequest).not.toHaveBeenCalled();
			expect(tools.state.calls).toBe(0);
		} finally {
			await tools.close();
		}
	});

	describe('a mutating call that fails', () => {
		async function allowedCreate() {
			const opened = await session();
			await new ChatPermissionStore(opened.api.deps.bucket).grant(opened.project.id, ACTOR, {
				kind: 'tool',
				scope_key: 'tool:create_notebook',
				scope_label: 'creating notebooks in this project',
				action: 'Create a notebook',
			});
			return opened;
		}

		it('reports a connect failure as known, since the call never reached the server', async () => {
			const { call, checkpoints, tools } = await allowedCreate();
			const connect = vi
				.spyOn(Client.prototype, 'connect')
				.mockRejectedValueOnce(new Error('transport down'));
			await expect(call('create_notebook', { title: 'T', code: 'import marimo' })).rejects.toThrow(
				/^TOOL_FAILED: The tool could not start/,
			);
			connect.mockRestore();
			expect(checkpoints.map((c) => c.type)).toEqual(['tool_started', 'tool_completed']);
			expect(checkpoints[1]).toMatchObject({ outcome: 'known' });
			await tools.close();
		});

		it('reports a call that did not return as uncertain', async () => {
			const { call, checkpoints, tools } = await allowedCreate();
			const callTool = vi
				.spyOn(Client.prototype, 'callTool')
				.mockRejectedValueOnce(new Error('timed out'));
			await expect(call('create_notebook', { title: 'T', code: 'import marimo' })).rejects.toThrow(
				/^TOOL_FAILED: The tool did not return a result/,
			);
			callTool.mockRestore();
			expect(checkpoints[1]).toMatchObject({ type: 'tool_completed', outcome: 'uncertain' });
			await tools.close();
		});
	});

	it('returns a tool budget message once the per-turn cap is reached', async () => {
		const { call, tools } = await session();
		tools.state.calls = 24;
		expect(await call('list_catalog', {})).toMatchObject({ code: 'TOOL_LIMIT' });
		expect(tools.state.toolLimit).toBe(true);
		await tools.close();
	});

	it('resolves the subject context once per call so each call observes revocation', async () => {
		const security = localResourceSecurity(['UNCLASSIFIED', 'SECRET'], makeSubjectContext());
		const resolve = vi.spyOn(security.subjectContext!, 'resolve');
		const { api, call, project, tools } = await session(
			{ resourceSecurity: security },
			withRequestMemo,
		);
		await api.deps.services.projects.setSecurityLabels(
			project.id,
			{ classification: 'SECRET', compartments: [] },
			ACTOR,
		);
		resolve.mockClear();
		await expect(call('list_catalog', {})).resolves.toHaveProperty('projects');
		expect(resolve).toHaveBeenCalledTimes(1);
		await expect(call('list_catalog', {})).resolves.toHaveProperty('projects');
		expect(resolve).toHaveBeenCalledTimes(2);
		resolve.mockResolvedValue(makeSubjectContext({ classification: 'UNCLASSIFIED' }));
		await expect(call('list_catalog', {})).rejects.toThrow(/not found/i);
		await tools.close();
	});
});
