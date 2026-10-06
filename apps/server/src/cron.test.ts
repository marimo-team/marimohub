import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitializedBucket, makeTestDeps, stubSourceControl } from '@marimo-hub/api/testing';
import type { ApiDeps } from '@marimo-hub/api';
import type * as CoreModule from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import {
	createSandboxId,
	MaintenanceLock,
	WarmPoolService,
	WarmPoolStore,
	paths,
	reapFilesystemSnapshots,
	ReconciliationService,
	SessionLifecycleService,
} from '@marimo-hub/core';
import { JobScheduler } from '@marimo-hub/core/jobs';
import type { SweepResult } from '@marimo-hub/core';
import { ACTOR, makeNotebookMeta, makeProject, makeSession } from '@marimo-hub/core/testing';
import {
	startPreviewPreparation,
	startJobScheduler,
	startMaintenance,
	startSessionLifecycle,
	startWarmPools,
} from './cron';
import { fanoutMetrics, WideEventMetrics } from './metrics';
import { BackgroundLoops } from './backgroundLoops';
import {
	flushRun,
	makeSessionLifetime,
	SESSION_SWEEP_INTERVAL_MS,
	useLoopHarness,
} from './test/loopHarness';

vi.mock('@marimo-hub/core', async (importOriginal) => {
	const actual = await importOriginal<typeof CoreModule>();
	return { ...actual, reapFilesystemSnapshots: vi.fn(actual.reapFilesystemSnapshots) };
});

const FIVE_MINUTES_MS = 5 * 60 * 1000;

type ReconcileResult = Awaited<ReturnType<ReconciliationService['reconcile']>>;

function makeReconcileResult(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
	return {
		skipped: false,
		reclaimed: 0,
		unreclaimedTerminal: 0,
		oldestUnreclaimedAgeMs: null,
		markedDead: 0,
		orphansReaped: 0,
		orphanSandboxIds: [],
		markedDeadSessions: [],
		...overrides,
	};
}

const ZERO_SWEEP: SweepResult = {
	snapshotted: 0,
	extended: 0,
	reapedExpired: 0,
	reapedIdle: 0,
	reclaimed: 0,
};

const ZERO_TICK: Awaited<ReturnType<JobScheduler['tick']>> = {
	fired: 0,
	repaired: 0,
	skipped: 0,
	dispatched: 0,
	timedOut: 0,
	markersPruned: 0,
	errors: 0,
};

function makeWarmPool(deps: ApiDeps, enabled = true) {
	return new WarmPoolService(
		new WarmPoolStore(deps.bucket, 'kubernetes'),
		deps.compute,
		deps.services.sessions,
		{ enabled, size: 1, profiles: [], creationTimeoutMs: 300_000, minimumRemainingMs: 60_000 },
	);
}

