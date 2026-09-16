import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CatalogService,
	NotebookId,
	SessionId,
	SandboxId,
	UserId,
	bootstrapKernel,
} from '@marimo-hub/core';
import type * as Core from '@marimo-hub/core';
import type { AuthenticatedPrincipal, TokenGrant } from '@marimo-hub/core';
import {
	fakeComputeFrom,
	makeFakeSandbox,
	MemoryBucket,
	localResourceSecurity,
} from '@marimo-hub/core/testing';
import { makeTestDeps } from '../testing';
import { connectMcpClient } from '../testing/mcp';

vi.mock('@marimo-hub/core', async (importOriginal) => ({
	...(await importOriginal<typeof Core>()),
	bootstrapKernel: vi.fn(),
}));

const USER_ID = UserId.parse('oauth-user');
const PRINCIPAL: AuthenticatedPrincipal = {
	id: USER_ID,
	email: 'oauth@example.com',
	credential: { kind: 'personal-access-token', id: 'tok-oauth' },
};

function principalWithGrant(grant: TokenGrant): AuthenticatedPrincipal {
	return {
		...PRINCIPAL,
		credential: { kind: 'personal-access-token', id: 'tok-oauth', grant },
	};
}

async function setup(overrides: Parameters<typeof makeTestDeps>[1] = {}) {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(USER_ID);
	const deps = makeTestDeps(bucket, overrides);
	const project = await deps.services.projects.createProject(
		{ name: 'Myles workspace', description: '' },
		USER_ID,
	);
	return { deps, project };
}

async function connect(
	deps: ReturnType<typeof makeTestDeps>,
	principal: AuthenticatedPrincipal = PRINCIPAL,
) {
	return connectMcpClient(deps, principal);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(bootstrapKernel).mockReset();
});

describe('create_notebook MCP tool', () => {
	it('does not advertise dependency metadata as an input', async () => {
		const { deps } = await setup();
		const client = await connect(deps);

		const tools = await client.listTools();

		const createNotebook = tools.tools.find((tool) => tool.name === 'create_notebook');
		expect(createNotebook?.inputSchema.properties).not.toHaveProperty('deps');
	});

	it('creates a notebook without a session when launch is omitted', async () => {
		const { deps, project } = await setup();
		const client = await connect(deps);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: {
				project: 'Myles workspace',
				title: 'Analysis',
				code: 'import marimo as mo',
				tags: ['mcp'],
			},
		});

		expect(response).toMatchObject({
			structuredContent: {
				project_id: project.id,
				title: 'Analysis',
				status: 'active',
				launched: false,
			},
		});
		const notebookId = NotebookId.parse(
			(response.structuredContent as { notebook_id: string }).notebook_id,
		);
		expect(await deps.services.notebooks.getNotebookContent(project.id, notebookId)).toBe(
			'import marimo as mo',
		);
		expect(await deps.services.sessions.listActiveByProject(project.id)).toEqual([]);
	});

	it('creates and launches an edit session when launch is true', async () => {
		vi.mocked(bootstrapKernel).mockResolvedValue({ status: 'ready' });
		const { instance } = makeFakeSandbox();
		const { deps, project } = await setup({
			compute: { ...fakeComputeFrom(instance), proxy: async () => Response.json([]) },
		});
		deps.sandbox = { ...deps.sandbox, hostname: 'sandboxes.example.com' };
		const client = await connect(deps);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: {
				project: project.id,
				title: 'Live analysis',
				description: 'Created through MCP',
				code: 'print("ready")',
				launch: true,
			},
		});

		expect(response).toMatchObject({
			structuredContent: {
				project_id: project.id,
				title: 'Live analysis',
				launched: true,
				session: {
					project_id: project.id,
					status: 'running',
					mode: 'edit',
					execution: { ready: true, status: 'ready' },
					sandbox_url: expect.any(String),
				},
			},
		});
		const data = response.structuredContent as {
			notebook_id: string;
			session: { notebook_id: string };
		};
		expect(data.session.notebook_id).toBe(data.notebook_id);
	});

	it('rejects creation when the token does not permit notebook writes', async () => {
		const { deps, project } = await setup();
		const principal = principalWithGrant({ actions: ['project.read'], projects: '*' });
		const client = await connect(deps, principal);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: 'Denied', code: '' },
		});

		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'FORBIDDEN' },
		});
		expect(await deps.services.notebooks.listNotebooks(project.id)).toEqual([]);
	});

	it('does not create a notebook when the requested launch is not permitted', async () => {
		const { deps, project } = await setup();
		const principal = principalWithGrant({
			actions: ['project.read', 'notebook.write'],
			projects: '*',
		});
		const client = await connect(deps, principal);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: 'No partial create', code: '', launch: true },
		});

		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'FORBIDDEN' },
		});
		expect(await deps.services.notebooks.listNotebooks(project.id)).toEqual([]);
	});

	it('rejects an empty title before it creates a notebook', async () => {
		const { deps, project } = await setup();
		const client = await connect(deps);

		const response = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: '', code: '' },
		});

		expect(response).toMatchObject({ isError: true });
		expect(await deps.services.notebooks.listNotebooks(project.id)).toEqual([]);
	});
});

