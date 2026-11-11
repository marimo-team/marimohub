import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	AuthorizationService,
	PreconditionFailedError,
	paths,
} from '@marimo-hub/core';
import type { AppVisit, Bucket, SessionId } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '@marimo-hub/core/testing';
import { expectOk } from './testing';
import { createAppSessionFixture, makeHeartbeatDue } from './testing/appSession';
import type { AppSessionFixtureOptions } from './testing/appSession';

const pause = async (ms: number) => {
	if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
};

type Operation = { method: string; key: string; conditional?: boolean; conflict?: boolean };

class MeasuredBucket extends MemoryBucket {
	operations: Operation[] = [];
	forcedConflicts = new Map<string, number>();
	delay: (method: string, key: string) => number = () => 0;

	private async record(operation: Operation) {
		this.operations.push(operation);
		await pause(this.delay(operation.method, operation.key));
	}

	override async get(key: string) {
		await this.record({ method: 'get', key });
		return super.get(key);
	}

	override async head(key: string) {
		await this.record({ method: 'head', key });
		return super.head(key);
	}

	override async list(options?: Parameters<MemoryBucket['list']>[0]) {
		await this.record({ method: 'list', key: options?.prefix ?? '' });
		return super.list(options);
	}

	override async put(...args: Parameters<MemoryBucket['put']>) {
		const operation: Operation = {
			method: 'put',
			key: args[0],
			conditional: Boolean(args[2]?.onlyIfEtagMatches || args[2]?.onlyIfNotExists),
		};
		await this.record(operation);
		try {
			const remaining = this.forcedConflicts.get(args[0]) ?? 0;
			if (remaining > 0) {
				this.forcedConflicts.set(args[0], remaining - 1);
				throw new PreconditionFailedError('Injected contention');
			}
			return await super.put(...args);
		} catch (error) {
			operation.conflict = error instanceof PreconditionFailedError;
			throw error;
		}
	}

	override async delete(key: string | string[]) {
		for (const item of Array.isArray(key) ? key : [key]) {
			await this.record({ method: 'delete', key: item });
		}
		return super.delete(key);
	}
}

async function fixture(options: AppSessionFixtureOptions = {}) {
	const f = await createAppSessionFixture(new MeasuredBucket(), options);
	const base = `/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions`;
	return {
		...f,
		admitVisit: async (visitId: string) =>
			expectOk<{ session_id: SessionId; app_assignment: AppVisit }>(
				await f.client.request('POST', base, { mode: 'app', app_visit_id: visitId }),
			),
		poolWrites: () =>
			f.bucket.operations.filter((op) => op.method === 'put' && op.key === f.poolKey),
		renew: (pool: AppPoolService, visit = f.admission.app_assignment) =>
			pool.heartbeat(f.project.id, f.notebook.id, f.session.user_id, f.admission.session_id, visit),
	};
}

function freezeHeartbeatClock() {
	const now = Date.now() + 61_000;
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.spyOn(Math, 'random').mockReturnValue(0);
	return now;
}

function blockNextWrite(bucket: MeasuredBucket, failure?: Error) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const put = bucket.put.bind(bucket);
	const writes = vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		if (failure) throw failure;
		return put(...args);
	});
	return { entered: entered.promise, release: release.resolve, writes };
}

