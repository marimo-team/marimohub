import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Millis } from '../../duration';
import { createRunId, SandboxId } from '../../ids';
import type { NotebookId, ProjectId } from '../../ids';
import type { ProjectAlertDispatcher } from '../../ports/projectAlerts';
import { paths } from '../../paths';
import type { SandboxInstance } from '../../ports/sandbox';
import type { JobDefinition, JobRun } from '../../schema';
import { ACTOR, RecordingCompute, setupTestEnv } from '../../testing';
import type { CreateJobInput } from './JobsService';
import { admit, JobScheduler } from './JobScheduler';
import type { JobSchedulerConfig, JobSchedulerDeps } from './JobScheduler';

const T0 = Date.parse('2026-09-02T06:00:30.000Z');
const SB = SandboxId.parse('sb-0123456789abcdef');
const MINUTE = 60_000;

const CONFIG: JobSchedulerConfig = {
	catchupWindowMs: 10 * MINUTE,
	maxConcurrentRuns: 5,
	maxConcurrentRunsPerProject: 2,
	defaultTimeoutMs: Millis.minutes(30),
	maxTimeoutMs: Millis.hours(4),
	watchdogGraceMs: MINUTE,
};

/** A runner double: records dispatches and completes each run with the chosen outcome. */
function fakeRunner(
	env: Awaited<ReturnType<typeof setupTestEnv>>,
	outcome: 'succeed' | 'fail' | 'hang' = 'succeed',
) {
	const executed: JobRun[] = [];
	const release = new Map<string, () => void>();
	return {
		executed,
		release,
		async execute(run: JobRun): Promise<JobRun> {
			executed.push(run);
			const provisioning = await env.jobRuns.transition(run, 'provision', () => ({
				sandbox_id: SB,
				started_at: new Date().toISOString(),
			}));
			if (!provisioning.transitioned) return provisioning.run;
			await env.jobRuns.transition(run, 'start');
			if (outcome === 'hang') {
				await new Promise<void>((resolve) => release.set(run.run_id, resolve));
			}
			const done = await env.jobRuns.transition(
				run,
				outcome === 'fail' ? 'fail' : 'succeed',
				() => ({
					finished_at: new Date().toISOString(),
					...(outcome === 'fail' ? { error: { code: 'NOTEBOOK_FAILED', message: 'boom' } } : {}),
				}),
			);
			return done.run;
		},
	};
}

