import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { ACTOR, setupTestEnv, uid, fakeComputeFrom, makeFsSandbox } from '../../testing';
import { paths } from '../../paths';
import { ConflictError, ForbiddenError } from '../../errors';
import { listAllKeys, deleteByPrefix } from '../catalog/storage';
import { SandboxProvisioner } from '../runtime/SandboxProvisioner';
import { IMPORT_RETENTION_MS } from './NotebookImportService';

const encode = (value: string) => new TextEncoder().encode(value);
const files = {
	'reports/revenue.py': encode('import marimo\nfrom shared.helpers import value\n'),
	'reports/forecast.py': encode('import marimo\n'),
	'notebook.py': encode('SIBLING = True\n'),
	'shared/helpers.py': encode('value = 42\n'),
	'data/raw.bin': new Uint8Array([0, 255, 128, 13, 10]),
	'pyproject.toml': encode('[project]\nname = "analysis"\nversion = "0.1.0"\n'),
	'uv.lock': encode('version = 1\n'),
	'.python-version': encode('3.13\n'),
};
const input = { entry_notebook: 'reports/revenue.py', title: 'Revenue' };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup() {
	const env = await setupTestEnv();
	const project = await env.projects.createProject({ name: 'Import', description: '' }, ACTOR);
	const prepared = await env.notebooks.imports.prepare(project.id, zipSync(files), ACTOR);
	return { ...env, projectId: project.id, importId: prepared.id };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
	env = await setup();
});
afterEach(() => vi.restoreAllMocks());

