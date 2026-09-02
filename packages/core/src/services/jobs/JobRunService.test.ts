import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../errors';
import { createRunId, SandboxId } from '../../ids';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import type { JobDefinition } from '../../schema';
import { ACTOR, MemoryBucket, setupTestEnv, uid } from '../../testing';
import { DANGLING_MARKER_GRACE_MS, JobRunService } from './JobRunService';

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

	const enqueue = (overrides: Partial<Parameters<JobRunService['enqueue']>[0]> = {}) =>
		runs.enqueue({ job, trigger: 'manual', triggeredBy: ACTOR, timeoutSeconds: 600, ...overrides });

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

	it('applies FSM transitions with CAS and drops the marker on a terminal status', async () => {
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
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).toBeNull();
		expect(await runs.listActive()).toEqual([]);
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

	it('writes a terminal skipped record without a marker', async () => {
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
		expect(await env.bucket.head(paths.jobRunMarker(pid, skipped.run_id))).toBeNull();
	});

	it('cancels every active run of a job and reports their sandboxes', async () => {
		const queued = await enqueue();
		const active = await enqueue();
		await runs.transition(active, 'provision', () => ({ sandbox_id: SB }));
		const sandboxIds = await runs.cancelRunsOfJob(job, ACTOR);
		expect(sandboxIds).toEqual([SB]);
		expect((await runs.getRun(pid, nid, job.id, queued.run_id)).status).toBe('cancelled');
		expect((await runs.getRun(pid, nid, job.id, active.run_id)).status).toBe('cancelled');
		expect(await runs.listActive()).toEqual([]);
	});

	it('prunes terminal runs and occurrence claims past retention, keeping active ones', async () => {
		const now = Date.parse('2026-09-02T12:00:00.000Z');
		const old = await enqueue();
		await runs.transition(old, 'fail', () => ({ finished_at: '2026-07-01T00:00:00.000Z' }));
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

		expect(await runs.pruneJob(job, 30 * 24 * 3_600_000, now)).toBe(1);
		const remaining = (await runs.listRuns(pid, nid, job.id)).map((r) => r.run_id);
		expect(remaining).toEqual(expect.arrayContaining([recent.run_id, active.run_id]));
		expect(remaining).not.toContain(old.run_id);
		const jobPaths = paths.project(pid).notebook(nid).job(job.id);
		expect(await env.bucket.head(jobPaths.occurrence('20260601T0600Z'))).toBeNull();
		expect(await env.bucket.head(jobPaths.occurrence('20260902T0600Z'))).not.toBeNull();
	});

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
		await bucket.put(
			paths.jobRunMarker(pid, fresh),
			JSON.stringify({
				run_id: fresh,
				job_id: job.id,
				notebook_id: nid,
				project_id: pid,
				created_at: new Date(now).toISOString(),
			}),
		);
		const stale = createRunId();
		await bucket.put(
			paths.jobRunMarker(pid, stale),
			JSON.stringify({
				run_id: stale,
				job_id: job.id,
				notebook_id: nid,
				project_id: pid,
				created_at: new Date(now - DANGLING_MARKER_GRACE_MS - 1000).toISOString(),
			}),
		);
		expect(await service.pruneStaleMarkers(now)).toBe(2);
		expect(await bucket.head(paths.jobRunMarker(pid, fresh))).not.toBeNull();
		expect(await bucket.head(paths.jobRunMarker(pid, stale))).toBeNull();
		expect(await bucket.head(paths.jobRunMarker(pid, terminal.run_id))).toBeNull();
	});

	describe('unhappy paths', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('removes a corrupt marker and reports a corrupt record as missing when listing active runs', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const healthy = await enqueue();
			await env.bucket.put(paths.jobRunMarker(pid, createRunId()), '{not json');
			const corruptRecord = await enqueue();
			await env.bucket.put(
				paths.project(pid).notebook(nid).job(job.id).run(corruptRecord.run_id).record,
				'garbage',
			);

			const active = await runs.listActive();
			const byRun = new Map(active.map((a) => [a.marker.run_id, a.run?.run_id ?? null]));
			expect(byRun.get(healthy.run_id)).toBe(healthy.run_id);
			expect(byRun.get(corruptRecord.run_id)).toBeNull();
			expect(byRun.size).toBe(2);
			// The corrupt marker is gone; only the two valid ones remain.
			expect(await runs.listActive()).toHaveLength(2);
			expect(
				errorSpy.mock.calls.some((c) => String(c[0]).includes('corrupt_job_run_marker_removed')),
			).toBe(true);
		});

		it('skips a corrupt run record when listing history', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const good = await enqueue();
			await env.bucket.put(
				paths.project(pid).notebook(nid).job(job.id).run(createRunId()).record,
				'{"status":"queued"}',
			);
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

		it('drops a dangling marker when cancelling a job’s runs', async () => {
			const dangling = createRunId();
			await env.bucket.put(
				paths.jobRunMarker(pid, dangling),
				JSON.stringify({
					run_id: dangling,
					job_id: job.id,
					notebook_id: nid,
					project_id: pid,
					created_at: new Date().toISOString(),
				}),
			);
			expect(await runs.cancelRunsOfJob(job, ACTOR)).toEqual([]);
			expect(await env.bucket.head(paths.jobRunMarker(pid, dangling))).toBeNull();
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

		it('surfaces a bucket failure from enqueue instead of a half-written run', async () => {
			vi.spyOn(env.bucket, 'put').mockRejectedValueOnce(new Error('bucket down'));
			await expect(enqueue()).rejects.toThrow('bucket down');
			expect(await runs.listActive()).toEqual([]);
			expect(await runs.listRuns(pid, nid, job.id)).toEqual([]);
		});
	});
});
