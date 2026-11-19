import { describe, expect, it } from 'vitest';
import type { HubStorage } from '../ports/metadata';
import { createServices } from '../services';
import { SYSTEM_ACTOR } from '../ids';
import { paths } from '../paths';

export function metadataCompositionContract(
	name: string,
	makeStorage: () => Promise<HubStorage>,
): void {
	describe(`Metadata domain composition: ${name}`, () => {
		it('publishes concurrent catalog updates through the metadata pointer', async () => {
			const storage = await makeStorage();
			const services = createServices(storage);
			await services.catalog.initialize(SYSTEM_ACTOR);
			const projects = await Promise.all(
				['one', 'two'].map((name) =>
					services.projects.createProject({ name, description: '' }, SYSTEM_ACTOR),
				),
			);
			const snapshot = await services.catalog.getCurrentSnapshot();
			expect(snapshot.projects.map((project) => project.id)).toEqual(
				expect.arrayContaining(projects.map((project) => project.id)),
			);
			expect(await storage.metadata.get(paths.catalog)).not.toBeNull();
		});
		it('keeps notebook payloads separate while sessions retain domain transitions', async () => {
			const storage = await makeStorage();
			const services = createServices(storage);
			await services.catalog.initialize(SYSTEM_ACTOR);
			const project = await services.projects.createProject(
				{ name: 'test', description: '' },
				SYSTEM_ACTOR,
			);
			const notebook = await services.notebooks.createNotebook(
				project.id,
				{ title: 'test', description: '', code: 'print(1)' },
				SYSTEM_ACTOR,
			);
			const keys = paths.project(project.id).notebook(notebook.id);
			expect(await storage.metadata.get(keys.meta)).not.toBeNull();
			expect(await storage.metadata.get(keys.source)).not.toBeNull();
			const artifacts = await storage.artifacts.list({ prefix: `${keys.base}/` });
			expect(artifacts.objects.some((object) => object.key.endsWith('notebook.py'))).toBe(true);
			const session = await services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: SYSTEM_ACTOR,
				mode: 'edit',
			});
			expect(
				(await services.sessions.listActiveByProject(project.id)).map(
					(record) => record.session_id,
				),
			).toContain(session.session_id);
			await services.sessions.markFailed(project.id, session.session_id);
			expect(await services.sessions.listActiveByProject(project.id)).toEqual([]);
			expect(
				await storage.metadata.get(paths.session(project.id, session.session_id)),
			).not.toBeNull();
		});
	});
}