describe('JobScheduler', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let pid: ProjectId;
	let nid: NotebookId;
	let compute: RecordingCompute;
	let now: number;

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
		compute = new RecordingCompute();
		now = T0;
	});

	const createJob = (input: Partial<CreateJobInput> = {}) =>
		env.jobs.createJob(
			pid,
			nid,
			{ name: 'nightly', schedule: { cron: '* * * * *', timezone: 'UTC' }, ...input },
			ACTOR,
		);

	function scheduler(
		runner: JobSchedulerDeps['runner'],
		overrides: Partial<ConstructorParameters<typeof JobScheduler>[0]> = {},
	) {
		return new JobScheduler({
			catalog: env.catalog,
			jobs: env.jobs,
			runs: env.jobRuns,
			runner,
			compute,
			notebooks: env.notebooks,
			projects: env.projects,
			config: CONFIG,
			now: () => now,
			...overrides,
		});
	}

	const settle = async (s: JobScheduler) => {
		await s.drain();
	};

	it('fires a due occurrence exactly once across ticks and dispatches it', async () => {
		const job = await createJob();
		const runner = fakeRunner(env);
		const s = scheduler(runner);

		const first = await s.tick();
		expect(first).toMatchObject({ fired: 1, dispatched: 1, repaired: 0, skipped: 0 });
		await settle(s);

		const second = await s.tick();
		expect(second).toMatchObject({ fired: 0, dispatched: 0 });
		await settle(s);

		const runs = await env.jobRuns.listRuns(pid, nid, job.id);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			status: 'succeeded',
			trigger: 'schedule',
			scheduled_for: '2026-09-02T06:00:00.000Z',
			timeout_seconds: 1800,
		});
		expect(runner.executed.map((r) => r.run_id)).toEqual([runs[0].run_id]);
		expect(
			await env.bucket.head(
				paths.project(pid).notebook(nid).job(job.id).occurrence('20260902T0600Z'),
			),
		).not.toBeNull();
	});

	it('admits exactly one of two concurrent replicas firing the same occurrence', async () => {
		const job = await createJob();
		const a = scheduler(fakeRunner(env));
		const b = scheduler(fakeRunner(env));
		const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
		expect(ra.fired + rb.fired).toBe(1);
		await Promise.all([settle(a), settle(b)]);
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
	});

	it('fires at most the latest missed occurrence after a gap', async () => {
		const job = await createJob();
		const s = scheduler(fakeRunner(env));
		now = T0 + 3 * 24 * 60 * MINUTE;
		expect((await s.tick()).fired).toBe(1);
		await settle(s);
		const runs = await env.jobRuns.listRuns(pid, nid, job.id);
		expect(runs).toHaveLength(1);
		expect(runs[0].scheduled_for).toBe('2026-09-05T06:00:00.000Z');
	});

	it('does not fire an occurrence older than the catch-up window', async () => {
		await createJob({ schedule: { cron: '0 6 * * *', timezone: 'UTC' } });
		const s = scheduler(fakeRunner(env));
		now = T0 + 20 * MINUTE;
		expect((await s.tick()).fired).toBe(0);
	});

	it('repairs a claimed occurrence whose run record was never written', async () => {
		const job = await createJob();
		const orphanRunId = createRunId();
		await env.bucket.put(
			paths.project(pid).notebook(nid).job(job.id).occurrence('20260902T0600Z'),
			JSON.stringify({ run_id: orphanRunId, fired_at: '2026-09-02T06:00:05.000Z' }),
		);
		const runner = fakeRunner(env);
		const s = scheduler(runner);
		const result = await s.tick();
		expect(result).toMatchObject({ fired: 0, repaired: 1, dispatched: 1 });
		await settle(s);
		const runs = await env.jobRuns.listRuns(pid, nid, job.id);
		expect(runs.map((r) => r.run_id)).toEqual([orphanRunId]);
		expect(runs[0].status).toBe('succeeded');
	});

	it('skips a fire under the forbid policy while a run is active, and allows it under allow', async () => {
		const forbid = await createJob({ name: 'forbid' });
		const allow = await createJob({ name: 'allow', concurrency_policy: 'allow' });
		for (const job of [forbid, allow]) {
			const active = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.jobRuns.transition(active, 'provision', () => ({
				started_at: new Date(now).toISOString(),
			}));
		}
		const s = scheduler(fakeRunner(env));
		const result = await s.tick();
		expect(result).toMatchObject({ fired: 1, skipped: 1 });
		const forbidRuns = await env.jobRuns.listRuns(pid, nid, forbid.id);
		expect(forbidRuns.map((r) => r.status).sort()).toEqual(['provisioning', 'skipped']);
		expect(forbidRuns.find((r) => r.status === 'skipped')?.error?.code).toBe(
			'CONCURRENCY_FORBIDDEN',
		);
		expect((await env.jobRuns.listRuns(pid, nid, allow.id)).map((r) => r.status).sort()).toEqual([
			'provisioning',
			'queued',
		]);
	});

	it('dispatches oldest-first under the deployment and per-project caps', async () => {
		const job = await createJob({ schedule: undefined });
		const runs = [];
		for (let i = 0; i < 4; i++) {
			runs.push(await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 }));
		}
		const runner = fakeRunner(env, 'hang');
		const s = scheduler(runner, {
			config: { ...CONFIG, maxConcurrentRuns: 3, maxConcurrentRunsPerProject: 2 },
		});
		expect((await s.tick()).dispatched).toBe(2);
		expect(runner.executed.map((r) => r.run_id)).toEqual([runs[0].run_id, runs[1].run_id]);
		// Still in flight: the next tick admits nothing more.
		expect((await s.tick()).dispatched).toBe(0);
		await vi.waitFor(() => expect(runner.release.size).toBe(2));
		for (const release of runner.release.values()) release();
		runner.release.clear();
		await settle(s);
		expect((await s.tick()).dispatched).toBe(2);
		await vi.waitFor(() => expect(runner.release.size).toBe(2));
		for (const release of runner.release.values()) release();
		await settle(s);
	});

	it('holds a retry back until its eligible_at', async () => {
		const job = await createJob({ schedule: undefined });
		await env.jobRuns.enqueue({
			job,
			trigger: 'manual',
			timeoutSeconds: 60,
			eligibleAt: new Date(now + 5 * MINUTE).toISOString(),
		});
		const s = scheduler(fakeRunner(env));
		expect((await s.tick()).dispatched).toBe(0);
		now += 5 * MINUTE;
		expect((await s.tick()).dispatched).toBe(1);
		await settle(s);
	});

	it('reclaims an active run past its deadline: destroys the sandbox and lands timed_out', async () => {
		const job = await createJob({ schedule: undefined });
		const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		await env.jobRuns.transition(run, 'provision', () => ({
			sandbox_id: SB,
			started_at: new Date(now - 10 * MINUTE).toISOString(),
			deadline_at: new Date(now - 2 * MINUTE).toISOString(),
		}));
		const s = scheduler(fakeRunner(env));
		expect((await s.tick()).timedOut).toBe(1);
		expect(compute.destroyed).toEqual([SB]);
		const stored = await env.jobRuns.getRun(pid, nid, job.id, run.run_id);
		expect(stored).toMatchObject({ status: 'timed_out', error: { code: 'RUN_TIMED_OUT' } });
		expect(await env.jobRuns.listActive()).toEqual([]);
	});

	it('leaves an active run alone before its deadline', async () => {
		const job = await createJob({ schedule: undefined });
		const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		await env.jobRuns.transition(run, 'provision', () => ({
			sandbox_id: SB,
			deadline_at: new Date(now + MINUTE).toISOString(),
		}));
		const s = scheduler(fakeRunner(env));
		expect((await s.tick()).timedOut).toBe(0);
		expect(compute.destroyed).toEqual([]);
	});

	it('enqueues a backed-off retry after a failure and notifies only on the final attempt', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);
		const projectAlerts: ProjectAlertDispatcher = { deliver, test: vi.fn() };
		const job = await createJob({
			schedule: undefined,
			retry: { max_retries: 1, backoff_seconds: 120 },
			notifications: { on: ['failure'] },
		});
		const first = await env.jobRuns.enqueue({
			job,
			trigger: 'manual',
			triggeredBy: ACTOR,
			timeoutSeconds: 60,
		});
		const runner = fakeRunner(env, 'fail');
		const s = scheduler(runner, { projectAlerts, appBaseUrl: 'https://hub.example' });

		expect((await s.tick()).dispatched).toBe(1);
		await settle(s);
		expect(deliver).not.toHaveBeenCalled();
		const afterFirst = await env.jobRuns.listRuns(pid, nid, job.id);
		expect(afterFirst).toHaveLength(2);
		const retry = afterFirst.find((r) => r.run_id !== first.run_id)!;
		expect(retry).toMatchObject({
			status: 'queued',
			attempt: 2,
			retry_of: first.run_id,
			triggered_by: ACTOR,
			eligible_at: new Date(now + 120_000).toISOString(),
		});

		// Not eligible yet, then eligible: the final failure notifies.
		expect((await s.tick()).dispatched).toBe(0);
		now += 120_000;
		expect((await s.tick()).dispatched).toBe(1);
		await settle(s);
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(2);
		expect(deliver).toHaveBeenCalledTimes(1);
		const [projectId, kind, notification] = deliver.mock.calls[0] as unknown as [
			string,
			string,
			{ kind: string; data: Record<string, unknown>; link?: string },
		];
		expect(projectId).toBe(pid);
		expect(kind).toBe('job.run.failed');
		expect(notification.data).toMatchObject({
			job_id: job.id,
			job_name: 'nightly',
			run_id: retry.run_id,
			status: 'failed',
			attempt: 2,
			error_code: 'NOTEBOOK_FAILED',
		});
		expect(notification.link).toBe(
			`https://hub.example/projects/${pid}/notebooks/${nid}/jobs?job=${job.id}&run=${retry.run_id}`,
		);
	});

	it('notifies on success when subscribed', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);
		const job = await createJob({ schedule: undefined, notifications: { on: ['success'] } });
		await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		const s = scheduler(fakeRunner(env), { projectAlerts: { deliver, test: vi.fn() } });
		await s.tick();
		await settle(s);
		expect(deliver).toHaveBeenCalledWith(
			pid,
			'job.run.succeeded',
			expect.objectContaining({ kind: 'job.run.succeeded' }),
		);
	});

	it('does not fire jobs of soft-deleted notebooks or disabled jobs', async () => {
		await createJob({ enabled: false });
		const disabledOnly = await scheduler(fakeRunner(env)).tick();
		expect(disabledOnly.fired).toBe(0);
		await createJob({ name: 'live' });
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect((await scheduler(fakeRunner(env)).tick()).fired).toBe(0);
	});

	it('prunes terminal runs past retention and stale markers', async () => {
		const job = await createJob({ schedule: undefined });
		const old = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		await env.jobRuns.transition(old, 'fail', () => ({
			finished_at: new Date(now - 40 * 24 * 60 * MINUTE).toISOString(),
		}));
		const s = scheduler(fakeRunner(env));
		expect(await s.prune(30 * 24 * 60 * MINUTE)).toEqual({ runsPruned: 1, markersPruned: 0 });
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toEqual([]);
	});

	it('derives the run timeout from the job under the deployment ceiling', () => {
		const s = scheduler(fakeRunner(env));
		expect(
			s.timeoutSeconds({ timeout_seconds: undefined } as Pick<JobDefinition, 'timeout_seconds'>),
		).toBe(1800);
		expect(s.timeoutSeconds({ timeout_seconds: 600 })).toBe(600);
		expect(s.timeoutSeconds({ timeout_seconds: 99_999 })).toBe(14_400);
	});

	describe('audit events', () => {
		const today = () => new Date().toISOString().slice(0, 10);

		it('appends job.run.finish for a completed run, attributed to the triggerer', async () => {
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({
				job,
				trigger: 'manual',
				triggeredBy: ACTOR,
				timeoutSeconds: 60,
			});
			const s = scheduler(fakeRunner(env), { events: env.events });
			await s.tick();
			await settle(s);
			const events = (await env.events.getEvents(today())).filter(
				(e) => e.event === 'job.run.finish',
			);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				actor: ACTOR,
				project_id: pid,
				notebook_id: nid,
				job_id: job.id,
				run_id: run.run_id,
				status: 'succeeded',
				trigger: 'manual',
				attempt: 1,
				duration_seconds: expect.any(Number),
			});
		});

		it('attributes a scheduled run to the system actor and records the failure code', async () => {
			const job = await createJob();
			const s = scheduler(fakeRunner(env, 'fail'), { events: env.events });
			await s.tick();
			await settle(s);
			const [event] = (await env.events.getEvents(today())).filter(
				(e) => e.event === 'job.run.finish',
			);
			expect(event).toMatchObject({
				actor: 'system',
				job_id: job.id,
				status: 'failed',
				trigger: 'schedule',
				error_code: 'NOTEBOOK_FAILED',
			});
		});

		it('audits a scheduled run skipped by the concurrency policy', async () => {
			const job = await createJob();
			await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const runner = fakeRunner(env, 'hang');
			const s = scheduler(runner, { events: env.events });
			await s.tick();
			const finish = (await env.events.getEvents(today())).find(
				(event) => event.event === 'job.run.finish' && event.status === 'skipped',
			);
			expect(finish).toMatchObject({
				actor: 'system',
				job_id: job.id,
				status: 'skipped',
				error_code: 'CONCURRENCY_FORBIDDEN',
			});
			await vi.waitFor(() => expect(runner.release.size).toBe(1));
			for (const release of runner.release.values()) release();
			await settle(s);
		});

		it('audits a watchdog timeout while cancellation auditing stays with the canceller', async () => {
			const job = await createJob({ schedule: undefined });
			const overdue = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.jobRuns.transition(overdue, 'provision', () => ({
				sandbox_id: SB,
				deadline_at: new Date(now - 5 * MINUTE).toISOString(),
			}));
			const cancelledRunner = {
				async execute(run: JobRun) {
					return (await env.jobRuns.cancel(run, ACTOR)).run;
				},
			};
			await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const s = scheduler(cancelledRunner, { events: env.events });
			await s.tick();
			await settle(s);
			const statuses = (await env.events.getEvents(today()))
				.filter((e) => e.event === 'job.run.finish')
				.map((e) => String(e.status))
				.sort();
			expect(statuses).toEqual(['timed_out']);
		});

		it('never lets a failing audit sink affect the run', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			vi.spyOn(env.events, 'append').mockRejectedValue(new Error('bucket down'));
			const s = scheduler(fakeRunner(env), { events: env.events });
			await s.tick();
			await settle(s);
			expect((await env.jobRuns.getRun(pid, nid, job.id, run.run_id)).status).toBe('succeeded');
			vi.restoreAllMocks();
		});
	});

	describe('unhappy paths', () => {
		beforeEach(() => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('ignores an indexed job whose stored cron is invalid and keeps ticking', async () => {
			const bad = await createJob({
				name: 'bad',
				schedule: { cron: '0 6 * * *', timezone: 'UTC' },
			});
			// Corrupt the stored schedule behind the service's validation.
			await env.catalog.updateNotebookEntry('test', ACTOR, pid, nid, (nb) => ({
				jobs: (nb.jobs ?? []).map((entry) =>
					entry.id === bad.id ? { ...entry, schedule: { cron: 'nope', timezone: 'UTC' } } : entry,
				),
			}));
			const good = await createJob({ name: 'good' });
			const s = scheduler(fakeRunner(env));
			const result = await s.tick();
			expect(result).toMatchObject({ fired: 1, errors: 0 });
			await settle(s);
			expect(await env.jobRuns.listRuns(pid, nid, good.id)).toHaveLength(1);
			expect(await env.jobRuns.listRuns(pid, nid, bad.id)).toEqual([]);
			expect(
				vi
					.mocked(console.error)
					.mock.calls.some((c) => String(c[0]).includes('job_schedule_invalid')),
			).toBe(true);
		});

		it('skips an indexed job whose definition is gone', async () => {
			const job = await createJob();
			await env.bucket.delete(paths.project(pid).notebook(nid).job(job.id).head);
			const s = scheduler(fakeRunner(env));
			expect(await s.tick()).toMatchObject({ fired: 0, errors: 0, dispatched: 0 });
		});

		it('counts a fire failure and continues with the other jobs', async () => {
			await createJob({ name: 'first' });
			await createJob({ name: 'second' });
			vi.spyOn(env.jobRuns, 'enqueue').mockRejectedValueOnce(new Error('bucket down'));
			const s = scheduler(fakeRunner(env));
			const result = await s.tick();
			expect(result.errors).toBe(1);
			expect(result.fired).toBe(1);
			await settle(s);
		});

		it('a failed tick step leaves the occurrence claimed so the next tick repairs it', async () => {
			const job = await createJob();
			vi.spyOn(env.jobRuns, 'enqueue').mockRejectedValueOnce(new Error('bucket down'));
			const s = scheduler(fakeRunner(env));
			expect((await s.tick()).errors).toBe(1);
			const second = await s.tick();
			expect(second).toMatchObject({ fired: 0, repaired: 1, dispatched: 1 });
			await settle(s);
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
		});

		it('still lands timed_out when the watchdog cannot destroy the sandbox', async () => {
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.jobRuns.transition(run, 'provision', () => ({
				sandbox_id: SB,
				deadline_at: new Date(now - 5 * MINUTE).toISOString(),
			}));
			const failing = {
				create: () =>
					({
						destroy: async () => {
							throw new Error('provider down');
						},
					}) as unknown as SandboxInstance,
				proxy: async () => null,
			};
			const s = scheduler(fakeRunner(env), { compute: failing });
			expect((await s.tick()).timedOut).toBe(1);
			expect((await env.jobRuns.getRun(pid, nid, job.id, run.run_id)).status).toBe('timed_out');
		});

		it('reclaims an overdue provisioning run that never recorded a sandbox', async () => {
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.jobRuns.transition(run, 'provision', () => ({
				deadline_at: new Date(now - 5 * MINUTE).toISOString(),
			}));
			const s = scheduler(fakeRunner(env));
			expect((await s.tick()).timedOut).toBe(1);
			expect(compute.destroyed).toEqual([]);
		});

		it('bounds a run with no deadline by the deployment ceiling', async () => {
			const job = await createJob({ schedule: undefined });
			// `queued_at` is stamped from the real clock; anchor the fake clock to it.
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			now = Date.parse(run.queued_at);
			await env.jobRuns.transition(run, 'provision');
			const s = scheduler(fakeRunner(env));
			expect((await s.tick()).timedOut).toBe(0);
			now += Number(CONFIG.maxTimeoutMs) + 5 * MINUTE;
			expect((await s.tick()).timedOut).toBe(1);
		});

		it('reclaims a locally executing run after its watchdog deadline', async () => {
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			now = Date.parse(run.queued_at);
			const runner = fakeRunner(env, 'hang');
			const s = scheduler(runner);
			await s.tick();
			await vi.waitFor(() => expect(runner.release.has(run.run_id)).toBe(true));
			now += Number(CONFIG.maxTimeoutMs) + 2 * MINUTE;
			expect((await s.tick()).timedOut).toBe(1);
			expect((await env.jobRuns.getRun(pid, nid, job.id, run.run_id)).status).toBe('timed_out');
			runner.release.get(run.run_id)?.();
			await settle(s);
			expect((await env.jobRuns.listRuns(pid, nid, job.id)).map((item) => item.status)).toEqual([
				'timed_out',
			]);
		});

		it('keeps a fresh dangling marker and prunes a stale one', async () => {
			const fresh = createRunId();
			const stale = createRunId();
			for (const [runId, ageMs] of [
				[fresh, MINUTE],
				[stale, 30 * MINUTE],
			] as const) {
				await env.bucket.put(
					paths.jobRunMarker(pid, runId),
					JSON.stringify({
						run_id: runId,
						job_id: 'job-0123456789abcdef',
						notebook_id: nid,
						project_id: pid,
						created_at: new Date(now - ageMs).toISOString(),
					}),
				);
			}
			const s = scheduler(fakeRunner(env));
			expect((await s.tick()).markersPruned).toBe(1);
			expect(await env.bucket.head(paths.jobRunMarker(pid, fresh))).not.toBeNull();
			expect(await env.bucket.head(paths.jobRunMarker(pid, stale))).toBeNull();
		});

		it('prunes a marker whose run is already terminal', async () => {
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			// Simulate a crash between the terminal CAS and the marker delete.
			await env.bucket.put(
				paths.project(pid).notebook(nid).job(job.id).run(run.run_id).record,
				JSON.stringify({ ...run, status: 'succeeded' }),
			);
			const s = scheduler(fakeRunner(env));
			expect((await s.tick()).markersPruned).toBe(1);
			expect(await env.jobRuns.listActive()).toEqual([]);
		});

		it('forbid counts a queued run as active', async () => {
			const job = await createJob();
			await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const s = scheduler(fakeRunner(env, 'hang'));
			const result = await s.tick();
			expect(result).toMatchObject({ fired: 0, skipped: 1 });
			expect((await env.jobRuns.listRuns(pid, nid, job.id)).map((r) => r.status).sort()).toEqual([
				'provisioning',
				'skipped',
			]);
		});

		it('does not retry a cancelled run', async () => {
			const job = await createJob({
				schedule: undefined,
				retry: { max_retries: 2, backoff_seconds: 0 },
			});
			await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const runner = {
				async execute(run: JobRun) {
					return (await env.jobRuns.cancel(run, ACTOR)).run;
				},
			};
			const s = scheduler(runner);
			await s.tick();
			await settle(s);
			await s.tick();
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
		});

		it('a failing alert dispatcher never fails the run pipeline', async () => {
			const job = await createJob({ schedule: undefined, notifications: { on: ['success'] } });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const s = scheduler(fakeRunner(env), {
				projectAlerts: {
					deliver: vi.fn(async () => {
						throw new Error('slack down');
					}),
					test: vi.fn(),
				},
			});
			await s.tick();
			await settle(s);
			expect((await env.jobRuns.getRun(pid, nid, job.id, run.run_id)).status).toBe('succeeded');
			expect(
				vi
					.mocked(console.error)
					.mock.calls.some((c) => String(c[0]).includes('project_alert_delivery_failed')),
			).toBe(true);
		});

		it('does not notify a job that opted out, even with a dispatcher', async () => {
			const deliver = vi.fn(async () => 'delivered' as const);
			const job = await createJob({ schedule: undefined });
			await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const s = scheduler(fakeRunner(env, 'fail'), { projectAlerts: { deliver, test: vi.fn() } });
			await s.tick();
			await settle(s);
			expect(deliver).not.toHaveBeenCalled();
		});

		it('prune continues past a job whose prune fails', async () => {
			const a = await createJob({ name: 'a', schedule: undefined });
			const b = await createJob({ name: 'b', schedule: undefined });
			for (const job of [a, b]) {
				const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
				await env.jobRuns.transition(run, 'fail', () => ({
					finished_at: new Date(now - 60 * 24 * 60 * MINUTE).toISOString(),
				}));
			}
			const original = env.jobRuns.pruneJob.bind(env.jobRuns);
			vi.spyOn(env.jobRuns, 'pruneJob').mockImplementation(async (job, retention, at) => {
				if (job.id === a.id) throw new Error('bucket down');
				return original(job, retention, at);
			});
			const s = scheduler(fakeRunner(env));
			expect(await s.prune(30 * 24 * 60 * MINUTE)).toEqual({ runsPruned: 1, markersPruned: 0 });
		});

		it('does nothing on an empty catalog', async () => {
			const fresh = await setupTestEnv();
			const s = new JobScheduler({
				catalog: fresh.catalog,
				jobs: fresh.jobs,
				runs: fresh.jobRuns,
				runner: fakeRunner(fresh),
				compute,
				notebooks: fresh.notebooks,
				projects: fresh.projects,
				config: CONFIG,
				now: () => now,
			});
			expect(await s.tick()).toEqual({
				fired: 0,
				repaired: 0,
				skipped: 0,
				dispatched: 0,
				timedOut: 0,
				markersPruned: 0,
				errors: 0,
			});
			expect(await s.prune(MINUTE)).toEqual({ runsPruned: 0, markersPruned: 0 });
		});

		it('admits one run per project under the per-project cap', async () => {
			const jobA = await createJob({ schedule: undefined });
			const other = await env.projects.createProject({ name: 'q', description: '' }, ACTOR);
			const otherNotebook = await env.notebooks.createNotebook(
				other.id,
				{ title: 'nb2', description: '', code: 'import marimo' },
				ACTOR,
			);
			const jobB = await env.jobs.createJob(other.id, otherNotebook.id, { name: 'b' }, ACTOR);
			for (const job of [jobA, jobA, jobB, jobB]) {
				await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			}
			const runner = fakeRunner(env, 'hang');
			const s = scheduler(runner, {
				config: { ...CONFIG, maxConcurrentRuns: 5, maxConcurrentRunsPerProject: 1 },
			});
			expect((await s.tick()).dispatched).toBe(2);
			expect(new Set(runner.executed.map((r) => r.project_id)).size).toBe(2);
			await vi.waitFor(() => expect(runner.release.size).toBe(2));
			for (const release of runner.release.values()) release();
			await settle(s);
		});
	});
});

