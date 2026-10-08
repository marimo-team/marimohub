import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv, uid, fakeComputeFrom, makeFsSandbox } from '../../testing';
import { makeFolderArchive } from '../../testing/workspaceFixtures';
import { paths } from '../../paths';
import { BadRequestError, ConflictError, ForbiddenError } from '../../errors';
import { ImportId, NotebookId, VersionId } from '../../ids';
import { sha256Hex } from '../../internal/sha256';
import {
	MAX_FOLDER_IMPORT_PATH_BYTES,
	MAX_FOLDER_IMPORT_SEGMENT_BYTES,
} from '../../integrations/workspaceIgnore';
import { listAllKeys, deleteByPrefix } from '../catalog/storage';
import { SandboxProvisioner } from '../runtime/SandboxProvisioner';
import { IMPORT_PURGE_MS, IMPORT_RETENTION_MS } from './NotebookImportService';

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
	const prepared = await env.notebooks.imports.prepare(project.id, makeFolderArchive(files), ACTOR);
	return { ...env, projectId: project.id, importId: prepared.id };
}

let env: Awaited<ReturnType<typeof setup>>;

/** The reported state of one entrypoint; an absent receipt reads as `pending`. */
async function itemState(entry = input.entry_notebook, importId = env.importId) {
	const result = await env.notebooks.imports.get(env.projectId, importId, ACTOR);
	return result.notebooks.find((item) => item.entry_notebook === entry) ?? { state: 'pending' };
}
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
			makeFolderArchive({ [entry_notebook]: encode('import marimo') }),
			ACTOR,
		);
		const args = { title: 'Report', entry_notebook };
		const notebook = await notebooks.imports.publish(projectId, prepared.id, args, ACTOR);
		expect((await notebooks.getNotebook(projectId, notebook.id)).source.entry_notebook).toBe(
			entry_notebook,
		);
		expect(await notebooks.getNotebookContent(projectId, notebook.id)).toBe('import marimo');
		expect(await itemState(entry_notebook, prepared.id)).toMatchObject({
			state: 'complete',
			notebook: { id: notebook.id },
		});
		expect((await notebooks.imports.publish(projectId, prepared.id, args, ACTOR)).id).toBe(
			notebook.id,
		);
	});

	it('rejects oversized UTF-8 paths before writing an import snapshot', async () => {
		const { notebooks, projectId, bucket } = env;
		const prefix = `projects/${projectId}/imports/`;
		const before = await listAllKeys(bucket, prefix);
		await expect(
			notebooks.imports.prepare(
				projectId,
				makeFolderArchive({ ['é'.repeat(MAX_FOLDER_IMPORT_PATH_BYTES / 2 + 1)]: encode('data') }),
				ACTOR,
			),
		).rejects.toThrow(`${MAX_FOLDER_IMPORT_PATH_BYTES} UTF-8 bytes`);
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
			const prepared = await notebooks.imports.prepare(
				projectId,
				makeFolderArchive(contents),
				ACTOR,
			);
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
		await expect(
			notebooks.imports.prepare(projectId, makeFolderArchive(contents), ACTOR),
		).rejects.toThrow(
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
		await expect(
			notebooks.imports.prepare(projectId, makeFolderArchive(contents), ACTOR),
		).rejects.toThrow('Archive exceeds the 1000-file limit');
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
		expect((await itemState()).state).toBe('publishing');
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
		expect((await itemState()).state).toBe('complete');
	});

	it('fences a stalled attempt and stops its writes after replacement', async () => {
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
		expect(await listAllKeys(bucket, `projects/${projectId}/notebooks/${orphanId}/`)).toHaveLength(
			0,
		);
		await notebooks.imports.sweep(projectId);
		expect(await listAllKeys(bucket, `projects/${projectId}/notebooks/${orphanId}/`)).toHaveLength(
			0,
		);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: winner.id }]);
	});

	it('reclaims a storage write that finishes after its attempt was replaced and swept', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		const started = deferred();
		const releaseWrite = deferred();
		const written = deferred();
		const releaseResponse = deferred();
		const put = bucket.put.bind(bucket);
		let lateKey = '';
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			if (!lateKey && args[0].endsWith('/workspace/data/raw.bin')) {
				lateKey = args[0];
				started.resolve();
				await releaseWrite.promise;
				const result = await put(...args);
				written.resolve();
				await releaseResponse.promise;
				return result;
			}
			return put(...args);
		});
		const stalled = notebooks.imports
			.publish(projectId, importId, input, ACTOR)
			.catch((error: unknown) => error);
		await started.promise;
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
		const winner = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS + 2 * 60 * 60_000);
		await notebooks.imports.sweep(projectId);
		expect(await bucket.head(lateKey)).toBeNull();
		releaseWrite.resolve();
		await written.promise;
		expect(await bucket.head(lateKey)).not.toBeNull();
		await notebooks.imports.sweep(projectId);
		expect(await bucket.head(lateKey)).toBeNull();
		releaseResponse.resolve();
		expect(await stalled).toBeInstanceOf(Error);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: winner.id }]);
	});

	it('renews the lease while workspace writes make progress beyond the initial lease', async () => {
		const { notebooks, projectId, bucket } = env;
		const prepared = await notebooks.imports.prepare(
			projectId,
			makeFolderArchive({
				...files,
				...Object.fromEntries(
					Array.from({ length: 50 }, (_, index) => [`data/${index}.txt`, encode('x')]),
				),
			}),
			ACTOR,
		);
		const started = Date.now();
		let now = started;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const put = bucket.put.bind(bucket);
		let checkedConcurrentRetry = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			if (args[0].includes('/workspace/')) {
				now += 30_000;
				if (!checkedConcurrentRetry && now > started + 11 * 60_000) {
					checkedConcurrentRetry = true;
					await expect(
						notebooks.imports.publish(projectId, prepared.id, input, ACTOR),
					).rejects.toThrow('still in progress');
				}
			}
			return put(...args);
		});
		const notebook = await notebooks.imports.publish(projectId, prepared.id, input, ACTOR);
		expect(checkedConcurrentRetry).toBe(true);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: notebook.id }]);
		const receipt = await bucket.get(
			paths
				.project(projectId)
				.notebookImport(ImportId.parse(prepared.id))
				.item(await sha256Hex(input.entry_notebook)),
		);
		expect(JSON.parse(await receipt!.text())).toMatchObject({
			state: 'complete',
			attempts: [notebook.id],
		});
	});

	it('cleans abandoned workspaces and later items when publication reconciliation keeps failing', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		const primaryInput = { title: 'Forecast', entry_notebook: 'reports/forecast.py' };
		const stage = notebooks.stageImportNotebook.bind(notebooks);
		const abandoned: string[] = [];
		const failAfterStaging = async (...args: Parameters<typeof stage>) => {
			abandoned.push(args[1]);
			await stage(...args);
			throw new Error('interrupted after staging');
		};
		const stageSpy = vi
			.spyOn(notebooks, 'stageImportNotebook')
			.mockImplementationOnce(failAfterStaging);
		await expect(
			notebooks.imports.publish(projectId, importId, primaryInput, ACTOR),
		).rejects.toThrow('interrupted after staging');
		const publishSpy = vi
			.spyOn(notebooks, 'publishImportNotebook')
			.mockRejectedValue(new ConflictError('Write conflict: max retries exceeded'));
		await expect(
			notebooks.imports.publish(projectId, importId, primaryInput, ACTOR),
		).rejects.toThrow('max retries');
		const fencedId = publishSpy.mock.calls[0][1];
		stageSpy.mockImplementationOnce(failAfterStaging);
		await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow(
			'interrupted after staging',
		);
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + IMPORT_RETENTION_MS + 2 * 60 * 60 * 1000);
		await notebooks.imports.sweep(projectId);
		for (const id of abandoned)
			expect(await listAllKeys(bucket, `projects/${projectId}/notebooks/${id}/`)).toHaveLength(0);
		expect(await bucket.head(paths.project(projectId).notebook(fencedId).meta)).not.toBeNull();
		expect(await bucket.head(`projects/${projectId}/imports/${importId}/snapshot.zip`)).toBeNull();
		expect(errorLog).toHaveBeenCalledWith(
			expect.stringContaining('notebook_import_publish_retry_failed'),
		);
		publishSpy.mockRestore();
		await notebooks.imports.sweep(projectId);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: fencedId }]);
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
		).rejects.toMatchObject({
			code: 'IMPORT_RESTART_REQUIRED',
			message: 'Import identity already has different notebook settings',
		});
		await expect(notebooks.imports.get(projectId, importId, uid('other'))).rejects.toThrow(
			'not found',
		);
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
		).rejects.toMatchObject({
			code: 'IMPORT_RESTART_REQUIRED',
			message: 'Import expired; choose the folder again',
		});
	});

	it('keeps an active attempt preparing across snapshot expiry and allows it to finish', async () => {
		const { notebooks, projectId, importId } = env;
		const started = deferred();
		const release = deferred();
		const stage = notebooks.stageImportNotebook.bind(notebooks);
		vi.spyOn(notebooks, 'stageImportNotebook').mockImplementationOnce(async (...args) => {
			started.resolve();
			await release.promise;
			return stage(...args);
		});
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS - 60_000);
		const publishing = notebooks.imports.publish(projectId, importId, input, ACTOR);
		await started.promise;
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS + 60_000);
		expect(await itemState()).toMatchObject({ state: 'preparing' });
		await expect(
			notebooks.imports.publish(projectId, importId, input, ACTOR),
		).rejects.toMatchObject({ code: 'CONFLICT' });
		release.resolve();
		const notebook = await publishing;
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: notebook.id }]);
	});

	it('fences a stale attempt before reporting expiry so resumed staging cannot publish', async () => {
		const { notebooks, projectId, importId } = env;
		const started = deferred();
		const release = deferred();
		const stage = notebooks.stageImportNotebook.bind(notebooks);
		vi.spyOn(notebooks, 'stageImportNotebook').mockImplementationOnce(async (...args) => {
			started.resolve();
			await release.promise;
			return stage(...args);
		});
		const now = Date.now();
		const stalled = notebooks.imports
			.publish(projectId, importId, input, ACTOR)
			.catch((error: unknown) => error);
		await started.promise;
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS + 60_000);
		expect(await itemState()).toMatchObject({ state: 'pending' });
		await expect(
			notebooks.imports.publish(projectId, importId, input, ACTOR),
		).rejects.toMatchObject({ code: 'IMPORT_RESTART_REQUIRED' });
		expect(await itemState()).toMatchObject({ state: 'expired' });
		release.resolve();
		expect(await stalled).toBeInstanceOf(ConflictError);
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
	});

	it('fences a delayed initial claim when an unused import expires', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		const started = deferred();
		const release = deferred();
		const put = bucket.put.bind(bucket);
		let delayed = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			if (!delayed && args[0].includes(`/imports/${importId}/items/`)) {
				delayed = true;
				started.resolve();
				await release.promise;
			}
			return put(...args);
		});
		const now = Date.now();
		const stalled = notebooks.imports
			.publish(projectId, importId, input, ACTOR)
			.catch((error: unknown) => error);
		await started.promise;
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS + 60_000);
		expect(await itemState()).toMatchObject({ state: 'pending' });
		await expect(
			notebooks.imports.publish(projectId, importId, input, ACTOR),
		).rejects.toMatchObject({ code: 'IMPORT_RESTART_REQUIRED' });
		release.resolve();
		expect(await stalled).toMatchObject({ code: 'IMPORT_RESTART_REQUIRED' });
		expect(await itemState()).toMatchObject({ state: 'expired' });
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
		expect(await listAllKeys(bucket, `projects/${projectId}/notebooks/`)).toHaveLength(0);
	});

	it('requires a new import after exhausting the attempt limit', async () => {
		const { notebooks, projectId, importId } = env;
		vi.spyOn(notebooks, 'stageImportNotebook').mockRejectedValue(new Error('Storage unavailable'));
		for (let attempt = 0; attempt < 10; attempt++) {
			await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow(
				'Storage unavailable',
			);
		}
		await expect(
			notebooks.imports.publish(projectId, importId, input, ACTOR),
		).rejects.toMatchObject({
			code: 'IMPORT_RESTART_REQUIRED',
			message: 'Import retry limit reached',
		});
		expect(await itemState()).toMatchObject({ state: 'expired' });
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
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
		expect(await itemState()).toMatchObject({ state: 'pending' });
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
				makeFolderArchive({ ...files, [path]: new Uint8Array([255]) }),
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
				env.notebooks.imports.prepare(
					env.projectId,
					makeFolderArchive({ [path]: encode('x') }),
					ACTOR,
				),
			).rejects.toBeInstanceOf(BadRequestError);
		},
	);

	it.each([
		[{}, 'no included files'],
		[{ data: 'x', 'data/raw.csv': 'y' }, 'File conflicts with directory: data/raw.csv'],
		[
			{ [`data/${'x'.repeat(MAX_FOLDER_IMPORT_SEGMENT_BYTES + 1)}`]: 'x' },
			`${MAX_FOLDER_IMPORT_SEGMENT_BYTES} UTF-8 bytes`,
		],
		[
			{ 'venv/pyvenv.cfg': 'home = /usr', 'venv/lib/mod.py': 'x', 'app.py': 'x' },
			'Exclude generated or Git metadata before importing: venv/',
		],
		[{ 'pyvenv.cfg': 'home = /usr', 'bin/python': 'x', 'app.py': 'x' }, 'is a virtual environment'],
		[
			{ 'env/lib/python3.13/site-packages/pkg.py': 'x', 'app.py': 'x' },
			'Exclude generated or Git metadata before importing: env/lib/python3.13/site-packages/pkg.py',
		],
	] as const)('rejects folder %j without storing a preparation', async (contents, message) => {
		const { notebooks, projectId, bucket } = env;
		const prefix = paths.project(projectId).notebookImportsPrefix;
		const before = await listAllKeys(bucket, prefix);
		const prepared = notebooks.imports.prepare(projectId, makeFolderArchive(contents), ACTOR);
		await expect(prepared).rejects.toBeInstanceOf(BadRequestError);
		await expect(prepared).rejects.toThrow(message);
		expect(await listAllKeys(bucket, prefix)).toEqual(before);
	});

	it('keys receipts by entry hash so long entry paths fit storage key limits', async () => {
		const { notebooks, projectId, bucket } = env;
		const entry_notebook = `${'é'.repeat(120)}/${'d'.repeat(250)}/${'n'.repeat(200)}.py`;
		const prepared = await notebooks.imports.prepare(
			projectId,
			makeFolderArchive({ [entry_notebook]: 'import marimo' }),
			ACTOR,
		);
		const notebook = await notebooks.imports.publish(
			projectId,
			prepared.id,
			{ title: 'Long', entry_notebook },
			ACTOR,
		);
		const keys = await listAllKeys(bucket, paths.project(projectId).notebookImportsPrefix);
		const encoder = new TextEncoder();
		for (const key of keys)
			for (const segment of key.split('/'))
				expect(encoder.encode(segment).byteLength).toBeLessThanOrEqual(255);
		const workspaceKey = paths
			.project(projectId)
			.notebook(notebook.id)
			.version(VersionId.parse('ver_00000000000000000000000000'))
			.workspaceFile(entry_notebook);
		expect(encoder.encode(workspaceKey).byteLength).toBeLessThanOrEqual(1024);
		expect(await itemState(entry_notebook, prepared.id)).toMatchObject({
			state: 'complete',
			notebook: { id: notebook.id },
		});
	});

	it('rejects an entrypoint that is not a notebook file', async () => {
		const { notebooks, projectId, importId } = env;
		await expect(
			notebooks.imports.publish(
				projectId,
				importId,
				{ title: 'Data', entry_notebook: 'data/raw.bin' },
				ACTOR,
			),
		).rejects.toBeInstanceOf(BadRequestError);
		await expect(notebooks.imports.get(projectId, 'not-an-import-id', ACTOR)).rejects.toThrow(
			'Invalid import id',
		);
		expect(await notebooks.listNotebooks(projectId)).toHaveLength(0);
	});

	it('reports every attempted entrypoint with its state and omits untried ones', async () => {
		const { notebooks, projectId, importId } = env;
		const complete = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		vi.spyOn(notebooks, 'publishImportNotebook').mockRejectedValueOnce(new Error('response lost'));
		const forecast = { title: 'Forecast', entry_notebook: 'reports/forecast.py' };
		await expect(notebooks.imports.publish(projectId, importId, forecast, ACTOR)).rejects.toThrow(
			'response lost',
		);
		const result = await notebooks.imports.get(projectId, importId, ACTOR);
		expect(result).toEqual({
			id: importId,
			expires_at: expect.any(String),
			notebooks: [
				{ entry_notebook: 'reports/forecast.py', state: 'publishing' },
				{ entry_notebook: 'reports/revenue.py', state: 'complete', notebook: complete },
			],
		});
	});

	it('requires a restart when the notebook was deleted before a lost publication completed', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		const publish = notebooks.publishImportNotebook.bind(notebooks);
		let notebookId = '';
		vi.spyOn(notebooks, 'publishImportNotebook').mockImplementationOnce(async (...args) => {
			notebookId = (await publish(...args)).id;
			throw new Error('response lost');
		});
		await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow(
			'response lost',
		);
		await notebooks.deleteNotebook(projectId, NotebookId.parse(notebookId), ACTOR);
		await expect(
			notebooks.imports.publish(projectId, importId, input, ACTOR),
		).rejects.toMatchObject({ code: 'IMPORT_RESTART_REQUIRED' });
		expect(await itemState()).toMatchObject({ state: 'expired' });
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + IMPORT_RETENTION_MS + 2 * 60 * 60 * 1000);
		await notebooks.imports.sweep(projectId);
		expect(
			await bucket.head(paths.project(projectId).notebook(NotebookId.parse(notebookId)).meta),
		).not.toBeNull();
	});

	it('purges the whole import once receipts are past the retention horizon', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		const notebook = await notebooks.imports.publish(projectId, importId, input, ACTOR);
		const imp = paths.project(projectId).notebookImport(ImportId.parse(importId));
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS + 2 * 60 * 60 * 1000);
		await notebooks.imports.sweep(projectId);
		expect(await bucket.head(imp.snapshot)).toBeNull();
		expect(await listAllKeys(bucket, imp.itemsPrefix)).toHaveLength(1);
		expect(await bucket.head(imp.preparation)).not.toBeNull();
		vi.spyOn(Date, 'now').mockReturnValue(now + IMPORT_RETENTION_MS + IMPORT_PURGE_MS + 1);
		await notebooks.imports.sweep(projectId);
		expect(await listAllKeys(bucket, imp.base)).toHaveLength(0);
		expect(await notebooks.listNotebooks(projectId)).toMatchObject([{ id: notebook.id }]);
		await expect(notebooks.imports.get(projectId, importId, ACTOR)).rejects.toThrow('not found');
	});

	it('logs and purges a publication that never completed by the retention horizon', async () => {
		const { notebooks, projectId, importId, bucket } = env;
		vi.spyOn(notebooks, 'publishImportNotebook').mockRejectedValue(new Error('unavailable'));
		await expect(notebooks.imports.publish(projectId, importId, input, ACTOR)).rejects.toThrow(
			'unavailable',
		);
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + IMPORT_RETENTION_MS + IMPORT_PURGE_MS + 1);
		await notebooks.imports.sweep(projectId);
		expect(errorLog).toHaveBeenCalledWith(
			expect.stringContaining('notebook_import_publish_abandoned'),
		);
		expect(
			await listAllKeys(
				bucket,
				paths.project(projectId).notebookImport(ImportId.parse(importId)).base,
			),
		).toHaveLength(0);
	});
});