describe('startMaintenance', () => {
	const h = useLoopHarness();
	let bucket: MemoryBucket;
	let deps: ApiDeps;
	let metrics: WideEventMetrics;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		deps = makeTestDeps(bucket);
		metrics = new WideEventMetrics();
	});

	it('emits exactly one maintenance_cycle wide event per run', async () => {
		metrics.increment('sessions_created');
		h.track(startMaintenance(deps, metrics));
		await flushRun();

		const events = h.events();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: 'maintenance_cycle',
			sessions_expired: 0,
			invite_rows_claimed: 0,
			projects_swept: 0,
			notebooks_swept: 0,
			sessions_reclaimed: 0,
			'counter.sessions_created': 1,
		});
		expect(events[0]).not.toHaveProperty('unreclaimed_terminal_sessions');
		expect(events[0]).not.toHaveProperty('oldest_unreclaimed_session_age_ms');
	});

	it('publishes unreclaimed terminal gauges to the metrics port and resets them after recovery', async () => {
		const gauge = vi.fn();
		deps.metrics = fanoutMetrics(metrics, { gauge, increment: vi.fn() });
		const result = makeReconcileResult({
			skipped: true,
			unreclaimedTerminal: 2,
			oldestUnreclaimedAgeMs: 60_000,
		});
		vi.spyOn(ReconciliationService.prototype, 'reconcile')
			.mockResolvedValueOnce(result)
			.mockResolvedValue(makeReconcileResult({ skipped: true }));
		h.track(startMaintenance(deps, metrics));
		await flushRun();
		expect(gauge).toHaveBeenCalledWith('sessions.unreclaimed_terminal.count', 2, undefined);
		expect(gauge).toHaveBeenCalledWith(
			'sessions.unreclaimed_terminal.oldest_age_ms',
			60_000,
			undefined,
		);
		expect(h.events().at(-1)).toMatchObject({
			'gauge.sessions.unreclaimed_terminal.count': 2,
			'gauge.sessions.unreclaimed_terminal.oldest_age_ms': 60_000,
		});
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
		expect(gauge).toHaveBeenCalledWith('sessions.unreclaimed_terminal.count', 0, undefined);
		expect(gauge).toHaveBeenCalledWith('sessions.unreclaimed_terminal.oldest_age_ms', 0, undefined);
		expect(h.events().at(-1)).toMatchObject({
			'gauge.sessions.unreclaimed_terminal.count': 0,
			'gauge.sessions.unreclaimed_terminal.oldest_age_ms': 0,
		});
	});

	it('keeps the last observed gauges when reconciliation fails, then resets them on recovery', async () => {
		metrics.gauge('sessions.unreclaimed_terminal.count', 2);
		metrics.gauge('sessions.unreclaimed_terminal.oldest_age_ms', 60_000);
		const reconcile = vi
			.spyOn(ReconciliationService.prototype, 'reconcile')
			.mockRejectedValueOnce(new Error('session listing unavailable'));
		h.track(startMaintenance(deps, metrics));
		await flushRun();
		expect(metrics.collect()).toMatchObject({
			'gauge.sessions.unreclaimed_terminal.count': 2,
			'gauge.sessions.unreclaimed_terminal.oldest_age_ms': 60_000,
		});
		expect(h.events()).toContainEqual(expect.objectContaining({ event: 'maintenance_failed' }));
		expect(h.events().some((event) => event.event === 'maintenance_cycle')).toBe(false);
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(h.events().at(-1)).toMatchObject({
			event: 'maintenance_cycle',
			'gauge.sessions.unreclaimed_terminal.count': 0,
			'gauge.sessions.unreclaimed_terminal.oldest_age_ms': 0,
		});
	});

	it('ignores gauges from a timed-out reconciliation after a newer sweep succeeds', async () => {
		const late = Promise.withResolvers<ReconcileResult>();
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockReturnValueOnce(late.promise);
		const loops = new BackgroundLoops();
		h.track(startMaintenance(deps, metrics, loops));
		await flushRun();
		await vi.advanceTimersByTimeAsync(
			loops.health().loops.maintenance.deadline_ms + FIVE_MINUTES_MS,
		);
		expect(h.events()).toContainEqual(expect.objectContaining({ event: 'maintenance_stalled' }));
		late.resolve(
			makeReconcileResult({
				unreclaimedTerminal: 7,
				oldestUnreclaimedAgeMs: 120_000,
			}),
		);
		await flushRun();
		expect(metrics.collect()).not.toHaveProperty('gauge.sessions.unreclaimed_terminal.count');
		expect(h.events().some((event) => event.event === 'maintenance_cycle')).toBe(false);

		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
		expect(h.events().at(-1)).toMatchObject({
			event: 'maintenance_cycle',
			'gauge.sessions.unreclaimed_terminal.count': 0,
			'gauge.sessions.unreclaimed_terminal.oldest_age_ms': 0,
		});
	});

	it('reports loop heartbeat gauges after work and lease release complete', async () => {
		vi.spyOn(MaintenanceLock.prototype, 'acquire').mockResolvedValue(true);
		vi.spyOn(MaintenanceLock.prototype, 'release').mockImplementation(
			() => new Promise((resolve) => setTimeout(resolve, 10)),
		);
		vi.spyOn(deps.services.sessions, 'expireStale').mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve(0), 40)),
		);
		h.track(startMaintenance(deps, metrics, new BackgroundLoops()));
		await vi.advanceTimersByTimeAsync(40);
		expect(h.events()).toEqual([]);
		await vi.advanceTimersByTimeAsync(10);
		const [cycle] = h.events();
		expect(Object.keys(cycle).filter((key) => key.includes('.loop.'))).toEqual([
			'gauge.loop.maintenance.seconds_since_success',
			'gauge.loop.maintenance.last_duration_ms',
			'gauge.loop.maintenance.consecutive_failures',
			'gauge.loop.maintenance.stalled',
			'counter.loop.maintenance.timeouts',
		]);
		expect(cycle).toMatchObject({
			event: 'maintenance_cycle',
			'gauge.loop.maintenance.seconds_since_success': 0,
			'gauge.loop.maintenance.last_duration_ms': 50,
			'gauge.loop.maintenance.consecutive_failures': 0,
			'gauge.loop.maintenance.stalled': 0,
			'counter.loop.maintenance.timeouts': 0,
		});
	});

	it.each([false, true])(
		'preserves the sweep result when the release read fails (failed: %s)',
		async (failed) => {
			const get = bucket.get.bind(bucket);
			vi.spyOn(bucket, 'get').mockImplementation((key) => {
				if (key === paths.maintenanceLock) return Promise.reject(new Error('release read failed'));
				return get(key);
			});
			if (failed)
				vi.spyOn(deps.services.sessions, 'expireStale').mockRejectedValueOnce(
					new Error('sweep failed'),
				);
			const loops = new BackgroundLoops();
			h.track(startMaintenance(deps, metrics, loops));
			await flushRun();
			const events = h.events();
			expect(events.map((event) => event.event)).toEqual([
				'maintenance_release_failed',
				failed ? 'maintenance_failed' : 'maintenance_cycle',
			]);
			expect(events[0].error).toBe('release read failed');
			if (failed) {
				expect(events[1].error).toBe('sweep failed');
				expect(loops.health().loops.maintenance.last_success_at).toBeNull();
			} else {
				expect(loops.health().loops.maintenance.last_success_at).toBe(Date.now());
			}
		},
	);

	it('sweeps previews before expiring session startup records', async () => {
		const previews = vi.spyOn(deps.services.previews, 'cleanupCandidates');
		const expire = vi.spyOn(deps.services.sessions, 'expireStale');
		h.track(startMaintenance(deps, metrics));
		await flushRun();
		expect(previews).toHaveBeenCalledOnce();
		expect(expire).toHaveBeenCalledOnce();
		expect(previews.mock.invocationCallOrder[0]).toBeLessThan(expire.mock.invocationCallOrder[0]);
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
		await deps.services.jobRuns.deleteMarker(old);

		h.track(startMaintenance(deps, metrics));
		await flushRun();

		expect(h.events()[0]).toMatchObject({
			event: 'maintenance_cycle',
			job_runs_pruned: 1,
			job_run_markers_pruned: 0,
		});
		expect(await deps.services.jobRuns.listRuns(project.id, notebook.id, job.id)).toEqual([]);
	});

	it('skips job pruning when jobs are off', async () => {
		const prune = vi.spyOn(deps.services.jobRuns, 'pruneJob');
		h.track(startMaintenance({ ...deps, jobs: undefined }, metrics));
		await flushRun();

		expect(prune).not.toHaveBeenCalled();
		expect(h.events()[0]).toMatchObject({
			event: 'maintenance_cycle',
			job_runs_pruned: 0,
			job_run_markers_pruned: 0,
		});
	});

	it('claims pending invite rows during the maintenance cycle', async () => {
		const claimSpy = vi.spyOn(deps.services.projects, 'claimPendingInvites').mockResolvedValue(2);

		h.track(startMaintenance(deps, metrics));
		await flushRun();

		expect(claimSpy).toHaveBeenCalledOnce();
		expect(h.events()[0]).toMatchObject({ invite_rows_claimed: 2 });
	});

	it('sweeps projects before notebooks (a deleted project reclaims its own notebooks)', async () => {
		const projectsSpy = vi.spyOn(deps.services.projects, 'sweepDeletedProjects');
		const notebooksSpy = vi.spyOn(deps.services.notebooks, 'sweepDeletedNotebooks');

		h.track(startMaintenance(deps, metrics));
		await flushRun();

		expect(projectsSpy).toHaveBeenCalledOnce();
		expect(notebooksSpy).toHaveBeenCalledOnce();
		expect(projectsSpy.mock.invocationCallOrder[0]).toBeLessThan(
			notebooksSpy.mock.invocationCallOrder[0],
		);
	});

	it('forwards orphaned notebook snapshots to reapFilesystemSnapshots', async () => {
		const orphaned = [{ snapshot_id: 'snap-1', captured_at: new Date().toISOString() }];
		vi.spyOn(deps.services.notebooks, 'sweepDeletedNotebooks').mockResolvedValue({
			purged: 1,
			orphanedSnapshots: orphaned,
		});
		vi.mocked(reapFilesystemSnapshots).mockResolvedValueOnce(1);

		h.track(startMaintenance(deps, metrics));
		await flushRun();

		expect(reapFilesystemSnapshots).toHaveBeenCalledWith(deps.compute, orphaned);
		const events = h.events();
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
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue(
			makeReconcileResult({
				markedDead: 1,
				markedDeadSessions: [session],
			}),
		);
		vi.spyOn(deps.services.projects, 'getProject').mockResolvedValue(project);
		vi.spyOn(deps.services.notebooks, 'getNotebook').mockResolvedValue({ meta: notebook } as never);
		const deliver = vi.fn(async () => 'delivered' as const);
		deps.projectAlerts = {
			store: {} as never,
			dispatcher: { deliver, test: vi.fn() },
			maxDestinations: 10,
		};

		h.track(startMaintenance(deps, metrics));
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
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue(
			makeReconcileResult({
				markedDead: 1,
				markedDeadSessions: [session],
			}),
		);
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

		h.track(startMaintenance(deps, metrics));
		await flushRun();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
		expect(getProject).toHaveBeenCalledTimes(2);
	});

	it('bounds concurrent unavailable-app alert metadata reads', async () => {
		const sessions = Array.from({ length: 9 }, () =>
			makeSession({ mode: 'app', sandbox_id: createSandboxId() }),
		);
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue(
			makeReconcileResult({
				markedDead: sessions.length,
				markedDeadSessions: sessions,
			}),
		);
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

		h.track(startMaintenance(deps, metrics));
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
		vi.spyOn(ReconciliationService.prototype, 'reconcile').mockResolvedValue(
			makeReconcileResult({
				markedDead: 2,
				markedDeadSessions: [editor, startingApp],
			}),
		);
		const deliver = vi.fn(async () => 'delivered' as const);
		deps.projectAlerts = {
			store: {} as never,
			dispatcher: { deliver, test: vi.fn() },
			maxDestinations: 10,
		};

		h.track(startMaintenance(deps, metrics));
		await flushRun();
		expect(deliver).not.toHaveBeenCalled();
	});
});

