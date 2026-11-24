import { backgroundMigrations } from '../catalog/migrations';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunId } from '../../ids';
import { paths } from '../../paths';
import { RunTagsSchema } from '../../schema';
import type { JobDefinition, RunTags } from '../../schema';
import { ACTOR, setupTestEnv } from '../../testing';

describe('project run history', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let job: JobDefinition;
	beforeEach(async () => {
		env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'p', description: '' }, ACTOR);
		const notebook = await env.notebooks.createNotebook(
			project.id,
			{ title: 'app', description: '', code: 'v1' },
			ACTOR,
		);
		job = await env.jobs.createJob(project.id, notebook.id, { name: 'job' }, ACTOR);
	});
	const enqueue = async (tags?: RunTags, runId = createRunId()) => {
		const source = (await env.notebooks.getNotebook(job.project_id, job.notebook_id)).source;
		return env.jobRuns.enqueue({
			job,
			runId,
			tags,
			trigger: 'manual',
			triggeredBy: ACTOR,
			timeoutSeconds: 60,
			sourceVersionId: source.type === 'local' ? source.current_version_id : undefined,
		});
	};
	const listing = (key = 'app', value = 'calibration', limit = 10) =>
		env.jobRuns.listProjectRunsPage(job.project_id, limit, undefined, { key, value });

	it('joins versions only by exact supplied tags and reads current state from the canonical run', async () => {
		const first = await enqueue({ app: 'calibration', app_version: 'v1' });
		await env.notebooks.updateNotebook(job.project_id, job.notebook_id, { code: 'v2' }, ACTOR);
		const second = await enqueue({ app: 'calibration', app_version: 'v2' });
		await enqueue({ app: 'other' });
		await enqueue();
		await env.jobRuns.cancel(first, ACTOR);
		const page = await listing();
		expect(page.items.map((run) => run.run_id)).toEqual([second.run_id, first.run_id]);
		expect(page.items[1]?.status).toBe('cancelled');
		expect(first.source_version_id).not.toBe(second.source_version_id);
		expect((await listing('app', 'Calibration')).items).toEqual([]);
		expect((await listing('constructor', 'Object')).items).toEqual([]);
		expect((await env.jobRuns.listProjectRunsPage(job.project_id, 10)).items).toHaveLength(4);
	});

	it('bounds scans, continues empty pages, and preserves deterministic run-ID order', async () => {
		const match = await enqueue({ app: 'calibration' });
		const missing = await enqueue();
		const other = await enqueue({ app: 'other' });
		await env.bucket.delete(
			paths.project(job.project_id).notebook(job.notebook_id).job(job.id).run(missing.run_id)
				.record,
		);
		const get = vi.spyOn(env.bucket, 'get');
		const list = vi.spyOn(env.bucket, 'list');
		const page = await listing('app', 'calibration', 2);
		expect(page.items).toEqual([]);
		expect(page.nextRunId).toBe(missing.run_id);
		expect(list).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledWith({
			prefix: paths.project(job.project_id).runIndexPrefix,
			limit: 2,
		});
		expect(get).toHaveBeenCalledTimes(4);
		get.mockRestore();
		list.mockRestore();
		const last = await env.jobRuns.listProjectRunsPage(job.project_id, 2, page.nextRunId!, {
			key: 'app',
			value: 'calibration',
		});
		expect(last.items.map((run) => run.run_id)).toEqual([match.run_id]);
		expect(last.nextRunId).toBeNull();
		const capped = vi.spyOn(env.bucket, 'list');
		await env.jobRuns.listProjectRunsPage(job.project_id, 9999);
		expect(capped.mock.calls[0]?.[0]?.limit).toBe(500);
		capped.mockRestore();
		expect(other.run_id > match.run_id).toBe(true);
	});

	it('keeps accepted tags through concurrent replay and rejects mutation', async () => {
		const id = createRunId();
		const accepted = await enqueue({ app: 'original' }, id);
		await Promise.all(Array.from({ length: 8 }, () => enqueue({ app: 'replacement' }, id)));
		expect((await listing('app', 'original')).items).toEqual([accepted]);
		expect((await listing('app', 'replacement')).items).toEqual([]);
		await expect(env.jobRuns.transition(accepted, 'cancel', () => ({ tags: {} }))).rejects.toThrow(
			'immutable',
		);
		expect((await listing('app', 'original')).items[0]?.status).toBe('queued');
	});

	it('repairs uncertain index publication and retains the marker when repair fails', async () => {
		const id = createRunId();
		const put = env.bucket.put.bind(env.bucket);
		const fault = vi.spyOn(env.bucket, 'put').mockImplementation(async (key, ...args) => {
			const result = await put(key, ...args);
			if (key.startsWith(paths.project(job.project_id).runIndexPrefix))
				throw new Error('response lost');
			return result;
		});
		expect((await enqueue({ app: 'calibration' }, id)).tags).toEqual({ app: 'calibration' });
		fault.mockRestore();
		const run = await enqueue({ app: 'different' }, id);
		expect(run.tags).toEqual({ app: 'calibration' });
		expect((await listing()).items).toHaveLength(1);
		await env.bucket.delete(paths.project(job.project_id).runIndex(id));
		const repair = vi
			.spyOn(env.jobRuns, 'publishProjectRun')
			.mockRejectedValueOnce(new Error('offline'));
		await expect(env.jobRuns.deleteMarker(run)).rejects.toThrow('offline');
		expect(await env.jobRuns.getMarker(run)).not.toBeNull();
		repair.mockRestore();
		await env.jobRuns.deleteMarker(run);
		expect((await listing()).items).toHaveLength(1);
	});

	it('backfills bounded pages repeatedly without inferring tags, including sparse legacy indexes', async () => {
		const tagged = await enqueue({ app: 'calibration' });
		const legacy = await enqueue();
		const missing = await enqueue();
		const source = paths.project(job.project_id).notebook(job.notebook_id).job(job.id);
		await env.bucket.delete(source.run(missing.run_id).record);
		await env.bucket.delete(
			[tagged, legacy, missing].map((run) => paths.project(job.project_id).runIndex(run.run_id)),
		);
		const first = await env.jobRuns.backfillProjectRuns(job, 1);
		expect(first.items).toEqual([]);
		expect(first.nextRunId).toBe(missing.run_id);
		await env.jobRuns.backfillProjectRuns(job, 1, first.nextRunId!);
		await env.jobRuns.backfillProjectRuns(job, 1, legacy.run_id);
		await env.jobRuns.backfillProjectRuns(job, 10);
		const page = await env.jobRuns.listProjectRunsPage(job.project_id, 10);
		expect(page.items.map((run) => run.run_id)).toEqual([legacy.run_id, tagged.run_id]);
		expect(page.items[0]?.tags).toBeUndefined();
		expect((await listing()).items).toEqual([tagged]);
	});

	it('automatically backfills in bounded migration batches and replays failed batches safely', async () => {
		const run = await enqueue();
		const project = paths.project(job.project_id);
		await env.bucket.delete(project.runIndex(run.run_id));
		for (let i = 0; i < 501; i++)
			await env.bucket.put(`projects/${job.project_id}/a-padding/${i}`, 'ignored');
		const migration = () =>
			backgroundMigrations(env.bucket, env.projects, env.sessions, env.jobRuns).find(
				(entry) => entry.id === 'project-run-index-v1',
			)!;
		const list = vi.spyOn(env.bucket, 'list');
		const first = await migration().runBatch({});
		expect(first.done).toBe(false);
		expect(list).toHaveBeenCalledTimes(1);
		expect(list.mock.calls[0]?.[0]?.limit).toBe(500);
		list.mockRestore();
		if (first.done) throw new Error('Expected continuation');
		const fault = vi
			.spyOn(env.jobRuns, 'publishProjectRun')
			.mockRejectedValueOnce(new Error('offline'));
		await expect(migration().runBatch({ cursor: first.cursor })).rejects.toThrow('offline');
		fault.mockRestore();
		let cursor = first.cursor;
		for (let i = 0; i < 10; i++) {
			const batch = await migration().runBatch({ cursor });
			if (batch.done) break;
			cursor = batch.cursor;
		}
		await migration().runBatch({ cursor: first.cursor });
		expect((await env.jobRuns.listProjectRunsPage(job.project_id, 10)).items).toEqual([run]);
		expect(
			(await env.jobRuns.getRun(job.project_id, job.notebook_id, job.id, run.run_id)).tags,
		).toBeUndefined();
	});

	it('does not expose a deleted run after a delayed publisher and skips bad entries', async () => {
		const kept = await enqueue({ app: 'calibration' });
		const run = await enqueue({ app: 'calibration' });
		const corrupt = await enqueue({ app: 'calibration' });
		const mismatched = await enqueue({ app: 'calibration' });
		const project = paths.project(job.project_id);
		const source = project.notebook(job.notebook_id).job(job.id).run(run.run_id).record;
		await env.bucket.delete(source);
		await env.jobRuns.publishProjectRun(run);
		expect((await listing()).items.map((item) => item.run_id)).not.toContain(run.run_id);
		await env.bucket.put(source, JSON.stringify({ ...run, run_id: createRunId() }));
		await env.bucket.put(project.runIndex(corrupt.run_id), '{not json');
		await env.bucket.put(
			project.runIndex(mismatched.run_id),
			JSON.stringify({ notebook_id: job.notebook_id, job_id: job.id, run_id: kept.run_id }),
		);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const page = await listing();
		expect(page.items.map((item) => item.run_id)).toEqual([kept.run_id]);
		const skipped = errors.mock.calls
			.map(([line]) => JSON.parse(String(line)) as { event: string; object: string })
			.filter((line) => line.event === 'stored_object_skipped')
			.map((line) => line.object)
			.sort();
		expect(skipped).toEqual(
			[source, project.runIndex(corrupt.run_id), project.runIndex(mismatched.run_id)].sort(),
		);
		errors.mockRestore();
	});

	it('moves project locators with the notebook', async () => {
		const run = await enqueue({ app: 'calibration' });
		const destination = await env.projects.createProject({ name: 'q', description: '' }, ACTOR);
		await env.jobRuns.copyForMove(job.project_id, destination.id, job.notebook_id);
		await env.jobRuns.finishMove(job.project_id, job.notebook_id);
		expect((await env.jobRuns.listProjectRunsPage(job.project_id, 10)).items).toEqual([]);
		const moved = await env.jobRuns.listProjectRunsPage(destination.id, 10, undefined, {
			key: 'app',
			value: 'calibration',
		});
		expect(moved.items).toEqual([{ ...run, project_id: destination.id }]);
	});

	it('skips corrupt and misattributed run records during the locator migration', async () => {
		const corrupt = await enqueue();
		const misattributed = await enqueue();
		const valid = await enqueue();
		const project = paths.project(job.project_id);
		const runs = project.notebook(job.notebook_id).job(job.id);
		await env.bucket.put(runs.run(corrupt.run_id).record, '{truncated');
		await env.bucket.put(
			runs.run(misattributed.run_id).record,
			JSON.stringify({ ...misattributed, run_id: createRunId() }),
		);
		await env.bucket.delete(
			[corrupt, misattributed, valid].map((run) => project.runIndex(run.run_id)),
		);
		const migration = backgroundMigrations(
			env.bucket,
			env.projects,
			env.sessions,
			env.jobRuns,
		).find((entry) => entry.id === 'project-run-index-v1')!;
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		let batch = await migration.runBatch({});
		for (let i = 0; i < 10 && !batch.done; i++)
			batch = await migration.runBatch({ cursor: batch.cursor });
		errors.mockRestore();
		expect(batch.done).toBe(true);
		expect(
			(await env.jobRuns.listProjectRunsPage(job.project_id, 10)).items.map((run) => run.run_id),
		).toEqual([valid.run_id]);
	});
});

describe('submission context bounds', () => {
	it.each([
		{ '': 'x' },
		{ ['a'.repeat(65)]: 'x' },
		{ app: 1 },
		{ app: 'x'.repeat(257) },
		Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, 'x'])),
		Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`key${i}`, '😀'.repeat(128)])),
	])('rejects invalid or oversized tags %j', (tags) =>
		expect(RunTagsSchema.safeParse(tags).success).toBe(false),
	);
});
