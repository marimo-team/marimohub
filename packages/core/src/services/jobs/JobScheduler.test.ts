import { ulid } from 'ulidx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Millis } from '../../duration';
import { createRunId, RunId, SandboxId } from '../../ids';
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
const DAY = 24 * 60 * MINUTE;

const CONFIG: JobSchedulerConfig = {
	catchupWindowMs: 10 * MINUTE,
	maxConcurrentRuns: 5,
	maxConcurrentRunsPerProject: 2,
	defaultTimeoutMs: Millis.minutes(30),
	maxTimeoutMs: Millis.hours(4),
	watchdogGraceMs: MINUTE,
};

const NO_DISPATCH_CONFIG = { ...CONFIG, maxConcurrentRuns: 0 };
const IDLE_JOBS = [
	{ state: 'disabled', enabled: false, schedule: { cron: '* * * * *', timezone: 'UTC' } },
	{ state: 'manual', enabled: true, schedule: undefined },
	{ state: 'rescheduled', enabled: true, schedule: { cron: '0 0 * * *', timezone: 'UTC' } },
];
const invalidSchedule = (field: 'cron' | 'timezone') => ({
	cron: field === 'cron' ? 'bad cron' : '* * * * *',
	timezone: field === 'timezone' ? 'Mars/Olympus_Mons' : 'UTC',
});

