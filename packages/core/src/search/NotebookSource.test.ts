import { expect, it } from 'vitest';
import { createServices } from '../services';
import { MemoryBucket } from '../testing/MemoryBucket';
import { ACTOR } from '../testing/fixtures';
import { paths } from '../paths';
import { AuthorizationService } from '../services/authorization/AuthorizationService';
import { NotebookSource } from './NotebookSource';

async function setup() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const project = await services.projects.createProject(
		{ name: 'Research', description: '' },
		ACTOR,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Revenue', description: '', code: 'revenue = 42' },
		ACTOR,
	);
	return {
		bucket,
		project,
		notebook,
		source: new NotebookSource(
			bucket,
			services.catalog,
			services.notebooks,
			new AuthorizationService({}),
		),
		keys: paths.project(project.id).notebook(notebook.id),
	};
}

it.each(['meta', 'source'] as const)(
	'reports missing required %s as partial coverage',
	async (kind) => {
		const f = await setup();
		await f.bucket.delete(f.keys[kind]);
		expect(await f.source.page(f.project, undefined, new AbortController().signal)).toMatchObject({
			documents: [],
			partial: true,
		});
	},
);
it.each(['meta', 'source'] as const)(
	'reports oversized required %s as partial coverage',
	async (kind) => {
		const f = await setup();
		await f.bucket.put(f.keys[kind], ' '.repeat(2 * 1024 * 1024 + 1));
		expect(await f.source.page(f.project, undefined, new AbortController().signal)).toMatchObject({
			documents: [],
			partial: true,
		});
	},
);
it('intentionally skips deleted notebooks even when their source has been removed', async () => {
	const f = await setup();
	const meta = await (await f.bucket.get(f.keys.meta))!.json<Record<string, unknown>>();
	await f.bucket.put(f.keys.meta, JSON.stringify({ ...meta, status: 'deleted' }));
	await f.bucket.delete(f.keys.source);
	expect(await f.source.page(f.project, undefined, new AbortController().signal)).toMatchObject({
		documents: [],
		partial: false,
	});
});
