import { ForbiddenError } from '../../errors';
import { thumbnailPng } from '../../testing/thumbnail';
import { NotebookMoveSchema } from './notebookMoveRecord';
import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../index';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '../../testing';
import { paths } from '../../paths';
import { searchPaths } from '../../search/paths';
import type { Bucket } from '../../ports/bucket';
import { ProjectId, SandboxId, SessionId } from '../../ids';
import type { NotebookId } from '../../ids';

async function setup() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const from = await services.projects.createProject({ name: 'Source', description: '' }, ACTOR);
	const to = await services.projects.createProject({ name: 'Destination', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		from.id,
		{
			title: 'Analysis',
			description: 'Description',
			code: 'print(1)',
			readme: '# Read me',
			entry_notebook: 'src/app.py',
			workspaceFiles: [{ path: 'data.bin', bytes: new Uint8Array([0, 255, 42]) }],
		},
		ACTOR,
	);
	const input = {
		source: from.id,
		destination: to.id,
		notebookId: notebook.id,
		actor: ACTOR,
		expectedVersion: notebook.updated_at,
		authorize: vi.fn(async () => {}),
	};
	return { bucket, services, from, to, notebook, input };
}

async function moveRecord(bucket: Bucket, nid: NotebookId) {
	const object = await bucket.get(paths.notebookMove(nid));
	return object ? NotebookMoveSchema.parse(await object.json()) : null;
}

/** Interrupts the first copy of the binary workspace file, leaving the move in `copying`. */
function interruptCopy(bucket: MemoryBucket, key: string, error = new Error('copy interrupted')) {
	const put = bucket.put.bind(bucket);
	let failed = false;
	vi.spyOn(bucket, 'put').mockImplementation(async (target, bytes, options) => {
		if (!failed && target === key) {
			failed = true;
			throw error;
		}
		return put(target, bytes, options);
	});
}