describe('session MCP tools', () => {
	it('starts and idempotently stops a session', async () => {
		const { instance, calls } = makeFakeSandbox();
		const { deps, project } = await setup({
			compute: { ...fakeComputeFrom(instance), proxy: async () => Response.json([]) },
		});
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: 'import marimo as mo' },
			USER_ID,
		);
		const client = await connect(deps);

		const started = await client.callTool({
			name: 'start_session',
			arguments: { project: project.name, notebook: notebook.title, wait_seconds: 0 },
		});
		const sessionId = SessionId.parse(
			(started.structuredContent as { session_id: string }).session_id,
		);
		expect(started).toMatchObject({ structuredContent: { status: 'running', mode: 'edit' } });

		const stopped = await client.callTool({
			name: 'stop_session',
			arguments: { project: project.id, session_id: sessionId },
		});
		expect(stopped).toMatchObject({
			structuredContent: {
				project_id: project.id,
				notebook_id: notebook.id,
				session_id: sessionId,
				status: 'terminated',
			},
		});

		const stoppedAgain = await client.callTool({
			name: 'stop_session',
			arguments: { project: project.id, session_id: sessionId },
		});

		expect(stoppedAgain).toMatchObject({
			structuredContent: { session_id: sessionId, status: 'terminated' },
		});
		expect(calls.destroy).toBe(1);
	});

	it('does not stop a session when the token omits session.stop', async () => {
		const { instance, calls } = makeFakeSandbox();
		const { deps, project } = await setup({
			compute: { ...fakeComputeFrom(instance), proxy: async () => Response.json([]) },
		});
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: 'import marimo as mo' },
			USER_ID,
		);
		const unrestricted = await connect(deps);
		const started = await unrestricted.callTool({
			name: 'start_session',
			arguments: { project: project.id, notebook: notebook.id, wait_seconds: 0 },
		});
		const sessionId = SessionId.parse(
			(started.structuredContent as { session_id: string }).session_id,
		);

		const principal = principalWithGrant({
			actions: ['project.read', 'session.attach'],
			projects: '*',
		});
		const restricted = await connect(deps, principal);
		const response = await restricted.callTool({
			name: 'stop_session',
			arguments: { project: project.id, session_id: sessionId },
		});

		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'FORBIDDEN' },
		});
		expect((await deps.services.sessions.getSession(project.id, sessionId)).status).toBe('running');
		expect(calls.destroy).toBe(0);
	});
});

