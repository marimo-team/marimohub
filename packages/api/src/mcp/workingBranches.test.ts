import { describe, expect, it } from 'vitest';
import { NotebookId, UserId } from '@marimo-hub/core';
import { ACTOR, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { connectMcpClient } from '../testing/mcp';
import { workingBranchFixture } from '../testing/workingBranches';
import { checkPermission } from '../chat/permissions/gate';
import { workingBranchConsentInput } from './workingBranches';
import { permissionRequest } from '../chat/permissions/policies';

const principal = {
	id: ACTOR,
	email: 'test@example.com',
	credential: { kind: 'development' as const },
};

describe('working branch MCP and chat', { timeout: 30000 }, () => {
	it('registers only when enabled and requires explicit operation keys', async () => {
		const env = await workingBranchFixture();
		const off = await connectMcpClient({ ...env.deps, sourceControl: undefined }, principal);
		expect((await off.listTools()).tools.map((tool) => tool.name)).not.toContain(
			'create_branch_notebook',
		);
		const client = await connectMcpClient(env.deps, principal);
		const tools = (await client.listTools()).tools;
		expect(tools.find((tool) => tool.name === 'save_to_branch')!.inputSchema.required).toContain(
			'idempotency_key',
		);
		expect(
			tools.find((tool) => tool.name === 'create_branch_notebook')!.inputSchema.required,
		).toContain('idempotency_key');
	});
	it('creates, saves and returns recovery links and current branch details for chat consent', async () => {
		const env = await workingBranchFixture();
		const client = await connectMcpClient(env.deps, principal);
		const created = await client.callTool({
			name: 'create_branch_notebook',
			arguments: {
				project: env.project.id,
				title: 'Working',
				repo: 'owner/repo',
				base_branch: 'main',
				entry_notebook: 'app.py',
				idempotency_key: 'create',
			},
		});
		expect(created.isError, JSON.stringify(created)).not.toBe(true);
		const data = created.structuredContent as { notebook_id: string; source: { branch: string } };
		const scoped = await connectMcpClient(env.deps, {
			...principal,
			credential: {
				kind: 'personal-access-token',
				grant: { actions: ['working-branch.write'], projects: [env.project.id] },
			},
		});
		const inspected = await scoped.callTool({
			name: 'get_working_branch',
			arguments: { project: env.project.id, notebook: data.notebook_id },
		});
		expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
		const sid = await env.session(NotebookId.parse(data.notebook_id));
		env.edit('mcp edit');
		const args = {
			project: env.project.id,
			notebook: data.notebook_id,
			session_id: sid,
			idempotency_key: 'save',
		};
		const saved = await client.callTool({ name: 'save_to_branch', arguments: args });
		expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
		expect(saved.structuredContent).toMatchObject({
			state: 'complete',
			recovery_url: expect.stringContaining('/recovery'),
		});
		for (const name of ['get_branch_save', 'retry_branch_save']) {
			const receipt = await client.callTool({
				name,
				arguments: {
					project: env.project.id,
					notebook: data.notebook_id,
					save_id: (saved.structuredContent as { id: string }).id,
				},
			});
			expect(receipt.isError, JSON.stringify(receipt)).not.toBe(true);
			expect(receipt.structuredContent).toEqual(saved.structuredContent);
		}
		const editor = UserId.parse('editor');
		await env.deps.services.projects.addMember(
			env.project.id,
			{ user_id: editor },
			'editor',
			ACTOR,
		);
		const other = await connectMcpClient(env.deps, {
			...principal,
			id: editor,
			email: 'editor@example.com',
		});
		const denied = await other.callTool({
			name: 'get_branch_save',
			arguments: {
				project: env.project.id,
				notebook: data.notebook_id,
				save_id: (saved.structuredContent as { id: string }).id,
			},
		});
		expect(denied.isError).toBe(true);
		expect(JSON.stringify(denied.content)).toContain('save author');
		const cards: unknown[] = [];
		const decision = await checkPermission(
			{
				deps: env.deps,
				principal,
				project: env.project,
				conversationId: 'conversation',
				toolCallId: 'tool',
				canPrompt: false,
				tool: {
					name: 'save_to_branch',
					consentInput: workingBranchConsentInput(
						env.deps,
						principal,
						env.project.id,
						'save_to_branch',
					),
				},
				record: async (permission) => {
					cards.push(permission);
				},
			},
			args,
		);
		expect(decision.allowed).toBe(false);
		expect(cards).toEqual([
			expect.objectContaining({
				can_remember: true,
				details: expect.arrayContaining([
					{ label: 'Repository', value: 'owner/repo' },
					{ label: 'Working branch', value: data.source.branch },
				]),
			}),
		]);
		const pr = await client.callTool({
			name: 'open_change_request',
			arguments: { project: env.project.id, notebook: data.notebook_id },
		});
		expect(pr.isError, JSON.stringify(pr)).not.toBe(true);
		expect(pr.structuredContent).toMatchObject({
			change_request: {
				number: 42,
				head_branch: data.source.branch,
				base_branch: 'main',
			},
		});
		expect(pr.structuredContent).not.toHaveProperty('change_request.headBranch');
		expect(pr.structuredContent).not.toHaveProperty('change_request.baseBranch');
		const status = await client.callTool({
			name: 'get_working_branch',
			arguments: {
				project: env.project.id,
				notebook: data.notebook_id,
			},
		});
		expect(status.structuredContent).toMatchObject(pr.structuredContent!);
		const enrich = workingBranchConsentInput(
			env.deps,
			principal,
			env.project.id,
			'open_change_request',
		)!;
		for (const draft of [undefined, false, true]) {
			const input = await enrich({
				notebook: data.notebook_id,
				body: 'Reviewed body',
				...(draft === undefined ? {} : { draft }),
			});
			const card = permissionRequest({ name: 'open_change_request' }, input)!;
			expect(card.details).toEqual(
				expect.arrayContaining([
					{ label: 'Draft', value: String(draft ?? true) },
					{ label: 'Body', value: 'Reviewed body' },
				]),
			);
		}
	});
	it('hides creation replay after notebook security labels change', async () => {
		const env = await workingBranchFixture();
		const client = await connectMcpClient(
			{
				...env.deps,
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ classification: 'UNCLASSIFIED', compartments: [] }),
				),
			},
			principal,
		);
		const input = {
			name: 'create_branch_notebook',
			arguments: {
				project: env.project.id,
				title: 'Working',
				repo: 'owner/repo',
				base_branch: 'main',
				entry_notebook: 'app.py',
				idempotency_key: 'create',
			},
		};
		const created = await client.callTool(input);
		expect(created.isError, JSON.stringify(created)).not.toBe(true);
		const nid = NotebookId.parse(
			(created.structuredContent as { notebook_id: string }).notebook_id,
		);
		await env.deps.services.notebooks.setSecurityLabels(
			env.project.id,
			nid,
			{ classification: 'SECRET', compartments: ['finance'] },
			ACTOR,
		);
		const replay = await client.callTool(input);
		expect(replay.isError).toBe(true);
		expect(replay.structuredContent).not.toHaveProperty('notebook');
		expect(JSON.stringify(replay)).not.toContain('finance');
		expect(env.writer.createBranch).toHaveBeenCalledTimes(1);
	});
	it('always asks for branch creation but permits remembered save and PR consent', () => {
		expect(permissionRequest({ name: 'create_branch_notebook' }, {})!.can_remember).toBe(false);
		for (const name of ['save_to_branch', 'open_change_request', 'retry_branch_save'])
			expect(permissionRequest({ name }, {})!.can_remember).toBe(true);
	});
});