describe('folder notebook import', () => {
	it('imports a whitespace-containing entrypoint without changing its identity', async () => {
		const { notebooks, projectId } = env;
		const entry_notebook = ' reports / report.py';
		const prepared = await notebooks.imports.prepare(
			projectId,
			zipSync({ [entry_notebook]: encode('import marimo') }),
			ACTOR,
		);
		const args = { title: 'Report', entry_notebook };
		const notebook = await notebooks.imports.publish(projectId, prepared.id, args, ACTOR);
		expect((await notebooks.getNotebook(projectId, notebook.id)).source.entry_notebook).toBe(
			entry_notebook,
		);
		expect(await notebooks.getNotebookContent(projectId, notebook.id)).toBe('import marimo');
		expect(
			await notebooks.imports.status(projectId, prepared.id, entry_notebook, ACTOR),
		).toMatchObject({ state: 'complete', notebook: { id: notebook.id } });
		expect((await notebooks.imports.publish(projectId, prepared.id, args, ACTOR)).id).toBe(
			notebook.id,
		);
	});

	it('rejects oversized UTF-8 paths before writing an import snapshot', async () => {
		const { notebooks, projectId, bucket } = env;
		const prefix = `projects/${projectId}/imports/`;
		const before = await listAllKeys(bucket, prefix);
		await expect(
			notebooks.imports.prepare(projectId, zipSync({ ['é'.repeat(513)]: encode('data') }), ACTOR),
		).rejects.toThrow('1024 UTF-8 bytes');
		expect(await listAllKeys(bucket, prefix)).toEqual(before);
	});

	it('publishes independent complete workspaces with original bytes, paths and entrypoints', async () => {
		const { notebooks, bucket, projectId, importId } = env;
		const one = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		const two = await notebooks.imports.publish(
			projectId,
			importId,
			{ title: 'Forecast', entry_notebook: 'reports/forecast.py' },
			ACTOR,
		);
		expect(one.id).not.toBe(two.id);
		for (const notebook of [one, two]) {
			for (const [path, bytes] of Object.entries(files))
				expect(
					await (
						await bucket.get(paths.project(projectId).notebook(notebook.id).workspaceFile(path))
					)?.bytes(),
				).toEqual(bytes);
		}
		expect((await notebooks.getNotebook(projectId, one.id)).source).toMatchObject({
			type: 'local',
			entry_notebook: input.entry_notebook,
		});
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(2);
		await notebooks.workspace.write(
			projectId,
			one.id,
			'shared/helpers.py',
			encode('value = 10'),
			ACTOR,
		);
		expect(
			await (
				await bucket.get(
					paths.project(projectId).notebook(two.id).workspaceFile('shared/helpers.py'),
				)
			)?.text(),
		).toBe('value = 42\n');
	});

	it.each([false, true])(
		'allows edits at capacity with an uploaded pyproject.toml: %s',
		async (withPyproject) => {
			const { notebooks, projectId } = env;
			const contents = {
				'reports/revenue.py': encode('import marimo'),
				...Object.fromEntries(
					Array.from({ length: 998 }, (_, index) => [`data/${index}.txt`, encode('x')]),
				),
				...(withPyproject ? { 'pyproject.toml': encode('') } : {}),
			};
			const prepared = await notebooks.imports.prepare(projectId, zipSync(contents), ACTOR);
			const notebook = await notebooks.imports.publish(projectId, prepared.id, input, ACTOR);
			expect(await notebooks.listWorkspaceFiles(projectId, notebook.id)).toHaveLength(1000);
			await notebooks.workspace.write(projectId, notebook.id, 'data/0.txt', encode('y'), ACTOR);
			expect(
				(await notebooks.listWorkspaceFiles(projectId, notebook.id)).find(
					(file) => file.path === 'data/0.txt',
				)?.bytes,
			).toEqual(encode('y'));
		},
	);

	it('rejects 1,000 upload files without root pyproject.toml before storing a preparation', async () => {
		const { notebooks, projectId, bucket } = env;
		const contents = Object.fromEntries(
			Array.from({ length: 1000 }, (_, index) => [`data/${index}.txt`, encode('x')]),
		);
		const prefix = `projects/${projectId}/imports/`;
		const before = await listAllKeys(bucket, prefix);
		await expect(notebooks.imports.prepare(projectId, zipSync(contents), ACTOR)).rejects.toThrow(
			'Include at most 999 files; reserve one workspace file for generated pyproject.toml.',
		);
		expect(await listAllKeys(bucket, prefix)).toEqual(before);
	});

	it('reports the archive file limit without a generated-file reservation when pyproject.toml is present', async () => {
		const { notebooks, projectId } = env;
		const contents = {
			'pyproject.toml': encode(''),
			...Object.fromEntries(
				Array.from({ length: 1000 }, (_, index) => [`data/${index}.txt`, encode('x')]),
			),
		};
		await expect(notebooks.imports.prepare(projectId, zipSync(contents), ACTOR)).rejects.toThrow(
			'Archive exceeds the 1000-file limit',
		);
	});

	it('preserves the original entry through save, restore, workspace edit and duplicate', async () => {
		const { notebooks, bucket, projectId, importId } = env;
		const notebook = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		const [version] = await notebooks.listVersions(projectId, notebook.id);
		await notebooks.updateNotebook(projectId, notebook.id, { code: 'saved' }, ACTOR);
		await notebooks.restoreVersion(projectId, notebook.id, version.version_id, ACTOR);
		expect(await notebooks.getNotebookContent(projectId, notebook.id)).toBe(
			new TextDecoder().decode(files['reports/revenue.py']),
		);
		await notebooks.workspace.write(
			projectId,
			notebook.id,
			input.entry_notebook,
			encode('edited'),
			ACTOR,
		);
		expect(await notebooks.getNotebookContent(projectId, notebook.id)).toBe('edited');
		expect(
			await (await bucket.get(paths.project(projectId).notebook(notebook.id).code))?.text(),
		).toBe('SIBLING = True\n');
		const copy = await notebooks.duplicateNotebook(projectId, notebook.id, ACTOR);
		expect(await notebooks.getNotebookContent(projectId, copy.id)).toBe('edited');
		expect((await notebooks.getNotebook(projectId, copy.id)).source).toMatchObject({
			entry_notebook: input.entry_notebook,
		});
		expect(
			await (
				await bucket.get(paths.project(projectId).notebook(copy.id).workspaceFile('data/raw.bin'))
			)?.bytes(),
		).toEqual(files['data/raw.bin']);
	});

	it('protects the entrypoint and its parent directories from moves, deletes and replacement', async () => {
		const { notebooks, projectId, importId } = env;
		const notebook = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		await expect(notebooks.workspace.delete(projectId, notebook.id, 'reports')).rejects.toThrow(
			'cannot be deleted',
		);
		await expect(
			notebooks.workspace.move(projectId, notebook.id, 'reports', 'renamed'),
		).rejects.toThrow('cannot be moved');
		await expect(
			notebooks.workspace.copy(projectId, notebook.id, 'shared', 'reports'),
		).rejects.toThrow('cannot be replaced by a copy');
		await expect(
			notebooks.workspace.createDirectory(projectId, notebook.id, input.entry_notebook),
		).rejects.toThrow();
		await expect(
			notebooks.workspace.createDirectory(projectId, notebook.id, 'reports'),
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			notebooks.workspace.createDirectory(projectId, notebook.id, 'shared'),
		).rejects.toBeInstanceOf(ConflictError);
		expect(await notebooks.getNotebookContent(projectId, notebook.id)).toBe(
			new TextDecoder().decode(files['reports/revenue.py']),
		);
	});

	it('captures nested editor changes without deleting supporting files under source-only deployment defaults', async () => {
		const { notebooks, bucket, projectId, importId } = env;
		const notebook = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		const { instance, fs } = makeFsSandbox();
		for (const [path, bytes] of Object.entries(files)) fs.set(path, bytes);
		fs.set(input.entry_notebook, encode('session edit'));
		fs.set('notebook.py', encode('sibling edit'));
		fs.set('reports/__marimo__/revenue.html', encode('<html>Revenue</html>'));
		fs.set('reports/__marimo__/session/revenue.py.json', encode('{"cells": []}'));
		const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
		await provisioner.captureSession(
			instance,
			notebooks,
			bucket,
			projectId,
			notebook.id,
			ACTOR,
			'source',
		);
		expect(await notebooks.getNotebookContent(projectId, notebook.id)).toBe('session edit');
		const nb = paths.project(projectId).notebook(notebook.id);
		expect(await (await bucket.get(nb.code))?.text()).toBe('sibling edit');
		expect(await (await bucket.get(nb.workspaceFile('data/raw.bin')))?.bytes()).toEqual(
			files['data/raw.bin'],
		);
		const source = (await notebooks.getNotebook(projectId, notebook.id)).source;
		expect(source.entry_notebook).toBe(input.entry_notebook);
		expect(await (await bucket.get(nb.version(source.current_version_id!).html))?.text()).toBe(
			'<html>Revenue</html>',
		);
		expect(await (await bucket.get(nb.version(source.current_version_id!).session))?.text()).toBe(
			'{"cells": []}',
		);
	});

	it('retains supporting files for a root notebook.py import under source-only defaults', async () => {
		const { notebooks, bucket, projectId, importId } = env;
		const notebook = await notebooks.imports.publish(
			projectId,
			importId,
			{ title: 'Root', entry_notebook: 'notebook.py' },
			ACTOR,
		);
		const { instance, fs } = makeFsSandbox();
		for (const [path, bytes] of Object.entries(files)) fs.set(path, bytes);
		fs.set('notebook.py', encode('root session edit'));
		fs.set('shared/helpers.py', encode('value = 100'));
		const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
		await provisioner.captureSession(
			instance,
			notebooks,
			bucket,
			projectId,
			notebook.id,
			ACTOR,
			'source',
		);
		const nb = paths.project(projectId).notebook(notebook.id);
		expect(await notebooks.getNotebookContent(projectId, notebook.id)).toBe('root session edit');
		expect(await (await bucket.get(nb.workspaceFile('shared/helpers.py')))?.text()).toBe(
			'value = 100',
		);
		expect(await (await bucket.get(nb.workspaceFile('data/raw.bin')))?.bytes()).toEqual(
			files['data/raw.bin'],
		);
	});

	it('replays a completed identity without overwriting edits or resurrecting a purged notebook', async () => {
		const { notebooks, bucket, projectId, importId, catalog } = env;
		const first = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		await notebooks.updateNotebook(projectId, first.id, { code: 'changed' }, ACTOR);
		const snapshotId = (await catalog.getCurrentSnapshot()).snapshot_id;
		expect((await notebooks.imports.publish(projectId, importId, input, ACTOR)).id).toBe(first.id);
		expect(await notebooks.getNotebookContent(projectId, first.id)).toBe('changed');
		expect((await catalog.getCurrentSnapshot()).snapshot_id).toBe(snapshotId);
		await deleteByPrefix(bucket, `${paths.project(projectId).notebook(first.id).base}/`);
		expect((await notebooks.imports.publish(projectId, importId, input, ACTOR)).id).toBe(first.id);
		expect(await bucket.head(paths.project(projectId).notebook(first.id).meta)).toBeNull();
	});

	it('reconciles a lost publication response without creating again', async () => {
		const { notebooks, projectId, importId } = env;
		const original = notebooks.publishImportNotebook.bind(notebooks);
		vi.spyOn(notebooks, 'publishImportNotebook').mockImplementationOnce(async (...args) => {
			await original(...args);
			throw new Error('response lost');
		});
		await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow(
			'response lost',
		);
		expect(
			(await notebooks.imports.status(projectId, importId, input.entry_notebook, ACTOR)).state,
		).toBe('publishing');
		const result = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: result.id }]);
	});

	it('maintenance completes an interrupted publication before reclaiming the snapshot', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		vi.spyOn(notebooks, 'publishImportNotebook').mockRejectedValueOnce(
			new Error('publication interrupted'),
		);
		await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow(
			'publication interrupted',
		);
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + IMPORT_RETENTION_MS + 2 * 60 * 60 * 1000);
		await notebooks.imports.sweep(projectId);
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(1);
		expect(await bucket.head(`projects/${projectId}/imports/${importId}/snapshot.zip`)).toBeNull();
		expect(
			(await notebooks.imports.status(projectId, importId, input.entry_notebook, ACTOR)).state,
		).toBe('complete');
	});

	it('fences a stalled attempt with a new identity and cleans late orphan writes on later sweeps', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		const started = deferred();
		const release = deferred();
		const original = notebooks.stageImportNotebook.bind(notebooks);
		let orphanId = '';
		vi.spyOn(notebooks, 'stageImportNotebook').mockImplementationOnce(async (...args) => {
			orphanId = args[1];
			started.resolve();
			await release.promise;
			return original(...args);
		});
		const stalled = notebooks.imports
			.publish(projectId, importId, input, ACTOR)
			.catch((error: unknown) => error);
		await started.promise;
		await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow(
			'still in progress',
		);
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
		const winner = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS + 2 * 60 * 60 * 1000);
		await notebooks.imports.sweep(projectId);
		release.resolve();
		expect(await stalled).toBeInstanceOf(Error);
		expect(
			await listAllKeys(bucket, `projects/${projectId}/notebooks/${orphanId}/`),
		).not.toHaveLength(0);
		await notebooks.imports.sweep(projectId);
		expect(await listAllKeys(bucket, `projects/${projectId}/notebooks/${orphanId}/`)).toHaveLength(
			0,
		);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: winner.id }]);
	});

	it('keeps the catalog empty until every supporting file is written', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		const started = deferred();
		const release = deferred();
		const original = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			if (args[0].endsWith('/workspace/data/raw.bin')) {
				started.resolve();
				await release.promise;
			}
			return original(...args);
		});
		const importing = notebooks.imports.publish(projectId, importId, input, ACTOR);
		await started.promise;
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
		release.resolve();
		await importing;
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(1);
	});

	it('rejects identity changes, cross-user access, missing entrypoints and expired snapshots', async () => {
		const { notebooks, projectId, importId } = env;
		await notebooks.imports.publish(projectId, importId, input, ACTOR);
		await expect(
			notebooks.imports.publish(projectId, importId, { ...input, title: 'Other' }, ACTOR),
		).rejects.toThrow('different notebook settings');
		await expect(
			notebooks.imports.status(projectId, importId, input.entry_notebook, uid('other')),
		).rejects.toThrow('not found');
		await expect(
			notebooks.imports.publish(
				projectId,
				importId,
				{ ...input, entry_notebook: 'missing.py' },
				ACTOR,
			),
		).rejects.toThrow('not included');
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + IMPORT_RETENTION_MS + 1);
		await expect(
			notebooks.imports.publish(
				projectId,
				importId,
				{ ...input, entry_notebook: 'reports/forecast.py' },
				ACTOR,
			),
		).rejects.toThrow('expired');
	});

	it('retries a failed workspace write without publishing partial files', async () => {
		const { notebooks, bucket, projectId, importId } = env;
		const put = bucket.put.bind(bucket);
		let failed = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			if (!failed && args[0].endsWith('/workspace/data/raw.bin')) {
				failed = true;
				throw new Error('Storage unavailable');
			}
			return put(...args);
		});
		await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow();
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
		expect(
			await notebooks.imports.status(projectId, importId, input.entry_notebook, ACTOR),
		).toMatchObject({ state: 'pending' });
		const imported = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: imported.id }]);
		expect(
			await (
				await bucket.get(
					paths.project(projectId).notebook(imported.id).workspaceFile('data/raw.bin'),
				)
			)?.bytes(),
		).toEqual(files['data/raw.bin']);
	});

	it.each(['reports/revenue.py', 'pyproject.toml'])(
		'rejects non-UTF-8 source %s without publication',
		async (path) => {
			const { notebooks, projectId } = env;
			const prepared = await notebooks.imports.prepare(
				projectId,
				zipSync({ ...files, [path]: new Uint8Array([255]) }),
				ACTOR,
			);
			await expect(notebooks.imports.publish(projectId, prepared.id, input, ACTOR)).rejects.toThrow(
				'UTF-8',
			);
			expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
		},
	);

	it.each(['../escape.py', '.git/config', '__pycache__/a.pyc', 'pyproject.toml/file'])(
		'rejects unsupported workspace path %s',
		async (path) => {
			await expect(
				env.notebooks.imports.prepare(env.projectId, zipSync({ [path]: encode('x') }), ACTOR),
			).rejects.toThrow();
		},
	);
});
