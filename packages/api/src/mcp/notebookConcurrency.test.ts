import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogService, SandboxId, UserId, paths } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { fakeComputeFrom, makeFakeSandbox } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { startNotebookSession } from '../routes/sessionStart';
import { makeTestDeps } from '../testing';
import { createMcpServer } from './server';

const principal: AuthenticatedPrincipal = {
	id: UserId.parse('mcp-editor'),
	email: 'editor@example.com',
	credential: { kind: 'personal-access-token', id: 'token' },
};
const request = {
	method: 'POST',
	path: '/mcp',
	hostname: 'hub.example.com',
	appBaseUrl: 'https://hub.example.com',
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function setup() {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(principal.id);
	const { instance } = makeFakeSandbox();
	const writer = makeTestDeps(bucket, { compute: fakeComputeFrom(instance) });
	const starter = makeTestDeps(bucket, { compute: fakeComputeFrom(instance) });
	const project = await writer.services.projects.createProject(
		{ name: 'Project', description: '' },
		principal.id,
	);
	const notebook = await writer.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'original' },
		principal.id,
	);
	const server = createMcpServer(writer, principal, request);
	const client = new Client({ name: 'test', version: '1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return {
		bucket,
		writer,
		starter,
		project,
		notebook,
		stop: (session_id: string) =>
			client.callTool({ name: 'stop_session', arguments: { project: project.id, session_id } }),
		update: () =>
			client.callTool({
				name: 'update_notebook',
				arguments: { project: project.id, notebook: notebook.id, code: 'replacement' },
			}),
		start: () =>
			startNotebookSession({
				deps: starter,
				user: principal,
				pid: project.id,
				nid: notebook.id,
				body: { mode: 'edit' },
				request,
			}),
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe('MCP source replacement and editor admission', () => {
	it('keeps a second replica from admitting an editor during the source write', async () => {
		const fixture = await setup();
		const { bucket, starter, project, notebook } = fixture;
		const enteredWrite = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		const get = bucket.get.bind(bucket);
		let paused = false;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key === paths.project(project.id).notebook(notebook.id).deps && !paused) {
				paused = true;
				enteredWrite.resolve();
				await releaseWrite.promise;
			}
			return get(key);
		});
		const admission = vi.spyOn(starter.services.notebooks.workspace, 'withMutation');
		const create = starter.services.sessions.createSession.bind(starter.services.sessions);
		let codeAtAdmission: string | undefined;
		const createSession = vi
			.spyOn(starter.services.sessions, 'createSession')
			.mockImplementation(async (input) => {
				codeAtAdmission = await starter.services.notebooks.getNotebookContent(
					project.id,
					notebook.id,
				);
				return create(input);
			});

		const writing = fixture.update();
		await enteredWrite.promise;
		const starting = fixture.start();
		try {
			await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
			expect(createSession).not.toHaveBeenCalled();
		} finally {
			releaseWrite.resolve();
		}
		expect((await writing).isError).toBeFalsy();
		expect((await starting).status).toBe('running');
		expect(codeAtAdmission).toBe('replacement');
		await fixture.close();
	});

	it('rejects a racing replacement after another replica publishes its starting session', async () => {
		const fixture = await setup();
		const { writer, starter, project, notebook } = fixture;
		const enteredCreate = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<void>();
		const create = starter.services.sessions.createSession.bind(starter.services.sessions);
		vi.spyOn(starter.services.sessions, 'createSession').mockImplementation(async (input) => {
			enteredCreate.resolve();
			await releaseCreate.promise;
			return create(input);
		});
		const mutation = vi.spyOn(writer.services.notebooks.workspace, 'withMutation');
		const starting = fixture.start();
		await enteredCreate.promise;
		const writing = fixture.update();
		try {
			await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce());
			expect(await writer.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
				'original',
			);
		} finally {
			releaseCreate.resolve();
		}
		const started = await starting;
		expect(await writing).toMatchObject({
			isError: true,
			structuredContent: { code: 'CONFLICT', message: expect.stringContaining(started.session_id) },
		});
		expect(await writer.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			'original',
		);
		expect(await writer.services.notebooks.listVersions(project.id, notebook.id)).toHaveLength(1);
		await fixture.close();
	});

	it.each([{ mode: 'app' }, { mode: 'edit', ephemeral: true }] as const)(
		'allows source replacement with a discard-only session: %j',
		async (sessionOptions) => {
			const fixture = await setup();
			const { writer, project, notebook } = fixture;
			await writer.services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: principal.id,
				...sessionOptions,
			});
			expect((await fixture.update()).isError).toBeFalsy();
			expect(await writer.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
				'replacement',
			);
			await fixture.close();
		},
	);

	it('allows source replacement immediately after stop_session finishes', async () => {
		const fixture = await setup();
		const started = await fixture.start();
		expect((await fixture.stop(started.session_id)).isError).toBeFalsy();
		expect((await fixture.update()).isError).toBeFalsy();
		await fixture.close();
	});

	it('does not commit source after losing its lease during dependency loading', async () => {
		const fixture = await setup();
		const { bucket, writer, project, notebook } = fixture;
		vi.useFakeTimers({ toFake: ['Date'] });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const get = bucket.get.bind(bucket);
		let paused = false;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key === paths.project(project.id).notebook(notebook.id).deps && !paused) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			return get(key);
		});
		const writing = fixture.update();
		await entered.promise;
		try {
			vi.setSystemTime(Date.now() + 3 * 60_000);
			expect((await fixture.start()).status).toBe('running');
		} finally {
			release.resolve();
		}
		expect(await writing).toMatchObject({ isError: true, structuredContent: { code: 'CONFLICT' } });
		expect(await writer.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			'original',
		);
		expect(await writer.services.notebooks.listVersions(project.id, notebook.id)).toHaveLength(1);
		await fixture.close();
	});

	it.each(['starting', 'running', 'terminating', 'failed', 'terminated', 'expired'] as const)(
		'blocks an unreclaimed %s editor',
		async (status) => {
			const fixture = await setup();
			const { writer, project, notebook } = fixture;
			const sessions = writer.services.sessions;
			const session = await sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: principal.id,
				sandbox_id: SandboxId.create(),
			});
			if (status === 'running')
				await sessions.setRunning(project.id, session.session_id, 'https://kernel.example');
			if (status === 'terminating' || status === 'terminated')
				await sessions.beginTerminating(project.id, session.session_id);
			if (status === 'terminated') await sessions.markTerminated(project.id, session.session_id);
			if (status === 'failed') await sessions.markFailed(project.id, session.session_id);
			if (status === 'expired') {
				const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
				await sessions.expireStale();
				clock.mockRestore();
			}
			expect((await sessions.getSession(project.id, session.session_id)).status).toBe(status);
			expect(await fixture.update()).toMatchObject({
				isError: true,
				structuredContent: { code: 'CONFLICT' },
			});
			expect(await writer.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
				'original',
			);
			if (status === 'terminated' || status === 'failed' || status === 'expired') {
				await sessions.markSandboxReclaimed(
					project.id,
					session.session_id,
					new Date().toISOString(),
				);
				expect((await fixture.update()).isError).toBeFalsy();
			}
			await fixture.close();
		},
	);
});
