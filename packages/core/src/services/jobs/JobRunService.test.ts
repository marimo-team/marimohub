import { ulid } from 'ulidx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { NotFoundError } from '../../errors';
import { createRunId, RunId, SandboxId } from '../../ids';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import type { JobDefinition } from '../../schema';
import { ACTOR, MemoryBucket, setupTestEnv, uid } from '../../testing';
import { DANGLING_MARKER_GRACE_MS, JobRunService } from './JobRunService';
import { occurrenceKey } from './cron';

const runIdAt = (at: number) => RunId.parse(`run_${ulid(at)}`);

const SB = SandboxId.parse('sb-0123456789abcdef');

describe('JobRunService', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let runs: JobRunService;
	let job: JobDefinition;
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		env = await setupTestEnv();
		runs = env.jobRuns;
		const project = await env.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		const notebook = await env.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
		job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const enqueue = (overrides: Partial<Parameters<JobRunService['enqueue']>[0]> = {}) =>
		runs.enqueue({ job, trigger: 'manual', triggeredBy: ACTOR, timeoutSeconds: 600, ...overrides });

	async function finalizedRun(queuedAt: number, finishedAt = queuedAt, runId = runIdAt(queuedAt)) {
		const run = await enqueue({ runId });
		const { run: finished } = await runs.transition(run, 'fail', () => ({
			queued_at: new Date(queuedAt).toISOString(),
			finished_at: new Date(finishedAt).toISOString(),
		}));
		await runs.deleteMarker(finished);
		return finished;
	}

	it('writes a queued record and an active-run marker', async () => {
		const run = await enqueue({ parameters: { name: 'Alice' } });
		expect(run).toMatchObject({
			status: 'queued',
			trigger: 'manual',
			triggered_by: ACTOR,
			attempt: 1,
			timeout_seconds: 600,
			parameters: { name: 'Alice' },
		});
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
		expect(await runs.getRun(pid, nid, job.id, run.run_id)).toEqual(run);
		expect((await runs.listActive()).map((a) => a.run?.run_id)).toEqual([run.run_id]);
	});

	it('converges on the existing record when enqueued twice with the same id', async () => {
		const runId = createRunId();
		const first = await enqueue({ runId });
		const second = await enqueue({ runId, parameters: { changed: 'yes' } });
		expect(second).toEqual(first);
	});

	it('lists runs newest first', async () => {
		const a = await enqueue();
		const b = await enqueue();
		const c = await enqueue();
		expect((await runs.listRuns(pid, nid, job.id)).map((r) => r.run_id)).toEqual([
			c.run_id,
			b.run_id,
			a.run_id,
		]);
	});

	it('paginates run history from the immutable newest-first index', async () => {
		const a = await enqueue();
		const b = await enqueue();
		const c = await enqueue();
		const first = await runs.listRunsPage(pid, nid, job.id, 2);
		expect(first.items.map((run) => run.run_id)).toEqual([c.run_id, b.run_id]);
		expect(first.nextRunId).toBe(b.run_id);
		const second = await runs.listRunsPage(pid, nid, job.id, 2, first.nextRunId!);
		expect(second.items.map((run) => run.run_id)).toEqual([a.run_id]);
		expect(second.nextRunId).toBeNull();
	});

	it('fetches only the records needed for one history page', async () => {
		const created = [];
		for (let i = 0; i < 6; i++) created.push(await enqueue());
		const get = vi.spyOn(env.bucket, 'get');

		const page = await runs.listRunsPage(pid, nid, job.id, 2);

		expect(page.items.map((run) => run.run_id)).toEqual([created[5].run_id, created[4].run_id]);
		const recordKeys = new Set(
			created.map((run) => paths.project(pid).notebook(nid).job(job.id).run(run.run_id).record),
		);
		const fetchedRecords = get.mock.calls.map(([key]) => key).filter((key) => recordKeys.has(key));
		expect(fetchedRecords).toEqual([
			paths.project(pid).notebook(nid).job(job.id).run(created[5].run_id).record,
			paths.project(pid).notebook(nid).job(job.id).run(created[4].run_id).record,
			paths.project(pid).notebook(nid).job(job.id).run(created[3].run_id).record,
		]);
	});

	it('fetches a history page with bounded parallel record reads', async () => {
		for (let index = 0; index < BUCKET_SCAN_CONCURRENCY + 2; index++) await enqueue();
		const get = env.bucket.get.bind(env.bucket);
		let concurrent = 0;
		let maximum = 0;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(env.bucket, 'get').mockImplementation(async (key) => {
			if (!key.endsWith('/run.json')) return get(key);
			concurrent++;
			maximum = Math.max(maximum, concurrent);
			if (concurrent === BUCKET_SCAN_CONCURRENCY) release();
			await blocked;
			const result = await get(key);
			concurrent--;
			return result;
		});

		const page = await runs.listRunsPage(pid, nid, job.id, BUCKET_SCAN_CONCURRENCY + 1);
		expect(page.items).toHaveLength(BUCKET_SCAN_CONCURRENCY + 1);
		expect(maximum).toBeGreaterThan(1);
		expect(maximum).toBeLessThanOrEqual(BUCKET_SCAN_CONCURRENCY);
	});

	it.each(['notebook', 'project'] as const)(
		'cancels %s runs despite a busy job claim',
		async (scope) => {
			const other = await env.jobs.createJob(pid, nid, { name: 'other' }, ACTOR);
			const first = await enqueue();
			const second = await enqueue({ job: other });
			await runs.withJobMutation(other, async () => {});
			const blocked = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.useFakeTimers();
			const busy = runs.withJobMutation(job, () => {
				entered.resolve();
				return blocked.promise;
			});
			await entered.promise;
			const mutation = vi.spyOn(runs, 'withJobMutation');
			try {
				const cancellation =
					scope === 'notebook'
						? runs.cancelRunsOfNotebook(pid, nid, ACTOR)
						: runs.cancelRunsOfProject(pid, ACTOR);
				await vi.advanceTimersByTimeAsync(0);
				expect(mutation.mock.calls.some(([ref]) => ref.id === other.id)).toBe(true);
				await vi.advanceTimersByTimeAsync(5000);
				expect((await cancellation).runs.map((run) => run.run_id)).toEqual([
					first.run_id,
					second.run_id,
				]);
				expect((await runs.listActive()).map(({ run }) => run?.status)).toEqual([
					'cancelled',
					'cancelled',
				]);
				expect(
					error.mock.calls.some(([line]) => String(line).includes('job_operation_wait_failed')),
				).toBe(true);
			} finally {
				blocked.resolve();
				await busy;
				vi.useRealTimers();
				mutation.mockRestore();
				error.mockRestore();
			}
		},
	);

	it.each(['write', 'list'] as const)(
		'continues cancellation after an operation claim %s fails',
		async (failure) => {
			const other = await env.jobs.createJob(pid, nid, { name: 'other' }, ACTOR);
			await runs.withJobMutation(job, async () => {});
			await runs.withJobMutation(other, async () => {});
			const first = await enqueue();
			const second = await enqueue({ job: other });
			const put = env.bucket.put.bind(env.bucket);
			const list = env.bucket.list.bind(env.bucket);
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const failed =
				failure === 'write'
					? vi.spyOn(env.bucket, 'put').mockImplementation((key, body, options) => {
							if (key === paths.jobOperationClaim(pid, nid, job.id))
								return Promise.reject(new Error('claim write failed'));
							return put(key, body, options);
						})
					: vi.spyOn(env.bucket, 'list').mockImplementation((options) => {
							if (options?.prefix === paths.jobOperationClaimsForNotebook(pid, nid))
								return Promise.reject(new Error('claim list failed'));
							return list(options);
						});
			try {
				expect(
					(await runs.cancelRunsOfNotebook(pid, nid, ACTOR)).runs.map((run) => run.run_id),
				).toEqual([first.run_id, second.run_id]);
				expect(
					error.mock.calls.some(([line]) => String(line).includes('job_operation_wait_failed')),
				).toBe(true);
			} finally {
				failed.mockRestore();
				error.mockRestore();
			}
		},
	);

	it('rejects a strict wait when a claim cannot be drained or listed', async () => {
		const blocked = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		vi.useFakeTimers();
		const busy = runs.withJobMutation(job, () => {
			entered.resolve();
			return blocked.promise;
		});
		try {
			await entered.promise;
			const waiting = runs.waitForJobMutations(pid, nid, { strict: true });
			const settled = expect(waiting).rejects.toThrow('Job is busy');
			await vi.advanceTimersByTimeAsync(5000);
			await settled;
		} finally {
			blocked.resolve();
			await busy;
			vi.useRealTimers();
		}
		const list = vi.spyOn(env.bucket, 'list').mockRejectedValueOnce(new Error('claim list failed'));
		await expect(runs.waitForJobMutations(pid, nid, { strict: true })).rejects.toThrow(
			'claim list failed',
		);
		list.mockRestore();
	});

	it('keeps a live operation claim when a move drops the source claims', async () => {
		const other = await env.jobs.createJob(pid, nid, { name: 'other' }, ACTOR);
		await runs.withJobMutation(other, async () => {});
		const blocked = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const busy = runs.withJobMutation(job, () => {
			entered.resolve();
			return blocked.promise;
		});
		await entered.promise;
		await runs.finishMove(pid, nid);
		expect(await env.bucket.head(paths.jobOperationClaim(pid, nid, job.id))).not.toBeNull();
		expect(await env.bucket.head(paths.jobOperationClaim(pid, nid, other.id))).toBeNull();
		blocked.resolve();
		await busy;
		await runs.finishMove(pid, nid);
		expect(await env.bucket.head(paths.jobOperationClaim(pid, nid, job.id))).toBeNull();
	});

	it('renews the per-job mutation lease while work is still active', async () => {
		vi.useFakeTimers();
		vi.setSystemTime('2026-09-02T00:00:00.000Z');
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const mutation = runs.withJobMutation(job, () => blocked);
		await vi.advanceTimersByTimeAsync(0);
		const key = paths.jobOperationClaim(pid, nid, job.id);
		const first = await (await env.bucket.get(key))!.json<{ holder: string }>();

		await vi.advanceTimersByTimeAsync(10_001);
		const renewed = await (await env.bucket.get(key))!.json<{ holder: string }>();
		expect(Number(renewed.holder.split(':')[0])).toBeGreaterThan(
			Number(first.holder.split(':')[0]),
		);

		release();
		await mutation;
		vi.useRealTimers();
	});

	it('applies FSM transitions with CAS and retains the marker for finalization', async () => {
		const run = await enqueue();
		const provisioning = await runs.transition(run, 'provision', () => ({ sandbox_id: undefined }));
		expect(provisioning).toMatchObject({ transitioned: true, run: { status: 'provisioning' } });
		const illegal = await runs.transition(run, 'succeed');
		expect(illegal).toMatchObject({ transitioned: false, run: { status: 'provisioning' } });
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();

		const running = await runs.transition(run, 'start');
		expect(running.run.status).toBe('running');
		const done = await runs.transition(run, 'succeed', () => ({ exit_code: 0 }));
		expect(done.run).toMatchObject({ status: 'succeeded', exit_code: 0 });
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
		expect(await runs.listActive()).toMatchObject([{ run: { status: 'succeeded' } }]);
	});

	it('resolves a cancel racing a completion to exactly one terminal state', async () => {
		const run = await enqueue();
		await runs.transition(run, 'provision');
		await runs.transition(run, 'start');
		const [cancel, complete] = await Promise.all([
			runs.cancel(run, uid('canceller')),
			runs.transition(run, 'succeed'),
		]);
		expect([cancel.transitioned, complete.transitioned].filter(Boolean)).toHaveLength(1);
		const stored = await runs.getRun(pid, nid, job.id, run.run_id);
		expect(['cancelled', 'succeeded']).toContain(stored.status);
		expect(cancel.run.status).toBe(stored.status);
		expect(complete.run.status).toBe(stored.status);
	});

	it('admits exactly one of two concurrent occurrence claims', async () => {
		const a = createRunId();
		const b = createRunId();
		const [first, second] = await Promise.all([
			runs.claimOccurrence(job, '20260902T0600Z', a, '2026-09-02T06:00:10.000Z'),
			runs.claimOccurrence(job, '20260902T0600Z', b, '2026-09-02T06:00:11.000Z'),
		]);
		const winners = [first, second].filter((claim) => claim.claimed);
		expect(winners).toHaveLength(1);
		const loser = [first, second].find((claim) => !claim.claimed);
		expect(loser && !loser.claimed ? loser.existing?.run_id : undefined).toMatch(/^run_/);
		expect([a, b]).toContain(loser && !loser.claimed ? loser.existing?.run_id : undefined);
	});

	it('writes and reads captured outputs beside the record', async () => {
		const run = await enqueue();
		const output = await runs.putOutputs(run, { html: '<html>hi</html>', logs: 'stdout' });
		expect(output).toEqual({ html_bytes: 15, logs_bytes: 6 });
		expect(await runs.readHtml(run)).toBe('<html>hi</html>');
		expect(await runs.readLogs(run)).toBe('stdout');
	});

	it('never overwrites captured outputs on a repeated capture', async () => {
		const run = await enqueue();
		await runs.putOutputs(run, { html: 'first', logs: 'original' });
		expect(
			await runs.putOutputs(run, {
				html: 'replacement',
				logs: 'new',
			}),
		).toEqual({
			html_bytes: 5,
			logs_bytes: 8,
		});
		expect(await runs.readHtml(run)).toBe('first');
		expect(await runs.readLogs(run)).toBe('original');
	});

	it('writes a terminal skipped record with a finalization marker', async () => {
		const skipped = await runs.writeSkipped({
			job,
			timeoutSeconds: 600,
			scheduledFor: '2026-09-02T06:00:00.000Z',
			reason: { code: 'CONCURRENCY_FORBIDDEN', message: 'busy' },
		});
		expect(skipped).toMatchObject({
			status: 'skipped',
			trigger: 'schedule',
			finished_at: expect.any(String),
		});
		expect(await env.bucket.head(paths.jobRunMarker(pid, skipped.run_id))).not.toBeNull();
	});

	it('cancels every active run of a job and reports their sandboxes', async () => {
		const queued = await enqueue();
		const active = await enqueue();
		await runs.transition(active, 'provision', () => ({ sandbox_id: SB }));
		const cancelled = await runs.cancelRunsOfJob(job, ACTOR);
		expect(cancelled.sandboxIds).toEqual([SB]);
		expect(cancelled.runs.map((run) => run.run_id)).toEqual(
			expect.arrayContaining([queued.run_id, active.run_id]),
		);
		expect((await runs.getRun(pid, nid, job.id, queued.run_id)).status).toBe('cancelled');
		expect((await runs.getRun(pid, nid, job.id, active.run_id)).status).toBe('cancelled');
		expect((await runs.listActive()).map(({ run }) => run?.status)).toEqual([
			'cancelled',
			'cancelled',
		]);
	});

	it('prunes terminal runs and occurrence claims past retention, keeping active ones', async () => {
		const now = Date.parse('2026-09-02T12:00:00.000Z');
		const old = await finalizedRun(Date.parse('2026-07-01T00:00:00.000Z'));
		const recent = await enqueue();
		await runs.transition(recent, 'fail', () => ({ finished_at: '2026-09-02T11:00:00.000Z' }));
		const active = await enqueue();
		await env.bucket.put(
			paths.project(pid).notebook(nid).job(job.id).occurrence('20260601T0600Z'),
			'{}',
		);
		await env.bucket.put(
			paths.project(pid).notebook(nid).job(job.id).occurrence('20260902T0600Z'),
			'{}',
		);
		await env.bucket.put(
			paths.project(pid).notebook(nid).job(job.id).occurrence('20260720T0600Z'),
			'{}',
		);

		expect(await runs.pruneJob(job, 30 * 24 * 3_600_000, now, 60 * 24 * 3_600_000)).toBe(1);
		const remaining = (await runs.listRuns(pid, nid, job.id)).map((r) => r.run_id);
		expect(remaining).toEqual(expect.arrayContaining([recent.run_id, active.run_id]));
		expect(remaining).not.toContain(old.run_id);
		const jobPaths = paths.project(pid).notebook(nid).job(job.id);
		expect(await env.bucket.head(jobPaths.occurrence('20260601T0600Z'))).toBeNull();
		expect(await env.bucket.head(jobPaths.occurrence('20260720T0600Z'))).not.toBeNull();
		expect(await env.bucket.head(jobPaths.occurrence('20260902T0600Z'))).not.toBeNull();
	});

	it('bounds inspection and resumes past retained runs and fresh occurrence claims', async () => {
		const now = Date.now();
		await finalizedRun(now - 10_000, now);
		await finalizedRun(now - 11_000, now);
		const expired = await finalizedRun(now - 12_000);
		for (let i = 0; i < 6; i++)
			await runs.claimOccurrence(
				job,
				occurrenceKey(now + i * 60_000),
				createRunId(),
				new Date(now).toISOString(),
			);
		const get = vi.spyOn(env.bucket, 'get');
		const list = vi.spyOn(env.bucket, 'list');
		expect(await runs.pruneJob(job, 1000, now, 1000, 2)).toBe(0);
		expect(get.mock.calls.filter(([key]) => key.endsWith('/run.json'))).toHaveLength(2);
		expect(
			list.mock.calls.filter(([options]) => options?.prefix?.endsWith('/occurrences/')),
		).toHaveLength(1);
		get.mockClear();
		list.mockClear();
		const restarted = new JobRunService(env.bucket);
		expect(await restarted.pruneJob(job, 1000, now, 1000, 2)).toBe(1);
		expect(get.mock.calls.filter(([key]) => key.endsWith('/run.json'))).toHaveLength(1);
		expect(
			await env.bucket.head(
				paths.project(pid).notebook(nid).job(job.id).run(expired.run_id).record,
			),
		).toBeNull();
		expect(
			list.mock.calls.find(([options]) => options?.prefix?.endsWith('/occurrences/'))?.[0]
				?.startAfter,
		).toBeUndefined();
	});

	it('restarts the occurrence scan at the first live claim', async () => {
		const now = Date.parse('2026-09-02T12:00:00.000Z');
		const jobPaths = paths.project(pid).notebook(nid).job(job.id);
		const keys = Array.from({ length: 450 }, (_, i) => occurrenceKey(now + (i - 150) * 60_000));
		for (const key of keys) await env.bucket.put(jobPaths.occurrence(key), '{}');
		const cursorKey = `${jobPaths.base}/prune-occurrences.json`;
		await runs.pruneJob(job, 1000, now, 1000, 100);
		await runs.pruneJob(job, 1000, now, 1000, 100);
		for (const key of keys.slice(0, 150))
			expect(await env.bucket.head(jobPaths.occurrence(key))).toBeNull();
		expect(await env.bucket.head(jobPaths.occurrence(keys[150]))).not.toBeNull();
		expect(await (await env.bucket.get(cursorKey))!.json()).toEqual({ after: '' });
		const put = vi.spyOn(env.bucket, 'put');
		await runs.pruneJob(job, 1000, now, 1000, 100);
		expect(put.mock.calls.filter(([key]) => key === cursorKey)).toEqual([]);
	});

	it('keeps listing run pages until the deadline passes', async () => {
		const now = Date.now();
		for (let i = 0; i < 7; i++) await finalizedRun(now - 10_000 - i);
		expect(await runs.pruneJob(job, 1000, now, 1000, 2, Date.now() + 60_000)).toBe(7);
		for (let i = 0; i < 7; i++) await finalizedRun(now - 20_000 - i);
		const deadline = Date.now() + 60_000;
		const clock = vi.spyOn(Date, 'now');
		const list = env.bucket.list.bind(env.bucket);
		let pages = 0;
		vi.spyOn(env.bucket, 'list').mockImplementation(async (options) => {
			if (options?.prefix?.endsWith('/run-index/') && ++pages === 2)
				clock.mockReturnValue(deadline);
			return list(options);
		});
		expect(await runs.pruneJob(job, 1000, now, 1000, 2, deadline)).toBe(4);
		clock.mockRestore();
		expect(await runs.pruneJob(job, 1000, now, 1000, 2)).toBe(2);
	});

	it('revisits newly eligible records after completing the bounded rotation', async () => {
		const now = Date.now();
		const newlyExpired = await finalizedRun(now - 500);
		await finalizedRun(now - 2000);
		const oldest = await finalizedRun(now - 3000);
		const key = paths.project(pid).notebook(nid).job(job.id).run(newlyExpired.run_id).record;
		expect(await runs.pruneJob(job, 1000, now, 1000, 1)).toBe(1);
		const restarted = new JobRunService(env.bucket);
		expect(await restarted.pruneJob(job, 1000, now + 1000, 1000, 1)).toBe(1);
		expect(await env.bucket.head(key)).not.toBeNull();
		expect(
			await env.bucket.head(paths.project(pid).notebook(nid).job(job.id).run(oldest.run_id).record),
		).toBeNull();
		expect(await restarted.pruneJob(job, 1000, now + 2000, 1000, 1)).toBe(1);
		expect(await env.bucket.head(key)).toBeNull();
	});

	it('bounds expired run deletion and resumes without replaying deleted runs', async () => {
		const now = Date.now();
		for (let i = 0; i < 5; i++) await finalizedRun(now - 10_000 - i);
		expect(await runs.pruneJob(job, 1000, now, 1000, 2)).toBe(2);
		expect(await runs.pruneJob(job, 1000, now, 1000, 2)).toBe(2);
		expect(await runs.pruneJob(job, 1000, now, 1000, 2)).toBe(1);
	});

	it.each(['read', 'delete'] as const)(
		'advances bounded pruning past a persistent run %s failure and retries after wrapping',
		async (failure) => {
			const now = Date.now();
			const blocked = await finalizedRun(now - 10_000);
			const healthy = await finalizedRun(now - 11_000);
			const jobPaths = paths.project(pid).notebook(nid).job(job.id);
			const blockedKey = jobPaths.run(blocked.run_id).record;
			const get = env.bucket.get.bind(env.bucket);
			const remove = env.bucket.delete.bind(env.bucket);
			vi.spyOn(env.bucket, 'get').mockImplementation((key) => {
				if (failure === 'read' && key === blockedKey) throw new Error('read unavailable');
				return get(key);
			});
			vi.spyOn(env.bucket, 'delete').mockImplementation((keys) => {
				if (failure === 'delete' && [keys].flat().includes(blockedKey))
					throw new Error('delete unavailable');
				return remove(keys);
			});
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			expect(await runs.pruneJob(job, 1000, now, 1000, 1)).toBe(0);
			expect(log).toHaveBeenCalled();
			const restarted = new JobRunService(env.bucket);
			expect(await restarted.pruneJob(job, 1000, now, 1000, 1)).toBe(1);
			expect(await env.bucket.head(jobPaths.run(healthy.run_id).record)).toBeNull();
			expect(await env.bucket.head(blockedKey)).not.toBeNull();
			vi.restoreAllMocks();
			expect(await restarted.pruneJob(job, 1000, now, 1000, 1)).toBe(1);
			expect(await env.bucket.head(blockedKey)).toBeNull();
		},
	);

	it.each(['read', 'delete'] as const)(
		'propagates cancellation during bounded run %s',
		async (phase) => {
			const now = Date.now();
			const run = await finalizedRun(now - 10_000);
			const jobPaths = paths.project(pid).notebook(nid).job(job.id);
			const failure = new DOMException('Cancelled', 'AbortError');
			if (phase === 'read') {
				const get = env.bucket.get.bind(env.bucket);
				vi.spyOn(env.bucket, 'get').mockImplementation((key) => {
					if (key === jobPaths.run(run.run_id).record) throw failure;
					return get(key);
				});
			} else vi.spyOn(env.bucket, 'delete').mockRejectedValueOnce(failure);
			await expect(runs.pruneJob(job, 1000, now, 1000, 1)).rejects.toBe(failure);
			expect(await env.bucket.head(`${jobPaths.base}/prune-runs.json`)).toBeNull();
		},
	);

	it.each(['runs', 'occurrences'] as const)(
		'surfaces a failed %s cursor write and resumes cleanup',
		async (phase) => {
			const now = Date.now();
			await finalizedRun(now - 10_000);
			await finalizedRun(now - 11_000);
			const jobPaths = paths.project(pid).notebook(nid).job(job.id);
			const claims = [now - 180_000, now - 120_000, now + 60_000].map((instant) =>
				occurrenceKey(instant),
			);
			for (const claim of claims)
				await runs.claimOccurrence(job, claim, createRunId(), new Date(now).toISOString());
			const key = `${jobPaths.base}/prune-${phase}.json`;
			const put = env.bucket.put.bind(env.bucket);
			vi.spyOn(env.bucket, 'put').mockImplementation((target, ...args) => {
				if (target === key) throw new Error('cursor unavailable');
				return put(target, ...args);
			});
			await expect(runs.pruneJob(job, 1000, now, 1000, 1)).rejects.toThrow('cursor unavailable');
			expect(await env.bucket.head(key)).toBeNull();
			expect(await env.bucket.head(jobPaths.occurrence(claims[0]))).toEqual(
				phase === 'occurrences' ? null : expect.anything(),
			);
			for (const claim of claims.slice(1))
				expect(await env.bucket.head(jobPaths.occurrence(claim))).not.toBeNull();
			vi.restoreAllMocks();
			expect(await new JobRunService(env.bucket).pruneJob(job, 1000, now, 1000, 1)).toBe(1);
			expect(await runs.listRuns(pid, nid, job.id)).toEqual([]);
			await runs.pruneJob(job, 1000, now, 1000, 1);
			for (const claim of claims.slice(0, 2))
				expect(await env.bucket.head(jobPaths.occurrence(claim))).toBeNull();
			expect(await env.bucket.head(jobPaths.occurrence(claims[2]))).not.toBeNull();
			const claimAgain = await runs.claimOccurrence(
				job,
				claims[2],
				createRunId(),
				new Date(now).toISOString(),
			);
			expect(claimAgain.claimed).toBe(false);
		},
	);

	it('prunes 10 expired runs without reading 1,000 retained runs', async () => {
		const now = Date.now();
		const retention = 60_000;
		for (let i = 0; i < 1010; i++) {
			const at = now - (i < 1000 ? 1000 : retention + 1000);
			await finalizedRun(at);
		}
		const get = vi.spyOn(env.bucket, 'get');
		const head = vi.spyOn(env.bucket, 'head');
		const list = vi.spyOn(env.bucket, 'list');
		const remove = vi.spyOn(env.bucket, 'delete');
		const put = vi.spyOn(env.bucket, 'put');

		expect(await runs.pruneJob(job, retention, now)).toBe(10);

		expect(get).toHaveBeenCalledTimes(10);
		expect(head).toHaveBeenCalledTimes(10);
		expect(list).toHaveBeenCalledTimes(12);
		expect(remove).toHaveBeenCalledTimes(20);
		expect(put).not.toHaveBeenCalled();
		expect(await runs.listRuns(pid, nid, job.id)).toHaveLength(1000);
	});

	it('prunes across history pages while skipping missing and corrupt records', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const now = Date.now();
		const jobPaths = paths.project(pid).notebook(nid).job(job.id);
		for (let i = 0; i < 505; i++) {
			const at = now - 10_000 - i;
			await finalizedRun(at);
		}
		const missing = runIdAt(now - 11_000);
		const corrupt = runIdAt(now - 12_000);
		await env.bucket.put(jobPaths.runIndex(missing), '');
		await env.bucket.put(jobPaths.runIndex(corrupt), '');
		await env.bucket.put(jobPaths.run(corrupt).record, 'invalid');

		expect(await runs.pruneJob(job, 1000, now)).toBe(505);
		expect(
			(await env.bucket.list({ prefix: jobPaths.runIndexPrefix })).objects.map((o) => o.key),
		).toEqual([jobPaths.runIndex(missing), jobPaths.runIndex(corrupt)]);
	});

	it('uses a strict cutoff and retains older runs that finished recently', async () => {
		const now = Date.now();
		const cutoff = now - 60_000;
		await finalizedRun(cutoff - 1);
		const at = await finalizedRun(
			cutoff,
			cutoff,
			RunId.parse(`run_${ulid(cutoff).slice(0, 10)}${'0'.repeat(16)}`),
		);
		const after = await finalizedRun(cutoff + 1);
		const longRunning = await finalizedRun(cutoff - 10_000, cutoff);

		expect(await runs.pruneJob(job, 60_000, now)).toBe(1);
		expect((await runs.listRuns(pid, nid, job.id)).map((run) => run.run_id)).toEqual([
			after.run_id,
			at.run_id,
			longRunning.run_id,
		]);
	});

	it('continues past short index pages containing only missing or corrupt records', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const now = Date.now();
		const jobPaths = paths.project(pid).notebook(nid).job(job.id);
		for (let i = 0; i < 6; i++) {
			const at = now - 10_000 - i;
			const run = await finalizedRun(at);
			if (i < 2) await env.bucket.delete(jobPaths.run(run.run_id).record);
			else if (i < 4) await env.bucket.put(jobPaths.run(run.run_id).record, 'invalid');
		}
		const list = env.bucket.list.bind(env.bucket);
		const listing = vi.spyOn(env.bucket, 'list').mockImplementation((options) =>
			list({
				...options,
				limit: options?.prefix === jobPaths.runIndexPrefix ? 2 : options?.limit,
			}),
		);

		expect(await runs.pruneJob(job, 1000, now)).toBe(2);
		expect(
			listing.mock.calls.filter(([options]) => options?.prefix === jobPaths.runIndexPrefix),
		).toHaveLength(3);
		expect(await runs.listRuns(pid, nid, job.id)).toEqual([]);
	});

	it.each([-1, 0, 0.5])('handles a cutoff of %s milliseconds after the epoch', async (cutoff) => {
		await finalizedRun(0);

		expect(await runs.pruneJob(job, 1000, 1000 + cutoff)).toBe(cutoff > 0 ? 1 : 0);
		expect(await runs.listRuns(pid, nid, job.id)).toHaveLength(cutoff > 0 ? 0 : 1);
	});

	it('uses queued_at for terminal records without a finish timestamp', async () => {
		const now = Date.now();
		const old = await enqueue({ runId: runIdAt(now - 10_000) });
		const repaired = await enqueue({ runId: runIdAt(now - 20_000) });
		for (const [run, queuedAt] of [
			[old, now - 10_000],
			[repaired, now],
		] as const) {
			await runs.transition(run, 'fail', () => ({ queued_at: new Date(queuedAt).toISOString() }));
			await runs.deleteMarker(run);
		}

		expect(await runs.pruneJob(job, 1000, now)).toBe(1);
		expect((await runs.listRuns(pid, nid, job.id)).map((run) => run.run_id)).toEqual([
			repaired.run_id,
		]);
	});

	it.each(['index list', 'record read', 'marker head', 'output list', 'output delete'] as const)(
		'preserves history and occurrence claims after a failed %s and retries safely',
		async (failure) => {
			const now = Date.now();
			const at = now - 120_000;
			const run = await finalizedRun(at);
			await runs.putOutputs(run, { html: '<p>output</p>', logs: 'logs' });
			const jobPaths = paths.project(pid).notebook(nid).job(job.id);
			const runPaths = jobPaths.run(run.run_id);
			const occurrence = occurrenceKey(at);
			await runs.claimOccurrence(job, occurrence, run.run_id, new Date(at).toISOString());
			const error = new Error('storage unavailable');
			const list = env.bucket.list.bind(env.bucket);
			vi.spyOn(env.bucket, 'list').mockImplementation((options) => {
				if (
					(failure === 'index list' && options?.prefix === jobPaths.runIndexPrefix) ||
					(failure === 'output list' && options?.prefix === runPaths.base)
				)
					throw error;
				return list(options);
			});
			if (failure === 'record read') vi.spyOn(env.bucket, 'get').mockRejectedValueOnce(error);
			if (failure === 'marker head') vi.spyOn(env.bucket, 'head').mockRejectedValueOnce(error);
			if (failure === 'output delete') vi.spyOn(env.bucket, 'delete').mockRejectedValueOnce(error);

			await expect(runs.pruneJob(job, 1000, now)).rejects.toThrow(error);
			vi.restoreAllMocks();
			expect(await runs.readHtml(run)).toBe('<p>output</p>');
			expect(await runs.readLogs(run)).toBe('logs');
			expect(await runs.getRun(pid, nid, job.id, run.run_id)).toMatchObject({ status: 'failed' });
			expect(await env.bucket.head(jobPaths.runIndex(run.run_id))).not.toBeNull();
			expect(await env.bucket.head(jobPaths.occurrence(occurrence))).not.toBeNull();

			expect(await runs.pruneJob(job, 1000, now)).toBe(1);
			expect(await env.bucket.list({ prefix: runPaths.base })).toMatchObject({ objects: [] });
			expect(await env.bucket.head(jobPaths.runIndex(run.run_id))).toBeNull();
			expect(await env.bucket.head(jobPaths.occurrence(occurrence))).toBeNull();
			expect(await runs.pruneJob(job, 1000, now)).toBe(0);
		},
	);

	it('drops markers whose run is terminal or missing past the grace window', async () => {
		const bucket = new MemoryBucket();
		const service = new JobRunService(bucket);
		const now = Date.now();
		const terminal = await service.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		// Simulate a crash between the terminal CAS and the marker delete.
		await bucket.put(
			paths.project(pid).notebook(nid).job(job.id).run(terminal.run_id).record,
			JSON.stringify({ ...terminal, status: 'succeeded' }),
		);
		const fresh = createRunId();
		const freshIndex = paths.project(pid).notebook(nid).job(job.id).runIndex(fresh);
		await bucket.put(
			paths.jobRunMarker(pid, fresh),
			JSON.stringify({
				run_id: fresh,
				continuation_run_id: createRunId(),
				job_id: job.id,
				notebook_id: nid,
				project_id: pid,
				created_at: new Date(now).toISOString(),
			}),
		);
		await bucket.put(freshIndex, '');
		const stale = createRunId();
		const staleIndex = paths.project(pid).notebook(nid).job(job.id).runIndex(stale);
		await bucket.put(
			paths.jobRunMarker(pid, stale),
			JSON.stringify({
				run_id: stale,
				continuation_run_id: createRunId(),
				job_id: job.id,
				notebook_id: nid,
				project_id: pid,
				created_at: new Date(now - DANGLING_MARKER_GRACE_MS - 1000).toISOString(),
			}),
		);
		await bucket.put(staleIndex, '');
		expect(await service.pruneStaleMarkers(now)).toBe(1);
		expect(await bucket.head(paths.jobRunMarker(pid, fresh))).not.toBeNull();
		expect(await bucket.head(freshIndex)).not.toBeNull();
		expect(await bucket.head(paths.jobRunMarker(pid, stale))).toBeNull();
		expect(await bucket.head(staleIndex)).toBeNull();
		expect(await bucket.head(paths.jobRunMarker(pid, terminal.run_id))).not.toBeNull();
	});

	describe('unhappy paths', () => {
		it('continues pruning after a stale marker cleanup fails', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const stale = [await enqueue(), await enqueue()];
			const jobPaths = paths.project(pid).notebook(nid).job(job.id);
			for (const run of stale) await env.bucket.delete(jobPaths.run(run.run_id).record);
			const failedIndex = jobPaths.runIndex(stale[0].run_id);
			const remove = env.bucket.delete.bind(env.bucket);
			vi.spyOn(env.bucket, 'delete').mockImplementation(async (key) => {
				if (key === failedIndex) throw new Error('storage unavailable');
				return remove(key);
			});

			expect(await runs.pruneStaleMarkers(Date.now() + DANGLING_MARKER_GRACE_MS + 1000)).toBe(1);

			expect(await env.bucket.head(paths.jobRunMarker(pid, stale[0].run_id))).not.toBeNull();
			expect(await env.bucket.head(failedIndex)).not.toBeNull();
			expect(await env.bucket.head(paths.jobRunMarker(pid, stale[1].run_id))).toBeNull();
			expect(await env.bucket.head(jobPaths.runIndex(stale[1].run_id))).toBeNull();
			expect(
				error.mock.calls.some(([line]) => String(line).includes('job_run_marker_prune_failed')),
			).toBe(true);
		});

		it('reports incomplete ownership and preserves corrupt markers', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const healthy = await enqueue();
			const corruptMarkerKey = paths.jobRunMarker(pid, createRunId());
			await env.bucket.put(corruptMarkerKey, '{not json');
			const corruptRecord = await enqueue();
			await env.bucket.put(
				paths.project(pid).notebook(nid).job(job.id).run(corruptRecord.run_id).record,
				'garbage',
			);

			const snapshot = await runs.listActiveSnapshot();
			const active = snapshot.entries;
			const byRun = new Map(active.map((a) => [a.marker.run_id, a.run?.run_id ?? null]));
			expect(byRun.get(healthy.run_id)).toBe(healthy.run_id);
			expect(byRun.get(corruptRecord.run_id)).toBeNull();
			expect(byRun.size).toBe(2);
			expect(snapshot.complete).toBe(false);
			await runs.pruneStaleMarkers(Date.now() + 60 * 60_000);
			expect(await env.bucket.head(paths.jobRunMarker(pid, corruptRecord.run_id))).not.toBeNull();
			expect(await env.bucket.head(corruptMarkerKey)).not.toBeNull();
			expect(
				errorSpy.mock.calls.some((c) => String(c[0]).includes('corrupt_job_run_marker_preserved')),
			).toBe(true);
		});

		it('skips a corrupt run record when listing history', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const good = await enqueue();
			const corrupt = createRunId();
			const jobPaths = paths.project(pid).notebook(nid).job(job.id);
			await env.bucket.put(jobPaths.runIndex(corrupt), '');
			await env.bucket.put(jobPaths.run(corrupt).record, '{"status":"queued"}');
			expect((await runs.listRuns(pid, nid, job.id)).map((r) => r.run_id)).toEqual([good.run_id]);
		});

		it('throws NotFoundError when transitioning a missing run', async () => {
			await expect(
				runs.transition(
					{ project_id: pid, notebook_id: nid, job_id: job.id, run_id: createRunId() },
					'provision',
				),
			).rejects.toBeInstanceOf(NotFoundError);
		});

		it('treats a cancel of a terminal run as a no-op', async () => {
			const run = await enqueue();
			await runs.transition(run, 'fail', () => ({ finished_at: new Date().toISOString() }));
			const result = await runs.cancel(run, uid('late'));
			expect(result.transitioned).toBe(false);
			expect(result.run.status).toBe('failed');
			expect(result.run.cancelled_by).toBeUndefined();
		});

		it('reports no existing run for a corrupt occurrence claim', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const key = paths.project(pid).notebook(nid).job(job.id).occurrence('20260902T0600Z');
			await env.bucket.put(key, '{"fired_at": 1}');
			const claim = await runs.claimOccurrence(
				job,
				'20260902T0600Z',
				createRunId(),
				'2026-09-02T06:00:00.000Z',
			);
			expect(claim).toEqual({ claimed: false, existing: null });
		});

		it('preserves a fresh dangling marker when cancelling a job’s runs', async () => {
			const dangling = createRunId();
			await env.bucket.put(
				paths.jobRunMarker(pid, dangling),
				JSON.stringify({
					run_id: dangling,
					continuation_run_id: createRunId(),
					job_id: job.id,
					notebook_id: nid,
					project_id: pid,
					created_at: new Date().toISOString(),
				}),
			);
			expect(await runs.cancelRunsOfJob(job, ACTOR)).toEqual({ runs: [], sandboxIds: [] });
			expect(await env.bucket.head(paths.jobRunMarker(pid, dangling))).not.toBeNull();
		});

		it('returns the sandbox of a run that became terminal before cancellation', async () => {
			const run = await enqueue();
			await runs.transition(run, 'provision', () => ({ sandbox_id: SB }));
			await runs.transition(run, 'fail', () => ({ finished_at: new Date().toISOString() }));

			expect(await runs.cancelRunsOfJob(job, ACTOR)).toEqual({ runs: [], sandboxIds: [SB] });
		});

		it('stores html-only outputs and reads null for absent artifacts', async () => {
			const run = await enqueue();
			expect(await runs.readHtml(run)).toBeNull();
			expect(await runs.readLogs(run)).toBeNull();
			expect(await runs.putOutputs(run, { html: '<p/>' })).toEqual({ html_bytes: 4 });
			expect(await runs.readLogs(run)).toBeNull();
		});

		it('swallows and logs a failed marker delete', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const run = await enqueue();
			vi.spyOn(env.bucket, 'delete').mockRejectedValueOnce(new Error('bucket down'));
			await expect(runs.deleteMarker(run)).resolves.toBeUndefined();
			expect(errorSpy.mock.calls[0][0]).toContain('job_run_marker_delete_failed');
		});

		it('omits an empty parameters object', async () => {
			const run = await enqueue({ parameters: {} });
			expect(run.parameters).toBeUndefined();
		});

		it('keeps queued and active runs regardless of age when pruning', async () => {
			const queued = await enqueue();
			const active = await enqueue();
			await runs.transition(active, 'provision');
			const farFuture = Date.parse('2030-01-01T00:00:00.000Z');
			expect(await runs.pruneJob(job, 1000, farFuture)).toBe(0);
			expect((await runs.listRuns(pid, nid, job.id)).map((r) => r.run_id).sort()).toEqual(
				[queued.run_id, active.run_id].sort(),
			);
		});

		it('keeps a terminal run while its finalization marker exists', async () => {
			const run = await enqueue({ runId: runIdAt(Date.parse('2026-01-01T00:00:00.000Z')) });
			await runs.transition(run, 'fail', () => ({ finished_at: '2026-01-01T00:00:00.000Z' }));

			expect(await runs.pruneJob(job, 1_000, Date.parse('2026-09-02T00:00:00.000Z'))).toBe(0);
			expect(await runs.getRun(pid, nid, job.id, run.run_id)).toMatchObject({ status: 'failed' });
		});

		it('repairs a run whose record write failed after its marker and index', async () => {
			const runId = createRunId();
			const put = env.bucket.put.bind(env.bucket);
			vi.spyOn(env.bucket, 'put')
				.mockImplementationOnce(put)
				.mockImplementationOnce(put)
				.mockRejectedValueOnce(new Error('bucket down'));
			await expect(enqueue({ runId })).rejects.toThrow('bucket down');
			expect(await runs.listActive()).toMatchObject([{ marker: { run_id: runId }, run: null }]);

			const repaired = await enqueue({ runId });
			expect(repaired.run_id).toBe(runId);
			expect((await runs.listRuns(pid, nid, job.id)).map((run) => run.run_id)).toEqual([runId]);
			expect((await runs.listActive()).map(({ marker }) => marker.run_id)).toEqual([runId]);
		});
	});
});