describe('admit', () => {
	const run = (project: string, queuedAt: string, eligibleAt?: string): JobRun =>
		({
			run_id: createRunId(),
			project_id: project as ProjectId,
			queued_at: queuedAt,
			...(eligibleAt ? { eligible_at: eligibleAt } : {}),
		}) as JobRun;
	const caps = { maxConcurrentRuns: 3, maxConcurrentRunsPerProject: 2 };

	it('admits oldest-eligible first, with a retry ranked by its eligible_at', () => {
		const late = run('p1', '2026-09-02T10:00:00Z', '2026-09-02T10:30:00Z');
		const early = run('p1', '2026-09-02T10:10:00Z');
		expect(admit([late, early], [], caps)).toEqual([early, late]);
	});

	it('counts running work against both caps and skips a saturated project without blocking others', () => {
		const running = [run('p1', '2026-09-02T09:00:00Z')];
		const p1a = run('p1', '2026-09-02T10:00:00Z');
		const p1b = run('p1', '2026-09-02T10:01:00Z');
		const p2 = run('p2', '2026-09-02T10:02:00Z');
		expect(admit([p1a, p1b, p2], running, caps)).toEqual([p1a, p2]);
		expect(admit([p1a, p1b, p2], running, { ...caps, maxConcurrentRuns: 1 })).toEqual([]);
	});

	it('breaks ties on run id so the order is total', () => {
		const a = run('p1', '2026-09-02T10:00:00Z');
		const b = run('p1', '2026-09-02T10:00:00Z');
		const [first, second] = [a, b].sort((x, y) => x.run_id.localeCompare(y.run_id));
		expect(admit([b, a], [], caps)).toEqual([first, second]);
	});
});