describe('startSessionLifecycle', () => {
	const h = useLoopHarness();
	let bucket: MemoryBucket;
	let deps: ApiDeps;
	let sweepSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const base = makeTestDeps(bucket);
		deps = { ...base, sandbox: { ...base.sandbox, sessionLifetime: makeSessionLifetime() } };
		sweepSpy = vi.spyOn(SessionLifecycleService.prototype, 'sweep').mockResolvedValue(ZERO_SWEEP);
	});

	it('is disabled (no interval) when sandbox.sessionLifetime is unset', async () => {
		expect(startSessionLifecycle(makeTestDeps(bucket))).toBeUndefined();
		await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS * 3);
		expect(sweepSpy).not.toHaveBeenCalled();
	});

	it.each(['acquire', 'release'] as const)(
		'recovers when bucket.get hangs during %s',
		async (phase) => {
			if (phase === 'acquire') {
				await bucket.put(
					paths.sessionLifecycleLock,
					JSON.stringify({ holder: 'expired', expires_at: new Date(0).toISOString() }),
				);
			}
			const get = bucket.get.bind(bucket);
			const unhang = Promise.withResolvers<void>();
			let hung = false;
			vi.spyOn(bucket, 'get').mockImplementation((key) => {
				if (key === paths.sessionLifecycleLock && !hung) {
					hung = true;
					return unhang.promise.then(() => get(key));
				}
				return get(key);
			});
			const loops = new BackgroundLoops();
			h.track(startSessionLifecycle(deps, loops));
			await flushRun();
			expect(sweepSpy).toHaveBeenCalledTimes(phase === 'acquire' ? 0 : 1);
			await vi.advanceTimersByTimeAsync(10 * 60_000 + SESSION_SWEEP_INTERVAL_MS);
			if (phase === 'acquire') {
				// The guard holds until the hung acquire settles; release is abandoned at the deadline.
				expect(sweepSpy).not.toHaveBeenCalled();
				expect(loops.health().loops.session_lifecycle.status).toBe('stalled');
				unhang.resolve();
				await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
			}
			expect(sweepSpy.mock.calls.length).toBeGreaterThan(phase === 'acquire' ? 0 : 1);
			expect(loops.health().loops.session_lifecycle).toMatchObject({ status: 'ok', timeouts: 1 });
			expect(h.events()).toContainEqual(
				expect.objectContaining({ event: 'session_lifecycle_stalled' }),
			);
		},
	);

	it('logs session_lifecycle_sweep only when the result is non-zero', async () => {
		h.track(startSessionLifecycle(deps));
		await flushRun();
		expect(h.events()).toEqual([]);

		h.logSpy.mockClear();
		sweepSpy.mockResolvedValueOnce({ ...ZERO_SWEEP, reapedExpired: 1 });
		await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);

		const events = h.events();
		expect(events).toEqual([
			expect.objectContaining({ event: 'session_lifecycle_sweep', reapedExpired: 1 }),
		]);
	});
});

