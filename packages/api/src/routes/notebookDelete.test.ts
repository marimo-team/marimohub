import { createSandboxId, SessionRetirer } from '@marimo-hub/core';
import { describe, expect, it, vi } from 'vitest';
import { ACTOR, fakeComputeFrom, makeFakeSandbox } from '@marimo-hub/core/testing';
import { connectMcpClient } from '../testing/mcp';
import { assertNotificationMutationAllowed } from '../notifications';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { deleteNotebookAndRetire } from './notebookDelete';

it.each([
	{ scope: 'notebook', fail: false },
	{ scope: 'project', fail: false },
	{ scope: 'notebook', fail: true },
	{ scope: 'project', fail: true },
])(
	'defers app retirement after $scope deletion and isolates failures (fail=$fail)',
	async ({ scope, fail }) => {
		const tasks: (() => Promise<unknown>)[] = [];
		const api = createTestApi({
			bucket: await createInitializedBucket(),
			deps: {
				backgroundWork: {
					defer: (_label, task) => {
						tasks.push(task);
					},
				},
			},
		});
		const { projects, notebooks, sessions } = api.deps.services;
		const project = await projects.createProject({ name: 'P', description: '' }, ACTOR);
		const notebook = await notebooks.createNotebook(
			project.id,
			{ title: 'N', description: '', code: '' },
			ACTOR,
		);
		const apps = await Promise.all(
			[1, 2].map(() =>
				sessions.createSession({
					project_id: project.id,
					notebook_id: notebook.id,
					user_id: ACTOR,
					mode: 'app',
				}),
			),
		);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let active = 0;
		const original = SessionRetirer.prototype.retire;
		const retire = vi
			.spyOn(SessionRetirer.prototype, 'retire')
			.mockImplementation(async function (this: SessionRetirer, session, options) {
				active++;
				if (active === 2) entered.resolve();
				await gate.promise;
				if (fail && session.session_id === apps[0].session_id) throw new Error('retirement failed');
				return original.call(this, session, options);
			});
		try {
			const path = `/projects/${project.id}${scope === 'notebook' ? `/notebooks/${notebook.id}` : ''}`;
			await expectOk(await api.request('DELETE', path));
			expect(retire).not.toHaveBeenCalled();
			if (scope === 'notebook')
				expect((await notebooks.getNotebook(project.id, notebook.id)).meta.status).toBe('deleted');
			else expect((await projects.getProject(project.id)).status).toBe('deleted');
			expect(tasks).toHaveLength(1);
			const completion = tasks[0]();
			await entered.promise;
			for (const app of apps)
				expect((await sessions.getSession(project.id, app.session_id)).status).toBe('terminating');
			gate.resolve();
			await completion;
			for (const app of apps)
				expect((await sessions.getSession(project.id, app.session_id)).status).toBe(
					fail && app.session_id === apps[0].session_id ? 'terminating' : 'terminated',
				);
		} finally {
			gate.resolve();
			retire.mockRestore();
		}
	},
);

it.each(['notebook', 'project'] as const)(
	'retires live app kernels inline when scheduling %s deletion fails',
	async (scope) => {
		const { instance, calls } = makeFakeSandbox();
		const tasks: (() => Promise<unknown>)[] = [];
		const api = createTestApi({
			bucket: await createInitializedBucket(),
			compute: fakeComputeFrom(instance),
			deps: {
				backgroundWork: {
					defer: (_label, task) => {
						tasks.push(task);
						throw new Error('scheduler closed');
					},
				},
			},
		});
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const { projects, notebooks, sessions } = api.deps.services;
			const project = await projects.createProject({ name: 'P', description: '' }, ACTOR);
			const notebook = await notebooks.createNotebook(
				project.id,
				{ title: 'N', description: '', code: '' },
				ACTOR,
			);
			const apps = await Promise.all(
				[1, 2].map(async () => {
					const session = await sessions.createSession({
						project_id: project.id,
						notebook_id: notebook.id,
						user_id: ACTOR,
						mode: 'app',
						sandbox_id: createSandboxId(),
					});
					return sessions.setRunning(project.id, session.session_id, 'https://kernel.example');
				}),
			);
			const path = `/projects/${project.id}${scope === 'notebook' ? `/notebooks/${notebook.id}` : ''}`;
			await expectOk(await api.request('DELETE', path));
			expect(calls.destroy).toBe(2);
			for (const app of apps)
				expect((await sessions.getSession(project.id, app.session_id)).status).toBe('terminated');
			for (const task of tasks) await task();
			expect(calls.destroy).toBe(2);
			const failure = log.mock.calls
				.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
				.find((event) => event.label === `${scope}.retire_apps`);
			expect(failure).toMatchObject({
				event: 'background_work_failed',
				project_id: project.id,
				...(scope === 'notebook' ? { notebook_id: notebook.id } : {}),
			});
		} finally {
			log.mockRestore();
		}
	},
);

