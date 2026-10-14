import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../errors';
import { paths } from '../../paths';
import { StoredObjectError } from '../../schema';
import { ACTOR, setupTestEnv } from '../../testing';

async function setup(kind: 'project' | 'notebook') {
	const env = await setupTestEnv();
	const project = await env.projects.createProject({ name: 'P', description: '' }, ACTOR);
	const notebook = await env.notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: '' },
		ACTOR,
	);
	const key =
		kind === 'project'
			? paths.project(project.id).meta
			: paths.project(project.id).notebook(notebook.id).meta;
	const read = () =>
		kind === 'project'
			? env.projects.getProject(project.id, { consistency: 'validated' })
			: env.notebooks.getNotebookMeta(project.id, notebook.id, { consistency: 'validated' });
	const original = await read();
	return { ...env, project, notebook, key, read, original };
}

describe.each(['project', 'notebook'] as const)('%s metadata cache failures', (kind) => {
	it.each([
		['invalid JSON', '{'],
		['invalid schema', '{}'],
	])('rejects %s repeatedly and recovers after repair', async (_name, corrupt) => {
		const { bucket, key, read, original } = await setup(kind);
		await bucket.put(key, corrupt);
		await expect(read()).rejects.toThrow(StoredObjectError);
		await expect(read()).rejects.toThrow(StoredObjectError);
		const repaired = { ...original, status: 'deleted' as const };
		await bucket.put(key, JSON.stringify(repaired));
		expect(await read()).toEqual(repaired);
	});

	it('rejects deletion between HEAD and GET and sees a recreated record', async () => {
		const { bucket, key, read, original } = await setup(kind);
		const replacement = { ...original, status: 'deleted' as const };
		await bucket.put(key, JSON.stringify(replacement));
		const head = bucket.head.bind(bucket);
		vi.spyOn(bucket, 'head').mockImplementationOnce(async (requestedKey) => {
			const result = await head(requestedKey);
			await bucket.delete(key);
			return result;
		});
		await expect(read()).rejects.toThrow(NotFoundError);
		await bucket.put(key, JSON.stringify(replacement));
		expect(await read()).toEqual(replacement);
	});

	it('revalidates after an older read finishes behind a newer read', async () => {
		const { bucket, key, read, original } = await setup(kind);
		const older = { ...original, description: 'Earlier edit' };
		await bucket.put(key, JSON.stringify(older));
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, 'get').mockImplementationOnce(async (requestedKey) => {
			const object = await get(requestedKey);
			started.resolve();
			await release.promise;
			return object;
		});
		const pending = read();
		const current = { ...older, status: 'deleted' as const };
		try {
			await started.promise;
			await bucket.put(key, JSON.stringify(current));
			expect(await read()).toEqual(current);
		} finally {
			release.resolve();
			await pending;
		}
		expect(await read()).toEqual(current);
	});
});

it('isolates identical notebook IDs in different projects', async () => {
	const { bucket, notebooks, projects, project, notebook, original, read } =
		await setup('notebook');
	const other = await projects.createProject({ name: 'Other', description: '' }, ACTOR);
	const labels = { classification: 'secret', compartments: ['restricted'] };
	await bucket.put(
		paths.project(other.id).notebook(notebook.id).meta,
		JSON.stringify({ ...original, security_labels: labels }),
	);
	expect(
		await notebooks.getSecurityLabels(other.id, notebook.id, { consistency: 'validated' }),
	).toEqual(labels);
	expect(
		await notebooks.getSecurityLabels(project.id, notebook.id, { consistency: 'validated' }),
	).toBeNull();
	await bucket.delete(paths.project(other.id).notebook(notebook.id).meta);
	await expect(
		notebooks.getNotebookMeta(other.id, notebook.id, { consistency: 'validated' }),
	).rejects.toThrow(NotFoundError);
	expect(await read()).toEqual(original);
});