describe('startJobScheduler', () => {
	const h = useLoopHarness();
	let deps: ApiDeps;
	let metrics: WideEventMetrics;

	beforeEach(async () => {
		deps = makeTestDeps(await createInitializedBucket());
		metrics = new WideEventMetrics();
	});

	it('refuses to start when jobs are off', () => {
		expect(() => startJobScheduler({ ...deps, jobs: undefined }, metrics)).toThrow(
			/notebook jobs are off/,
		);
	});

	it('stays quiet when a tick did nothing', async () => {
		h.track(startJobScheduler(deps, metrics));
		await flushRun();
		expect(h.events()).toEqual([]);
	});

	it('waits for the current tick before draining executions', async () => {
		let finishTick!: (result: Awaited<ReturnType<JobScheduler['tick']>>) => void;
		vi.spyOn(JobScheduler.prototype, 'tick').mockImplementation(
			() =>
				new Promise((resolve) => {
					finishTick = resolve;
				}),
		);
		const drain = vi.spyOn(JobScheduler.prototype, 'drain').mockResolvedValue(undefined);
		const handle = h.track(startJobScheduler(deps, metrics));
		await flushRun();

		const draining = handle.drain();
		await Promise.resolve();
		expect(drain).not.toHaveBeenCalled();

		finishTick(ZERO_TICK);
		await draining;
		expect(drain).toHaveBeenCalledOnce();
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
		const handle = h.track(startJobScheduler(deps, metrics));
		await flushRun();
		await handle.drain();

		const tick = h.events().find((e) => e.event === 'job_scheduler_tick');
		expect(tick).toMatchObject({ fired: 1, dispatched: 1 });
		const runs = await deps.services.jobRuns.listRuns(project.id, notebook.id, job.id);
		expect(runs).toHaveLength(1);
		// `noopCompute` cannot provision, so the runner lands the run failed — the
		// point here is the loop wiring, not the execution.
		expect(runs[0].status).toBe('failed');
	});
});