function counts(operations: Operation[]) {
	const reads = operations.filter((op) => ['get', 'head', 'list'].includes(op.method));
	const identityReads = reads.filter((op) => op.key.startsWith('_system/identities/')).length;
	return {
		metadataReads: reads.length - identityReads,
		identityReads,
		putAttempts: operations.filter((op) => op.method === 'put').length,
		identityPutAttempts: operations.filter(
			(op) => op.method === 'put' && op.key.startsWith('_system/identities/'),
		).length,
		conditionalPuts: operations.filter((op) => op.conditional).length,
		conflicts: operations.filter((op) => op.conflict).length,
		deletes: operations.filter((op) => op.method === 'delete').length,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('app pool failure recovery', () => {
	it.each(['conflict', 'offline', 'lost-acknowledgement'] as const)(
		'rejects a whole failed heartbeat batch and recovers with the same visit: %s',
		async (failureMode) => {
			const f = await fixture();
			freezeHeartbeatClock();
			const pool = new AppPoolService(f.bucket, f.services.sessions);
			const before = await pool.store.read(f.project.id, f.notebook.id);
			const failure = new Error('Storage unavailable');
			const put = f.bucket.put.bind(f.bucket);
			const writes = vi.spyOn(f.bucket, 'put').mockImplementation(async (...args) => {
				if (args[0] !== f.poolKey) return put(...args);
				if (failureMode === 'conflict') throw new PreconditionFailedError('Contended');
				if (failureMode === 'lost-acknowledgement') await put(...args);
				throw failure;
			});
			const renew = () => f.renew(pool);
			const batch = Promise.allSettled(Array.from({ length: 50 }, renew));
			await vi.runAllTimersAsync();
			for (const outcome of await batch) {
				expect(outcome.status).toBe('rejected');
				if (outcome.status === 'rejected') {
					if (failureMode === 'conflict')
						expect(outcome.reason).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
					else expect(outcome.reason).toBe(failure);
				}
			}
			const failed = await pool.store.read(f.project.id, f.notebook.id);
			if (failureMode !== 'lost-acknowledgement') expect(failed).toEqual(before);
			else
				expect(failed!.assignments[0].visits[0].expires_at).toBeGreaterThan(
					before!.assignments[0].visits[0].expires_at,
				);
			writes.mockRestore();
			f.bucket.operations = [];
			const recovered = renew();
			await vi.runAllTimersAsync();
			expect(await recovered).toBe(true);
			const after = await pool.store.read(f.project.id, f.notebook.id);
			expect(after!.assignments[0].generation).toBe(f.admission.app_assignment.generation);
			expect(after!.assignments[0].visits[0].expires_at).toBeGreaterThan(
				before!.assignments[0].visits[0].expires_at,
			);
			expect(f.poolWrites()).toHaveLength(failureMode === 'lost-acknowledgement' ? 0 : 1);
		},
	);

	it.each([false, true])(
		'drains the next batch after a blocked write (first write fails: %s)',
		async (failFirst) => {
			const f = await fixture();
			vi.useFakeTimers();
			const store = new AppPoolService(f.bucket, f.services.sessions).store;
			const known = await store.readWithEtag(f.project.id, f.notebook.id);
			const initialExpiry = known!.value.assignments[0].visits[0].expires_at;
			const { entered, release, writes } = blockNextWrite(
				f.bucket,
				failFirst ? new Error('Storage unavailable') : undefined,
			);
			const change = () =>
				store.mutateBatched(
					f.project.id,
					f.notebook.id,
					(pool) => {
						pool.assignments[0].visits[0].expires_at += 10;
						return { pool, value: pool.assignments[0].visits[0].expires_at };
					},
					known,
					1000,
					true,
				);
			let firstSettled = false;
			const first = Promise.allSettled([change()]).then((outcome) => {
				firstSettled = true;
				return outcome[0];
			});
			await vi.advanceTimersByTimeAsync(1000);
			await entered;
			expect(firstSettled).toBe(false);
			expect(await store.readWithEtag(f.project.id, f.notebook.id)).toEqual(known);
			let secondSettled = false;
			const second = change().then((value) => {
				secondSettled = true;
				return value;
			});
			release();
			await vi.advanceTimersByTimeAsync(0);
			expect((await first).status).toBe(failFirst ? 'rejected' : 'fulfilled');
			await vi.advanceTimersByTimeAsync(999);
			expect(secondSettled).toBe(false);
			expect(writes).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(await second).toBe(initialExpiry + (failFirst ? 10 : 20));
			expect(writes).toHaveBeenCalledTimes(2);
		},
	);

	it('discards changes made by a rejected callback while committing the other admissions', async () => {
		const f = await fixture();
		const store = new AppPoolService(f.bucket, f.services.sessions).store;
		const known = await store.readWithEtag(f.project.id, f.notebook.id);
		const rejected = new Error('Admission denied');
		const outcomes = await Promise.allSettled([
			store.mutateBatched(
				f.project.id,
				f.notebook.id,
				(pool) => {
					pool.members = [];
					pool.assignments = [];
					throw rejected;
				},
				known,
				0,
			),
			store.mutateBatched(
				f.project.id,
				f.notebook.id,
				(pool) => {
					pool.assignments[0].visits[0].expires_at += 10;
					return { pool, value: 'admitted' };
				},
				known,
				0,
			),
		]);
		expect(outcomes).toEqual([
			{ status: 'rejected', reason: rejected },
			{ status: 'fulfilled', value: 'admitted' },
		]);
		const stored = await store.read(f.project.id, f.notebook.id);
		expect(stored!.members).toEqual(known!.value.members);
		expect(stored!.assignments).toHaveLength(1);
		expect(stored!.assignments[0].visits[0].expires_at).toBe(
			known!.value.assignments[0].visits[0].expires_at + 10,
		);
	});

	it.each(['departure', 'deletion'] as const)(
		'cannot overwrite %s with an in-flight renewal',
		async (action) => {
			const f = await fixture();
			freezeHeartbeatClock();
			const pool = new AppPoolService(f.bucket, f.services.sessions);
			const { entered, release } = blockNextWrite(f.bucket);
			const pending = f.renew(pool);
			await vi.advanceTimersByTimeAsync(1000);
			await entered;
			if (action === 'deletion') await pool.store.retireForDeletion(f.project.id, f.notebook.id);
			else
				await pool.leave(
					f.project.id,
					f.notebook.id,
					f.session.user_id,
					f.admission.session_id,
					f.admission.app_assignment,
				);
			release();
			await vi.runAllTimersAsync();
			expect(await pending).toBe(false);
			const stored = await pool.store.read(f.project.id, f.notebook.id);
			expect(stored!.assignments.flatMap((assignment) => assignment.visits)).toEqual([]);
			if (action === 'deletion') expect(stored!.deleted_at).toBeDefined();
		},
	);

	it('renews 100 visits across four independent replica queues without losing CAS updates', async () => {
		const f = await fixture();
		const visits = await Promise.all(
			Array.from({ length: 100 }, async (_, index) => {
				const result = await f.admitVisit(`replica-${index}`);
				return result.app_assignment;
			}),
		);
		const now = freezeHeartbeatClock();
		const replicas = Array.from({ length: 4 }, () => {
			const bucket: Bucket = {
				get: f.bucket.get.bind(f.bucket),
				head: f.bucket.head.bind(f.bucket),
				put: f.bucket.put.bind(f.bucket),
				delete: f.bucket.delete.bind(f.bucket),
				list: f.bucket.list.bind(f.bucket),
			};
			return new AppPoolService(bucket, f.services.sessions);
		});
		f.bucket.operations = [];
		const pending = Promise.all(
			visits.map((visit, index) => f.renew(replicas[index % replicas.length], visit)),
		);
		await vi.runAllTimersAsync();
		expect(await pending).toEqual(Array.from({ length: 100 }, () => true));
		const writes = f.poolWrites();
		expect(writes.filter((op) => !op.conflict)).toHaveLength(4);
		expect(writes.some((op) => op.conflict)).toBe(true);
		const stored = await replicas[0].store.read(f.project.id, f.notebook.id);
		for (const visit of visits) {
			const assignment = stored!.assignments.find((item) => item.visit_id === visit.visit_id)!;
			expect(assignment.generation).toBe(visit.generation);
			expect(assignment.visits[0].expires_at).toBeGreaterThanOrEqual(
				now + replicas[0].policy.userLeaseMs,
			);
		}
	});
});

describe('app operation budgets', () => {
	it('admits a cold burst while the reservation owner is still creating its session', async () => {
		const f = await fixture();
		await new AppPoolService(f.bucket, f.services.sessions).invalidate(
			f.project.id,
			f.notebook.id,
			f.admission.session_id,
		);
		const sessions = f.client.deps.services.sessions;
		const create = sessions.createSessionWithEtag.bind(sessions);
		// Hold the reservation until every admission has routed, so all of them see it.
		const routed = Promise.withResolvers<void>();
		let outcomes = 0;
		const admit = AppPoolService.prototype.admit;
		vi.spyOn(AppPoolService.prototype, 'admit').mockImplementation(
			async function (this: AppPoolService, input) {
				const decision = await admit.call(this, input);
				if (++outcomes === 100) routed.resolve();
				return decision;
			},
		);
		const createSession = vi
			.spyOn(sessions, 'createSessionWithEtag')
			.mockImplementation(async (...args) => {
				await routed.promise;
				return create(...args);
			});
		const admissions = await Promise.all(
			Array.from({ length: 100 }, async (_, index) => f.admitVisit(`cold-${index}`)),
		);
		expect(createSession).toHaveBeenCalledOnce();
		expect(new Set(admissions.map((admission) => admission.session_id)).size).toBe(1);
		expect(admissions[0].session_id).not.toBe(f.admission.session_id);
	}, 30_000);

	it('renews a visit after a three-minute background-tab pause', async () => {
		const f = await fixture();
		const now = Date.now();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now + 180_000);
		expect((await expectOk(await f.heartbeat())).status).toBe('running');
	});

	it('overlaps the post-admission source fence with the session read', async () => {
		const f = await fixture();
		const sourceKey = paths.project(f.project.id).notebook(f.notebook.id).source;
		const get = f.bucket.get.bind(f.bucket);
		let sources = 0;
		let sessions = 0;
		const fence = Promise.withResolvers<void>();
		vi.spyOn(f.bucket, 'get').mockImplementation(async (key) => {
			if (key === f.sessionKey && ++sessions === 2) await fence.promise;
			if (key === sourceKey && ++sources === 3) {
				expect(sessions).toBe(2);
				fence.resolve();
			}
			return get(key);
		});
		await expectOk(
			await f.client.request(
				'POST',
				`/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions`,
				{ mode: 'app', app_visit_id: 'parallel-read' },
			),
		);
		expect(sources).toBe(3);
		expect(sessions).toBe(2);
	});

	it.each(['stale generation', 'expired lease'] as const)(
		'reports %s as a terminal conflict',
		async (reason) => {
			const f = await fixture();
			const assignment = { ...f.admission.app_assignment };
			if (reason === 'expired lease') {
				const pool = await new AppPoolService(f.bucket, f.services.sessions).store.read(
					f.project.id,
					f.notebook.id,
				);
				vi.useFakeTimers({ toFake: ['Date'] });
				vi.setSystemTime(pool!.assignments[0].visits[0].expires_at + 1);
			} else assignment.generation = 'stale';
			const response = await f.client.request(
				'POST',
				`/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions/${f.admission.session_id}/heartbeat`,
				assignment,
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				error: {
					code: 'APP_ASSIGNMENT_EXPIRED',
					message: 'The app assignment expired. Open the app again.',
				},
			});
		},
	);

	it.each([2, 3])(
		'preserves the stale-version conflict at source check %s',
		async (sourceCheck) => {
			const f = await fixture();
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const admit = vi.spyOn(AppPoolService.prototype, 'admit');
			const sourceKey = paths.project(f.project.id).notebook(f.notebook.id).source;
			const get = f.bucket.get.bind(f.bucket);
			let reads = 0;
			vi.spyOn(f.bucket, 'get').mockImplementation(async (key) => {
				if (key === sourceKey && ++reads === sourceCheck) {
					await f.services.notebooks.commitSession(
						f.project.id,
						f.notebook.id,
						{ code: 'published concurrently' },
						ACTOR,
					);
				}
				return get(key);
			});
			const response = await f.client.request(
				'POST',
				`/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions`,
				{ mode: 'app', app_visit_id: 'stale-version' },
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				error: { code: 'CONFLICT', message: 'The app version changed. Retry shortly.' },
			});
			expect(admit).toHaveBeenCalledOnce();
			const pool = await new AppPoolService(f.bucket, f.services.sessions).store.read(
				f.project.id,
				f.notebook.id,
			);
			expect(pool!.assignments.some((assignment) => assignment.visit_id === 'stale-version')).toBe(
				false,
			);
		},
	);

	it.each([
		{ conflicts: 12, attempts: 2, status: 200 },
		{ conflicts: 48, attempts: 4, status: 503 },
	])(
		'retries exhausted CAS admissions ($conflicts conflicts)',
		async ({ conflicts, attempts, status }) => {
			const f = await fixture();
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const admit = vi.spyOn(AppPoolService.prototype, 'admit');
			f.bucket.forcedConflicts.set(f.poolKey, conflicts);
			const response = await f.client.request(
				'POST',
				`/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions`,
				{ mode: 'app', app_visit_id: 'cas-retry' },
			);
			expect(response.status).toBe(status);
			expect(admit).toHaveBeenCalledTimes(attempts);
			expect(admit.mock.calls.map(([input]) => input.visitId)).toEqual(
				Array(attempts).fill('cas-retry'),
			);
			if (status === 200) {
				expect(await expectOk(response)).toMatchObject({
					session_id: f.admission.session_id,
					app_assignment: { visit_id: 'cas-retry' },
				});
			} else {
				expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
			}
		},
	);

	it('reclaims a crashed startup reservation after the reservation floor', async () => {
		const f = await fixture();
		const pool = new AppPoolService(f.bucket, f.services.sessions, undefined, undefined, () =>
			Date.now(),
		);
		const initial = (await pool.store.read(f.project.id, f.notebook.id))!.members[0];
		// The route reserves max(startup timeout + 30 s, 900 s) so slow boots cannot expire mid-start.
		expect(initial.operation_expires_at - initial.created_at).toBe(900_000);
		await pool.invalidate(f.project.id, f.notebook.id, f.admission.session_id);
		const input = {
			projectId: f.project.id,
			notebookId: f.notebook.id,
			userId: f.session.user_id,
			versionId: f.session.source_version_id!,
			visitId: 'crashed-start',
			startupMs: 150_000,
		};
		const crashed = await pool.admit(input);
		expect(crashed.kind).toBe('reserve');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(crashed.member.operation_expires_at + 1);
		const next = await pool.admit(input);
		expect(next.kind).toBe('reserve');
		expect(next.member.session_id).not.toBe(crashed.member.session_id);
		await expect(
			pool.complete(
				f.project.id,
				f.notebook.id,
				crashed.member.session_id,
				crashed.member.operation_token,
			),
		).rejects.toThrow('expired');
	});

	it('admits 200 visits through contention and batches their durable heartbeat renewals', async () => {
		// The production policy: the one-second coalescing window is what is under test.
		const f = await fixture({ appPool: {} });
		const base = `/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions`;
		f.bucket.forcedConflicts.set(f.poolKey, 3);
		f.bucket.operations = [];
		const visits = await Promise.all(
			Array.from({ length: 200 }, async (_, index) => {
				const admission = await f.admitVisit(`burst-${index}`);
				expect(admission.session_id).toBe(f.admission.session_id);
				return admission.app_assignment;
			}),
		);
		expect(new Set(visits.map((visit) => visit.generation)).size).toBe(200);
		const { poolWrites } = f;
		expect(poolWrites().filter((op) => op.conflict)).toHaveLength(3);
		expect(poolWrites().filter((op) => !op.conflict)).toHaveLength(1);
		makeHeartbeatDue();
		f.bucket.operations = [];
		const before = await new AppPoolService(f.bucket, f.services.sessions).store.read(
			f.project.id,
			f.notebook.id,
		);
		const responses = await Promise.all(
			visits.map(async (visit) =>
				f.client.request('POST', `${base}/${f.admission.session_id}/heartbeat`, visit),
			),
		);
		for (const response of responses) expect((await expectOk(response)).status).toBe('running');
		expect(poolWrites()).toHaveLength(1);
		const after = await new AppPoolService(f.bucket, f.services.sessions).store.read(
			f.project.id,
			f.notebook.id,
		);
		for (const visit of visits) {
			const expiry = (pool: NonNullable<typeof before>) =>
				pool.assignments.find((a) => a.visit_id === visit.visit_id)!.visits[0].expires_at;
			expect(expiry(after!)).toBeGreaterThan(expiry(before!));
		}
		f.bucket.operations = [];
		await Promise.all(
			visits.map(async (visit) =>
				f.client.request('POST', `${base}/${f.admission.session_id}/heartbeat`, visit),
			),
		);
		expect(poolWrites()).toHaveLength(0);
	}, 30_000);

	it('does not resurrect a visit that leaves while its renewal is queued', async () => {
		const f = await fixture();
		makeHeartbeatDue();
		const pool = new AppPoolService(f.bucket, f.services.sessions);
		const read = pool.store.readWithEtag.bind(pool.store);
		const queued = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let paused = false;
		vi.spyOn(pool.store, 'readWithEtag').mockImplementation(async (...args) => {
			const record = await read(...args);
			if (!paused) {
				paused = true;
				queued.resolve();
				await release.promise;
			}
			return record;
		});
		const heartbeat = f.renew(pool);
		await queued.promise;
		await pool.leave(
			f.project.id,
			f.notebook.id,
			f.session.user_id,
			f.admission.session_id,
			f.admission.app_assignment,
		);
		release.resolve();
		expect(await heartbeat).toBe(false);
		expect(await expectOk(await f.admit())).toHaveProperty('app_assignment');
	});

	it('reports exhausted pool heartbeat writes as retryable before lease expiry', async () => {
		const f = await fixture();
		makeHeartbeatDue();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const put = f.bucket.put.bind(f.bucket);
		vi.spyOn(f.bucket, 'put').mockImplementation(async (...args) => {
			if (args[0] === f.poolKey) throw new PreconditionFailedError('Injected contention');
			return put(...args);
		});
		const response = await f.heartbeat();
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: 'SERVICE_UNAVAILABLE', message: 'App presence is busy. Retry shortly.' },
		});
	});

	it('loads notebook detail only once for content and uses metadata alone for deep links', async () => {
		const f = await fixture();
		const nb = paths.project(f.project.id).notebook(f.notebook.id);
		const base = `/projects/${f.project.id}/notebooks/${f.notebook.id}`;
		f.bucket.operations = [];
		expect(await expectOk(await f.client.request('GET', `${base}/content`))).toEqual({
			code: 'original',
		});
		for (const key of [nb.source, nb.readme])
			expect(
				f.bucket.operations.filter((op) => op.method === 'get' && op.key === key),
			).toHaveLength(1);
		f.bucket.operations = [];
		await expectOk(await f.client.request('GET', `${base}/deep-links`));
		expect(
			f.bucket.operations.filter((op) => op.key === nb.source || op.key === nb.readme),
		).toEqual([]);
	});

	it('coalesces fresh heartbeats and never renews for a burst of proxy requests or upgrades', async () => {
		const f = await fixture();
		f.bucket.operations = [];
		await expectOk(await f.heartbeat());
		expect(counts(f.bucket.operations)).toMatchObject({ putAttempts: 0, deletes: 0 });
		const heartbeatReads = counts(f.bucket.operations).metadataReads;
		expect(
			f.bucket.operations.filter(
				(op) =>
					op.key === paths.project(f.project.id).notebook(f.notebook.id).source ||
					op.key === paths.editorClaim(f.project.id, f.notebook.id),
			),
		).toEqual([
			{ method: 'get', key: paths.project(f.project.id).notebook(f.notebook.id).source },
			{ method: 'get', key: paths.editorClaim(f.project.id, f.notebook.id) },
		]);
		expect(f.bucket.operations.some((op) => op.method === 'list')).toBe(false);
		expect(
			f.bucket.operations.filter((op) => op.method === 'get' && op.key === f.sessionKey),
		).toHaveLength(1);
		expect(f.bucket.operations).not.toContainEqual({ method: 'head', key: paths.catalog });
		const renew = vi.spyOn(f.client.deps.services.sessions, 'heartbeat');
		f.bucket.operations = [];
		for (let i = 0; i < 20; i++) expect(await f.proxy()).toMatchObject({ kind: 'forward' });
		expect(await f.proxy(true)).toMatchObject({ kind: 'forward' });
		expect(renew).not.toHaveBeenCalled();
		expect(counts(f.bucket.operations)).toMatchObject({
			metadataReads: 21 * 4,
			identityReads: 0,
			putAttempts: 0,
			deletes: 0,
		});
		expect(heartbeatReads).toBe(6);
	});

	it('reads changed notebook constraints on the next proxy request', async () => {
		const f = await fixture();
		expect(await f.proxy()).toMatchObject({ kind: 'forward' });
		await f.client.deps.services.notebooks.setSecurityLabels(
			f.project.id,
			f.notebook.id,
			{ classification: 'SECRET', compartments: [] },
			ACTOR,
		);
		vi.spyOn(f.resourceSecurity.subjectContext!, 'resolve').mockResolvedValue(null);
		f.bucket.operations = [];
		expect(await f.proxy()).toMatchObject({ kind: 'reject', status: 404 });
		expect(counts(f.bucket.operations).putAttempts).toBe(0);
		expect(
			f.bucket.operations.some((op) => op.key === paths.appPool(f.project.id, f.notebook.id)),
		).toBe(false);
	});

	it('coalesces concurrent due heartbeats across separate service instances using CAS', async () => {
		const f = await fixture();
		const clients = Array.from({ length: 4 }, () => f.newClient());
		const get = f.bucket.get.bind(f.bucket);
		const snapshotsReady = Promise.withResolvers<void>();
		let readers = 0;
		vi.spyOn(f.bucket, 'get').mockImplementation(async (key) => {
			const value = await get(key);
			if (key === paths.appPool(f.project.id, f.notebook.id) && readers < clients.length) {
				readers++;
				if (readers === clients.length) snapshotsReady.resolve();
				await snapshotsReady.promise;
			}
			return value;
		});
		makeHeartbeatDue();
		f.bucket.operations = [];
		const responses = await Promise.all(clients.map((client) => f.heartbeat(client)));
		for (const response of responses) expect((await expectOk(response)).status).toBe('running');
		const puts = f.bucket.operations.filter(
			(op) => op.method === 'put' && !op.key.startsWith('_system/identities/'),
		);
		expect(puts.every((op) => op.conditional)).toBe(true);
		expect(puts.filter((op) => !op.conflict)).toHaveLength(2);
		expect(puts.some((op) => op.conflict)).toBe(true);
		f.bucket.operations = [];
		await expectOk(await f.heartbeat());
		expect(counts(f.bucket.operations).putAttempts).toBe(0);
	});
});

