import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogService, UserId, paths } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { fakeComputeFrom, makeFakeSandbox } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { startNotebookSession } from '../routes/sessionStart';
import { makeTestDeps } from '../testing';
import { connectMcpClient } from '../testing/mcp';

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
	const client = await connectMcpClient(writer, principal, request);
	return {
		bucket,
		instance,
		writer,
		starter,
		project,
		notebook,
		stop: (session_id: string) =>
			client.callTool({ name: 'stop_session', arguments: { project: project.id, session_id } }),
		read: () =>
			client.callTool({
				name: 'get_notebook',
				arguments: { project: project.id, notebook: notebook.id },
			}),
		update: (expected_updated_at?: string) =>
			client.callTool({
				name: 'update_notebook',
				arguments: {
					project: project.id,
					notebook: notebook.id,
					code: 'replacement',
					...(expected_updated_at ? { expected_updated_at } : {}),
				},
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
	};
}

describe('MCP source replacement and editor admission', () => {
	it('does not return a new update token with old code while a source write is pending', async () => {
		const fixture = await setup();
		const { bucket, starter, writer, project, notebook } = fixture;
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
		const writing = starter.services.notebooks.updateNotebook(
			project.id,
			notebook.id,
			{ code: 'new source' },
			principal.id,
		);
		await entered.promise;
		const readingLease = vi.spyOn(writer.services.notebooks.workspace, 'withMutation');
		const reading = fixture.read();
		try {
			await vi.waitFor(() => expect(readingLease).toHaveBeenCalledOnce());
		} finally {
			release.resolve();
		}
		const updated = await writing;
		expect(await reading).toMatchObject({
			structuredContent: { code: 'new source', updated_at: updated.updated_at },
		});
	});

	it('rejects a read token after another replica replaces the source', async () => {
		const fixture = await setup();
		const { bucket, starter, project, notebook } = fixture;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const get = bucket.get.bind(bucket);
		let paused = false;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			const object = await get(key);
			if (key === paths.project(project.id).notebook(notebook.id).code && !paused) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			return object;
		});
		const reading = fixture.read();
		await entered.promise;
		const writing = starter.services.notebooks.updateNotebook(
			project.id,
			notebook.id,
			{ code: 'intervening source' },
			principal.id,
		);
		release.resolve();
		const read = await reading;
		await writing;
		expect(read).toMatchObject({ structuredContent: { code: 'original' } });
		const token = (read.structuredContent as { updated_at: string }).updated_at;
		expect(await fixture.update(token)).toMatchObject({
			isError: true,
			structuredContent: { code: 'PRECONDITION_FAILED' },
		});
		expect(await starter.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			'intervening source',
		);
	});

	it.each([
		{ phase: 'before provision', cleanupFails: false },
		{ phase: 'during provision', cleanupFails: false },
		{ phase: 'after provision', cleanupFails: false },
		{ phase: 'during provision', cleanupFails: true },
		{ phase: 'after provision', cleanupFails: true },
	])(
		'tracks cleanup after a failure $phase (cleanup fails: $cleanupFails)',
		async ({ phase, cleanupFails }) => {
			const fixture = await setup();
			const { instance, starter, notebook } = fixture;
			const destroy = vi.spyOn(instance, 'destroy');
			if (cleanupFails) destroy.mockRejectedValue(new Error('destroy failed'));
			if (phase === 'before provision')
				vi.spyOn(starter.services.sessions, 'claimEditor').mockRejectedValueOnce(
					new Error('claim failed'),
				);
			if (phase === 'during provision')
				vi.spyOn(instance, 'exec').mockRejectedValue(new Error('provision failed'));
			if (phase === 'after provision')
				vi.spyOn(starter.services.sessions, 'setRunning').mockRejectedValueOnce(
					new Error('mark running failed'),
				);
			await expect(fixture.start()).rejects.toThrow();
			const [session] = await starter.services.sessions.listSessions(notebook.id);
			expect(session.status).toBe('failed');
			expect(!!session.sandbox_reclaimed_at).toBe(!cleanupFails);
			if (phase === 'before provision') expect(destroy).not.toHaveBeenCalled();
			else expect(destroy).toHaveBeenCalledOnce();
			const update = await fixture.update();
			if (cleanupFails)
				expect(update).toMatchObject({ isError: true, structuredContent: { code: 'CONFLICT' } });
			else expect(update.isError).toBeFalsy();
		},
	);

	it('keeps source blocked when cleanup succeeds but its marker cannot be stored', async () => {
		const fixture = await setup();
		const { instance, starter, notebook } = fixture;
		const destroy = vi.spyOn(instance, 'destroy');
		vi.spyOn(instance, 'exec').mockRejectedValue(new Error('provision failed'));
		vi.spyOn(starter.services.sessions, 'markSandboxReclaimed').mockRejectedValue(
			new Error('marker storage unavailable'),
		);
		await expect(fixture.start()).rejects.toThrow();
		expect(destroy).toHaveBeenCalledOnce();
		const [session] = await starter.services.sessions.listSessions(notebook.id);
		expect(session.status).toBe('failed');
		expect(session.sandbox_reclaimed_at).toBeUndefined();
		expect(await fixture.update()).toMatchObject({
			isError: true,
			structuredContent: { code: 'CONFLICT' },
		});
	});

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
		},
	);

	it('allows source replacement immediately after stop_session finishes', async () => {
		const fixture = await setup();
		const started = await fixture.start();
		expect((await fixture.stop(started.session_id)).isError).toBeFalsy();
		expect((await fixture.update()).isError).toBeFalsy();
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
	});
});
