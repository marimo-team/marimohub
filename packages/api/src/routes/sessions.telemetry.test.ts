import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredential, AuthenticatedPrincipal } from '@marimo-hub/core';
import { createNotebookId } from '@marimo-hub/core';
import { ACTOR, makeFakeCompute } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { captureLogEvents } from '../testing/logs';
import { connectMcpClient } from '../testing/mcp';
import type { SessionCreateResult } from './sessionStart';

afterEach(() => {
	vi.restoreAllMocks();
});

async function setup(credential: AuthCredential) {
	const bucket = await createInitializedBucket();
	const compute = makeFakeCompute();
	const principal: AuthenticatedPrincipal = {
		id: ACTOR,
		email: 'owner@example.com',
		credential,
	};
	const { deps, request } = createTestApi({
		bucket,
		compute,
		deps: { authenticator: { authenticate: async () => principal } },
	});
	const project = await deps.services.projects.createProject(
		{ name: 'Telemetry', description: '' },
		ACTOR,
	);
	const notebook = await deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo as mo' },
		ACTOR,
	);
	const { events } = captureLogEvents('session_provision');
	return {
		deps,
		create: vi.spyOn(compute, 'create'),
		notebook,
		start: (nid = notebook.id) =>
			request('POST', `/projects/${project.id}/notebooks/${nid}/sessions`),
		startMcp: async () => {
			const client = await connectMcpClient(deps, principal);
			return client.callTool({
				name: 'start_session',
				arguments: { project: project.id, notebook: notebook.id, wait_seconds: 0 },
			});
		},
		events,
		expectProvision: (fields: Record<string, unknown>) =>
			expect(events()).toEqual([
				expect.objectContaining({
					project_id: project.id,
					notebook_id: notebook.id,
					auth_reuse_ms: expect.any(Number),
					stop_wait_ms: expect.any(Number),
					total_ms: expect.any(Number),
					...fields,
				}),
			]),
	};
}

describe('Session provision client telemetry', () => {
	it.each([
		{ kind: 'sso', client: 'web' },
		{ kind: 'development', client: 'web' },
		{ kind: 'personal-access-token', client: 'cli' },
		{ kind: 'external-access-token', client: 'cli' },
	] as const)('groups REST requests using $kind as $client', async ({ kind, client }) => {
		const env = await setup({ kind });
		const session = await expectOk<SessionCreateResult>(await env.start());
		env.expectProvision({
			client,
			session_id: session.session_id,
			admission_ms: expect.any(Number),
			cap_recheck_ms: expect.any(Number),
			editor_claim_ms: expect.any(Number),
			provision_boot_overlap_ms: expect.any(Number),
		});
	});

	it.each(['development', 'personal-access-token', 'external-access-token'] as const)(
		'classifies MCP requests using %s as mcp',
		async (kind) => {
			const env = await setup({ kind });
			const result = await env.startMcp();
			expect(result.isError).not.toBe(true);
			const session = result.structuredContent as { session_id: string };
			env.expectProvision({ client: 'mcp', session_id: session.session_id });
		},
	);

	it.each([
		{ kind: 'sso', client: 'web' },
		{ kind: 'personal-access-token', client: 'cli' },
		{ kind: 'personal-access-token', client: 'mcp' },
	] as const)('retains $client attribution when provisioning fails', async ({ kind, client }) => {
		const env = await setup({ kind });
		env.create.mockImplementation(() => {
			throw new Error('provider unavailable');
		});
		if (client === 'mcp') {
			expect(await env.startMcp()).toMatchObject({
				isError: true,
				structuredContent: { code: 'INTERNAL_ERROR' },
			});
		} else {
			await expectError(await env.start(), 500, 'INTERNAL_ERROR');
		}
		expect(await env.deps.services.sessions.listSessions(env.notebook.id)).toEqual([]);
		env.expectProvision({
			client,
			sandbox_boot_failed: true,
		});
	});

	it('does not count a reused session as another provision', async () => {
		const env = await setup({ kind: 'personal-access-token' });
		const created = await expectOk<SessionCreateResult>(await env.start());
		const reused = await expectOk<SessionCreateResult>(await env.start());
		expect(reused).toMatchObject({ session_id: created.session_id, reused: true });
		env.expectProvision({ client: 'cli', session_id: created.session_id });
	});

	it.each([
		{ reason: 'missing notebook', kind: 'sso', missing: true },
		{ reason: 'service account access denied', kind: 'service-account', missing: false },
	] as const)('does not emit a provision event for $reason', async ({ kind, missing }) => {
		const env = await setup({ kind });
		await expectError(
			await env.start(missing ? createNotebookId() : env.notebook.id),
			404,
			'NOT_FOUND',
		);
		expect(env.create).not.toHaveBeenCalled();
		expect(env.events()).toEqual([]);
	});
});