const reportPath = process.env.APP_PERFORMANCE_REPORT;
it.skipIf(!reportPath)(
	'records repeatable latency and operation samples',
	async () => {
		const results = [];
		for (const profile of [
			{ name: 'memory', metadataMs: 0, projectMs: 0, policyMs: 0, labeled: false },
			{ name: 'remote', metadataMs: 10, projectMs: 10, policyMs: 0, labeled: false },
			{ name: 'slow-project-policy', metadataMs: 10, projectMs: 30, policyMs: 10, labeled: true },
		]) {
			for (const workload of [
				'fresh-heartbeat',
				'due-heartbeat',
				'concurrent-due-heartbeats',
				'proxy',
				'websocket-authorization',
				'reconnect',
			] as const) {
				const samples = [];
				for (let i = -2; i < 20; i++) {
					const f = await fixture({ labeled: profile.labeled });
					const clients = Array.from({ length: 4 }, () => f.newClient());
					const authenticators = [f.client, ...clients].map((client) =>
						vi.spyOn(client.deps.authenticator, 'authenticate'),
					);
					const authorizer = vi.spyOn(AuthorizationService.prototype, 'authorize');
					const resolve = f.resourceSecurity.subjectContext!.resolve.bind(
						f.resourceSecurity.subjectContext,
					);
					const context = vi
						.spyOn(f.resourceSecurity.subjectContext!, 'resolve')
						.mockImplementation(async (...args) => {
							await pause(profile.policyMs);
							return resolve(...args);
						});
					const evaluate = f.resourceSecurity.constraints.evaluate.bind(
						f.resourceSecurity.constraints,
					);
					const constraint = vi
						.spyOn(f.resourceSecurity.constraints, 'evaluate')
						.mockImplementation(async (...args) => {
							await pause(profile.policyMs);
							return evaluate(...args);
						});
					f.bucket.delay = (_method, key) =>
						key.startsWith('_system/identities/')
							? 0
							: key === paths.project(f.project.id).meta
								? profile.projectMs
								: profile.metadataMs;
					if (workload.includes('due')) makeHeartbeatDue();
					f.bucket.operations = [];
					const start = performance.now();
					if (workload === 'proxy' || workload === 'websocket-authorization')
						expect(await f.proxy(workload === 'websocket-authorization')).toMatchObject({
							kind: 'forward',
						});
					else if (workload === 'reconnect') await expectOk(await f.admit());
					else if (workload === 'concurrent-due-heartbeats') {
						for (const response of await Promise.all(clients.map((client) => f.heartbeat(client))))
							await expectOk(response);
					} else await expectOk(await f.heartbeat());
					const elapsedMs = performance.now() - start;
					if (i >= 0)
						samples.push({
							elapsedMs,
							...counts(f.bucket.operations),
							authenticationCalls: authenticators.reduce(
								(sum, spy) => sum + spy.mock.calls.length,
								0,
							),
							authorizationCalls: authorizer.mock.calls.length,
							subjectContextCalls: context.mock.calls.length,
							constraintCalls: constraint.mock.calls.length,
							operations: f.bucket.operations,
						});
					vi.restoreAllMocks();
					vi.useRealTimers();
				}
				const times = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
				results.push({
					profile,
					workload,
					concurrency: workload === 'concurrent-due-heartbeats' ? 4 : 1,
					p50: times[9],
					p95: times[18],
					samples,
				});
			}
		}
		await writeFile(
			reportPath!,
			JSON.stringify(
				{
					environment: { node: process.version, platform: process.platform, arch: process.arch },
					warmups: 2,
					sampleCount: 20,
					kernel: 'fake compute; proxy authorization only; no kernel forwarding',
					results,
				},
				null,
				2,
			),
		);
	},
	180_000,
);