const NOTEBOOK_CODE = `# /// script
# dependencies = ["polars"]
# ///
import marimo
app = marimo.App()

@app.cell
def _():
    value = 1
    return (value,)

if __name__ == "__main__":
    app.run()
`;

describe('stored notebook MCP tools', () => {
	it('creates, reads, replaces, and deletes source without a kernel', async () => {
		const { deps, project } = await setup();
		const createSandbox = vi.spyOn(deps.compute, 'create');
		const client = await connect(deps);
		const created = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: 'Round trip', code: NOTEBOOK_CODE, tags: ['keep'] },
		});
		const notebook = NotebookId.parse(
			(created.structuredContent as { notebook_id: string }).notebook_id,
		);
		const read = await client.callTool({
			name: 'get_notebook',
			arguments: { project: project.name.toUpperCase(), notebook: 'ROUND TRIP' },
		});
		expect(read).toMatchObject({
			structuredContent: { code: NOTEBOOK_CODE, notebook_id: notebook, source: { type: 'local' } },
		});
		const updatedCode = NOTEBOOK_CODE.replace('value = 1', 'value = 2');
		const updated = await client.callTool({
			name: 'update_notebook',
			arguments: {
				project: project.id,
				notebook,
				code: updatedCode,
				expected_updated_at: (read.structuredContent as { updated_at: string }).updated_at,
			},
		});
		expect(updated.isError).toBeFalsy();
		const reread = await client.callTool({
			name: 'get_notebook',
			arguments: { project: project.id, notebook },
		});
		expect(reread).toMatchObject({
			structuredContent: { code: updatedCode, title: 'Round trip', tags: ['keep'] },
		});
		expect(await deps.services.notebooks.listVersions(project.id, notebook)).toHaveLength(2);
		const deleted = await client.callTool({
			name: 'delete_notebook',
			arguments: { project: project.id, notebook },
		});
		expect(deleted).toMatchObject({
			structuredContent: { status: 'deleted', notebook_id: notebook },
		});
		const missing = await client.callTool({
			name: 'get_notebook',
			arguments: { project: project.id, notebook },
		});
		expect(missing).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
		expect(await deps.services.notebooks.listNotebooks(project.id)).toEqual([]);
		expect(createSandbox).not.toHaveBeenCalled();
	});

	it.each(['update_notebook', 'delete_notebook'])(
		'rejects %s without notebook.write',
		async (name) => {
			const { deps, project } = await setup();
			const notebook = await deps.services.notebooks.createNotebook(
				project.id,
				{ title: 'Protected', description: '', code: NOTEBOOK_CODE },
				USER_ID,
			);
			const client = await connect(
				deps,
				principalWithGrant({ actions: ['project.read'], projects: '*' }),
			);
			const response = await client.callTool({
				name,
				arguments: {
					project: project.id,
					notebook: notebook.id,
					...(name === 'update_notebook' ? { code: '' } : {}),
				},
			});
			expect(response).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
			expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
				NOTEBOOK_CODE,
			);
			expect((await deps.services.notebooks.getNotebook(project.id, notebook.id)).meta.status).toBe(
				'active',
			);
		},
	);

	it.each(['update_notebook', 'delete_notebook'])(
		'rejects a stale %s precondition',
		async (name) => {
			const { deps, project } = await setup();
			const notebook = await deps.services.notebooks.createNotebook(
				project.id,
				{ title: 'Protected', description: '', code: NOTEBOOK_CODE },
				USER_ID,
			);
			const client = await connect(deps);
			const response = await client.callTool({
				name,
				arguments: {
					project: project.id,
					notebook: notebook.id,
					expected_updated_at: '2000-01-01T00:00:00.000Z',
					...(name === 'update_notebook' ? { code: '' } : {}),
				},
			});
			expect(response).toMatchObject({
				isError: true,
				structuredContent: { code: 'PRECONDITION_FAILED' },
			});
			expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
				NOTEBOOK_CODE,
			);
			expect((await deps.services.notebooks.getNotebook(project.id, notebook.id)).meta.status).toBe(
				'active',
			);
		},
	);

	it('rejects source replacement during an edit session but allows metadata edits', async () => {
		const { deps, project } = await setup();
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Editing', description: '', code: NOTEBOOK_CODE },
			USER_ID,
		);
		const session = await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: USER_ID,
		});
		const client = await connect(deps);
		const response = await client.callTool({
			name: 'update_notebook',
			arguments: { project: project.id, notebook: notebook.id, code: '' },
		});
		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'CONFLICT', message: expect.stringContaining(session.session_id) },
		});
		expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			NOTEBOOK_CODE,
		);
		const metadata = await client.callTool({
			name: 'update_notebook',
			arguments: { project: project.id, notebook: notebook.id, title: 'Renamed' },
		});
		expect(metadata).toMatchObject({ structuredContent: { title: 'Renamed' } });
	});

	it.each(['get_notebook', 'update_notebook', 'delete_notebook'])(
		'rejects ambiguous titles in %s',
		async (name) => {
			const { deps, project } = await setup();
			for (let i = 0; i < 2; i++)
				await deps.services.notebooks.createNotebook(
					project.id,
					{ title: 'Duplicate', description: '', code: '' },
					USER_ID,
				);
			const client = await connect(deps);
			const response = await client.callTool({
				name,
				arguments: {
					project: project.id,
					notebook: 'Duplicate',
					...(name === 'update_notebook' ? { code: '' } : {}),
				},
			});
			expect(response).toMatchObject({
				isError: true,
				structuredContent: { code: 'BAD_REQUEST', message: expect.stringContaining('ambiguous') },
			});
			expect(await deps.services.notebooks.listNotebooks(project.id)).toHaveLength(2);
		},
	);
});

