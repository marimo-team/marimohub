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
					updated_at: job.updated_at,
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

	it('enforces the per-notebook cap across concurrent creates', async () => {
		const results = await Promise.allSettled([
			env.jobs.createJob(pid, nid, { name: 'one' }, ACTOR, { maxPerNotebook: 1 }),
			env.jobs.createJob(pid, nid, { name: 'two' }, ACTOR, { maxPerNotebook: 1 }),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(await env.jobs.listJobs(pid, nid)).toHaveLength(1);
		expect(indexedJobs(await env.catalog.getCurrentSnapshot())).toHaveLength(1);
	});

	it('paginates definitions with a keyset cursor', async () => {
		const created = [];
		for (let index = 0; index < 3; index++) {
			created.push(await env.jobs.createJob(pid, nid, { name: `job ${index}` }, ACTOR));
		}
		const ordered = [...created].sort(
			(a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
		);
		const first = await env.jobs.listJobsPage(pid, nid, 2);
		expect(first.items.map((job) => job.id)).toEqual(ordered.slice(0, 2).map((job) => job.id));
		expect(first.next).not.toBeNull();
		const second = await env.jobs.listJobsPage(pid, nid, 2, first.next!);
		expect(second.items.map((job) => job.id)).toEqual([ordered[2].id]);
		expect(second.next).toBeNull();
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
		expect(entry).toEqual({ id: job.id, enabled: false, updated_at: updated.updated_at });
	});

	it('does not let a delayed older update overwrite the snapshot index', async () => {
		const job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
		const updateNotebookEntry = env.catalog.updateNotebookEntry.bind(env.catalog);
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let reachedFirst!: () => void;
		const firstReached = new Promise<void>((resolve) => {
			reachedFirst = resolve;
		});
		let updateCalls = 0;
		vi.spyOn(env.catalog, 'updateNotebookEntry').mockImplementation(async (...args) => {
			if (args[0] === 'job.update' && ++updateCalls === 1) {
				reachedFirst();
				await firstBlocked;
			}
			return updateNotebookEntry(...args);
		});

		const older = env.jobs.updateJob(pid, nid, job.id, { enabled: false }, ACTOR);
		await firstReached;
		const newer = await env.jobs.updateJob(pid, nid, job.id, { enabled: true }, ACTOR);
		releaseFirst();
		await older;

		const entry = indexedJobs(await env.catalog.getCurrentSnapshot())[0].entry;
		expect(entry).toMatchObject({ enabled: true, updated_at: newer.updated_at });
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
		await env.jobs.beginDelete(pid, nid, job.id, ACTOR, job.updated_at);
		expect(indexedJobs(await env.catalog.getCurrentSnapshot())).toEqual([]);
		expect(await env.jobs.isDeleting(job)).toBe(true);
		await env.jobs.finishDelete(pid, nid, job.id);
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
			const corruptA = JobId.create();
			const corruptB = JobId.create();
			const notebook = paths.project(pid).notebook(nid);
			await env.bucket.put(notebook.job(corruptA).head, '{not json');
			await env.bucket.put(notebook.job(corruptB).head, JSON.stringify({ id: 'nope' }));
			await env.bucket.put(notebook.jobIndex('2026-09-02T00:00:00.000Z', corruptA), '');
			await env.bucket.put(notebook.jobIndex('2026-09-02T00:00:01.000Z', corruptB), '');
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
			await expect(env.jobs.beginDelete(pid, nid, missing, ACTOR)).rejects.toBeInstanceOf(
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

		it('removes the definition when the index write fails', async () => {
			vi.spyOn(env.catalog, 'updateNotebookEntry').mockRejectedValueOnce(new Error('catalog down'));
			await expect(env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR)).rejects.toThrow(
				'catalog down',
			);
			expect(await env.jobs.listJobs(pid, nid)).toEqual([]);
			expect(indexedJobs(await env.catalog.getCurrentSnapshot())).toEqual([]);
		});
	});
});