describe('startWarmPools', () => {
	const h = useLoopHarness();

	async function setup(enabled = true) {
		const bucket = await createInitializedBucket();
		const deps = makeTestDeps(bucket);
		const service = makeWarmPool(deps, enabled);
		deps.warmPool = service;
		const sweep = vi.spyOn(service, 'sweep').mockResolvedValue(undefined);
		return { bucket, deps, service, sweep };
	}

	it('does not start a timer when no warm pool service is configured', async () => {
		const deps = makeTestDeps(await createInitializedBucket());
		expect(startWarmPools(deps)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('checks disabled, empty pools for late cleanup without acquiring an idle lease', async () => {
		const w = await setup(false);
		const acquire = vi.spyOn(MaintenanceLock.prototype, 'acquire');
		const owned = vi.spyOn(w.service.store, 'ownedSandboxIds').mockResolvedValue(new Set());
		h.track(startWarmPools(w.deps));
		await flushRun();
		expect(acquire).not.toHaveBeenCalled();
		expect(w.sweep).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS - 1);
		expect(owned).toHaveBeenCalledOnce();
		owned.mockResolvedValue(new Set(['late-cleanup']));
		await vi.advanceTimersByTimeAsync(1);
		expect(acquire).toHaveBeenCalledOnce();
		expect(w.sweep).toHaveBeenCalledOnce();
	});

	it('keeps checking disabled cleanup after all ownership records are drained', async () => {
		const w = await setup(false);
		const owned = vi
			.spyOn(w.service.store, 'ownedSandboxIds')
			.mockResolvedValueOnce(new Set(['pending-cleanup']))
			.mockResolvedValueOnce(new Set(['pending-cleanup']))
			.mockResolvedValue(new Set());
		h.track(startWarmPools(w.deps));
		await flushRun();
		await vi.advanceTimersByTimeAsync(2 * FIVE_MINUTES_MS);
		expect(w.sweep).toHaveBeenCalledTimes(2);
		expect(owned).toHaveBeenCalledTimes(3);
		owned.mockResolvedValue(new Set(['late-cleanup']));
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
		expect(w.sweep).toHaveBeenCalledTimes(3);
	});

	it('retries unreadable disabled ownership instead of treating it as empty', async () => {
		const w = await setup(false);
		const owned = vi
			.spyOn(w.service.store, 'ownedSandboxIds')
			.mockRejectedValueOnce(new Error('bucket unavailable'))
			.mockResolvedValue(new Set(['pending-cleanup']));
		h.track(startWarmPools(w.deps));
		await flushRun();
		expect(w.sweep).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
		expect(owned).toHaveBeenCalledTimes(2);
		expect(w.sweep).toHaveBeenCalledOnce();
	});
});

describe('startPreviewPreparation', () => {
	const h = useLoopHarness();

	it('requires a source-control registry', async () => {
		expect(startPreviewPreparation(makeTestDeps(await createInitializedBucket()))).toBeUndefined();
	});

	it('does not overlap ticks, does not block maintenance, and cancels on shutdown', async () => {
		const deps = makeTestDeps(await createInitializedBucket());
		deps.sourceControl = stubSourceControl();
		const done = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const prepare = vi
			.spyOn(deps.services.previews, 'preparePending')
			.mockImplementation(async (_registry, incoming) => {
				signal = incoming;
				await done.promise;
			});
		const stop = h.track(startPreviewPreparation(deps)!);
		const expired = vi.spyOn(deps.services.sessions, 'expireStale');
		h.track(startMaintenance(deps, new WideEventMetrics()));
		try {
			await vi.advanceTimersByTimeAsync(30_000);
			expect(prepare).toHaveBeenCalledOnce();
			expect(expired).toHaveBeenCalledOnce();
			stop();
			expect(signal?.aborted).toBe(true);
			done.resolve();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(prepare).toHaveBeenCalledOnce();
		} finally {
			done.resolve();
		}
	});
});

type LoopWork = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;

interface LoopCase {
	name: string;
	lockKey?: string;
	intervalMs: number;
	failureEvent: string;
	overlapEvent?: string;
	notLeaderEvent?: string;
	start(deps: ApiDeps, loops: BackgroundLoops, work: LoopWork): () => void;
}

const LOOPS: LoopCase[] = [
	{
		name: 'maintenance',
		lockKey: paths.maintenanceLock,
		intervalMs: FIVE_MINUTES_MS,
		failureEvent: 'maintenance_failed',
		overlapEvent: 'maintenance_cycle_overlap_skipped',
		notLeaderEvent: 'maintenance_skipped_not_leader',
		start(deps, loops, work) {
			vi.spyOn(deps.services.sessions, 'expireStale').mockImplementation(async () => {
				await work();
				return 0;
			});
			return startMaintenance(deps, new WideEventMetrics(), loops);
		},
	},
	{
		name: 'session_lifecycle',
		lockKey: paths.sessionLifecycleLock,
		intervalMs: SESSION_SWEEP_INTERVAL_MS,
		failureEvent: 'session_lifecycle_failed',
		start(deps, loops, work) {
			deps.sandbox.sessionLifetime = makeSessionLifetime();
			vi.spyOn(SessionLifecycleService.prototype, 'sweep').mockImplementation(async () => {
				await work();
				return ZERO_SWEEP;
			});
			return startSessionLifecycle(deps, loops)!;
		},
	},
	{
		name: 'job_scheduler',
		lockKey: paths.jobSchedulerLock,
		intervalMs: 60_000,
		failureEvent: 'job_scheduler_failed',
		start(deps, loops, work) {
			vi.spyOn(JobScheduler.prototype, 'tick').mockImplementation(async () => {
				await work();
				return ZERO_TICK;
			});
			return startJobScheduler(deps, new WideEventMetrics(), loops).stop;
		},
	},
	{
		name: 'warm_pool',
		lockKey: paths.warmPoolLock,
		intervalMs: 5_000,
		failureEvent: 'warm_pool_sweep_failed',
		start(deps, loops, work) {
			deps.warmPool = makeWarmPool(deps);
			vi.spyOn(deps.warmPool, 'sweep').mockImplementation(() => work());
			return startWarmPools(deps, loops)!.stop;
		},
	},
	{
		name: 'preview_preparation',
		intervalMs: 15_000,
		failureEvent: 'preview_preparation_failed',
		start(deps, loops, work) {
			deps.sourceControl = stubSourceControl();
			vi.spyOn(deps.services.previews, 'preparePending').mockImplementation((...args) =>
				work(...args),
			);
			return startPreviewPreparation(deps, loops)!;
		},
	},
];

const LOCK_KEYS = new Set(LOOPS.flatMap((loop) => (loop.lockKey ? [loop.lockKey] : [])));

describe('background loop wiring', () => {
	const h = useLoopHarness();
	let bucket: MemoryBucket;
	let deps: ApiDeps;
	let loops: BackgroundLoops;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		deps = makeTestDeps(bucket);
		loops = new BackgroundLoops();
	});

	it.each(LOOPS)(
		'$name runs at once, leases its own key, and retries a failure after $intervalMs ms',
		async (loop) => {
			const put = vi.spyOn(bucket, 'put');
			const work: LoopWork = vi
				.fn<(...args: unknown[]) => Promise<void>>()
				.mockRejectedValueOnce(new Error('boom'))
				.mockResolvedValue(undefined);
			h.track(loop.start(deps, loops, work));
			await flushRun();
			expect(work).toHaveBeenCalledOnce();
			expect(h.events()).toContainEqual(
				expect.objectContaining({ event: loop.failureEvent, error: 'boom' }),
			);
			expect(loops.health().loops[loop.name].interval_ms).toBe(loop.intervalMs);
			const leased = new Set(
				put.mock.calls.map(([key]) => key).filter((key) => LOCK_KEYS.has(key)),
			);
			expect([...leased]).toEqual(loop.lockKey ? [loop.lockKey] : []);

			// A fresh holder can only lease again if the failed attempt released.
			await vi.advanceTimersByTimeAsync(loop.intervalMs);
			expect(work).toHaveBeenCalledTimes(2);
			expect(loops.health().loops[loop.name].status).toBe('ok');
		},
	);

	it.each(LOOPS.filter((loop) => loop.lockKey))(
		'$name skips work while another replica holds the lease',
		async (loop) => {
			vi.spyOn(MaintenanceLock.prototype, 'acquire').mockResolvedValue(false);
			const work: LoopWork = vi.fn<(...args: unknown[]) => Promise<void>>();
			h.track(loop.start(deps, loops, work));
			await flushRun();
			expect(work).not.toHaveBeenCalled();
			if (loop.notLeaderEvent)
				expect(h.events()).toEqual([expect.objectContaining({ event: loop.notLeaderEvent })]);
		},
	);

	it.each(LOOPS)(
		'$name holds hung work past its deadline and ignores its late completion',
		async (loop) => {
			const late = Promise.withResolvers<void>();
			const work: LoopWork = vi
				.fn<(...args: unknown[]) => Promise<void>>()
				.mockReturnValueOnce(late.promise)
				.mockResolvedValue(undefined);
			h.track(loop.start(deps, loops, work));
			try {
				await flushRun();
				const { deadline_ms, interval_ms } = loops.health().loops[loop.name];
				await vi.advanceTimersByTimeAsync(deadline_ms + interval_ms);
				expect(work).toHaveBeenCalledOnce();
				if (loop.overlapEvent)
					expect(h.events()).toContainEqual(expect.objectContaining({ event: loop.overlapEvent }));
				expect(h.events()).toContainEqual(
					expect.objectContaining({ event: `${loop.name}_stalled` }),
				);
				expect(loops.health().loops[loop.name].status).toBe('stalled');
				if (loop.name === 'preview_preparation') {
					expect((work.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
				}

				late.resolve();
				await flushRun();
				expect(h.events()).toContainEqual(
					expect.objectContaining({ event: `${loop.name}_recovered` }),
				);
				expect(loops.health().loops[loop.name]).toMatchObject({
					last_success_at: null,
					consecutive_failures: 1,
				});

				await vi.advanceTimersByTimeAsync(interval_ms);
				expect(work).toHaveBeenCalledTimes(2);
				expect(loops.health().loops[loop.name]).toMatchObject({
					status: 'ok',
					timeouts: 1,
					consecutive_failures: 0,
				});
			} finally {
				late.resolve();
			}
		},
	);
});
