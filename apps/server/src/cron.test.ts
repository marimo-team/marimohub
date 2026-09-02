import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import type { ApiDeps, SessionLifetimeConfig } from '@marimo-hub/api';
import type * as CoreModule from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import {
	createSandboxId,
	MaintenanceLock,
	Millis,
	paths,
	reapFilesystemSnapshots,
	ReconciliationService,
	SessionLifecycleService,
} from '@marimo-hub/core';
import type { SweepResult } from '@marimo-hub/core';
import { ACTOR, makeNotebookMeta, makeProject, makeSession } from '@marimo-hub/core/testing';
import { startJobScheduler, startMaintenance, startSessionLifecycle } from './cron';
import { WideEventMetrics } from './metrics';

vi.mock('@marimo-hub/core', async (importOriginal) => {
	const actual = await importOriginal<typeof CoreModule>();
	return { ...actual, reapFilesystemSnapshots: vi.fn(actual.reapFilesystemSnapshots) };
});

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Flush the initial (non-timer) `void run()` call, whose awaits are microtasks. */
async function flushRun() {
	await vi.advanceTimersByTimeAsync(0);
}

function parseLoggedEvents(logSpy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
	return logSpy.mock.calls.map(
		(call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
	);
}

describe('startMaintenance', () => {
	let bucket: MemoryBucket;
	let deps: ApiDeps;
	let metrics: WideEventMetrics;
	let stop: () => void;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vi.useFakeTimers();
		bucket = await createInitializedBucket();
		deps = makeTestDeps(bucket);
		metrics = new WideEventMetrics();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		stop?.();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('emits exactly one maintenance_cycle wide event per run', async () => {
		metrics.increment('sessions_created');
		stop = startMaintenance(deps, metrics);
		await flushRun();

		const events = parseLoggedEvents(logSpy);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: 'maintenance_cycle',
			sessions_expired: 0,
			invite_rows_claimed: 0,
			projects_swept: 0,
			notebooks_swept: 0,
			'counter.sessions_created': 1,
		});
	});

	it('prunes job history in the maintenance cycle and reports the counts', async () => {
		const project = await deps.services.projects.createProject(
			{ name: 'p', description: '' },
			ACTOR,
		);
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		const job = await deps.services.jobs.createJob(project.id, notebook.id, { name: 'j' }, ACTOR);
		const old = await deps.services.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
		await deps.services.jobRuns.transition(old, 'fail', () => ({
			finished_at: new Date(Date.now() - 60 * 24 * 3_600_000).toISOString(),
		}));

		stop = startMaintenance(deps, metrics);
		await flushRun();

		expect(parseLoggedEvents(logSpy)[0]).toMatchObject({
			event: 'maintenance_cycle',
			job_runs_pruned: 1,
			job_run_markers_pruned: 0,
		});
		expect(await deps.services.jobRuns.listRuns(project.id, notebook.id, job.id)).toEqual([]);
	});

	it('skips job pruning when jobs are off', async () => {
		const prune = vi.spyOn(deps.services.jobRuns, 'pruneJob');
		stop = startMaintenance({ ...deps, jobs: undefined }, metrics);
		await flushRun();

		expect(prune).not.toHaveBeenCalled();
		expect(parseLoggedEvents(logSpy)[0]).toMatchObject({
			event: 'maintenance_cycle',
			job_runs_pruned: 0,
			job_run_markers_pruned: 0,
		});
	});

	it('claims pending invite rows during the maintenance cycle', async () => {
		const claimSpy = vi.spyOn(deps.services.projects, 'claimPendingInvites').mockResolvedValue(2);

		stop = startMaintenance(deps, metrics);
		await flushRun();

		expect(claimSpy).toHaveBeenCalledOnce();
		expect(parseLoggedEvents(logSpy)[0]).toMatchObject({ invite_rows_claimed: 2 });
	});

	it('sweeps projects before notebooks (a deleted project reclaims its own notebooks)', async () => {
		const projectsSpy = vi.spyOn(deps.services.projects, 'sweepDeletedProjects');
		const notebooksSpy = vi.spyOn(deps.services.notebooks, 'sweepDeletedNotebooks');

		stop = startMaintenance(deps, metrics);
		await flushRun();

		expect(projectsSpy).toHaveBeenCalledOnce();
		expect(notebooksSpy).toHaveBeenCalledOnce();
		expect(projectsSpy.mock.invocationCallOrder[0]).toBeLessThan(
			notebooksSpy.mock.invocationCallOrder[0],
		);
	});

	it('contains a cycle failure and keeps the interval alive for the next cycle', async () => {
		const expireStale = vi.spyOn(deps.services.sessions, 'expireStale');
		expireStale.mockRejectedValueOnce(new Error('bucket unavailable'));

		stop = startMaintenance(deps, metrics);
		await flushRun();

		let events = parseLoggedEvents(logSpy);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ event: 'maintenance_failed', error: 'bucket unavailable' });

		logSpy.mockClear();
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);

		events = parseLoggedEvents(logSpy);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ event: 'maintenance_cycle' });
		expect(expireStale).toHaveBeenCalledTimes(2);
	});

	it('releases the lock after a failed cycle so the next cycle is not blocked', async () => {
		vi.spyOn(deps.services.sessions, 'expireStale').mockRejectedValueOnce(new Error('boom'));

		stop = startMaintenance(deps, metrics);
		await flushRun();
		logSpy.mockClear();
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);

		const events = parseLoggedEvents(logSpy);
		// Reaching `maintenance_cycle` (not `maintenance_skipped_not_leader`) proves
		// the failed cycle's `finally` released the lease.
		expect(events.map((e) => e.event)).toEqual(['maintenance_cycle']);
	});

	it('skips the cycle quietly when this replica is not the lease holder', async () => {
		vi.spyOn(MaintenanceLock.prototype, 'acquire').mockResolvedValue(false);
		const expireStale = vi.spyOn(deps.services.sessions, 'expireStale');

		stop = startMaintenance(deps, metrics);
		await flushRun();

		expect(expireStale).not.toHaveBeenCalled();
		const events = parseLoggedEvents(logSpy);
		expect(events).toEqual([expect.objectContaining({ event: 'maintenance_skipped_not_leader' })]);
	});

	it('guards against overlap: a hung cycle is not re-entered on the next tick', async () => {
		const acquireSpy = vi.spyOn(MaintenanceLock.prototype, 'acquire');
		const releaseSpy = vi.spyOn(MaintenanceLock.prototype, 'release');
		let resolveExpire!: (n: number) => void;
		const expireStale = vi.spyOn(deps.services.sessions, 'expireStale').mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveExpire = resolve;
				}),
		);

		stop = startMaintenance(deps, metrics);
		await flushRun();
		expect(expireStale).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS * 2);
		// Still hung: the overlap guard held — no second acquire, and crucially no
		// release while the first cycle is mid-run.
		expect(expireStale).toHaveBeenCalledTimes(1);
		expect(acquireSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).not.toHaveBeenCalled();
		expect(
			parseLoggedEvents(logSpy).filter((e) => e.event === 'maintenance_cycle_overlap_skipped'),
		).toHaveLength(2);

		resolveExpire(0);
		await flushRun();
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
		expect(expireStale).toHaveBeenCalledTimes(2);
	});

	it('forwards orphaned notebook snapshots to reapFilesystemSnapshots', async () => {
		const orphaned = [{ snapshot_id: 'snap-1', captured_at: new Date().toISOString() }];
		vi.spyOn(deps.services.notebooks, 'sweepDeletedNotebooks').mockResolvedValue({
			purged: 1,
			orphanedSnapshots: orphaned,
		});
		vi.mocked(reapFilesystemSnapshots).mockResolvedValueOnce(1);

		stop = startMaintenance(deps, metrics);
		await flushRun();

		expect(reapFilesystemSnapshots).toHaveBeenCalledWith(deps.compute, orphaned);
		const events = parseLoggedEvents(logSpy);
		expect(events[0]).toMatchObject({ notebooks_swept: 1, snapshots_reaped: 1 });
	});

	it('alerts once when reconciliation finds a running shared app without its sandbox', async () => {
		const session = makeSession({ mode: 'app', sandbox_id: createSandboxId() });
		const project = makeProject({ id: session.project_id });
		const notebook = makeNotebookMeta({
			id: session.notebook_id,
			project_id: session.project_id,
			title: 'Shared app',
		});
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue({
			skipped: false,
			reclaimed: 0,
			markedDead: 1,
			orphansReaped: 0,
			orphanSandboxIds: [],
			markedDeadSessions: [session],
		});
		vi.spyOn(deps.services.projects, 'getProject').mockResolvedValue(project);
		vi.spyOn(deps.services.notebooks, 'getNotebook').mockResolvedValue({ meta: notebook } as never);
		const deliver = vi.fn(async () => 'delivered' as const);
		deps.projectAlerts = {
			store: {} as never,
			dispatcher: { deliver, test: vi.fn() },
			maxDestinations: 10,
		};

		stop = startMaintenance(deps, metrics);
		await flushRun();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
		expect(deliver).toHaveBeenCalledWith(
			session.project_id,
			'app.unavailable',
			expect.objectContaining({
				kind: 'app.unavailable',
				data: expect.objectContaining({ session_id: session.session_id }),
			}),
		);
	});

	it('retries a transient metadata read before scheduling an unavailable-app alert', async () => {
		const session = makeSession({ mode: 'app', sandbox_id: createSandboxId() });
		const project = makeProject({ id: session.project_id });
		const notebook = makeNotebookMeta({
			id: session.notebook_id,
			project_id: session.project_id,
			title: 'Shared app',
		});
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue({
			skipped: false,
			reclaimed: 0,
			markedDead: 1,
			orphansReaped: 0,
			orphanSandboxIds: [],
			markedDeadSessions: [session],
		});
		const getProject = vi
			.spyOn(deps.services.projects, 'getProject')
			.mockRejectedValueOnce(new Error('temporary read failure'))
			.mockResolvedValue(project);
		vi.spyOn(deps.services.notebooks, 'getNotebook').mockResolvedValue({ meta: notebook } as never);
		const deliver = vi.fn(async () => 'delivered' as const);
		deps.projectAlerts = {
			store: {} as never,
			dispatcher: { deliver, test: vi.fn() },
			maxDestinations: 10,
		};

		stop = startMaintenance(deps, metrics);
		await flushRun();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
		expect(getProject).toHaveBeenCalledTimes(2);
	});

	it('bounds concurrent unavailable-app alert metadata reads', async () => {
		const sessions = Array.from({ length: 9 }, () =>
			makeSession({ mode: 'app', sandbox_id: createSandboxId() }),
		);
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue({
			skipped: false,
			reclaimed: 0,
			markedDead: sessions.length,
			orphansReaped: 0,
			orphanSandboxIds: [],
			markedDeadSessions: sessions,
		});
		const releases: (() => void)[] = [];
		const getProject = vi.spyOn(deps.services.projects, 'getProject').mockImplementation(
			(projectId) =>
				new Promise((resolve) => {
					releases.push(() => resolve(makeProject({ id: projectId })));
				}),
		);
		vi.spyOn(deps.services.notebooks, 'getNotebook').mockImplementation(
			async (projectId, notebookId) =>
				({
					meta: makeNotebookMeta({ id: notebookId, project_id: projectId }),
				}) as never,
		);

		stop = startMaintenance(deps, metrics);
		await flushRun();
		expect(getProject).toHaveBeenCalledTimes(8);
		for (const release of releases.splice(0)) release();
		await vi.waitFor(() => expect(getProject).toHaveBeenCalledTimes(9));
		for (const release of releases) release();
		await flushRun();
	});

	it('does not alert for vanished editor sessions or non-running apps', async () => {
		const editor = makeSession({ mode: 'edit', sandbox_id: createSandboxId() });
		const startingApp = makeSession({
			mode: 'app',
			status: 'starting',
			sandbox_id: createSandboxId(),
		});
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue({
			skipped: false,
			reclaimed: 0,
			markedDead: 2,
			orphansReaped: 0,
			orphanSandboxIds: [],
			markedDeadSessions: [editor, startingApp],
		});
		const deliver = vi.fn(async () => 'delivered' as const);
		deps.projectAlerts = {
			store: {} as never,
			dispatcher: { deliver, test: vi.fn() },
			maxDestinations: 10,
		};

		stop = startMaintenance(deps, metrics);
		await flushRun();
		expect(deliver).not.toHaveBeenCalled();
	});
});

