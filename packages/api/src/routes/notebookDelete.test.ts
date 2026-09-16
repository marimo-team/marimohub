import { describe, expect, it, vi } from 'vitest';
import { ACTOR } from '@marimo-hub/core/testing';
import { connectMcpClient } from '../testing/mcp';
import { assertNotificationMutationAllowed } from '../notifications';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { deleteNotebookAndRetire } from './notebookDelete';

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
			expect(deferred).toHaveLength(20);
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
		expect(deferred).toHaveLength(1);
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
