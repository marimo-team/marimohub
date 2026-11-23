import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunId } from '../../ids';
import { paths } from '../../paths';
import { RunTagsSchema, RunMetadataSchema } from '../../schema';
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
		await expect(enqueue({ app: 'calibration' }, id)).rejects.toThrow('response lost');
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

	it('does not expose a deleted run after a delayed publisher and fails closed on corrupt attribution', async () => {
		const run = await enqueue({ app: 'calibration' });
		const source = paths
			.project(job.project_id)
			.notebook(job.notebook_id)
			.job(job.id)
			.run(run.run_id).record;
		await env.bucket.delete(source);
		await env.jobRuns.publishProjectRun(run);
		expect((await listing()).items).toEqual([]);
		await env.bucket.put(source, JSON.stringify({ ...run, run_id: createRunId() }));
		await expect(listing()).rejects.toThrow('attribution');
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
	it('supports bounded flat metadata and rejects nested and non-finite values', () => {
		expect(
			RunMetadataSchema.parse({ report: 'https://reports.example/123', score: 1, passed: true }),
		).toEqual({ report: 'https://reports.example/123', score: 1, passed: true });
		for (const value of [null, [], {}, Infinity, 'x'.repeat(1025)])
			expect(RunMetadataSchema.safeParse({ result: value }).success).toBe(false);
	});
});