const SESSION_SWEEP_INTERVAL_MS = Millis.seconds(60);

const ZERO_SWEEP: SweepResult = {
	snapshotted: 0,
	extended: 0,
	reapedExpired: 0,
	reapedIdle: 0,
	reclaimed: 0,
};

function makeSessionLifetime(
	overrides: Partial<SessionLifetimeConfig> = {},
): SessionLifetimeConfig {
	return {
		maxLifetimeMs: Millis.hours(4),
		idleTimeoutMs: Millis.minutes(30),
		snapshotIntervalMs: Millis.minutes(2),
		extensionMs: Millis.minutes(30),
		connectionAware: false,
		sweepIntervalMs: SESSION_SWEEP_INTERVAL_MS,
		...overrides,
	};
}

describe('startSessionLifecycle', () => {
	let bucket: MemoryBucket;
	let deps: ApiDeps;
	let stop: (() => void) | undefined;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let sweepSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vi.useFakeTimers();
		bucket = await createInitializedBucket();
		const base = makeTestDeps(bucket);
		deps = { ...base, sandbox: { ...base.sandbox, sessionLifetime: makeSessionLifetime() } };
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		sweepSpy = vi.spyOn(SessionLifecycleService.prototype, 'sweep').mockResolvedValue(ZERO_SWEEP);
	});

	afterEach(() => {
		stop?.();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('is disabled (no interval) when sandbox.sessionLifetime is unset', async () => {
		const disabledDeps = makeTestDeps(bucket);
		const handle = startSessionLifecycle(disabledDeps);
		expect(handle).toBeUndefined();

		await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS * 3);
		expect(sweepSpy).not.toHaveBeenCalled();
	});

	it('leases its own key, separate from the maintenance lock', async () => {
		const putSpy = vi.spyOn(bucket, 'put');
		stop = startSessionLifecycle(deps);
		await flushRun();

		expect(sweepSpy).toHaveBeenCalledOnce();
		expect(putSpy.mock.calls.some(([key]) => key === paths.sessionLifecycleLock)).toBe(true);
	});

	it('guards against overlap: a hung sweep is not re-entered on the next tick', async () => {
		let resolveSweep!: (r: SweepResult) => void;
		sweepSpy.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSweep = resolve;
				}),
		);

		stop = startSessionLifecycle(deps);
		await flushRun();
		expect(sweepSpy).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS * 2);
		expect(sweepSpy).toHaveBeenCalledTimes(1); // still hung — the overlap guard held

		resolveSweep(ZERO_SWEEP);
		await flushRun();
		await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
		expect(sweepSpy).toHaveBeenCalledTimes(2);
	});

	it('contains a sweep failure and releases the lease for the next tick', async () => {
		const releaseSpy = vi.spyOn(MaintenanceLock.prototype, 'release');
		sweepSpy.mockRejectedValueOnce(new Error('boom'));

		stop = startSessionLifecycle(deps);
		await flushRun();

		const events = parseLoggedEvents(logSpy);
		expect(events).toEqual([
			expect.objectContaining({ event: 'session_lifecycle_failed', error: 'boom' }),
		]);
		expect(releaseSpy).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
		expect(sweepSpy).toHaveBeenCalledTimes(2);
	});

	it('logs session_lifecycle_sweep only when the result is non-zero', async () => {
		stop = startSessionLifecycle(deps);
		await flushRun();
		expect(parseLoggedEvents(logSpy)).toEqual([]);

		logSpy.mockClear();
		sweepSpy.mockResolvedValueOnce({ ...ZERO_SWEEP, reapedExpired: 1 });
		await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);

		const events = parseLoggedEvents(logSpy);
		expect(events).toEqual([
			expect.objectContaining({ event: 'session_lifecycle_sweep', reapedExpired: 1 }),
		]);
	});
});