async function setupAlerts() {
	const deliver = vi.fn(async () => 'delivered' as const);
	const deferred: Promise<unknown>[] = [];
	const api = createTestApi({
		bucket: await createInitializedBucket(),
		deps: {
			projectAlerts: {
				store: {} as never,
				dispatcher: { deliver, test: vi.fn() },
				maxDestinations: 10,
			},
			backgroundTasks: { defer: (task) => deferred.push(task) },
		},
	});
	const { notebooks, projects } = api.deps.services;
	const project = await projects.createProject({ name: 'Project', description: '' }, ACTOR);
	const create = () =>
		notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: 'import marimo' },
			ACTOR,
		);
	return { api, project, notebooks, create, deliver, deferred };
}

describe('notebook deletion notification budget', () => {
	it.each(['API', 'MCP'])(
		'limits %s deletion before deleting or broadcasting',
		async (transport) => {
			const { api, project, notebooks, create, deliver, deferred } = await setupAlerts();
			const client = await connectMcpClient(
				api.deps,
				{ id: ACTOR, email: `${ACTOR}@example.com`, credential: { kind: 'development' } },
				{
					requestId: 'delete-budget',
					method: 'POST',
					path: '/mcp',
					hostname: 'localhost',
					appBaseUrl: 'http://localhost',
				},
			);
			const remove = (notebook: string) =>
				client.callTool({
					name: 'delete_notebook',
					arguments: { project: project.id, notebook },
				});

			for (let i = 0; i < 20; i++) {
				const notebook = await create();
				if (transport === 'API') {
					await expectOk(
						await api.request('DELETE', `/projects/${project.id}/notebooks/${notebook.id}`),
					);
				} else {
					expect(await remove(notebook.id)).toMatchObject({
						structuredContent: { status: 'deleted' },
					});
				}
			}
			await Promise.all(deferred);
			expect(deliver).toHaveBeenCalledTimes(20);
			const notebook = await create();
			if (transport === 'API') {
				await expectError(
					await api.request('DELETE', `/projects/${project.id}/notebooks/${notebook.id}`),
					429,
					'RESOURCE_EXHAUSTED',
				);
			} else {
				expect(await remove(notebook.id)).toMatchObject({
					isError: true,
					structuredContent: { code: 'RESOURCE_EXHAUSTED' },
				});
			}
			expect(await notebooks.getNotebook(project.id, notebook.id)).toMatchObject({
				meta: { status: 'active' },
			});
			expect(deferred).toHaveLength(40);
			expect(deliver).toHaveBeenCalledTimes(20);
		},
	);

	it('does not rebroadcast an already-deleted notebook', async () => {
		const { api, project, create, deliver, deferred } = await setupAlerts();
		const notebook = await create();
		const user = {
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			credential: { kind: 'development' as const },
		};
		await deleteNotebookAndRetire(api.deps, project, notebook.id, user);
		await deleteNotebookAndRetire(api.deps, project, notebook.id, user);
		await Promise.all(deferred);
		expect(deliver).toHaveBeenCalledOnce();
		expect(deliver).toHaveBeenCalledWith(
			project.id,
			'notebook.deleted',
			expect.objectContaining({ kind: 'notebook.deleted' }),
		);
		expect(deferred).toHaveLength(3);
	});

	it('allows deletion when only personal notifications have exhausted the budget', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);
		const api = createTestApi({
			bucket: await createInitializedBucket(),
			deps: { notifier: { deliver } },
		});
		const { projects, notebooks } = api.deps.services;
		const project = await projects.createProject({ name: 'Project', description: '' }, ACTOR);
		const notebook = await notebooks.createNotebook(
			project.id,
			{ title: 'Notebook', description: '', code: 'import marimo' },
			ACTOR,
		);
		for (let i = 0; i < 20; i++) {
			assertNotificationMutationAllowed(api.deps, ACTOR);
		}

		await deleteNotebookAndRetire(api.deps, project, notebook.id, {
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			credential: { kind: 'development' },
		});
		expect(await notebooks.getNotebook(project.id, notebook.id)).toMatchObject({
			meta: { status: 'deleted' },
		});
		expect(deliver).not.toHaveBeenCalled();
	});
});