describe('MCP session execution readiness', () => {
	it.each([
		{ kernels: [], ready: false, status: 'initializing' as const },
		{ kernels: [], ready: false, status: 'awaiting_client' as const },
		{ kernels: [], ready: false, status: 'unavailable' as const },
		{ kernels: [{ id: 'kernel-1' }], ready: true, status: 'ready' as const },
	])('reports $status independently of sandbox status', async ({ kernels, ready, status }) => {
		vi.mocked(bootstrapKernel).mockResolvedValue({ status });
		const { instance } = makeFakeSandbox();
		const proxy = vi.fn(async () => Response.json(kernels));
		const { deps, project } = await setup({ compute: { ...fakeComputeFrom(instance), proxy } });
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: NOTEBOOK_CODE },
			USER_ID,
		);
		const client = await connect(deps);
		const response = await client.callTool({
			name: 'start_session',
			arguments: { project: project.id, notebook: notebook.id, wait_seconds: 0 },
		});
		expect(response).toMatchObject({
			structuredContent: {
				status: 'running',
				execution: { ready, status, next_step: expect.any(String) },
			},
		});
		expect(bootstrapKernel).toHaveBeenCalledWith(
			instance,
			expect.objectContaining({ inspectOnly: true }),
		);
		expect(proxy).not.toHaveBeenCalled();
		const data = response.structuredContent as {
			execution: unknown;
			notebook_url: string;
			session_id: string;
		};
		if (!ready) {
			expect(data.execution).toMatchObject({
				next_step: expect.stringContaining(
					status === 'awaiting_client' ? data.notebook_url : 'start_session',
				),
			});
			const execution = await client.callTool({
				name: 'execute_code',
				arguments: {
					project: project.id,
					session_id: data.session_id,
					code: '1 + 1',
				},
			});
			expect(execution).toMatchObject({
				isError: true,
				structuredContent: {
					code: 'NO_KERNEL_SESSION',
					notebook_url: data.notebook_url,
				},
			});
		}
	});

	it('shares the wait deadline between polling and bootstrap', async () => {
		const { instance } = makeFakeSandbox();
		const { deps, project } = await setup({ compute: fakeComputeFrom(instance) });
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: NOTEBOOK_CODE },
			USER_ID,
		);
		const session = await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: USER_ID,
			sandbox_id: SandboxId.create(),
		});
		const client = await connect(deps);
		vi.mocked(bootstrapKernel).mockResolvedValue({ status: 'ready' });
		vi.useFakeTimers();
		try {
			const pending = client.callTool({
				name: 'start_session',
				arguments: { project: project.id, notebook: notebook.id, wait_seconds: 5 },
			});
			await vi.advanceTimersByTimeAsync(2_500);
			await deps.services.sessions.setRunning(
				project.id,
				session.session_id,
				'https://kernel.example',
			);
			await vi.advanceTimersByTimeAsync(1_500);
			expect(await pending).toMatchObject({ structuredContent: { execution: { ready: true } } });
			expect(bootstrapKernel).toHaveBeenCalledWith(
				instance,
				expect.objectContaining({ timeoutMs: 1_000, inspectOnly: false }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(['starting', 'forbidden'] as const)(
		'does not probe execution readiness when %s',
		async (status) => {
			const { instance } = makeFakeSandbox();
			const proxy = vi.fn(async () => Response.json([{ id: 'kernel-1' }]));
			const { deps, project } = await setup({ compute: { ...fakeComputeFrom(instance), proxy } });
			const notebook = await deps.services.notebooks.createNotebook(
				project.id,
				{ title: 'Notebook', description: '', code: NOTEBOOK_CODE },
				USER_ID,
			);
			const session = await deps.services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: USER_ID,
			});
			if (status === 'forbidden')
				await deps.services.sessions.setRunning(
					project.id,
					session.session_id,
					'https://kernel.example',
				);
			const client = await connect(
				deps,
				principalWithGrant({ actions: ['project.read', 'session.start'], projects: '*' }),
			);
			const response = await client.callTool({
				name: 'start_session',
				arguments: { project: project.id, notebook: notebook.id, wait_seconds: 0 },
			});
			expect(response).toMatchObject({
				structuredContent: {
					session_id: session.session_id,
					reused: true,
					execution: { ready: false, status },
				},
			});
			expect(proxy).not.toHaveBeenCalled();
			expect(bootstrapKernel).not.toHaveBeenCalled();
		},
	);

	it('returns created notebook and session details when bootstrap fails', async () => {
		vi.mocked(bootstrapKernel).mockResolvedValue({ status: 'unavailable' });
		const { instance } = makeFakeSandbox();
		const { deps, project } = await setup({
			compute: {
				...fakeComputeFrom(instance),
				proxy: async () => {
					throw new Error('secret kernel URL');
				},
			},
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const client = await connect(deps);
		const response = await client.callTool({
			name: 'create_notebook',
			arguments: { project: project.id, title: 'Created', code: NOTEBOOK_CODE, launch: true },
		});
		expect(response).toMatchObject({
			structuredContent: {
				notebook_id: expect.any(String),
				launched: true,
				session: { status: 'running', execution: { ready: false, status: 'unavailable' } },
			},
		});
		expect(JSON.stringify(response)).not.toContain('secret kernel URL');
		expect(await deps.services.notebooks.listNotebooks(project.id)).toHaveLength(1);
	});

	it('does not probe app sessions for scratchpad execution', async () => {
		const { instance } = makeFakeSandbox();
		const proxy = vi.fn(async () => Response.json([]));
		const { deps, project } = await setup({ compute: { ...fakeComputeFrom(instance), proxy } });
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'App', description: '', code: NOTEBOOK_CODE },
			USER_ID,
		);
		const client = await connect(deps);
		const response = await client.callTool({
			name: 'start_session',
			arguments: { project: project.id, notebook: notebook.id, mode: 'app', wait_seconds: 0 },
		});
		expect(response).toMatchObject({
			structuredContent: { execution: { ready: false, status: 'app_mode' } },
		});
		expect(proxy).not.toHaveBeenCalled();
	});
});