/** A runner double: records dispatches and completes each run with the chosen outcome. */
function fakeRunner(
	env: Awaited<ReturnType<typeof setupTestEnv>>,
	outcome: 'succeed' | 'fail' | 'hang' = 'succeed',
	clock: () => number = Date.now,
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
				started_at: new Date(clock()).toISOString(),
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
					finished_at: new Date(clock()).toISOString(),
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

	it('memoizes completed occurrences across the catch-up window without hiding the next occurrence', async () => {
		await createJob({ schedule: { cron: '0 * * * *', timezone: 'UTC' } });
		const clock = scheduler(fakeRunner(env));
		expect((await clock.tick()).fired).toBe(1);
		await settle(clock);
		const claim = vi.spyOn(env.jobRuns, 'claimOccurrence');
		const load = vi.spyOn(env.jobs, 'getJob');
		for (let i = 0; i < 9; i++) {
			now += MINUTE;
			expect((await clock.tick()).fired).toBe(0);
		}
		expect(claim).not.toHaveBeenCalled();
		expect(load).not.toHaveBeenCalled();
		now = T0 + 60 * MINUTE;
		expect((await clock.tick()).fired).toBe(1);
		await settle(clock);
	});

	it('retries an occurrence after enqueue fails instead of memoizing its incomplete claim', async () => {
		await createJob();
		const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
		vi.spyOn(env.jobRuns, 'enqueue').mockRejectedValueOnce(new Error('storage unavailable'));
		expect(await clock.tick()).toMatchObject({ errors: 1, fired: 0 });
		expect(await clock.tick()).toMatchObject({ errors: 0, repaired: 1 });
	});

	it('performs no per-job bucket operations when no indexed jobs are due', async () => {
		for (let i = 0; i < 50; i++)
			await createJob({ name: `idle-${i}`, schedule: { cron: '0 0 * * *', timezone: 'UTC' } });
		await createJob({ name: 'disabled', enabled: false });
		await createJob({ name: 'manual', schedule: undefined });
		const get = vi.spyOn(env.bucket, 'get');
		const head = vi.spyOn(env.bucket, 'head');
		const put = vi.spyOn(env.bucket, 'put');
		const remove = vi.spyOn(env.bucket, 'delete');
		const getJob = vi.spyOn(env.jobs, 'getJob');
		const getProject = vi.spyOn(env.projects, 'getProject');
		const getNotebook = vi.spyOn(env.notebooks, 'getNotebookMeta');

		expect(await scheduler(fakeRunner(env)).tick()).toMatchObject({ fired: 0, errors: 0 });

		expect(get.mock.calls.every(([key]) => key.startsWith('_system/'))).toBe(true);
		expect(head).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(getJob).not.toHaveBeenCalled();
		expect(getProject).not.toHaveBeenCalled();
		expect(getNotebook).not.toHaveBeenCalled();
	});

	it.each(IDLE_JOBS)(
		'fires after a $state snapshot entry is updated to a due schedule',
		async ({ enabled, schedule }) => {
			const job = await createJob({ enabled, schedule });
			const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
			expect(await clock.tick()).toMatchObject({ fired: 0, errors: 0 });
			await env.jobs.updateJob(
				pid,
				nid,
				job.id,
				{
					enabled: true,
					schedule: { cron: '* * * * *', timezone: 'UTC' },
				},
				ACTOR,
			);
			expect(await clock.tick()).toMatchObject({ fired: 1, errors: 0 });
			expect(await clock.tick()).toMatchObject({ fired: 0, errors: 0 });
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
		},
	);

	it.each(IDLE_JOBS)(
		'revalidates a due snapshot candidate whose definition is now $state',
		async ({ enabled, schedule }) => {
			const job = await createJob();
			const key = paths.project(pid).notebook(nid).job(job.id).head;
			await env.bucket.put(key, JSON.stringify({ ...job, enabled, schedule }));
			expect(await scheduler(fakeRunner(env)).tick()).toMatchObject({ fired: 0, errors: 0 });
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(0);
		},
	);

	it.each(['cron', 'timezone', 'storage'] as const)(
		'continues firing healthy jobs after a %s failure and retries on the next tick',
		async (failure) => {
			const broken = await createJob({ name: 'broken' });
			const healthy = await createJob({ name: 'healthy' });
			const getJob = env.jobs.getJob.bind(env.jobs);
			const read = vi.spyOn(env.jobs, 'getJob').mockImplementation(async (...args) => {
				const job = await getJob(...args);
				if (job.id !== broken.id) return job;
				if (failure === 'storage') throw new Error('storage unavailable');
				return {
					...job,
					schedule: invalidSchedule(failure),
				};
			});
			const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
			expect(await clock.tick()).toMatchObject({ fired: 1, errors: failure === 'cron' ? 0 : 1 });
			expect(await env.jobRuns.listRuns(pid, nid, healthy.id)).toHaveLength(1);
			expect(await env.jobRuns.listRuns(pid, nid, broken.id)).toHaveLength(0);
			read.mockRestore();
			expect(await clock.tick()).toMatchObject({ fired: 1, errors: 0 });
			expect(await env.jobRuns.listRuns(pid, nid, healthy.id)).toHaveLength(1);
			expect(await env.jobRuns.listRuns(pid, nid, broken.id)).toHaveLength(1);
		},
	);

	it.each([0, 1])(
		'includes the catch-up boundary and excludes occurrences %i milliseconds past it',
		async (offset) => {
			const job = await createJob({ schedule: { cron: '0 6 * * *', timezone: 'UTC' } });
			now = Date.parse('2026-09-02T06:00:00.000Z') + CONFIG.catchupWindowMs + offset;
			const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
			expect(await clock.tick()).toMatchObject({ fired: offset === 0 ? 1 : 0, errors: 0 });
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(offset === 0 ? 1 : 0);
		},
	);

	it('evaluates snapshot schedules in their configured timezone', async () => {
		const due = await createJob({
			schedule: { cron: '0 23 * * *', timezone: 'America/Los_Angeles' },
		});
		await createJob({ name: 'utc', schedule: { cron: '0 23 * * *', timezone: 'UTC' } });
		const getJob = vi.spyOn(env.jobs, 'getJob');
		const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });

		expect(await clock.tick()).toMatchObject({ fired: 1, errors: 0 });
		expect(getJob.mock.calls.every(([, , id]) => id === due.id)).toBe(true);
		expect(await env.jobRuns.listRuns(pid, nid, due.id)).toMatchObject([
			{ scheduled_for: '2026-09-02T06:00:00.000Z' },
		]);
	});

	it.each([
		{
			change: 'spring-forward',
			first: '2026-03-29T01:35:00Z',
			second: '2026-03-29T02:35:00Z',
			occurrence: '2026-03-29T01:30:00.000Z',
		},
		{
			change: 'fall-back',
			first: '2026-10-25T00:35:00Z',
			second: '2026-10-25T01:35:00Z',
			occurrence: '2026-10-25T00:30:00.000Z',
		},
	])('fires exactly once across the $change transition', async ({ first, second, occurrence }) => {
		const job = await createJob({ schedule: { cron: '30 2 * * *', timezone: 'Europe/Berlin' } });
		const clock = scheduler(fakeRunner(env), {
			config: { ...CONFIG, catchupWindowMs: 3 * 60 * MINUTE, maxConcurrentRuns: 0 },
		});
		now = Date.parse(first);
		expect(await clock.tick()).toMatchObject({ fired: 1, errors: 0 });
		now = Date.parse(second);
		expect(await clock.tick()).toMatchObject({ fired: 0, repaired: 0, skipped: 0, errors: 0 });
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toMatchObject([
			{ scheduled_for: occurrence },
		]);
	});

	it('reads source metadata once and does not load the readme when firing', async () => {
		await createJob();
		const get = vi.spyOn(env.bucket, 'get');
		const s = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });

		expect((await s.tick()).fired).toBe(1);

		const nb = paths.project(pid).notebook(nid);
		const reads = get.mock.calls.map(([key]) => key);
		expect(reads.filter((key) => key === nb.source)).toHaveLength(1);
		expect(reads).not.toContain(nb.readme);
		expect(reads).not.toContain(nb.code);
	});

	it.each(['notebook', 'project'] as const)(
		'cancels a fire already in progress when its %s is deleted',
		async (parent) => {
			const job = await createJob();
			const blocked = Promise.withResolvers<void>();
			const claiming = Promise.withResolvers<void>();
			const claimOccurrence = env.jobRuns.claimOccurrence.bind(env.jobRuns);
			vi.spyOn(env.jobRuns, 'claimOccurrence').mockImplementationOnce(async (...args) => {
				claiming.resolve();
				await blocked.promise;
				return claimOccurrence(...args);
			});
			const s = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
			const ticking = s.tick();
			await claiming.promise;
			if (parent === 'notebook') await env.notebooks.deleteNotebook(pid, nid, ACTOR);
			else await env.projects.deleteProject(pid, ACTOR);

			const mutation = vi.spyOn(env.jobRuns, 'withJobMutation');
			let cancellationComplete = false;
			const cancelling = (
				parent === 'notebook'
					? env.jobRuns.cancelRunsOfNotebook(pid, nid, ACTOR)
					: env.jobRuns.cancelRunsOfProject(pid, ACTOR)
			).then((result) => {
				cancellationComplete = true;
				return result;
			});
			try {
				await vi.waitFor(() => expect(mutation).toHaveBeenCalled());
				expect(cancellationComplete).toBe(false);
			} finally {
				blocked.resolve();
				await ticking;
				await cancelling;
			}

			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toMatchObject([{ status: 'cancelled' }]);
			now += MINUTE;
			expect((await s.tick()).fired).toBe(0);
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
		},
	);

	it.each(['notebook', 'project'] as const)(
		'cancels a late enqueue after %s cancellation exhausts its wait',
		async (parent) => {
			const job = await createJob();
			const runner = fakeRunner(env);
			const s = scheduler(runner);
			const blocked = Promise.withResolvers<void>();
			const enqueuing = Promise.withResolvers<void>();
			const enqueue = env.jobRuns.enqueue.bind(env.jobRuns);
			vi.spyOn(env.jobRuns, 'enqueue').mockImplementationOnce(async (...args) => {
				enqueuing.resolve();
				await blocked.promise;
				return enqueue(...args);
			});
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.useFakeTimers();
			const ticking = s.tick();
			try {
				await enqueuing.promise;
				if (parent === 'notebook') await env.notebooks.deleteNotebook(pid, nid, ACTOR);
				else await env.projects.deleteProject(pid, ACTOR);
				const cancellation =
					parent === 'notebook'
						? env.jobRuns.cancelRunsOfNotebook(pid, nid, ACTOR)
						: env.jobRuns.cancelRunsOfProject(pid, ACTOR);
				await vi.advanceTimersByTimeAsync(5000);
				expect(await cancellation).toEqual({ runs: [], sandboxIds: [] });
				expect(
					error.mock.calls.some(([line]) => String(line).includes('job_operation_wait_failed')),
				).toBe(true);
				expect(await env.jobRuns.listActive()).toEqual([]);
			} finally {
				blocked.resolve();
				await ticking;
				vi.useRealTimers();
				error.mockRestore();
			}

			expect(runner.executed).toEqual([]);
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toMatchObject([{ status: 'cancelled' }]);
		},
	);

	it.each(['metadata read', 'cancellation write'] as const)(
		'keeps deleted-notebook runs undispatched while a %s fails',
		async (failure) => {
			const job = await createJob({ schedule: undefined });
			await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.notebooks.deleteNotebook(pid, nid, ACTOR);
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const failingOperation =
				failure === 'metadata read'
					? vi.spyOn(env.notebooks, 'getNotebookMeta').mockRejectedValue(new Error('bucket down'))
					: vi.spyOn(env.jobRuns, 'cancel').mockRejectedValue(new Error('bucket down'));
			const runner = fakeRunner(env);
			const s = scheduler(runner);
			try {
				const result = await s.tick();
				expect(result.dispatched).toBe(0);
				expect(result.errors).toBeGreaterThan(0);
				expect(runner.executed).toEqual([]);
				expect(await env.jobRuns.listRuns(pid, nid, job.id)).toMatchObject([{ status: 'queued' }]);
				expect(await env.jobRuns.listActive()).toHaveLength(1);
				failingOperation.mockRestore();
				expect(await s.tick()).toMatchObject({ dispatched: 0 });
				expect(await env.jobRuns.listRuns(pid, nid, job.id)).toMatchObject([
					{ status: 'cancelled' },
				]);
				expect(runner.executed).toEqual([]);
			} finally {
				failingOperation.mockRestore();
				error.mockRestore();
			}
		},
	);

	it('shares admission reads across queued runs and refreshes them on the next tick', async () => {
		const jobs = [
			await createJob({ schedule: undefined }),
			await createJob({ name: 'second', schedule: undefined }),
		];
		for (const job of jobs) {
			for (let index = 0; index < 3; index++) {
				await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			}
		}
		const projectReads = vi.spyOn(env.projects, 'getProject');
		const notebookReads = vi.spyOn(env.notebooks, 'getNotebookMeta');
		const jobReads = vi.spyOn(env.jobs, 'getJob');
		const s = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });

		expect((await s.tick()).dispatched).toBe(0);

		expect(projectReads).toHaveBeenCalledTimes(1);
		expect(notebookReads).toHaveBeenCalledTimes(1);
		expect(jobReads).toHaveBeenCalledTimes(jobs.length);
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect((await s.tick()).dispatched).toBe(0);
		for (const job of jobs) {
			expect((await env.jobRuns.listRuns(pid, nid, job.id)).map((run) => run.status)).toEqual([
				'cancelled',
				'cancelled',
				'cancelled',
			]);
		}
	});

	it('admits healthy runs when another notebook metadata read fails', async () => {
		const brokenJob = await createJob({ schedule: undefined });
		const broken = await env.jobRuns.enqueue({
			job: brokenJob,
			trigger: 'manual',
			timeoutSeconds: 60,
		});
		const healthyNotebook = await env.notebooks.createNotebook(
			pid,
			{ title: 'healthy', description: '', code: 'import marimo' },
			ACTOR,
		);
		const healthyJob = await env.jobs.createJob(
			pid,
			healthyNotebook.id,
			{ name: 'healthy' },
			ACTOR,
		);
		const healthy = await env.jobRuns.enqueue({
			job: healthyJob,
			trigger: 'manual',
			timeoutSeconds: 60,
		});
		const getMeta = env.notebooks.getNotebookMeta.bind(env.notebooks);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const read = vi
			.spyOn(env.notebooks, 'getNotebookMeta')
			.mockImplementation((project, notebook) => {
				if (notebook === nid) return Promise.reject(new Error('metadata unavailable'));
				return getMeta(project, notebook);
			});
		const runner = fakeRunner(env);
		const s = scheduler(runner);
		try {
			const result = await s.tick();
			await s.drain();
			expect(result.dispatched).toBe(1);
			expect(result.errors).toBeGreaterThan(0);
			expect(runner.executed.map((run) => run.run_id)).toEqual([healthy.run_id]);
			expect((await env.jobRuns.getRun(pid, nid, brokenJob.id, broken.run_id)).status).toBe(
				'queued',
			);
			expect(
				(await env.jobRuns.getRun(pid, healthyNotebook.id, healthyJob.id, healthy.run_id)).status,
			).toBe('succeeded');
		} finally {
			read.mockRestore();
			error.mockRestore();
		}
	});

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

	it('does not recreate job state when deletion starts after an occurrence claim', async () => {
		const job = await createJob();
		let occurrenceClaimed!: () => void;
		const claimed = new Promise<void>((resolve) => {
			occurrenceClaimed = resolve;
		});
		let resumeClaim!: () => void;
		const claimPaused = new Promise<void>((resolve) => {
			resumeClaim = resolve;
		});
		const claimOccurrence = env.jobRuns.claimOccurrence.bind(env.jobRuns);
		vi.spyOn(env.jobRuns, 'claimOccurrence').mockImplementation(async (...args) => {
			const result = await claimOccurrence(...args);
			occurrenceClaimed();
			await claimPaused;
			return result;
		});

		const s = scheduler(fakeRunner(env), {
			config: NO_DISPATCH_CONFIG,
		});
		const ticking = s.tick();
		await claimed;
		let deletionEntered = false;
		const deleting = env.jobRuns
			.withJobMutation(job, async () => {
				deletionEntered = true;
				const fenced = await env.jobs.beginDelete(pid, nid, job.id, ACTOR, job.updated_at);
				const cancelled = await env.jobRuns.cancelRunsOfJob(fenced, ACTOR);
				for (const run of cancelled.runs) await env.jobRuns.deleteMarker(run);
			})
			.then(() => env.jobs.finishDelete(pid, nid, job.id));
		await Promise.resolve();
		expect(deletionEntered).toBe(false);

		resumeClaim();
		await Promise.all([ticking, deleting]);
		expect(await env.jobRuns.listActive()).toEqual([]);
		expect(
			(
				await env.bucket.list({
					prefix: paths.project(pid).notebook(nid).job(job.id).base,
				})
			).objects,
		).toEqual([]);
		expect(await env.jobs.isDeleting(job)).toBe(false);
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

	it('serializes concurrent finalizers so a failed run creates one retry', async () => {
		const job = await createJob({
			schedule: undefined,
			retry: { max_retries: 1, backoff_seconds: 0 },
		});
		const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		const failed = await env.jobRuns.transition(run, 'fail', () => ({
			finished_at: new Date(now).toISOString(),
			error: { code: 'NOTEBOOK_FAILED', message: 'boom' },
		}));
		expect(failed.transitioned).toBe(true);

		let auditEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			auditEntered = resolve;
		});
		let releaseAudit!: () => void;
		const blocked = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		const append = env.events.append.bind(env.events);
		let pause = true;
		vi.spyOn(env.events, 'append').mockImplementation(async (...args) => {
			if (pause && args[0].event === 'job.run.finish') {
				pause = false;
				auditEntered();
				await blocked;
			}
			return append(...args);
		});

		const a = scheduler(fakeRunner(env), { events: env.events });
		const b = scheduler(fakeRunner(env), { events: env.events });
		const firstTick = a.tick();
		await entered;
		const secondTick = b.tick();
		releaseAudit();
		await Promise.all([firstTick, secondTick]);

		const runs = await env.jobRuns.listRuns(pid, nid, job.id);
		expect(runs.filter((candidate) => candidate.retry_of === run.run_id)).toHaveLength(1);
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).toBeNull();
		const events = await env.events.getEvents(new Date(now).toISOString().slice(0, 10));
		expect(events.filter((event) => event.run_id === run.run_id)).toHaveLength(1);
	});

	it('retries partial alert delivery before deleting the finalization marker', async () => {
		const deliver = vi
			.fn<ProjectAlertDispatcher['deliver']>()
			.mockResolvedValueOnce('partial')
			.mockResolvedValueOnce('delivered');
		const job = await createJob({ schedule: undefined, notifications: { on: ['success'] } });
		const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		const s = scheduler(fakeRunner(env), {
			projectAlerts: { deliver, test: vi.fn() },
		});

		await s.tick();
		await settle(s);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();

		await s.tick();
		expect(deliver).toHaveBeenCalledTimes(2);
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).toBeNull();
	});

	it('does not fire jobs of soft-deleted notebooks or disabled jobs', async () => {
		await createJob({ enabled: false });
		const disabledOnly = await scheduler(fakeRunner(env)).tick();
		expect(disabledOnly.fired).toBe(0);
		await createJob({ name: 'live' });
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect((await scheduler(fakeRunner(env)).tick()).fired).toBe(0);
	});

	it('waits for snapshot publication before firing a newly enabled job', async () => {
		const job = await createJob();
		await env.catalog.updateNotebookEntry('test.jobs.stale', ACTOR, pid, nid, (notebook) => ({
			jobs: (notebook.jobs ?? []).map((entry) =>
				entry.id === job.id
					? { id: entry.id, enabled: false, updated_at: entry.updated_at }
					: entry,
			),
		}));
		const s = scheduler(fakeRunner(env), {
			config: NO_DISPATCH_CONFIG,
		});

		expect(await s.tick()).toMatchObject({ fired: 0, errors: 0 });
		await env.jobs.updateJob(pid, nid, job.id, { enabled: true }, ACTOR);
		expect(await s.tick()).toMatchObject({ fired: 1, errors: 0 });
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
	});

	it.each([
		{ legacy: false, rollback: false },
		{ legacy: false, rollback: true },
		{ legacy: true, rollback: false },
		{ legacy: true, rollback: true },
	])(
		'waits for reschedule publication (legacy=$legacy, rollback=$rollback)',
		async ({ legacy, rollback }) => {
			const job = await createJob({ schedule: { cron: '55 5 * * *', timezone: 'UTC' } });
			if (legacy) {
				await env.catalog.updateNotebookEntry('test.jobs.legacy', ACTOR, pid, nid, (notebook) => ({
					jobs: notebook.jobs!.map((entry) => ({ ...entry, updated_at: undefined })),
				}));
			}
			const publishing = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const publicationError = new Error('snapshot publication failed');
			const publish = env.catalog.updateNotebookEntry.bind(env.catalog);
			vi.spyOn(env.catalog, 'updateNotebookEntry').mockImplementationOnce(async (...args) => {
				publishing.resolve();
				await release.promise;
				if (rollback) throw publicationError;
				return publish(...args);
			});
			const updating = env.jobs
				.updateJob(
					pid,
					nid,
					job.id,
					{
						schedule: { cron: '0 6 * * *', timezone: 'UTC' },
					},
					ACTOR,
				)
				.then(
					() => null,
					(error) => error,
				);
			const claim = vi.spyOn(env.jobRuns, 'claimOccurrence');
			const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
			try {
				await publishing.promise;
				const head = await env.jobs.getJob(pid, nid, job.id);
				expect(head.updated_at).not.toBe(job.updated_at);
				expect(head.schedule).toEqual({ cron: '0 6 * * *', timezone: 'UTC' });
				expect(await clock.tick()).toMatchObject({ fired: 0, skipped: 0, repaired: 0, errors: 0 });
				expect(claim).not.toHaveBeenCalled();
				expect(await env.jobRuns.listRuns(pid, nid, job.id)).toEqual([]);
			} finally {
				release.resolve();
				await updating;
			}
			expect(await updating).toBe(rollback ? publicationError : null);
			expect(await clock.tick()).toMatchObject({ fired: 1, errors: 0 });
			expect(await clock.tick()).toMatchObject({ fired: 0, skipped: 0, repaired: 0, errors: 0 });
			expect(await env.jobRuns.listRuns(pid, nid, job.id)).toMatchObject([
				{
					scheduled_for: rollback ? '2026-09-02T05:55:00.000Z' : '2026-09-02T06:00:00.000Z',
				},
			]);
		},
	);

	it('republishes a head whose index publication was lost after the grace period', async () => {
		const job = await createJob();
		const head = paths.project(pid).notebook(nid).job(job.id).head;
		const updatedAt = new Date(Date.parse(job.updated_at) + 1000).toISOString();
		await env.bucket.put(head, JSON.stringify({ ...job, name: 'renamed', updated_at: updatedAt }));
		const republish = vi.spyOn(env.jobs, 'republishIndex');
		const s = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
		now = Date.parse(updatedAt) + 2 * CONFIG.catchupWindowMs - 1;
		expect(await s.tick()).toMatchObject({ fired: 0, errors: 0 });
		expect(republish).not.toHaveBeenCalled();
		now += 1;
		expect(await s.tick()).toMatchObject({ fired: 0, errors: 0 });
		expect(republish).toHaveBeenCalledOnce();
		expect(await s.tick()).toMatchObject({ fired: 1, errors: 0 });
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
	});

	it('republishes a re-enabled head whose index entry is still disabled', async () => {
		const job = await env.jobs.updateJob(
			pid,
			nid,
			(await createJob()).id,
			{ enabled: false },
			ACTOR,
		);
		const head = paths.project(pid).notebook(nid).job(job.id).head;
		const updatedAt = new Date(Date.parse(job.updated_at) + 1000).toISOString();
		await env.bucket.put(head, JSON.stringify({ ...job, enabled: true, updated_at: updatedAt }));
		const s = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
		now = Date.parse(updatedAt) + CONFIG.catchupWindowMs;
		expect(await s.tick()).toMatchObject({ fired: 0, errors: 0 });
		now += CONFIG.catchupWindowMs;
		expect(await s.tick()).toMatchObject({ fired: 0, errors: 0 });
		const entry = (await env.catalog.getCurrentSnapshot()).projects
			.find((p) => p.id === pid)!
			.notebooks.find((n) => n.id === nid)!
			.jobs!.find((j) => j.id === job.id)!;
		expect(entry).toMatchObject({ enabled: true, updated_at: updatedAt });
		expect(await s.tick()).toMatchObject({ fired: 1, errors: 0 });
	});

	it('rotates a bounded idle index recovery window once per catch-up window', async () => {
		for (let i = 0; i < 30; i++) await createJob({ enabled: false });
		const getJob = vi.spyOn(env.jobs, 'getJob');
		const s = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });
		await s.tick();
		expect(getJob).not.toHaveBeenCalled();
		now += CONFIG.catchupWindowMs;
		await s.tick();
		await s.tick();
		expect(getJob).toHaveBeenCalledTimes(25);
		now += CONFIG.catchupWindowMs;
		await s.tick();
		expect(getJob).toHaveBeenCalledTimes(50);
		expect(new Set(getJob.mock.calls.map(([, , id]) => id)).size).toBe(30);
	});

	it('republishes the index when a failed update cannot roll back its head', async () => {
		const job = await createJob();
		const head = paths.project(pid).notebook(nid).job(job.id).head;
		const publicationError = new Error('snapshot publication failed');
		vi.spyOn(env.catalog, 'updateNotebookEntry').mockRejectedValueOnce(publicationError);
		const put = env.bucket.put.bind(env.bucket);
		let headWrites = 0;
		vi.spyOn(env.bucket, 'put').mockImplementation((key, ...args) => {
			if (key === head && ++headWrites === 2) throw new Error('rollback failed');
			return put(key, ...args);
		});
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(env.jobs.updateJob(pid, nid, job.id, { name: 'renamed' }, ACTOR)).rejects.toBe(
			publicationError,
		);
		log.mockRestore();
		const updated = await env.jobs.getJob(pid, nid, job.id);
		expect(updated.name).toBe('renamed');
		const entry = (await env.catalog.getCurrentSnapshot()).projects
			.find((p) => p.id === pid)!
			.notebooks.find((n) => n.id === nid)!
			.jobs!.find((j) => j.id === job.id)!;
		expect(entry.updated_at).toBe(updated.updated_at);
	});

	it('rejects a stale snapshot version even when the schedule has not changed', async () => {
		const job = await createJob();
		const snapshot = await env.catalog.getCurrentSnapshot();
		await env.jobs.updateJob(pid, nid, job.id, { parameters: { value: 'new' } }, ACTOR);
		vi.spyOn(env.catalog, 'getCurrentSnapshot').mockResolvedValueOnce(snapshot);
		const claim = vi.spyOn(env.jobRuns, 'claimOccurrence');
		const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });

		expect(await clock.tick()).toMatchObject({ fired: 0, errors: 0 });
		expect(claim).not.toHaveBeenCalled();
		expect(await clock.tick()).toMatchObject({ fired: 1, errors: 0 });
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toMatchObject([
			{ parameters: { value: 'new' } },
		]);
	});

	it.each([false, true])('checks legacy snapshot timezones (changed=%s)', async (changed) => {
		const job = await createJob();
		await env.catalog.updateNotebookEntry('test.jobs.legacy', ACTOR, pid, nid, (notebook) => ({
			jobs: notebook.jobs!.map((entry) => ({ ...entry, updated_at: undefined })),
		}));
		const snapshot = await env.catalog.getCurrentSnapshot();
		if (changed) {
			await env.jobs.updateJob(
				pid,
				nid,
				job.id,
				{
					schedule: { cron: '* * * * *', timezone: 'Asia/Kathmandu' },
				},
				ACTOR,
			);
		}
		vi.spyOn(env.catalog, 'getCurrentSnapshot').mockResolvedValueOnce(snapshot);
		const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });

		expect(await clock.tick()).toMatchObject({ fired: changed ? 0 : 1, errors: 0 });
		expect(await clock.tick()).toMatchObject({ fired: changed ? 1 : 0, errors: 0 });
		expect(await env.jobRuns.listRuns(pid, nid, job.id)).toHaveLength(1);
	});

	it('scans active-run storage a constant number of times per tick', async () => {
		for (let index = 0; index < 3; index++) await createJob({ name: `job ${index}` });
		const listActive = vi.spyOn(env.jobRuns, 'listActiveSnapshot');
		const s = scheduler(fakeRunner(env), {
			config: NO_DISPATCH_CONFIG,
		});

		expect(await s.tick()).toMatchObject({ fired: 3, errors: 0 });
		expect(listActive).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])(
		'resumes bounded job retention and retries failures after wrapping (failure: %s)',
		async (fails) => {
			for (let i = 0; i < 129; i++) await createJob({ name: `job-${i}` });
			const prune = vi.spyOn(env.jobRuns, 'pruneJob').mockImplementation(async () => {
				if (fails) throw new Error('storage unavailable');
				return 0;
			});
			await scheduler(fakeRunner(env)).prune(DAY);
			expect(prune).toHaveBeenCalledTimes(128);
			const first = new Set(prune.mock.calls.map(([job]) => job.id));
			prune.mockClear();
			await scheduler(fakeRunner(env)).prune(DAY);
			expect(prune).toHaveBeenCalledOnce();
			expect(first.has(prune.mock.calls[0][0].id)).toBe(false);
			prune.mockClear();
			await scheduler(fakeRunner(env)).prune(DAY);
			expect(new Set(prune.mock.calls.map(([job]) => job.id))).toEqual(first);
		},
	);

	it('prunes terminal runs past retention and stale markers', async () => {
		const job = await createJob({ schedule: undefined });
		const old = await env.jobRuns.enqueue({
			job,
			trigger: 'manual',
			timeoutSeconds: 60,
			runId: RunId.parse(`run_${ulid(now - 40 * DAY)}`),
		});
		await env.jobRuns.transition(old, 'fail', () => ({
			finished_at: new Date(now - 40 * 24 * 60 * MINUTE).toISOString(),
		}));
		await env.jobRuns.deleteMarker(old);
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

		it('audits watchdog timeouts and recovers cancellation auditing', async () => {
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
			const cancelled = await env.jobRuns.enqueue({
				job,
				trigger: 'manual',
				timeoutSeconds: 60,
			});
			const s = scheduler(cancelledRunner, { events: env.events });
			await s.tick();
			await settle(s);
			const terminalRuns = await Promise.all(
				[overdue, cancelled].map((run) => env.jobRuns.getRun(pid, nid, job.id, run.run_id)),
			);
			const dates = new Set(
				terminalRuns.map((run) => (run.finished_at ?? run.queued_at).slice(0, 10)),
			);
			const events = (
				await Promise.all([...dates].map((date) => env.events.getEvents(date)))
			).flat();
			const statuses = events
				.filter((e) => e.event === 'job.run.finish')
				.map((e) => String(e.status))
				.sort();
			expect(statuses).toEqual(['cancelled', 'timed_out']);
		});

		it('retries durable finalization when the audit sink recovers', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const append = vi.spyOn(env.events, 'append').mockRejectedValue(new Error('bucket down'));
			const s = scheduler(fakeRunner(env), { events: env.events });
			await s.tick();
			await settle(s);
			expect((await env.jobRuns.getRun(pid, nid, job.id, run.run_id)).status).toBe('succeeded');
			expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();

			append.mockRestore();
			await s.tick();
			expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).toBeNull();
			const events = (await env.events.getEvents(today())).filter(
				(event) => event.event === 'job.run.finish' && event.run_id === run.run_id,
			);
			expect(events).toHaveLength(1);
		});
	});

	describe('unhappy paths', () => {
		beforeEach(() => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it.each([0, DAY])(
			'ignores invalid cron with an index %i ms old and keeps ticking',
			async (age) => {
				const bad = await createJob({
					name: 'bad',
					schedule: { cron: '0 6 * * *', timezone: 'UTC' },
				});
				const key = paths.project(pid).notebook(nid).job(bad.id).head;
				await env.bucket.put(
					key,
					JSON.stringify({ ...bad, schedule: { cron: 'nope', timezone: 'UTC' } }),
				);
				await env.catalog.updateNotebookEntry(
					'test.invalid-schedule',
					ACTOR,
					pid,
					nid,
					(notebook) => ({
						jobs: (notebook.jobs ?? []).map((entry) => ({
							...entry,
							schedule: { cron: 'nope', timezone: 'UTC' },
							updated_at: new Date(now - age).toISOString(),
						})),
					}),
				);
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
			},
		);

		it.each(['cron', 'timezone'] as const)(
			'isolates an invalid snapshot %s before reading its job and recovers after publication',
			async (field) => {
				const broken = await createJob({ name: 'broken' });
				const healthy = await createJob({ name: 'healthy' });
				const snapshot = structuredClone(await env.catalog.getCurrentSnapshot());
				const entry = snapshot.projects
					.find((project) => project.id === pid)!
					.notebooks.find((notebook) => notebook.id === nid)!
					.jobs!.find((job) => job.id === broken.id)!;
				entry.schedule = invalidSchedule(field);
				vi.spyOn(env.catalog, 'getCurrentSnapshot').mockResolvedValueOnce(snapshot);
				const getJob = vi.spyOn(env.jobs, 'getJob');
				const clock = scheduler(fakeRunner(env), { config: NO_DISPATCH_CONFIG });

				expect(await clock.tick()).toMatchObject({ fired: 1, errors: field === 'cron' ? 0 : 1 });
				expect(getJob.mock.calls.map(([, , id]) => id)).not.toContain(broken.id);
				expect(await env.jobRuns.listRuns(pid, nid, healthy.id)).toHaveLength(1);
				expect(await env.jobRuns.listRuns(pid, nid, broken.id)).toHaveLength(0);
				expect(await clock.tick()).toMatchObject({ fired: 1, errors: 0 });
				expect(await env.jobRuns.listRuns(pid, nid, healthy.id)).toHaveLength(1);
				expect(await env.jobRuns.listRuns(pid, nid, broken.id)).toHaveLength(1);
			},
		);

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

		it('repairs a claimed forbid outcome as skipped', async () => {
			const job = await createJob();
			const active = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.jobRuns.transition(active, 'provision');
			vi.spyOn(env.jobRuns, 'writeSkipped').mockRejectedValueOnce(new Error('bucket down'));
			const s = scheduler(fakeRunner(env));
			expect((await s.tick()).errors).toBe(1);
			const repaired = await s.tick();
			expect(repaired).toMatchObject({ repaired: 1, fired: 0, dispatched: 0 });
			expect(
				(await env.jobRuns.listRuns(pid, nid, job.id)).map((run) => run.status).sort(),
			).toEqual(['provisioning', 'skipped']);
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
						continuation_run_id: createRunId(),
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

		it('continues known-run cleanup when a stale-marker existence check fails', async () => {
			const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
			const job = await createJob({ schedule: undefined });
			const missing = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.bucket.delete(
				paths.project(pid).notebook(nid).job(job.id).run(missing.run_id).record,
			);
			now = Date.parse(missing.queued_at) + 30 * MINUTE;
			const queued = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const terminal = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.jobRuns.cancel(terminal, ACTOR);
			const expired = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.jobRuns.transition(expired, 'provision', () => ({
				sandbox_id: SB,
				deadline_at: new Date(now - 2 * MINUTE).toISOString(),
			}));
			vi.spyOn(env.jobRuns, 'runExists').mockRejectedValueOnce(new Error('head unavailable'));
			const runner = fakeRunner(env);
			const s = scheduler(runner);

			expect(await s.tick()).toMatchObject({
				dispatched: 0,
				timedOut: 1,
				markersPruned: 1,
				errors: 1,
			});
			expect(await env.bucket.head(paths.jobRunMarker(pid, missing.run_id))).not.toBeNull();
			expect(await env.bucket.head(paths.jobRunMarker(pid, terminal.run_id))).toBeNull();
			expect(await env.bucket.head(paths.jobRunMarker(pid, expired.run_id))).toBeNull();
			expect((await env.jobRuns.getRun(pid, nid, job.id, queued.run_id)).status).toBe('queued');
			expect((await env.jobRuns.getRun(pid, nid, job.id, expired.run_id)).status).toBe('timed_out');
			expect(runner.executed).toHaveLength(0);
			expect(
				errorLog.mock.calls.some(([message]) =>
					String(message).includes('job_run_marker_prune_failed'),
				),
			).toBe(true);
		});

		it('preserves a stale marker when its run record is unreadable', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const job = await createJob({ schedule: undefined });
			const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			await env.bucket.put(
				paths.project(pid).notebook(nid).job(job.id).run(run.run_id).record,
				'corrupt record',
			);
			now = Date.parse(run.queued_at) + 30 * MINUTE;
			const s = scheduler(fakeRunner(env));
			expect((await s.tick()).markersPruned).toBe(0);
			expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
			expect((await env.jobRuns.listActiveSnapshot()).complete).toBe(false);
		});

		it('blocks new work with incomplete ownership while reclaiming known expired runs', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const scheduled = await createJob();
			const manual = await createJob({ schedule: undefined });
			const queued = await env.jobRuns.enqueue({
				job: manual,
				trigger: 'manual',
				timeoutSeconds: 60,
			});
			const expired = await env.jobRuns.enqueue({
				job: manual,
				trigger: 'manual',
				timeoutSeconds: 60,
			});
			await env.jobRuns.transition(expired, 'provision', () => ({
				sandbox_id: SB,
				deadline_at: new Date(now - 2 * MINUTE).toISOString(),
			}));
			await env.bucket.put(paths.jobRunMarker(pid, createRunId()), 'corrupt marker');
			const runner = fakeRunner(env);
			const s = scheduler(runner);

			expect(await s.tick()).toMatchObject({ fired: 0, dispatched: 0, timedOut: 1, errors: 1 });
			expect(runner.executed).toHaveLength(0);
			expect(await env.jobRuns.listRuns(pid, nid, scheduled.id)).toEqual([]);
			expect((await env.jobRuns.getRun(pid, nid, manual.id, queued.run_id)).status).toBe('queued');
			expect((await env.jobRuns.getRun(pid, nid, manual.id, expired.run_id)).status).toBe(
				'timed_out',
			);
			expect(await env.bucket.head(paths.jobRunMarker(pid, expired.run_id))).toBeNull();
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
			expect(result).toMatchObject({ fired: 0, skipped: 1, dispatched: 1 });
			const runs = await env.jobRuns.listRuns(pid, nid, job.id);
			expect(runs).toHaveLength(2);
			expect(runs.filter((run) => run.status === 'skipped')).toHaveLength(1);
			expect(
				runs.filter((run) => ['queued', 'provisioning', 'running'].includes(run.status)),
			).toHaveLength(1);
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
				const run = await env.jobRuns.enqueue({
					job,
					trigger: 'manual',
					timeoutSeconds: 60,
					runId: RunId.parse(`run_${ulid(now - 60 * DAY)}`),
				});
				await env.jobRuns.transition(run, 'fail', () => ({
					finished_at: new Date(now - 60 * 24 * 60 * MINUTE).toISOString(),
				}));
				await env.jobRuns.deleteMarker(run);
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

	it('prunes both a dangling marker and its run-index entry', async () => {
		const job = await createJob({ schedule: undefined });
		const orphan = createRunId();
		const indexKey = paths.project(pid).notebook(nid).job(job.id).runIndex(orphan);
		await env.bucket.put(
			paths.jobRunMarker(pid, orphan),
			JSON.stringify({
				run_id: orphan,
				continuation_run_id: createRunId(),
				job_id: job.id,
				notebook_id: nid,
				project_id: pid,
				created_at: new Date(now - 30 * MINUTE).toISOString(),
			}),
		);
		await env.bucket.put(indexKey, '');

		const s = scheduler(fakeRunner(env, 'succeed', () => now));
		expect((await s.tick()).markersPruned).toBe(1);

		expect(await env.bucket.head(paths.jobRunMarker(pid, orphan))).toBeNull();
		expect(await env.bucket.head(indexKey)).toBeNull();
	});

	it('retains completed occurrences throughout the catch-up window', async () => {
		const config = { ...CONFIG, catchupWindowMs: 3 * DAY };
		const job = await createJob({ schedule: { cron: '0 6 * * wed', timezone: 'UTC' } });
		const runner = fakeRunner(env, 'succeed', () => now);
		const s = scheduler(runner, { config });

		expect((await s.tick()).fired).toBe(1);
		await s.drain();
		const [firstRun] = await env.jobRuns.listRuns(pid, nid, job.id);
		expect(firstRun.status).toBe('succeeded');
		expect(firstRun.scheduled_for).toBe('2026-09-02T06:00:00.000Z');

		// Two days later — still inside the 3-day catch-up window, and past a 1-day
		// run retention; the catch-up window must still protect the completed run.
		now = Date.parse('2026-09-04T12:00:00.000Z');
		expect(await s.prune(DAY)).toMatchObject({ runsPruned: 0 });

		const second = await s.tick();
		await s.drain();
		expect(second.repaired).toBe(0);
		expect(runner.executed).toHaveLength(1);
	});

	it('does not retry a notebook soft-deleted before finalization', async () => {
		const job = await createJob({
			schedule: undefined,
			retry: { max_retries: 2, backoff_seconds: 0 },
		});
		const run = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		// A crash between the terminal CAS and finalization leaves the marker behind.
		await env.jobRuns.transition(run, 'fail', () => ({
			finished_at: new Date(now).toISOString(),
			error: { code: 'NOTEBOOK_FAILED', message: 'boom' },
		}));
		await env.jobRuns.cancelRunsOfNotebook(pid, nid, ACTOR);
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);

		const s = scheduler(fakeRunner(env, 'succeed', () => now));
		await s.tick();
		await s.drain();

		expect((await env.jobRuns.listRuns(pid, nid, job.id)).map((r) => r.run_id)).toEqual([
			run.run_id,
		]);
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
