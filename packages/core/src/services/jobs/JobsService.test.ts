import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
	ValidationError,
} from '../../errors';
import { JobId } from '../../ids';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import { ACTOR, setupTestEnv } from '../../testing';
import { indexedJobs } from './JobsService';

describe('JobsService', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		const notebook = await env.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
	});

	it('creates a definition, indexes it in the snapshot, and lists it', async () => {
		const job = await env.jobs.createJob(
			pid,
			nid,
			{ name: 'nightly', schedule: { cron: '0 6 * * *', timezone: 'Europe/Berlin' } },
			ACTOR,
		);
		expect(job).toMatchObject({
			name: 'nightly',
			enabled: true,
			concurrency_policy: 'forbid',
			created_by: ACTOR,
			project_id: pid,
			notebook_id: nid,
		});
		expect(await env.bucket.head(paths.project(pid).notebook(nid).job(job.id).head)).not.toBeNull();

		const snapshot = await env.catalog.getCurrentSnapshot();
		expect(indexedJobs(snapshot)).toEqual([
			{
				projectId: pid,
				notebookId: nid,
				entry: {
					id: job.id,
					enabled: true,
					schedule: { cron: '0 6 * * *', timezone: 'Europe/Berlin' },
				},
			},
		]);
		expect(await env.jobs.listJobs(pid, nid)).toEqual([job]);
		expect(await env.jobs.getJob(pid, nid, job.id)).toEqual(job);
	});

	it('validates the cron expression, time zone, and timeout ceiling', async () => {
		await expect(
			env.jobs.createJob(
				pid,
				nid,
				{ name: 'x', schedule: { cron: 'bogus', timezone: 'UTC' } },
				ACTOR,
			),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(
			env.jobs.createJob(
				pid,
				nid,
				{ name: 'x', schedule: { cron: '* * * * *', timezone: 'Nowhere/Land' } },
				ACTOR,
			),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(
			env.jobs.createJob(pid, nid, { name: 'x', timeout_seconds: 7200 }, ACTOR, {
				maxTimeoutSeconds: 3600,
			}),
		).rejects.toThrow('MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS');
		expect(await env.jobs.listJobs(pid, nid)).toEqual([]);
	});

	it('enforces the per-notebook definition cap', async () => {
		await env.jobs.createJob(pid, nid, { name: 'one' }, ACTOR, { maxPerNotebook: 1 });
		await expect(
			env.jobs.createJob(pid, nid, { name: 'two' }, ACTOR, { maxPerNotebook: 1 }),
		).rejects.toBeInstanceOf(ResourceExhaustedError);
	});

	it('updates through CAS, clears optional fields with null, and re-indexes', async () => {
		const job = await env.jobs.createJob(
			pid,
			nid,
			{ name: 'nightly', schedule: { cron: '0 6 * * *', timezone: 'UTC' }, timeout_seconds: 600 },
			ACTOR,
		);
		const updated = await env.jobs.updateJob(
			pid,
			nid,
			job.id,
			{
				enabled: false,
				schedule: null,
				timeout_seconds: null,
				retry: { max_retries: 2, backoff_seconds: 30 },
			},
			ACTOR,
			job.updated_at,
		);
		expect(updated.enabled).toBe(false);
		expect(updated.schedule).toBeUndefined();
		expect(updated.timeout_seconds).toBeUndefined();
		expect(updated.retry).toEqual({ max_retries: 2, backoff_seconds: 30 });
		expect(updated.updated_at > job.updated_at).toBe(true);

		const entry = indexedJobs(await env.catalog.getCurrentSnapshot())[0].entry;
		expect(entry).toEqual({ id: job.id, enabled: false });
	});

	it('rejects a stale If-Match version', async () => {
		const job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
		await expect(
			env.jobs.updateJob(pid, nid, job.id, { name: 'renamed' }, ACTOR, '2000-01-01T00:00:00.000Z'),
		).rejects.toBeInstanceOf(PreconditionFailedError);
	});

	it('deletes the whole job subtree and drops the index entry', async () => {
		const job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
		const jobPaths = paths.project(pid).notebook(nid).job(job.id);
		await env.bucket.put(jobPaths.occurrence('20260902T0600Z'), '{}');
		await env.jobs.deleteJob(pid, nid, job.id, ACTOR);
		expect(await env.bucket.head(jobPaths.head)).toBeNull();
		expect(await env.bucket.head(jobPaths.occurrence('20260902T0600Z'))).toBeNull();
		expect(indexedJobs(await env.catalog.getCurrentSnapshot())).toEqual([]);
		await expect(env.jobs.getJob(pid, nid, job.id)).rejects.toThrow('not found');
	});

	it('omits jobs of soft-deleted notebooks from the index view', async () => {
		await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect(indexedJobs(await env.catalog.getCurrentSnapshot())).toEqual([]);
	});

	describe('unhappy paths', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('skips a corrupt definition when listing and logs it', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const good = await env.jobs.createJob(pid, nid, { name: 'good' }, ACTOR);
			await env.bucket.put(paths.project(pid).notebook(nid).job(JobId.create()).head, '{not json');
			await env.bucket.put(
				paths.project(pid).notebook(nid).job(JobId.create()).head,
				JSON.stringify({ id: 'nope' }),
			);
			expect((await env.jobs.listJobs(pid, nid)).map((j) => j.id)).toEqual([good.id]);
			expect(errorSpy).toHaveBeenCalledTimes(2);
			expect(errorSpy.mock.calls[0][0]).toContain('stored_object_skipped');
		});

		it('throws NotFoundError for an unknown job on get, update, and delete', async () => {
			const missing = JobId.create();
			await expect(env.jobs.getJob(pid, nid, missing)).rejects.toBeInstanceOf(NotFoundError);
			await expect(
				env.jobs.updateJob(pid, nid, missing, { name: 'x' }, ACTOR),
			).rejects.toBeInstanceOf(NotFoundError);
			await expect(env.jobs.deleteJob(pid, nid, missing, ACTOR)).rejects.toBeInstanceOf(
				NotFoundError,
			);
		});

		it('does not cap definitions when no limit is configured', async () => {
			for (let i = 0; i < 6; i++) await env.jobs.createJob(pid, nid, { name: `job ${i}` }, ACTOR);
			expect(await env.jobs.listJobs(pid, nid)).toHaveLength(6);
		});

		it('rejects an empty or over-long name at the schema boundary', async () => {
			await expect(env.jobs.createJob(pid, nid, { name: '' }, ACTOR)).rejects.toThrow();
			await expect(
				env.jobs.createJob(pid, nid, { name: 'x'.repeat(121) }, ACTOR),
			).rejects.toThrow();
			expect(await env.jobs.listJobs(pid, nid)).toEqual([]);
		});

		it('validates a new schedule and the timeout ceiling on update', async () => {
			const job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
			await expect(
				env.jobs.updateJob(
					pid,
					nid,
					job.id,
					{ schedule: { cron: '* * *', timezone: 'UTC' } },
					ACTOR,
				),
			).rejects.toBeInstanceOf(ValidationError);
			await expect(
				env.jobs.updateJob(pid, nid, job.id, { timeout_seconds: 9999 }, ACTOR, undefined, {
					maxTimeoutSeconds: 600,
				}),
			).rejects.toBeInstanceOf(ValidationError);
			expect(await env.jobs.getJob(pid, nid, job.id)).toEqual(job);
		});

		it('indexes both of two concurrent creates despite the catalog CAS race', async () => {
			const [a, b] = await Promise.all([
				env.jobs.createJob(pid, nid, { name: 'a' }, ACTOR),
				env.jobs.createJob(pid, nid, { name: 'b' }, ACTOR),
			]);
			const ids = indexedJobs(await env.catalog.getCurrentSnapshot()).map(
				(entry) => entry.entry.id,
			);
			expect(ids.sort()).toEqual([a.id, b.id].sort());
		});

		it('leaves the definition readable when the index write fails', async () => {
			vi.spyOn(env.catalog, 'updateNotebookEntry').mockRejectedValueOnce(new Error('catalog down'));
			await expect(env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR)).rejects.toThrow(
				'catalog down',
			);
			// The head landed before the index; a later update re-syncs it.
			const [job] = await env.jobs.listJobs(pid, nid);
			expect(job.name).toBe('nightly');
			expect(indexedJobs(await env.catalog.getCurrentSnapshot())).toEqual([]);
			await env.jobs.updateJob(pid, nid, job.id, { enabled: false }, ACTOR);
			expect(indexedJobs(await env.catalog.getCurrentSnapshot())).toHaveLength(1);
		});
	});
});
