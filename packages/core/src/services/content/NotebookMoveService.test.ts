import { ConflictError, ForbiddenError } from '../../errors';
import { thumbnailPng } from '../../testing/thumbnail';
import { NotebookMoveService } from './NotebookMoveService';
import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../index';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '../../testing';
import { paths } from '../../paths';
import { NotebookMutationGate } from './NotebookMutationGate';

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
		idempotencyKey: 'move-one',
		expectedVersion: notebook.updated_at,
		authorize: vi.fn(async () => {}),
	};
	return { bucket, services, from, to, notebook, input };
}

describe('NotebookMoveService', () => {
	it('rejects a move to the same project without changing the notebook', async () => {
		const { services, from, notebook, input } = await setup();
		const before = await services.catalog.getCurrentSnapshot();
		await expect(services.moves.move({ ...input, destination: from.id })).rejects.toMatchObject({
			code: 'CONFLICT',
		});
		expect(await services.catalog.getCurrentSnapshot()).toEqual(before);
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
	});

	it('rejects reusing a completed request key for a different destination', async () => {
		const { services, to, notebook, input } = await setup();
		const third = await services.projects.createProject({ name: 'Third', description: '' }, ACTOR);
		await services.moves.move(input);
		await expect(services.moves.move({ ...input, destination: third.id })).rejects.toThrow(
			'Idempotency key was used for a different destination',
		);
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
		expect(await services.notebooks.listNotebooks(third.id)).toEqual([]);
	});

	it('excludes concurrent requests and project permission changes while copying', async () => {
		const { services, from, to, notebook, input } = await setup();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const copy = services.notebooks.copyForMove.bind(services.notebooks);
		vi.spyOn(services.notebooks, 'copyForMove').mockImplementationOnce(async (...args) => {
			entered.resolve();
			await resume.promise;
			return copy(...args);
		});
		const moving = services.moves.move(input);
		await entered.promise;
		try {
			await expect(services.moves.move(input)).rejects.toThrow('already running');
			for (const project of [from, to]) {
				await expect(
					services.projects.setSecurityLabels(
						project.id,
						{ classification: 'SECRET', compartments: [] },
						ACTOR,
					),
				).rejects.toMatchObject({ code: 'CONFLICT' });
			}
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
		await expect(services.notebooks.getNotebook(to.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
		await services.moves.move({ ...input, reclaimSnapshot });
		expect(reclaimSnapshot).toHaveBeenCalledTimes(2);
		expect(reclaimSnapshot).toHaveBeenLastCalledWith(snapshot);
		expect(await services.notebooks.getFsSnapshot(to.id, notebook.id)).toBeNull();
		expect(await services.notebooks.getNotebookContent(to.id, notebook.id)).toBe('print(1)');
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
			idempotencyKey: 'move-back',
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

	it('rejects active sessions and releases reservations after a preflight rejection', async () => {
		const { services, from, notebook, input } = await setup();
		const session = await services.sessions.createSession({
			project_id: from.id,
			notebook_id: notebook.id,
			user_id: ACTOR,
		});
		await expect(services.moves.move(input)).rejects.toThrow('Stop notebook');
		expect(await services.notebooks.getNotebookContent(from.id, notebook.id)).toBe('print(1)');
		await services.sessions.markFailed(from.id, session.session_id, {
			code: 'FAILED',
			message: 'failed',
		});
		await expect(services.moves.move(input)).resolves.toMatchObject({ id: notebook.id });
	});

	it('excludes admitted writers and blocks stale source writes after completion', async () => {
		const { bucket, services, from, notebook, input } = await setup();
		await new NotebookMutationGate(bucket).write(from.id, notebook.id, async () => {
			await expect(services.moves.move(input)).rejects.toMatchObject({ code: 'CONFLICT' });
		});
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

	it('resumes an interrupted copy with the same key while keeping both locations hidden', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const put = bucket.put.bind(bucket);
		let failed = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, bytes, options) => {
			if (!failed && key === paths.project(to.id).notebook(notebook.id).workspaceFile('data.bin')) {
				failed = true;
				throw new Error('copy interrupted');
			}
			return put(key, bytes, options);
		});
		await expect(services.moves.move(input)).rejects.toThrow('copy interrupted');
		await expect(services.notebooks.getNotebook(from.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
		await expect(services.notebooks.getNotebook(to.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
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
	it('requires offline recovery for abandoned writers and preserves retirement on failed move-back', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		await expect(
			new NotebookMutationGate(bucket).write(from.id, notebook.id, async () => {
				throw new Error('uncertain write');
			}),
		).rejects.toThrow('uncertain write');
		await expect(services.moves.move(input)).rejects.toMatchObject({ code: 'CONFLICT' });
		await expect(
			NotebookMoveService.recover(bucket, { writersStopped: false as true }),
		).rejects.toThrow('Stop all writers');
		await NotebookMoveService.recover(bucket, { writersStopped: true });
		const moved = await services.moves.move(input);
		await services.sessions.createSession({
			project_id: to.id,
			notebook_id: notebook.id,
			user_id: ACTOR,
		});
		await expect(
			services.moves.move({
				...input,
				source: to.id,
				destination: from.id,
				idempotencyKey: 'back',
				expectedVersion: moved.updated_at,
			}),
		).rejects.toThrow('Stop notebook');
		await expect(
			new NotebookMutationGate(bucket).write(from.id, notebook.id, async () => {}),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('recovers a crashed executor without exposing a partial copy', async () => {
		const { bucket, services, from, to, notebook, input } = await setup();
		const original = services.notebooks.copyForMove.bind(services.notebooks);
		const copy = vi
			.spyOn(services.notebooks, 'copyForMove')
			.mockRejectedValueOnce(new Error('crash'));
		await expect(services.moves.move(input)).rejects.toThrow('crash');
		const key = (await bucket.list({ prefix: paths.notebookMoves })).objects[0].key;
		const record = await (await bucket.get(key))!.json<Record<string, unknown>>();
		await bucket.put(key, JSON.stringify({ ...record, executor: 'lost-process' }));
		await expect(services.moves.move(input)).rejects.toThrow('already running');
		await expect(services.catalog.planRecovery({ mode: 'rebuild' })).rejects.toThrow(
			'pending notebook moves',
		);
		expect(await NotebookMoveService.recover(bucket, { writersStopped: true })).toMatchObject([
			{ source: from.id, destination: to.id, idempotency_key: input.idempotencyKey },
		]);
		await expect(services.notebooks.getNotebook(to.id, notebook.id)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
		copy.mockImplementation(original);
		await services.moves.move(input);
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
	it('waits for sibling storage writes before releasing a failed save admission', async () => {
		const { bucket, services, from, notebook } = await setup();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const put = bucket.put.bind(bucket);
		const nb = paths.project(from.id).notebook(notebook.id);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, bytes, options) => {
			if (key === nb.deps) throw new ConflictError('save failed');
			if (key.startsWith(`${nb.base}/versions/`) && key.endsWith('/notebook.py')) {
				started.resolve();
				await finish.promise;
			}
			return put(key, bytes, options);
		});
		let settled = false;
		const saving = services.notebooks
			.updateNotebook(from.id, notebook.id, { code: 'print(4)' }, ACTOR)
			.catch((error: unknown) => error)
			.finally(() => {
				settled = true;
			});
		await started.promise;
		try {
			await expect(
				new NotebookMutationGate(bucket).claim(from.id, notebook.id, 'move'),
			).rejects.toMatchObject({ code: 'CONFLICT' });
			expect(settled).toBe(false);
		} finally {
			finish.resolve();
		}
		expect(await saving).toBeInstanceOf(ConflictError);
		await new NotebookMutationGate(bucket).claim(from.id, notebook.id, 'move');
	});
});