describe('NotebookMoveService', () => {
	it('retries both search refreshes after a completion-side refresh failure', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const put = bucket.put.bind(bucket);
		let fail = true;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, bytes, options) => {
			if (key === searchPaths.refresh(to.id) && fail) {
				fail = false;
				throw new Error('refresh interrupted');
			}
			return put(key, bytes, options);
		});
		await expect(services.moves.move(input)).rejects.toThrow('refresh interrupted');
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
		expect(await moveRecord(bucket, notebook.id)).toMatchObject({
			phase: 'complete',
			search_refreshed: false,
		});
		await services.moves.move(input);
		expect(await moveRecord(bucket, notebook.id)).toMatchObject({
			phase: 'complete',
			search_refreshed: true,
		});
		expect(await (await bucket.get(searchPaths.refresh(from.id)))!.text()).toBe(
			await (await bucket.get(searchPaths.refresh(to.id)))!.text(),
		);
	});

	it('does not request new crawls when a completed move is replayed', async () => {
		const { bucket, services, from, to, input } = await setup();
		await services.moves.move(input);
		const before = await Promise.all(
			[from, to].map(async (project) =>
				(await bucket.get(searchPaths.refresh(project.id)))!.text(),
			),
		);
		const put = vi.spyOn(bucket, 'put');
		await services.moves.move(input);
		expect(
			put.mock.calls.filter(
				([key]) => key === searchPaths.refresh(from.id) || key === searchPaths.refresh(to.id),
			),
		).toEqual([]);
		expect(
			await Promise.all(
				[from, to].map(async (project) =>
					(await bucket.get(searchPaths.refresh(project.id)))!.text(),
				),
			),
		).toEqual(before);
	});

	it.each(['committed', 'pending'] as const)(
		'releases the notebook when the copying-phase write loses its %s response',
		async (outcome) => {
			const { bucket, services, from, to, notebook, input } = await setup();
			const put = bucket.put.bind(bucket);
			let failed = false;
			let lateWrite: (() => ReturnType<typeof put>) | undefined;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, bytes, options) => {
				if (
					!failed &&
					key === paths.notebookMove(notebook.id) &&
					typeof bytes === 'string' &&
					NotebookMoveSchema.parse(JSON.parse(bytes)).phase === 'copying'
				) {
					failed = true;
					if (outcome === 'committed') await put(key, bytes, options);
					else lateWrite = () => put(key, bytes, options);
					throw new Error('phase response lost');
				}
				return put(key, bytes, options);
			});
			await expect(services.moves.move(input)).rejects.toThrow('phase response lost');
			expect(await moveRecord(bucket, notebook.id)).toBeNull();
			expect((await services.notebooks.getNotebook(from.id, notebook.id)).meta.move_id).toBe(
				undefined,
			);
			if (lateWrite)
				await expect(lateWrite()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
			await expect(services.moves.move(input)).resolves.toMatchObject({ project_id: to.id });
			expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
		},
	);

	it('rejects a move to the same project without changing the notebook', async () => {
		const { services, from, notebook, input } = await setup();
		const before = await services.catalog.getCurrentSnapshot();
		await expect(services.moves.move({ ...input, destination: from.id })).rejects.toMatchObject({
			code: 'CONFLICT',
		});
		expect(await services.catalog.getCurrentSnapshot()).toEqual(before);
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
	});

	it('refuses a second destination while a move is pending', async () => {
		const { bucket, services, to, notebook, input } = await setup();
		const third = await services.projects.createProject({ name: 'Third', description: '' }, ACTOR);
		interruptCopy(bucket, paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin'));
		await expect(services.moves.move(input)).rejects.toThrow('copy interrupted');
		await expect(services.moves.move({ ...input, destination: third.id })).rejects.toThrow(
			'in progress',
		);
		expect(await services.notebooks.listNotebooks(third.id)).toEqual([]);
		await expect(services.moves.move(input)).resolves.toMatchObject({ project_id: to.id });
	});

	it('hides the notebook from readers and writers in both projects while copying', async () => {
		const { services, from, to, notebook, input } = await setup();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const copy = services.notebooks.thumbnails.copyForMove.bind(services.notebooks.thumbnails);
		vi.spyOn(services.notebooks.thumbnails, 'copyForMove').mockImplementationOnce(
			async (...args) => {
				entered.resolve();
				await resume.promise;
				return copy(...args);
			},
		);
		const moving = services.moves.move(input);
		await entered.promise;
		try {
			await expect(services.moves.move(input)).rejects.toThrow('already running');
			for (const project of [from, to]) {
				await expect(services.notebooks.getNotebook(project.id, notebook.id)).rejects.toMatchObject(
					{ code: 'NOT_FOUND' },
				);
				await expect(
					services.notebooks.updateNotebook(project.id, notebook.id, { code: 'print(9)' }, ACTOR),
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
			}
			// Project settings stay editable; only the notebook in transit is fenced.
			await services.projects.updateProject(from.id, { description: 'Edited' }, ACTOR);
		} finally {
			resume.resolve();
			await moving;
		}
		expect(await services.notebooks.listNotebooks(to.id)).toHaveLength(1);
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
	});

	it('rechecks authorization before publication and resumes only after authorization is restored', async () => {
		const { services, from, to, notebook, input } = await setup();
		const before = await services.catalog.getCurrentSnapshot();
		input.authorize
			.mockResolvedValueOnce()
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(new ForbiddenError('Access revoked'));
		await expect(services.moves.move(input)).rejects.toThrow('Access revoked');
		expect(await services.catalog.getCurrentSnapshot()).toEqual(before);
		for (const project of [from, to]) {
			await expect(services.notebooks.getNotebook(project.id, notebook.id)).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
		}
		input.authorize.mockRejectedValueOnce(new ForbiddenError('Access still revoked'));
		await expect(services.moves.move(input)).rejects.toThrow('Access still revoked');
		await expect(services.moves.move(input)).resolves.toMatchObject({ project_id: to.id });
	});

	it('blocks both active jobs and terminal runs awaiting finalization', async () => {
		const { services, from, to, notebook, input } = await setup();
		const job = await services.jobs.createJob(
			from.id,
			notebook.id,
			{ name: 'Daily', enabled: true },
			ACTOR,
		);
		const run = await services.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		await expect(services.moves.move(input)).rejects.toThrow('jobs and their finalization');
		await services.jobRuns.transition(run, 'provision');
		await services.jobRuns.transition(run, 'start');
		await services.jobRuns.transition(run, 'succeed', () => ({ exit_code: 0 }));
		await expect(services.moves.move(input)).rejects.toThrow('jobs and their finalization');
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
		await services.jobRuns.deleteMarker(run);
		await services.moves.move(input);
		expect(await services.jobRuns.getRun(to.id, notebook.id, job.id, run.run_id)).toMatchObject({
			status: 'succeeded',
		});
	});

	it('requires snapshot cleanup and resumes cleanup after source objects have been deleted', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const snapshot = { snapshot_id: 'snapshot-1', captured_at: new Date().toISOString() };
		await services.notebooks.setFsSnapshot(from.id, notebook.id, snapshot);
		await expect(services.moves.move(input)).rejects.toThrow('snapshot cleanup is unavailable');
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
		const reclaimSnapshot = vi
			.fn(async () => {})
			.mockRejectedValueOnce(new Error('cleanup unavailable'));
		await expect(services.moves.move({ ...input, reclaimSnapshot })).rejects.toThrow(
			'cleanup unavailable',
		);
		expect(await bucket.get(paths.project(from.id).notebook(notebook.id).meta)).toBeNull();
		// Publication already happened, so the destination serves the notebook during cleanup.
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
		await services.moves.move({ ...input, reclaimSnapshot });
		expect(reclaimSnapshot).toHaveBeenCalledTimes(2);
		expect(reclaimSnapshot).toHaveBeenLastCalledWith(snapshot);
		expect(await services.notebooks.getFsSnapshot(to.id, notebook.id)).toBeNull();
		const catalog = await services.catalog.getCurrentSnapshot();
		expect(catalog.projects.find((p) => p.id === from.id)?.notebook_count).toBe(0);
		expect(catalog.projects.find((p) => p.id === to.id)?.notebook_count).toBe(1);
	});

	it('refuses mismatched bytes when resuming a partially copied notebook', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const key = paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin');
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (target, bytes, options) => {
			if (target === key && !(await bucket.get(key))) {
				await put(key, 'different bytes');
				throw new Error('copy interrupted');
			}
			return put(target, bytes, options);
		});
		await expect(services.moves.move(input)).rejects.toThrow('copy interrupted');
		await expect(services.moves.move(input)).rejects.toThrow('destination contains different data');
		expect(await (await bucket.get(key))!.text()).toBe('different bytes');
		expect(
			await (await bucket.get(
				paths.project(from.id).notebook(notebook.id).workspaceFile('data.bin'),
			))!.bytes(),
		).toEqual(new Uint8Array([0, 255, 42]));
		expect(
			(await services.catalog.getCurrentSnapshot()).projects.find((p) => p.id === from.id)
				?.notebook_count,
		).toBe(1);
	});

	it('preserves identity, binary files, history, jobs and app slugs, and updates both catalog entries', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		await services.notebooks.updateNotebook(from.id, notebook.id, { code: 'print(2)' }, ACTOR);
		const before = await services.notebooks.getNotebook(from.id, notebook.id);
		const versions = await services.notebooks.listVersions(from.id, notebook.id);
		const job = await services.jobs.createJob(
			from.id,
			notebook.id,
			{ name: 'Daily', enabled: true },
			ACTOR,
		);
		const thumbnail = await services.notebooks.thumbnails.setCustom(
			from.id,
			notebook.id,
			thumbnailPng(),
		);
		const run = await services.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		await services.jobRuns.transition(run, 'provision');
		await services.jobRuns.transition(run, 'start');
		const output = await services.jobRuns.putOutputs(run, {
			html: '<html>Results</html>',
			logs: 'done',
		});
		await services.jobRuns.transition(run, 'succeed', () => ({ output, exit_code: 0 }));
		await services.jobRuns.deleteMarker(run);
		await services.deepLinks.register(
			'analysis',
			{ kind: 'app', project_id: from.id, notebook_id: notebook.id },
			ACTOR,
		);
		const result = await services.moves.move({ ...input, expectedVersion: before.meta.updated_at });
		expect(result).toMatchObject({
			id: notebook.id,
			project_id: to.id,
			author: notebook.author,
			created_at: notebook.created_at,
		});
		expect(result).not.toHaveProperty('move_id');
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(2)');
		expect((await services.notebooks.getNotebook(to.id, notebook.id)).readme).toBe('# Read me');
		expect(await services.notebooks.listVersions(to.id, notebook.id)).toEqual(versions);
		expect(
			await (await bucket.get(
				paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin'),
			))!.bytes(),
		).toEqual(new Uint8Array([0, 255, 42]));
		expect(await services.jobs.getJob(to.id, notebook.id, job.id)).toMatchObject({
			id: job.id,
			project_id: to.id,
			enabled: true,
		});
		expect((await services.deepLinks.resolve('analysis')).target.project_id).toBe(to.id);
		expect(await services.notebooks.thumbnails.metadata(to.id, notebook.id)).toEqual(thumbnail);
		const movedRun = await services.jobRuns.getRun(to.id, notebook.id, job.id, run.run_id);
		expect(movedRun).toMatchObject({ project_id: to.id, status: 'succeeded', output });
		expect(await services.jobRuns.readHtml(movedRun)).toBe('<html>Results</html>');
		expect(await services.jobRuns.readLogs(movedRun)).toBe('done');
		await expect(services.notebooks.getNotebook(from.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
		const snapshot = await services.catalog.getCurrentSnapshot();
		expect(snapshot.projects.find((p) => p.id === from.id)).toMatchObject({
			notebook_count: 0,
			notebooks: [],
		});
		expect(snapshot.projects.find((p) => p.id === to.id)).toMatchObject({
			notebook_count: 1,
			notebooks: [{ id: notebook.id, jobs: [{ id: job.id }] }],
		});
	});

	it('replays a completed move without duplicating the notebook and allows a move back', async () => {
		const { services, from, to, notebook, input } = await setup();
		const result = await services.moves.move(input);
		expect(await services.moves.move(input)).toEqual(result);
		await services.moves.move({
			...input,
			source: to.id,
			destination: from.id,
			expectedVersion: result.updated_at,
		});
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
		expect(await services.notebooks.listNotebooks(to.id)).toEqual([]);
	});

	it('refuses a destination collision without overwriting its objects', async () => {
		const { bucket, services, to, notebook, input } = await setup();
		const key = paths.project(to.id).notebook(notebook.id).code;
		await bucket.put(key, 'unrelated');
		await expect(services.moves.move(input)).rejects.toMatchObject({ code: 'CONFLICT' });
		expect(await (await bucket.get(key))!.text()).toBe('unrelated');
	});

	it('rejects active sessions and leaves no record or fence after a preflight rejection', async () => {
		const { bucket, services, from, notebook, input } = await setup();
		const session = await services.sessions.createSession({
			project_id: from.id,
			notebook_id: notebook.id,
			user_id: ACTOR,
		});
		await expect(services.moves.move(input)).rejects.toThrow('Stop notebook');
		expect(await moveRecord(bucket, notebook.id)).toBeNull();
		expect((await services.notebooks.getNotebook(from.id, notebook.id)).meta).not.toHaveProperty(
			'move_id',
		);
		await services.sessions.markFailed(from.id, session.session_id, {
			code: 'FAILED',
			message: 'failed',
		});
		await expect(services.moves.move(input)).resolves.toMatchObject({ id: notebook.id });
	});

	it('rejects stale source writes after completion', async () => {
		const { services, from, notebook, input } = await setup();
		await services.moves.move(input);
		await expect(
			services.notebooks.workspace.write(
				from.id,
				notebook.id,
				'late.txt',
				new Uint8Array([1]),
				ACTOR,
			),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('resumes an interrupted copy while keeping both locations hidden', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		interruptCopy(bucket, paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin'));
		await expect(services.moves.move(input)).rejects.toThrow('copy interrupted');
		for (const project of [from, to]) {
			await expect(services.notebooks.getNotebook(project.id, notebook.id)).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
		}
		await expect(services.moves.move(input)).resolves.toMatchObject({
			id: notebook.id,
			project_id: to.id,
		});
	});

	it('does not double-count a catalog commit whose response was lost', async () => {
		const { bucket, services, to, notebook, input } = await setup();
		const put = bucket.put.bind(bucket);
		let failed = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, bytes, options) => {
			const result = await put(key, bytes, options);
			if (!failed && key === paths.catalog) {
				failed = true;
				throw new Error('lost response');
			}
			return result;
		});
		await expect(services.moves.move(input)).rejects.toThrow('lost response');
		await services.moves.move(input);
		expect(
			(await services.catalog.getCurrentSnapshot()).projects.find((p) => p.id === to.id),
		).toMatchObject({ notebook_count: 1, notebooks: [{ id: notebook.id }] });
	});

	it('takes over a crashed executor once its lease expires', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		interruptCopy(bucket, paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin'));
		await expect(services.moves.move(input)).rejects.toThrow('copy interrupted');
		const key = paths.notebookMove(notebook.id);
		const record = (await moveRecord(bucket, notebook.id))!;
		expect(record).toMatchObject({ phase: 'copying', lease: null });
		const lease = (expires_at: number) =>
			bucket.put(
				key,
				JSON.stringify({ ...record, lease: { executor: 'lost-process', expires_at } }),
			);
		await lease(Date.now() + 60_000);
		await expect(services.moves.move(input)).rejects.toThrow('already running');
		await expect(services.catalog.planRecovery({ mode: 'rebuild' })).rejects.toThrow(
			'pending notebook moves',
		);
		await lease(Date.now() - 1);
		await expect(services.moves.move(input)).resolves.toMatchObject({ project_id: to.id });
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
		await expect(services.notebooks.getNotebook(from.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
		await expect(services.catalog.planRecovery({ mode: 'rebuild' })).resolves.toBeDefined();
	});

	it('cancels an unpublished move and restores the source notebook', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const before = await services.catalog.getCurrentSnapshot();
		await expect(
			services.moves.cancel({ source: from.id, notebookId: notebook.id }),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		interruptCopy(bucket, paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin'));
		await expect(services.moves.move(input)).rejects.toThrow('copy interrupted');
		const record = (await moveRecord(bucket, notebook.id))!;
		await bucket.put(
			paths.notebookMove(notebook.id),
			JSON.stringify({
				...record,
				lease: { executor: 'running', expires_at: Date.now() + 60_000 },
			}),
		);
		await expect(
			services.moves.cancel({ source: from.id, notebookId: notebook.id }),
		).rejects.toThrow('already running');
		await bucket.put(paths.notebookMove(notebook.id), JSON.stringify(record));
		await services.moves.cancel({ source: from.id, notebookId: notebook.id });
		expect(await moveRecord(bucket, notebook.id)).toBeNull();
		expect(await services.catalog.getCurrentSnapshot()).toEqual(before);
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
		expect(
			(await bucket.list({ prefix: `${paths.project(to.id).notebook(notebook.id).base}/` }))
				.objects,
		).toEqual([]);
		await services.notebooks.updateNotebook(from.id, notebook.id, { code: 'print(5)' }, ACTOR);
		const current = await services.notebooks.getNotebook(from.id, notebook.id);
		await expect(
			services.moves.move({ ...input, expectedVersion: current.meta.updated_at }),
		).resolves.toMatchObject({ project_id: to.id });
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(5)');
	});

	it('does not cancel a published move', async () => {
		const { services, from, to, notebook, input } = await setup();
		const reclaimSnapshot = vi.fn(async () => {
			throw new Error('cleanup unavailable');
		});
		await services.notebooks.setFsSnapshot(from.id, notebook.id, {
			snapshot_id: 'snapshot-1',
			captured_at: new Date().toISOString(),
		});
		await expect(services.moves.move({ ...input, reclaimSnapshot })).rejects.toThrow(
			'cleanup unavailable',
		);
		await expect(
			services.moves.cancel({ source: from.id, notebookId: notebook.id }),
		).rejects.toThrow('published');
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
	});

	it('revalidates a notebook that changed after a rejected preflight', async () => {
		const { services, from, notebook, input } = await setup();
		const session = await services.sessions.createSession({
			project_id: from.id,
			notebook_id: notebook.id,
			user_id: ACTOR,
		});
		await expect(services.moves.move(input)).rejects.toThrow('Stop notebook');
		await services.sessions.markFailed(from.id, session.session_id, {
			code: 'FAILED',
			message: 'failed',
		});
		await services.notebooks.updateNotebook(from.id, notebook.id, { code: 'print(3)' }, ACTOR);
		await expect(services.moves.move(input)).rejects.toMatchObject({
			code: 'PRECONDITION_FAILED',
		});
		const current = await services.notebooks.getNotebook(from.id, notebook.id);
		await services.moves.move({ ...input, expectedVersion: current.meta.updated_at });
		expect(await services.notebooks.getNotebookContent(input.destination, notebook.id)).toBe(
			'print(3)',
		);
	});

	it('requires uploads to finish and carries their completed receipts and bytes', async () => {
		const { services, from, to, notebook, input } = await setup();
		const workspace = services.notebooks.workspace;
		const upload = await workspace.startUpload(
			from.id,
			notebook.id,
			{ path: 'upload.bin', size: 3 },
			ACTOR,
		);
		await expect(services.moves.move(input)).rejects.toThrow('Finish or cancel workspace uploads');
		await workspace.putUploadPart(
			from.id,
			notebook.id,
			upload.id,
			1,
			new Uint8Array([1, 2, 3]),
			ACTOR,
		);
		const result = await workspace.completeUpload(from.id, notebook.id, upload.id, ACTOR);
		await services.moves.move(input);
		expect(await workspace.getUpload(to.id, notebook.id, upload.id, ACTOR)).toMatchObject({
			status: 'complete',
		});
		expect(await workspace.completeUpload(to.id, notebook.id, upload.id, ACTOR)).toEqual(result);
	});

	it('authorizes a replay against the live destination notebook', async () => {
		const { services, to, notebook, input } = await setup();
		await services.moves.move(input);
		await services.notebooks.updateNotebook(to.id, notebook.id, { title: 'Renamed' }, ACTOR);
		input.authorize.mockClear();
		await services.moves.move(input);
		expect(input.authorize).toHaveBeenLastCalledWith(
			expect.objectContaining({ notebook: expect.objectContaining({ title: 'Renamed' }) }),
		);
		await services.notebooks.deleteNotebookWithMutation(to.id, notebook.id, ACTOR);
		await expect(services.moves.move(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('rejects metadata that changed between the preflight comparison and the fence', async () => {
		const { services, from, notebook, input } = await setup();
		const ready = services.jobs.assertReadyForMove.bind(services.jobs);
		vi.spyOn(services.jobs, 'assertReadyForMove').mockImplementationOnce(async (pid, nid) => {
			await services.notebooks.updateNotebook(pid, nid, { title: 'Renamed late' }, ACTOR);
			return ready(pid, nid);
		});
		await expect(services.moves.move(input)).rejects.toThrow('Notebook changed');
		const current = await services.notebooks.getNotebook(from.id, notebook.id);
		expect(current.meta).toMatchObject({ title: 'Renamed late' });
		expect(current.meta).not.toHaveProperty('move_id');
		await expect(
			services.moves.move({ ...input, expectedVersion: current.meta.updated_at }),
		).resolves.toMatchObject({ title: 'Renamed late' });
	});

	it('waits for an admitted workspace mutation before copying', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const file = (pid: string) =>
			paths
				.project(pid as typeof from.id)
				.notebook(notebook.id)
				.workspaceFile('data.bin');
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		// An admitted writer that has passed its checks but not yet written its bytes.
		const mutation = services.notebooks.workspace.withMutation(
			from.id,
			notebook.id,
			{},
			async () => {
				entered.resolve();
				await finish.promise;
				await bucket.put(file(from.id), new Uint8Array([7]));
			},
		);
		await entered.promise;
		let moved = false;
		const moving = services.moves.move(input).finally(() => {
			moved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(moved).toBe(false);
		finish.resolve();
		await mutation;
		await moving;
		expect(await (await bucket.get(file(to.id)))!.bytes()).toEqual(new Uint8Array([7]));
	});

	it('stops a stale executor from publishing after its lease was taken over and cancelled', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const before = await services.catalog.getCurrentSnapshot();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const copy = services.notebooks.thumbnails.copyForMove.bind(services.notebooks.thumbnails);
		vi.spyOn(services.notebooks.thumbnails, 'copyForMove').mockImplementationOnce(
			async (...args) => {
				entered.resolve();
				await resume.promise;
				return copy(...args);
			},
		);
		const stale = services.moves.move(input);
		await entered.promise;
		const record = (await moveRecord(bucket, notebook.id))!;
		await bucket.put(
			paths.notebookMove(notebook.id),
			JSON.stringify({ ...record, lease: { ...record.lease, expires_at: Date.now() - 1 } }),
		);
		await services.moves.cancel({ source: from.id, notebookId: notebook.id });
		resume.resolve();
		await expect(stale).rejects.toThrow('ownership changed');
		expect(await services.catalog.getCurrentSnapshot()).toEqual(before);
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
		await expect(services.notebooks.getNotebook(to.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});

	it('refuses to cancel once the catalog shows the publication, even with a lost response', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const put = bucket.put.bind(bucket);
		let failed = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, bytes, options) => {
			const result = await put(key, bytes, options);
			if (!failed && key === paths.catalog) {
				failed = true;
				throw new Error('lost response');
			}
			return result;
		});
		await expect(services.moves.move(input)).rejects.toThrow('lost response');
		expect(await moveRecord(bucket, notebook.id)).toMatchObject({ phase: 'copying' });
		await expect(
			services.moves.cancel({ source: from.id, notebookId: notebook.id }),
		).rejects.toThrow('published');
		await services.moves.move(input);
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
	});

	it('keeps destination app pool members admitted before a cleanup retry', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const reclaimSnapshot = vi
			.fn(async () => {})
			.mockRejectedValueOnce(new Error('cleanup unavailable'));
		await services.notebooks.setFsSnapshot(from.id, notebook.id, {
			snapshot_id: 'snapshot-1',
			captured_at: new Date().toISOString(),
		});
		await expect(services.moves.move({ ...input, reclaimSnapshot })).rejects.toThrow(
			'cleanup unavailable',
		);
		const key = paths.appPool(to.id, notebook.id);
		const pool = await (await bucket.get(key))!.json<Record<string, unknown>>();
		expect(pool).not.toHaveProperty('deleted_at');
		const member = {
			session_id: SessionId.create(),
			sandbox_id: SandboxId.create(),
			user_id: ACTOR,
			state: 'ready',
			created_at: Date.now(),
			operation_token: 'token',
			operation_expires_at: Date.now() + 60_000,
		};
		await bucket.put(key, JSON.stringify({ ...pool, members: [member] }));
		await services.moves.move({ ...input, reclaimSnapshot });
		expect(await (await bucket.get(key))!.json()).toMatchObject({ members: [member] });
	});

	it('rejects a deleted notebook, a missing destination, and a notebook without a source record', async () => {
		const { bucket, services, from, notebook, input } = await setup();
		await expect(
			services.moves.move({ ...input, destination: ProjectId.create() }),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await bucket.delete([paths.project(from.id).notebook(notebook.id).source]);
		await expect(services.moves.move(input)).rejects.toThrow('Notebook source not found');
		const second = await services.notebooks.createNotebook(
			from.id,
			{ title: 'Second', description: '', code: 'print(2)' },
			ACTOR,
		);
		await services.notebooks.deleteNotebookWithMutation(from.id, second.id, ACTOR);
		await expect(
			services.moves.move({ ...input, notebookId: second.id, expectedVersion: undefined }),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		expect(await moveRecord(bucket, second.id)).toBeNull();
	});

	it('cannot publish into a destination deleted mid-copy, and cancel restores the source', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const before = await services.catalog.getCurrentSnapshot();
		const copy = services.notebooks.thumbnails.copyForMove.bind(services.notebooks.thumbnails);
		vi.spyOn(services.notebooks.thumbnails, 'copyForMove').mockImplementationOnce(
			async (...args) => {
				await services.projects.deleteProject(to.id, ACTOR);
				return copy(...args);
			},
		);
		await expect(services.moves.move(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		expect(await moveRecord(bucket, notebook.id)).toMatchObject({ phase: 'copying', lease: null });
		await expect(services.moves.move(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await services.moves.cancel({ source: from.id, notebookId: notebook.id });
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
		const after = await services.catalog.getCurrentSnapshot();
		expect(after.projects.find((p) => p.id === from.id)).toEqual(
			before.projects.find((p) => p.id === from.id),
		);
	});

	it('lets a different actor resume with the original precondition only', async () => {
		const { bucket, services, to, notebook, input } = await setup();
		interruptCopy(bucket, paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin'));
		await expect(services.moves.move(input)).rejects.toThrow('copy interrupted');
		const other = { ...input, actor: 'someone-else' as typeof ACTOR };
		await expect(services.moves.move({ ...other, expectedVersion: 'stale' })).rejects.toMatchObject(
			{ code: 'PRECONDITION_FAILED' },
		);
		await expect(services.moves.move(other)).resolves.toMatchObject({ project_id: to.id });
		expect(await moveRecord(bucket, notebook.id)).toMatchObject({
			phase: 'complete',
			actor: ACTOR,
		});
	});

	it('does not release a move whose lease was taken over during preflight', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const ready = services.sessions.assertReadyForMove.bind(services.sessions);
		vi.spyOn(services.sessions, 'assertReadyForMove').mockImplementationOnce(async (...args) => {
			entered.resolve();
			await resume.promise;
			return ready(...args);
		});
		const paused = services.moves.move(input);
		await entered.promise;
		const record = (await moveRecord(bucket, notebook.id))!;
		await bucket.put(
			paths.notebookMove(notebook.id),
			JSON.stringify({ ...record, lease: { ...record.lease, expires_at: Date.now() - 1 } }),
		);
		await expect(services.moves.move(input)).resolves.toMatchObject({ project_id: to.id });
		resume.resolve();
		// The stale executor notices the source is gone or that its save lost ownership.
		await expect(paused).rejects.toMatchObject({ code: 'CONFLICT' });
		expect(await moveRecord(bucket, notebook.id)).toMatchObject({ phase: 'complete' });
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
		await expect(services.notebooks.getNotebook(from.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});

	it('finishes cleanup idempotently after a failure following publication', async () => {
		const { services, from, to, notebook, input } = await setup();
		await services.deepLinks.register(
			'analysis',
			{ kind: 'app', project_id: from.id, notebook_id: notebook.id },
			ACTOR,
		);
		vi.spyOn(services.deepLinks, 'moveNotebook').mockRejectedValueOnce(new Error('link outage'));
		await expect(services.moves.move(input)).rejects.toThrow('link outage');
		expect((await services.deepLinks.resolve('analysis')).target.project_id).toBe(from.id);
		await services.moves.move(input);
		expect((await services.deepLinks.resolve('analysis')).target.project_id).toBe(to.id);
		const today = new Date().toISOString().slice(0, 10);
		const events = (await services.events.getEvents(today)).filter(
			(event) => event.event === 'notebook.move.received',
		);
		expect(events).toHaveLength(1);
		await expect(services.notebooks.getNotebook(from.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});

	it('refuses cancellation from a non-source project and repairs an orphaned fence', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		await expect(
			services.moves.cancel({ source: to.id, notebookId: notebook.id }),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const key = paths.project(from.id).notebook(notebook.id).meta;
		const meta = await (await bucket.get(key))!.json<Record<string, unknown>>();
		await bucket.put(key, JSON.stringify({ ...meta, move_id: 'lost-move' }));
		await expect(services.notebooks.getNotebook(from.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
		await expect(services.moves.move(input)).rejects.toThrow('lost move');
		await services.moves.cancel({ source: from.id, notebookId: notebook.id });
		expect((await services.notebooks.getNotebook(from.id, notebook.id)).meta).not.toHaveProperty(
			'move_id',
		);
		await expect(services.moves.move(input)).resolves.toMatchObject({ project_id: to.id });
	});

	it('moves two notebooks of the same project concurrently', async () => {
		const { services, from, to, notebook, input } = await setup();
		const second = await services.notebooks.createNotebook(
			from.id,
			{ title: 'Second', description: '', code: 'print(2)' },
			ACTOR,
		);
		await Promise.all([
			services.moves.move(input),
			services.moves.move({ ...input, notebookId: second.id, expectedVersion: second.updated_at }),
		]);
		expect((await services.notebooks.listNotebooks(to.id)).map((entry) => entry.id).sort()).toEqual(
			[notebook.id, second.id].sort(),
		);
		expect(await services.notebooks.listNotebooks(from.id)).toEqual([]);
		const snapshot = await services.catalog.getCurrentSnapshot();
		expect(snapshot.projects.find((p) => p.id === from.id)?.notebook_count).toBe(0);
		expect(snapshot.projects.find((p) => p.id === to.id)?.notebook_count).toBe(2);
	});

	it('leaves deep links and thumbnails on the source after a cancelled move', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		await services.deepLinks.register(
			'analysis',
			{ kind: 'app', project_id: from.id, notebook_id: notebook.id },
			ACTOR,
		);
		const thumbnail = await services.notebooks.thumbnails.setCustom(
			from.id,
			notebook.id,
			thumbnailPng(),
		);
		const current = await services.notebooks.getNotebook(from.id, notebook.id);
		interruptCopy(bucket, paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin'));
		await expect(
			services.moves.move({ ...input, expectedVersion: current.meta.updated_at }),
		).rejects.toThrow('copy interrupted');
		await services.moves.cancel({ source: from.id, notebookId: notebook.id });
		expect((await services.deepLinks.resolve('analysis')).target.project_id).toBe(from.id);
		expect(await services.notebooks.thumbnails.metadata(from.id, notebook.id)).toEqual(thumbnail);
		expect(
			(await bucket.list({ prefix: `${paths.project(to.id).notebook(notebook.id).base}/` }))
				.objects,
		).toEqual([]);
		expect(await bucket.get(paths.appPool(from.id, notebook.id))).not.toBeNull();
		expect(
			await (await bucket.get(paths.appPool(from.id, notebook.id)))!.json<{
				deleted_at?: number;
			}>(),
		).not.toHaveProperty('deleted_at');
	});

	it('stops copying when another executor holds the lease, then resumes once it is free', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const before = await services.catalog.getCurrentSnapshot();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const copy = services.notebooks.thumbnails.copyForMove.bind(services.notebooks.thumbnails);
		vi.spyOn(services.notebooks.thumbnails, 'copyForMove').mockImplementationOnce(
			async (...args) => {
				entered.resolve();
				await resume.promise;
				return copy(...args);
			},
		);
		const stale = services.moves.move(input);
		await entered.promise;
		const record = (await moveRecord(bucket, notebook.id))!;
		const key = paths.notebookMove(notebook.id);
		await bucket.put(
			key,
			JSON.stringify({
				...record,
				lease: { executor: 'other', expires_at: Date.now() + 60_000 },
			}),
		);
		resume.resolve();
		await expect(stale).rejects.toThrow('ownership changed');
		expect(await services.catalog.getCurrentSnapshot()).toEqual(before);
		expect(await moveRecord(bucket, notebook.id)).toMatchObject({
			lease: { executor: 'other' },
		});
		await bucket.put(key, JSON.stringify({ ...record, lease: null }));
		await expect(services.moves.move(input)).resolves.toMatchObject({ project_id: to.id });
		await expect(services.notebooks.getNotebook(from.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});
});
