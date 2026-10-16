import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../errors';
import { paths } from '../../paths';
import { StoredObjectError } from '../../schema';
import type { ReadConsistency } from './metadataCache';
import { NotebookService } from './NotebookService';
import { ProjectService } from './ProjectService';
import { ACTOR, setupTestEnv } from '../../testing';

async function setup(kind: 'project' | 'notebook', warm = true) {
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
	const read = (options: { consistency?: ReadConsistency } = { consistency: 'validated' }) =>
		kind === 'project'
			? env.projects.getProject(project.id, options)
			: env.notebooks.getNotebookMeta(project.id, notebook.id, options);
	const deleteFromReplica = () =>
		kind === 'project'
			? new ProjectService(env.bucket, env.catalog).deleteProject(project.id, ACTOR)
			: new NotebookService(env.bucket, env.catalog).deleteNotebook(project.id, notebook.id, ACTOR);
	const original = await read(warm ? { consistency: 'validated' } : {});
	return { ...env, project, notebook, key, read, original, deleteFromReplica };
}

describe.each(['project', 'notebook'] as const)('%s metadata cache', (kind) => {
	it('keeps default reads fresh and validates cached reads without downloading again', async () => {
		const { bucket, key, read } = await setup(kind, false);
		const get = vi.spyOn(bucket, 'get');
		const head = vi.spyOn(bucket, 'head');
		await read({});
		await read({});
		expect(get.mock.calls.filter(([requestedKey]) => requestedKey === key)).toHaveLength(2);
		get.mockClear();
		await read();
		expect(head).not.toHaveBeenCalled();
		await read();
		expect(get.mock.calls.filter(([requestedKey]) => requestedKey === key)).toHaveLength(1);
		expect(head).toHaveBeenCalledWith(key);
	});

	it('revalidates a deletion from another replica on the next read', async () => {
		const { read, deleteFromReplica } = await setup(kind);
		await deleteFromReplica();
		expect((await read()).status).toBe('deleted');
	});

	it.each(['head', 'get'] as const)(
		'fails closed when %s fails during revalidation',
		async (method) => {
			const { bucket, read, deleteFromReplica } = await setup(kind);
			await deleteFromReplica();
			vi.spyOn(bucket, method).mockRejectedValueOnce(new Error('storage unavailable'));
			await expect(read()).rejects.toThrow('storage unavailable');
			expect((await read()).status).toBe('deleted');
		},
	);

	it('serves concurrent validated misses and caches the current record', async () => {
		const { bucket, key, read, original } = await setup(kind);
		const updated = { ...original, description: 'Concurrent' };
		await bucket.put(key, JSON.stringify(updated));
		const get = vi.spyOn(bucket, 'get');
		expect(await Promise.all([read(), read()])).toEqual([updated, updated]);
		get.mockClear();
		expect(await read()).toEqual(updated);
		expect(get.mock.calls.filter(([requestedKey]) => requestedKey === key)).toHaveLength(0);
	});

	it.each([false, true])(
		'rejects missing metadata and sees recreation (warm: %s)',
		async (warm) => {
			const { bucket, key, read, original } = await setup(kind, warm);
			await bucket.delete(key);
			await expect(read()).rejects.toThrow(NotFoundError);
			await bucket.put(key, JSON.stringify(original));
			expect(await read()).toEqual(original);
		},
	);

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