describe('stored notebook access boundaries', () => {
	it.each(['get_notebook', 'update_notebook', 'delete_notebook'])(
		'hides restricted notebooks from %s',
		async (name) => {
			const { deps, project } = await setup({
				resourceSecurity: localResourceSecurity(['UNCLASSIFIED', 'SECRET']),
			});
			const notebook = await deps.services.notebooks.createNotebook(
				project.id,
				{ title: 'Secret', description: '', code: NOTEBOOK_CODE },
				USER_ID,
			);
			await deps.services.notebooks.setSecurityLabels(
				project.id,
				notebook.id,
				{ classification: 'SECRET', compartments: ['restricted'] },
				USER_ID,
			);
			const client = await connect(deps);
			const response = await client.callTool({
				name,
				arguments: {
					project: project.id,
					notebook: notebook.id,
					...(name === 'update_notebook' ? { code: '' } : {}),
				},
			});
			expect(response).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
			expect(JSON.stringify(response)).not.toContain(NOTEBOOK_CODE);
			expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
				NOTEBOOK_CODE,
			);
			expect((await deps.services.notebooks.getNotebook(project.id, notebook.id)).meta.status).toBe(
				'active',
			);
		},
	);

	it('rejects remote source replacement without changing its metadata', async () => {
		const { deps, project } = await setup();
		const { meta } = await deps.services.notebooks.synced.create(
			project.id,
			{
				title: 'Remote',
				description: '',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			},
			USER_ID,
		);
		const client = await connect(deps);
		const response = await client.callTool({
			name: 'update_notebook',
			arguments: { project: project.id, notebook: meta.id, title: 'Changed', code: NOTEBOOK_CODE },
		});
		expect(response).toMatchObject({ isError: true, structuredContent: { code: 'CONFLICT' } });
		expect((await deps.services.notebooks.getNotebook(project.id, meta.id)).meta.title).toBe(
			'Remote',
		);
	});

	it.each([
		{},
		{ message: 'No source supplied' },
		{ expected_updated_at: '2000-01-01T00:00:00.000Z' },
	])('rejects an update without changed fields: %j', async (input) => {
		const { deps, project } = await setup();
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: NOTEBOOK_CODE },
			USER_ID,
		);
		const client = await connect(deps);
		const response = await client.callTool({
			name: 'update_notebook',
			arguments: { project: project.id, notebook: notebook.id, ...input },
		});
		expect(response).toMatchObject({ isError: true, structuredContent: { code: 'BAD_REQUEST' } });
		expect(await deps.services.notebooks.listVersions(project.id, notebook.id)).toHaveLength(1);
	});

	it('preserves the started session when bootstrap times out', async () => {
		vi.mocked(bootstrapKernel).mockResolvedValue({ status: 'initializing' });
		const { instance } = makeFakeSandbox();
		let discoverySignal: AbortSignal | undefined;
		const proxy = vi.fn(async (request: Request) => {
			discoverySignal = request.signal;
			return new Promise<Response | null>(() => {});
		});
		const { deps, project } = await setup({ compute: { ...fakeComputeFrom(instance), proxy } });
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: NOTEBOOK_CODE },
			USER_ID,
		);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const client = await connect(deps);
		const response = await client.callTool({
			name: 'start_session',
			arguments: { project: project.id, notebook: notebook.id, wait_seconds: 0 },
		});
		expect(response).toMatchObject({
			structuredContent: {
				session_id: expect.any(String),
				status: 'running',
				execution: { ready: false, status: 'initializing' },
			},
		});
		expect(discoverySignal).toBeUndefined();
		expect(await deps.services.sessions.listActiveByProject(project.id)).toHaveLength(1);
	}, 10_000);
});
