import { APP_PRESENCE_PERSIST_INTERVAL_MS } from '../../constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createVersionId, UserId } from '../../ids';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { SessionService } from './SessionService';
import { AppPoolService } from './AppPoolService';
import { makeLocalSource } from '../../testing/fixtures';
import { paths } from '../../paths';
import { NotFoundError } from '../../errors';
import { DEFAULT_APP_POOL_POLICY } from './AppPoolRouter';
import type { AppPoolPolicy } from './AppPoolRouter';

describe('app pool admission and lifecycle', () => {
	const pid = createProjectId();
	const nid = createNotebookId();
	const v1 = createVersionId();
	const v2 = createVersionId();
	const v3 = createVersionId();
	let now: number;
	let bucket: MemoryBucket;
	let sessions: SessionService;
	let pool: AppPoolService;
	let policy: AppPoolPolicy;

	beforeEach(async () => {
		now = Date.now();
		bucket = new MemoryBucket();
		await bucket.put(paths.project(pid).notebook(nid).source, JSON.stringify(makeLocalSource(v1)));
		sessions = new SessionService(bucket);
		policy = { ...DEFAULT_APP_POOL_POLICY, maxUsersPerSession: 4 };
		pool = new AppPoolService(bucket, sessions, policy, undefined, () => now);
	});

	const admit = async (user = 'alice', versionId = v1, visitId = 'tab', service = pool) => {
		if (versionId !== v1)
			await bucket.put(
				paths.project(pid).notebook(nid).source,
				JSON.stringify(makeLocalSource(versionId)),
			);
		return service.admit({
			projectId: pid,
			notebookId: nid,
			userId: UserId.parse(user),
			versionId,
			visitId,
			startupMs: 900_000,
		});
	};
	const ready = async (
		admission: Awaited<ReturnType<typeof admit>>,
		authorizationExpiresAt?: string,
	) => {
		await sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: admission.member.user_id,
			mode: 'app',
			app_pool: true,
			session_id: admission.member.session_id,
			sandbox_id: admission.member.sandbox_id,
			source_version_id: admission.member.source_version_id,
			authorization_expires_at: authorizationExpiresAt,
		});
		await sessions.setRunning(pid, admission.member.session_id, 'https://sandbox.example');
		await pool.complete(pid, nid, admission.member.session_id, admission.member.operation_token);
		return admission;
	};
	const visit = (admission: Awaited<ReturnType<typeof admit>>, visitId = 'tab') => ({
		visit_id: visitId,
		generation: admission.assignment.generation,
	});
	const effects = () => ({ probe: vi.fn(async () => 0), retire: vi.fn(async () => true) });

	it('checks an empty deletion tombstone with one read and no writes', async () => {
		await pool.store.retireForDeletion(pid, nid);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		const list = vi.spyOn(bucket, 'list');
		const cleanup = effects();
		await pool.reconcile(pid, nid, cleanup);
		expect(get.mock.calls).toEqual([[paths.appPool(pid, nid)]]);
		expect(put).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
		expect(cleanup.probe).not.toHaveBeenCalled();
		expect(cleanup.retire).not.toHaveBeenCalled();
	});

	it.each(['ready', 'draining'] as const)(
		'retires a missing %s session before re-admission',
		async (state) => {
			const first = await ready(await admit());
			if (state === 'draining') await ready(await admit('bob', v2));
			await bucket.delete(paths.session(pid, first.member.session_id));
			const next = await admit('alice', state === 'draining' ? v2 : v1);
			expect(next.member.session_id).not.toBe(first.member.session_id);
			expect(next.assignment.generation).not.toBe(first.assignment.generation);
			expect(
				(await pool.inspect(pid, nid)).find(
					(member) => member.session_id === first.member.session_id,
				),
			).toMatchObject({ state: 'retiring', users: 0 });
			expect(
				await pool.heartbeat(
					pid,
					nid,
					UserId.parse('alice'),
					first.member.session_id,
					visit(first),
				),
			).toBe(false);
			const cleanup = effects();
			await pool.reconcile(pid, nid, cleanup);
			expect(cleanup.retire).toHaveBeenCalledWith(
				expect.objectContaining({ session_id: first.member.session_id }),
				null,
			);
		},
	);

	it('retains a live recordless startup until the reservation deadline', async () => {
		const first = await admit();
		const second = await admit('bob');
		expect(second.kind).toBe('reuse');
		expect(second.member.session_id).toBe(first.member.session_id);
		now = first.member.operation_expires_at;
		await pool.synchronize(pid, nid);
		expect((await pool.inspect(pid, nid))[0]).toMatchObject({ state: 'retiring', users: 0 });
	});

	it('rejects startup heartbeats at the operation deadline and frees the account slot', async () => {
		const first = await admit();
		now = first.member.operation_expires_at - 1;
		expect(
			await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first)),
		).toBe(true);
		now++;
		expect(
			await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first)),
		).toBe(false);
		expect((await pool.store.read(pid, nid))?.assignments).toEqual([]);
		expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			false,
		);
		const replacement = await admit();
		expect(replacement.member.session_id).not.toBe(first.member.session_id);
	});

	it('does not infer missing records from a partial legacy adoption snapshot', async () => {
		const first = await ready(await admit());
		await pool.synchronize(pid, nid, []);
		expect((await pool.inspect(pid, nid))[0]).toMatchObject({
			session_id: first.member.session_id,
			state: 'ready',
		});
	});

	it('does not retire a startup published while its missing record is being read', async () => {
		const first = await admit();
		vi.spyOn(sessions, 'getSession').mockImplementationOnce(async () => {
			now = first.member.operation_expires_at - 1;
			await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
			await ready(first);
			now++;
			throw new NotFoundError('not yet published');
		});
		await pool.synchronize(pid, nid);
		expect((await pool.inspect(pid, nid))[0]).toMatchObject({ state: 'ready', users: 1 });
	});

	it('bounds steady admission and maintenance reads to pool members without bucket scans', async () => {
		const first = await ready(await admit());
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		const list = vi.spyOn(bucket, 'list');
		const poolKey = paths.appPool(pid, nid);
		const sessionKey = paths.session(pid, first.member.session_id);
		await admit('bob');
		expect(list).not.toHaveBeenCalled();
		expect(get.mock.calls.map(([key]) => key)).toEqual([
			poolKey,
			sessionKey,
			poolKey,
			poolKey,
			paths.project(pid).notebook(nid).source,
			paths.project(pid).notebook(nid).source,
		]);
		expect(put.mock.calls.map(([key]) => key)).toEqual([poolKey]);
		get.mockClear();
		put.mockClear();
		await pool.reconcile(pid, nid, effects());
		expect(list).not.toHaveBeenCalled();
		expect(get.mock.calls.map(([key]) => key)).toEqual([poolKey, sessionKey, poolKey]);
		expect(put).not.toHaveBeenCalled();
	});

	it('coalesces presence writes across service instances without buffering accepted renewals', async () => {
		const first = await ready(await admit());
		const other = new AppPoolService(bucket, sessions, policy, undefined, () => now);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		const renew = (service: AppPoolService) =>
			service.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		for (let tick = 0; tick < 4; tick++) {
			now += APP_PRESENCE_PERSIST_INTERVAL_MS / 2;
			expect(await renew(tick % 2 ? other : pool)).toBe(true);
		}
		expect(get).toHaveBeenCalledTimes(4);
		expect(put).toHaveBeenCalledTimes(2);
		get.mockClear();
		put.mockClear();
		expect(await renew(other)).toBe(true);
		expect(put).not.toHaveBeenCalled();
		now += policy.userLeaseMs - 1;
		expect(await other.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			true,
		);
		now += 1;
		expect(await renew(pool)).toBe(false);
	});

	it('persists explicit departure even when the heartbeat write was coalesced', async () => {
		const first = await ready(await admit());
		now += 30_000;
		await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		const put = vi.spyOn(bucket, 'put');
		await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		expect(put).toHaveBeenCalledTimes(1);
		now += policy.reconnectGraceMs;
		expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			false,
		);
	});

	it('packs four accounts, expands for the fifth, and reuses released space', async () => {
		const first = await ready(await admit());
		for (const user of ['bob', 'charlie', 'dan'])
			expect((await admit(user)).member.session_id).toBe(first.member.session_id);
		const second = await ready(await admit('eve'));
		expect(second.kind).toBe('reserve');
		await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		now += policy.reconnectGraceMs + 1;
		expect((await admit('frank')).member.session_id).toBe(first.member.session_id);
	});

	it('defaults to one unlimited sandbox per version', async () => {
		delete policy.maxUsersPerSession;
		const first = await ready(await admit());
		for (let i = 0; i < 12; i++)
			expect((await admit(`user-${i}`)).member.session_id).toBe(first.member.session_id);
		expect((await pool.inspect(pid, nid))[0].users).toBe(13);
	});

	it('counts concurrent tabs and devices once and releases only the departed visit', async () => {
		const first = await ready(await admit());
		const secondTab = await admit('alice', v1, 'phone');
		expect(secondTab.assignment.generation).toBe(first.assignment.generation);
		expect((await pool.inspect(pid, nid))[0].users).toBe(1);
		await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		now += policy.reconnectGraceMs + 1;
		expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			true,
		);
	});

	it('retains stickiness during grace but uses the latest version after departure', async () => {
		const first = await ready(await admit());
		await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		expect((await admit('alice', v2)).member.session_id).toBe(first.member.session_id);
		await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		now += policy.reconnectGraceMs + 1;
		const next = await admit('alice', v2);
		expect(next.member.source_version_id).toBe(v2);
		expect(next.assignment.generation).not.toBe(first.assignment.generation);
	});

	it('pins users across repeated releases while allowing rollover surge', async () => {
		policy.maxSessionsPerVersion = 1;
		const first = await ready(await admit());
		await ready(await admit('bob', v2));
		await ready(await admit('charlie', v3));
		expect((await admit('alice', v3)).member.session_id).toBe(first.member.session_id);
		expect((await pool.inspect(pid, nid)).map((member) => member.state)).toEqual([
			'draining',
			'draining',
			'ready',
		]);
	});

	it('rejects a full pool without overbooking or losing existing assignments', async () => {
		policy.maxUsersPerSession = 1;
		policy.maxSessionsPerVersion = 1;
		const first = await ready(await admit());
		await expect(admit('bob')).rejects.toMatchObject({ status: 429 });
		expect((await admit()).member.session_id).toBe(first.member.session_id);
	});

	it('reserves starting capacity before compute or session creation', async () => {
		policy.maxUsersPerSession = 1;
		const first = await admit();
		const second = await admit('bob');
		expect(first.member.session_id).not.toBe(second.member.session_id);
	});

	it('independent instances race for the last slot without over-admission', async () => {
		policy.maxUsersPerSession = 1;
		policy.maxSessionsPerVersion = 1;
		const contenders = Array.from({ length: 8 }, (_, i) =>
			admit(
				`user-${i}`,
				v1,
				'tab',
				new AppPoolService(bucket, sessions, policy, undefined, () => now),
			),
		);
		const results = await Promise.allSettled(contenders);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		for (const result of results)
			if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 429 });
		expect((await pool.inspect(pid, nid))[0].users).toBe(1);
	});

	it('duplicate account admissions have only one provisioning winner', async () => {
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) => admit('alice', v1, `tab-${i}`)),
		);
		expect(results.filter((result) => result.kind === 'reserve')).toHaveLength(1);
		expect(new Set(results.map((result) => result.member.session_id)).size).toBe(1);
		expect((await pool.inspect(pid, nid))[0].users).toBe(1);
	});

	it('prefers ready capacity to a starting sandbox', async () => {
		policy.maxUsersPerSession = 1;
		const first = await ready(await admit());
		await admit('bob');
		await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		now += policy.reconnectGraceMs + 1;
		expect((await admit('charlie')).member.session_id).toBe(first.member.session_id);
	});

	it('does not regress the observed version for a delayed arrival', async () => {
		await admit('alice', v2);
		await expect(admit('bob', v1)).rejects.toMatchObject({ status: 409 });
		expect((await pool.store.read(pid, nid))?.latest_version_id).toBe(v2);
	});

	it('observes the latest version while preserving a reconnecting account assignment', async () => {
		const first = await ready(await admit());
		const reconnect = await admit('alice', v2, 'second-tab');
		expect(reconnect.assignment.generation).toBe(first.assignment.generation);
		expect(reconnect.member.session_id).toBe(first.member.session_id);
		expect(reconnect.member.state).toBe('draining');
		expect((await pool.store.read(pid, nid))?.latest_version_id).toBe(v2);
		await expect(admit('alice', v1)).rejects.toMatchObject({ status: 409 });
		expect((await pool.store.read(pid, nid))?.latest_version_id).toBe(v2);
	});

	it.each(['reserve', 'reuse', 'replace'] as const)(
		'%s compensates a source commit between the head read and pool CAS',
		async (operation) => {
			const first = await ready(await admit());
			if (operation === 'reserve') policy.maxUsersPerSession = 1;
			const put = bucket.put.bind(bucket);
			let committed = false;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key === paths.appPool(pid, nid) && !committed) {
					committed = true;
					await put(paths.project(pid).notebook(nid).source, JSON.stringify(makeLocalSource(v2)));
				}
				return put(key, value, options);
			});
			const admission =
				operation === 'replace'
					? pool.replace({
							projectId: pid,
							notebookId: nid,
							userId: UserId.parse('bob'),
							versionId: v1,
							startupMs: 900_000,
							replacesSessionId: first.member.session_id,
						})
					: admit('bob');
			await expect(admission).rejects.toMatchObject({ status: 409 });
			const stored = await pool.store.read(pid, nid);
			expect(stored?.assignments.map((item) => item.user_id)).toEqual(['alice']);
			const abandoned = stored?.members.filter(
				(item) => item.session_id !== first.member.session_id,
			);
			expect(abandoned).toHaveLength(operation === 'reuse' ? 0 : 1);
			expect(abandoned?.every((item) => item.state === 'retiring')).toBe(true);
			expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
				true,
			);
			const next = await admit('bob', v2);
			expect(next.member.source_version_id).toBe(v2);
		},
	);

	it('abandons a reservation when the post-CAS source check is unavailable', async () => {
		const first = await ready(await admit());
		policy.maxUsersPerSession = 1;
		const sourceKey = paths.project(pid).notebook(nid).source;
		const get = bucket.get.bind(bucket);
		const failure = new Error('source unavailable');
		let sourceReads = 0;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key === sourceKey && ++sourceReads === 2) throw failure;
			return get(key);
		});
		await expect(admit('bob')).rejects.toBe(failure);
		const stored = await pool.store.read(pid, nid);
		expect(stored?.assignments.map((item) => item.user_id)).toEqual(['alice']);
		expect(stored?.members).toHaveLength(2);
		expect(stored?.members[1].state).toBe('retiring');
		expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			true,
		);
		await pool.reconcile(pid, nid, effects());
		expect((await pool.inspect(pid, nid)).map((item) => item.session_id)).toEqual([
			first.member.session_id,
		]);
	});

	it('preserves a newer assignment when stale admission compensation loses a race', async () => {
		const first = await ready(await admit());
		const get = bucket.get.bind(bucket);
		const put = bucket.put.bind(bucket);
		const sourceKey = paths.project(pid).notebook(nid).source;
		let sourceReads = 0;
		let current: Awaited<ReturnType<typeof admit>> | undefined;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key === sourceKey && ++sourceReads === 2) {
				await put(sourceKey, JSON.stringify(makeLocalSource(v2)));
				await pool.store.mutate(pid, nid, (stored) => {
					stored.assignments = stored.assignments.filter((item) => item.user_id !== 'bob');
					return { pool: stored, value: undefined };
				});
				current = await admit('bob', v2);
			}
			return get(key);
		});
		await expect(admit('bob')).rejects.toMatchObject({ status: 409 });
		expect(current).toBeDefined();
		const stored = await pool.store.read(pid, nid);
		expect(stored?.latest_version_id).toBe(v2);
		expect(stored?.assignments.find((item) => item.user_id === 'bob')).toEqual(current?.assignment);
		expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			true,
		);
	});

	it('rechecks the authoritative head after a competing admission wins CAS', async () => {
		await ready(await admit());
		const put = bucket.put.bind(bucket);
		let entered!: () => void;
		let release!: () => void;
		const writing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === paths.appPool(pid, nid) && !held) {
				held = true;
				entered();
				await gate;
			}
			return put(key, value, options);
		});
		const delayed = admit('bob');
		const rejected = expect(delayed).rejects.toMatchObject({ status: 409 });
		await writing;
		await admit('carol', v2);
		release();
		await rejected;
		const stored = await pool.store.read(pid, nid);
		expect(stored?.latest_version_id).toBe(v2);
		expect(stored?.assignments.some((assignment) => assignment.user_id === 'bob')).toBe(false);
	});

	it('reserves one replacement across replicas and keeps other assignments sticky', async () => {
		const operator = await ready(await admit());
		const target = await ready(await admit('bob', v2));
		await pool.invalidate(pid, nid, target.member.session_id);
		const other = new AppPoolService(bucket, sessions, policy, undefined, () => now);
		const input = {
			projectId: pid,
			notebookId: nid,
			userId: UserId.parse('alice'),
			versionId: v2,
			replacesSessionId: target.member.session_id,
			startupMs: 900_000,
		};
		const results = await Promise.all([pool.replace(input), other.replace(input)]);
		expect(results.map((result) => result.kind).sort()).toEqual(['reserve', 'reuse']);
		expect(results[0].member.session_id).toBe(results[1].member.session_id);
		expect(results[0].member.session_id).not.toBe(operator.member.session_id);
		expect(await other.canAccess(pid, nid, UserId.parse('alice'), operator.member.session_id)).toBe(
			true,
		);
		expect(
			await other.canAccess(pid, nid, UserId.parse('alice'), results[0].member.session_id),
		).toBe(false);
	});

	it('enforces the current-version cap for explicit replacement reservations', async () => {
		policy.maxSessionsPerVersion = 1;
		const old = await ready(await admit());
		await ready(await admit('bob', v2));
		await pool.invalidate(pid, nid, old.member.session_id);
		await expect(
			pool.replace({
				projectId: pid,
				notebookId: nid,
				userId: UserId.parse('alice'),
				versionId: v2,
				replacesSessionId: old.member.session_id,
				startupMs: 900_000,
			}),
		).rejects.toMatchObject({ status: 429 });
	});

	it.each(['admit', 'replace'] as const)(
		'%s rejects missing, corrupt, or unavailable heads without reserving',
		async (operation) => {
			const sourceKey = paths.project(pid).notebook(nid).source;
			const input = {
				projectId: pid,
				notebookId: nid,
				userId: UserId.parse('alice'),
				versionId: v1,
				startupMs: 900_000,
				replacesSessionId: (await admit()).member.session_id,
			};
			await pool.invalidate(pid, nid, input.replacesSessionId);
			await pool.synchronize(pid, nid);
			const before = await pool.store.read(pid, nid);
			for (const content of [
				null,
				'invalid JSON',
				JSON.stringify({ schema_version: 1, type: 'local' }),
			]) {
				if (content === null) await bucket.delete(sourceKey);
				else await bucket.put(sourceKey, content);
				await expect(pool[operation](input)).rejects.toThrow();
				expect(await pool.store.read(pid, nid)).toEqual(before);
			}
			const get = bucket.get.bind(bucket);
			const failure = new Error('source unavailable');
			vi.spyOn(bucket, 'get').mockImplementation((key) =>
				key === sourceKey ? Promise.reject(failure) : get(key),
			);
			await expect(pool[operation](input)).rejects.toBe(failure);
			expect(await pool.store.read(pid, nid)).toEqual(before);
		},
	);

	it.each(['admit', 'replace'] as const)(
		'%s reports capacity rejection consistently',
		async (operation) => {
			policy.maxSessionsPerVersion = 1;
			policy.maxUsersPerSession = 1;
			const first = await ready(await admit());
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			const service = new AppPoolService(bucket, sessions, policy, metrics, () => now);
			await expect(
				service[operation]({
					projectId: pid,
					notebookId: nid,
					userId: UserId.parse('bob'),
					versionId: v1,
					startupMs: 900_000,
					replacesSessionId: first.member.session_id,
				}),
			).rejects.toMatchObject({ status: 429 });
			expect(metrics.increment).toHaveBeenCalledWith('app_pool.admission', 1, {
				decision: 'busy',
				operation,
			});
			expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
				true,
			);
		},
	);

	it('does not treat session lookup failures as missing sandboxes', async () => {
		await ready(await admit());
		const before = await pool.store.read(pid, nid);
		const failure = new Error('session lookup unavailable');
		vi.spyOn(sessions, 'getSession').mockRejectedValueOnce(failure);
		await expect(admit('bob')).rejects.toBe(failure);
		expect(await pool.store.read(pid, nid)).toEqual(before);
	});

	it.each(['probe', 'retire'] as const)(
		'continues maintenance after a %s failure and retries safely',
		async (stage) => {
			policy.maxUsersPerSession = 1;
			const first = await ready(await admit());
			await ready(await admit('bob'));
			now += policy.userLeaseMs + policy.idleMs;
			const cleanup = effects();
			cleanup[stage].mockRejectedValueOnce(new Error('provider unavailable'));
			await pool.reconcile(pid, nid, cleanup);
			expect(await pool.inspect(pid, nid)).toEqual([
				expect.objectContaining({
					session_id: first.member.session_id,
					state: stage === 'probe' ? 'ready' : 'retiring',
				}),
			]);
			await pool.reconcile(pid, nid, cleanup);
			expect(await pool.inspect(pid, nid)).toEqual([]);
		},
	);

	it('requires a recorded API visit for legacy-compatible heartbeats on managed members', async () => {
		const first = await ready(await admit());
		expect(await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			false,
		);
		await admit('alice', v1, 'api');
		expect(await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			true,
		);
		expect(await pool.heartbeat(pid, nid, UserId.parse('intruder'), first.member.session_id)).toBe(
			false,
		);
	});

	it.each(['unknown', 'departed'] as const)(
		'rejects a %s visit even when its assignment generation is current',
		async (state) => {
			const first = await ready(await admit());
			await admit('alice', v1, 'phone');
			const invalidVisit = visit(first, state === 'unknown' ? 'unknown' : 'tab');
			if (state === 'departed')
				await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, invalidVisit);
			const before = await pool.store.read(pid, nid);
			const put = vi.spyOn(bucket, 'put');
			expect(
				await pool.heartbeat(
					pid,
					nid,
					UserId.parse('alice'),
					first.member.session_id,
					invalidVisit,
				),
			).toBe(false);
			expect(put).not.toHaveBeenCalled();
			expect(await pool.store.read(pid, nid)).toEqual(before);
			expect(
				await pool.heartbeat(
					pid,
					nid,
					UserId.parse('alice'),
					first.member.session_id,
					visit(first, 'phone'),
				),
			).toBe(true);
		},
	);

	it.each(['running', 'terminating', 'failed', 'authorization boundary'] as const)(
		'reconciles a %s session without letting presence override mandatory retirement',
		async (state) => {
			const first = await ready(await admit(), new Date(now + 1).toISOString());
			if (state === 'terminating') await sessions.beginTerminating(pid, first.member.session_id);
			if (state === 'failed') await sessions.markFailed(pid, first.member.session_id);
			if (state === 'authorization boundary') now++;
			await pool.synchronize(pid, nid);
			const retained = state === 'running';
			expect((await pool.inspect(pid, nid))[0]).toMatchObject({
				state: retained ? 'ready' : 'retiring',
				users: retained ? 1 : 0,
			});
			expect(
				await pool.heartbeat(
					pid,
					nid,
					UserId.parse('alice'),
					first.member.session_id,
					visit(first),
				),
			).toBe(retained);
		},
	);

	it('keeps a retirement intent if its final session lookup fails', async () => {
		const first = await ready(await admit());
		await pool.invalidate(pid, nid, first.member.session_id);
		const getSession = sessions.getSession.bind(sessions);
		vi.spyOn(sessions, 'getSession')
			.mockImplementationOnce(getSession)
			.mockRejectedValueOnce(new Error('storage unavailable'));
		const cleanup = effects();
		await pool.reconcile(pid, nid, cleanup);
		expect(cleanup.retire).not.toHaveBeenCalled();
		expect((await pool.inspect(pid, nid))[0].state).toBe('retiring');
		await pool.reconcile(pid, nid, cleanup);
		expect(cleanup.retire).toHaveBeenCalledTimes(1);
		expect(await pool.inspect(pid, nid)).toEqual([]);
	});

	it('does not tear down a member already reclaimed by another replica during the probe', async () => {
		await ready(await admit());
		now += policy.userLeaseMs + policy.idleMs;
		const other = new AppPoolService(bucket, sessions, policy, undefined, () => now);
		const inner = effects();
		const outer = effects();
		outer.probe.mockImplementationOnce(async () => {
			await other.reconcile(pid, nid, inner);
			return 0;
		});
		await pool.reconcile(pid, nid, outer);
		expect(inner.retire).toHaveBeenCalledTimes(1);
		expect(outer.retire).not.toHaveBeenCalled();
		expect(await pool.inspect(pid, nid)).toEqual([]);
	});

	it('a slow old provision completes as draining', async () => {
		const first = await admit();
		await admit('bob', v2);
		await ready(first);
		expect((await pool.inspect(pid, nid))[0].state).toBe('draining');
	});

	it('rejects expired startup completion and reclaims a recordless reservation', async () => {
		const first = await admit();
		now += 900_001;
		await expect(
			pool.complete(pid, nid, first.member.session_id, first.member.operation_token),
		).rejects.toMatchObject({ status: 409 });
		const cleanup = effects();
		await pool.reconcile(pid, nid, cleanup);
		expect(cleanup.retire).toHaveBeenCalledWith(
			expect.objectContaining({ session_id: first.member.session_id }),
			null,
		);
		expect(await pool.inspect(pid, nid)).toEqual([]);
	});

	it('fences completion by operation token', async () => {
		const first = await admit();
		await expect(pool.complete(pid, nid, first.member.session_id, 'wrong')).rejects.toMatchObject({
			status: 409,
		});
	});

	it('expired heartbeats cannot reacquire a full slot', async () => {
		const first = await ready(await admit());
		now += policy.userLeaseMs + 1;
		expect(
			await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first)),
		).toBe(false);
		expect(await pool.canAccess(pid, nid, UserId.parse('alice'), first.member.session_id)).toBe(
			false,
		);
	});

	it('stale leave and heartbeat cannot alter a replacement assignment', async () => {
		const first = await ready(await admit());
		now += policy.userLeaseMs + 1;
		const next = await admit();
		await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
		expect(
			await pool.heartbeat(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first)),
		).toBe(false);
		expect(
			await pool.heartbeat(pid, nid, UserId.parse('alice'), next.member.session_id, visit(next)),
		).toBe(true);
	});

	it.each(['leave', 'lease expiry'] as const)(
		'starts idle retirement after %s, independently of slot expiry',
		async (departure) => {
			const first = await ready(await admit());
			const presenceEnd =
				now + (departure === 'leave' ? policy.reconnectGraceMs : policy.userLeaseMs);
			if (departure === 'leave')
				await pool.leave(pid, nid, UserId.parse('alice'), first.member.session_id, visit(first));
			const cleanup = effects();
			now = presenceEnd - 1;
			await pool.reconcile(pid, nid, cleanup);
			expect((await pool.inspect(pid, nid))[0].users).toBe(1);
			now = presenceEnd;
			await pool.reconcile(pid, nid, cleanup);
			expect((await pool.inspect(pid, nid))[0].users).toBe(0);
			expect((await pool.store.read(pid, nid))?.members[0].idle_since).toBe(presenceEnd);
			now = presenceEnd + policy.idleMs - 1;
			await pool.reconcile(pid, nid, cleanup);
			expect(cleanup.probe).not.toHaveBeenCalled();
			expect(cleanup.retire).not.toHaveBeenCalled();
			now++;
			await pool.reconcile(pid, nid, cleanup);
			expect(cleanup.retire).toHaveBeenCalledTimes(1);
		},
	);

	it('a delayed maintenance pass measures idle time from the last visit expiry', async () => {
		const first = await ready(await admit());
		now += 10_000;
		await admit('bob');
		const lastVisitExpiry = now + policy.userLeaseMs;
		now = lastVisitExpiry + policy.idleMs;
		const cleanup = effects();
		await pool.reconcile(pid, nid, cleanup);
		expect(cleanup.retire).toHaveBeenCalledWith(
			expect.objectContaining({ session_id: first.member.session_id, idle_since: lastVisitExpiry }),
			expect.objectContaining({ session_id: first.member.session_id }),
		);
	});

	it('an admission during the retirement probe prevents teardown', async () => {
		const first = await ready(await admit());
		now += policy.userLeaseMs + 1;
		await pool.synchronize(pid, nid);
		now += policy.idleMs;
		const cleanup = effects();
		cleanup.probe.mockImplementation(async () => {
			await admit('bob');
			return 0;
		});
		await pool.reconcile(pid, nid, cleanup);
		expect(cleanup.retire).not.toHaveBeenCalled();
		expect((await pool.inspect(pid, nid))[0].session_id).toBe(first.member.session_id);
	});

	it.each([null, 1])(
		'protects idle kernels when the connection probe returns %s',
		async (connections) => {
			await ready(await admit());
			now += policy.userLeaseMs + 1;
			await pool.synchronize(pid, nid);
			now += policy.idleMs;
			const retire = vi.fn(async () => true);
			await pool.reconcile(pid, nid, { probe: async () => connections, retire });
			expect(retire).not.toHaveBeenCalled();
		},
	);

	it('retains failed cleanup and retries it after a service restart', async () => {
		const first = await admit();
		await pool.invalidate(pid, nid, first.member.session_id);
		await pool.reconcile(pid, nid, { ...effects(), retire: async () => false });
		expect((await pool.inspect(pid, nid))[0].state).toBe('retiring');
		const restarted = new AppPoolService(bucket, sessions, policy, undefined, () => now);
		await restarted.reconcile(pid, nid, effects());
		expect(await pool.inspect(pid, nid)).toEqual([]);
	});

	it('keeps project and starter caps occupied through failed retirement', async () => {
		const admission = await admit();
		const session = await sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: UserId.parse('alice'),
			mode: 'app',
			app_pool: true,
			session_id: admission.member.session_id,
			sandbox_id: admission.member.sandbox_id,
		});
		await pool.invalidate(pid, nid, session.session_id);
		const retire = vi.fn(async () => {
			await sessions.beginTerminating(pid, session.session_id);
			await sessions.markTerminated(pid, session.session_id);
			return false;
		});
		await pool.reconcile(pid, nid, { ...effects(), retire });
		expect(retire).toHaveBeenCalledOnce();
		expect((await pool.inspect(pid, nid))[0].state).toBe('retiring');
		expect(await sessions.countActiveAppsForProject(pid)).toBe(1);
		expect(await sessions.countActiveForUser(UserId.parse('alice'), 'project')).toBe(1);
		retire.mockImplementation(async () => {
			await sessions.markSandboxReclaimed(pid, session.session_id, new Date(now).toISOString());
			return true;
		});
		await pool.reconcile(pid, nid, { ...effects(), retire });
		expect(retire).toHaveBeenCalledTimes(2);
		expect(await pool.inspect(pid, nid)).toEqual([]);
		expect(await sessions.countActiveAppsForProject(pid)).toBe(0);
		expect(await sessions.countActiveForUser(UserId.parse('alice'), 'project')).toBe(0);
	});

	it('protects reserved and retiring source versions until reclamation', async () => {
		const admission = await admit();
		expect(await sessions.listProtectedVersionIds(pid, nid)).toEqual(new Set([v1]));
		await pool.invalidate(pid, nid, admission.member.session_id);
		expect(await sessions.listProtectedVersionIds(pid, nid)).toEqual(new Set([v1]));
		await pool.reconcile(pid, nid, effects());
		expect(await sessions.listProtectedVersionIds(pid, nid)).toEqual(new Set());
	});

	it('late completion and invalidation do not recreate a deleted pool', async () => {
		const admission = await admit();
		await bucket.delete(paths.appPool(pid, nid));
		await expect(ready(admission)).rejects.toMatchObject({ status: 409 });
		await pool.invalidate(pid, nid, admission.member.session_id);
		expect(await pool.store.read(pid, nid)).toBeNull();
	});

	it('adopts a legacy singleton for drain-only access and heartbeat registration', async () => {
		const legacy = await sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: UserId.parse('alice'),
			mode: 'app',
			sandbox_id: (await admit()).member.sandbox_id,
		});
		await pool.synchronize(pid, nid, [legacy]);
		expect(await pool.heartbeat(pid, nid, UserId.parse('legacy-user'), legacy.session_id)).toBe(
			true,
		);
		expect((await admit('bob')).member.session_id).not.toBe(legacy.session_id);
		expect(
			(await pool.inspect(pid, nid)).find((item) => item.session_id === legacy.session_id)?.state,
		).toBe('draining');
	});

	it('fences legacy fallback and late adoption after deletion', async () => {
		const admission = await ready(await admit());
		const legacy = await sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: UserId.parse('alice'),
			mode: 'app',
			sandbox_id: admission.member.sandbox_id,
		});
		expect(await pool.canAccess(pid, nid, UserId.parse('legacy'), legacy.session_id, true)).toBe(
			true,
		);
		await pool.store.retireForDeletion(pid, nid);
		expect(await pool.canAccess(pid, nid, UserId.parse('legacy'), legacy.session_id, true)).toBe(
			false,
		);
		await pool.synchronize(pid, nid, [legacy]);
		expect(
			(await pool.inspect(pid, nid)).find((member) => member.session_id === legacy.session_id),
		).toMatchObject({ state: 'retiring', users: 0 });
		expect(await pool.heartbeat(pid, nid, UserId.parse('legacy'), legacy.session_id)).toBe(false);
		await expect(admit()).rejects.toMatchObject({ status: 404 });
		await expect(
			pool.complete(pid, nid, admission.member.session_id, admission.member.operation_token),
		).rejects.toMatchObject({ status: 409 });
	});
});