describe('startJobScheduler', () => {
	let bucket: MemoryBucket;
	let deps: ApiDeps;
	let metrics: WideEventMetrics;
	let handle: ReturnType<typeof startJobScheduler> | undefined;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vi.useFakeTimers();
		bucket = await createInitializedBucket();
		deps = makeTestDeps(bucket);
		metrics = new WideEventMetrics();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		handle?.stop();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('refuses to start when jobs are off', () => {
		expect(() => startJobScheduler({ ...deps, jobs: undefined }, metrics)).toThrow(
			/notebook jobs are off/,
		);
	});

	it('runs a tick under its own lease and stays quiet when nothing happened', async () => {
		handle = startJobScheduler(deps, metrics);
		await flushRun();
		expect(parseLoggedEvents(logSpy)).toEqual([]);
		// The lease is released after the tick, on the scheduler's own key.
		expect(await bucket.head(paths.jobSchedulerLock)).toBeNull();
	});

	it('fires a due schedule and logs one tick event', async () => {
		const project = await deps.services.projects.createProject(
			{ name: 'p', description: '' },
			ACTOR,
		);
		const notebook = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		const job = await deps.services.jobs.createJob(
			project.id,
			notebook.id,
			{ name: 'every minute', schedule: { cron: '* * * * *', timezone: 'UTC' } },
			ACTOR,
		);
		handle = startJobScheduler(deps, metrics);
		await flushRun();
		await handle.drain();

		const tick = parseLoggedEvents(logSpy).find((e) => e.event === 'job_scheduler_tick');
		expect(tick).toMatchObject({ fired: 1, dispatched: 1 });
		const runs = await deps.services.jobRuns.listRuns(project.id, notebook.id, job.id);
		expect(runs).toHaveLength(1);
		// `noopCompute` cannot provision, so the runner lands the run failed — the
		// point here is the loop wiring, not the execution.
		expect(runs[0].status).toBe('failed');
	});

	it('skips the tick when this replica is not the lease holder', async () => {
		vi.spyOn(MaintenanceLock.prototype, 'acquire').mockResolvedValue(false);
		const tickSpy = vi.spyOn(deps.services.jobRuns, 'listActive');
		handle = startJobScheduler(deps, metrics);
		await flushRun();
		expect(tickSpy).not.toHaveBeenCalled();
	});

	it('logs a failed tick and keeps the interval alive', async () => {
		vi.spyOn(deps.services.catalog, 'getCurrentSnapshot').mockRejectedValueOnce(
			new Error('bucket down'),
		);
		handle = startJobScheduler(deps, metrics);
		await flushRun();
		expect(parseLoggedEvents(logSpy)[0]).toMatchObject({
			event: 'job_scheduler_failed',
			error: 'bucket down',
		});
		logSpy.mockClear();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(parseLoggedEvents(logSpy)).toEqual([]);
	});
});
