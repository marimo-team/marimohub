import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { ACTOR, makeFakeSandbox } from '../../testing';
import {
	createNotebookId,
	createProjectId,
	createSandboxId,
	createSessionId,
	createVersionId,
} from '../../ids';
import type { SandboxId } from '../../ids';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import { execResult } from '../../ports/sandbox';
import { paths } from '../../paths';
import { NotFoundError } from '../../errors';
import { SessionService } from './SessionService';
import { AppPoolStore } from './AppPoolStore';
import { WarmPoolStore } from './WarmPoolStore';
import { WarmPoolService, WARM_POOL_MAX_IDLE_MS } from './WarmPoolService';
import type { WarmPoolConfig } from './WarmPoolService';

function setup(overrides: Partial<WarmPoolConfig> = {}) {
	const bucket = new MemoryBucket();
	const sessions = new SessionService(bucket);
	const live = new Map<SandboxId, SandboxInstance>();
	const created: SandboxId[] = [];
	const destroyed: SandboxId[] = [];
	const compute: SandboxProvider = {
		create(id) {
			const instance = makeFakeSandbox().instance;
			return {
				...instance,
				ready: async () => {
					created.push(id);
					live.set(id, instance);
				},
				destroy: async () => {
					destroyed.push(id);
					live.delete(id);
				},
			};
		},
		connectExisting(id) {
			const instance = live.get(id);
			if (!instance) throw new Error('missing sandbox');
			return instance;
		},
		proxy: async () => null,
	};
	let now = Date.now();
	const config: WarmPoolConfig = {
		enabled: true,
		size: 1,
		profiles: [{ key: 'default', resources: {} }],
		creationTimeoutMs: 300_000,
		minimumRemainingMs: 60_000,
		...overrides,
	};
	const replica = (options: Partial<WarmPoolConfig> = {}) =>
		new WarmPoolService(
			new WarmPoolStore(bucket, 'test-provider'),
			compute,
			sessions,
			{ ...config, ...options },
			undefined,
			() => now,
			new AppPoolStore(bucket),
		);
	const service = replica();
	const request = () => ({
		destination: {
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			session_id: createSessionId(),
		},
	});
	const members = async () => (await service.store.read()).pools.flatMap((pool) => pool.members);
	return {
		bucket,
		sessions,
		live,
		compute,
		created,
		destroyed,
		config,
		replica,
		service,
		request,
		members,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe('warm sandbox pools', () => {
	it('does no provider or claim work when disabled', async () => {
		const w = setup({ enabled: false });
		const get = vi.spyOn(w.bucket, 'get');
		expect(await w.service.claim(w.request())).toBeUndefined();
		expect(get).not.toHaveBeenCalled();
		await w.service.sweep();
		expect(w.created).toEqual([]);
	});

	it('counts in-flight creations toward a deployment-wide target', async () => {
		const w = setup({ size: 2 });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const create = w.compute.create.bind(w.compute);
		vi.spyOn(w.compute, 'create').mockImplementation((id, options) => {
			const sandbox = create(id, options);
			return {
				...sandbox,
				ready: async () => {
					await gate;
					await sandbox.ready!();
				},
			};
		});
		const first = w.service.sweep();
		await vi.waitFor(async () =>
			expect((await w.members()).filter((m) => m.state === 'creating')).toHaveLength(2),
		);
		await w.replica().sweep();
		expect(w.created).toHaveLength(0);
		release();
		await first;
		expect(w.created).toHaveLength(2);
		expect((await w.members()).map((m) => m.state)).toEqual(['ready', 'ready']);
	});

	it('lets only one replica claim a sandbox and replenishes it', async () => {
		const w = setup();
		await w.service.sweep();
		const claims = await Promise.all([
			w.service.claim(w.request()),
			w.replica().claim(w.request()),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(claims.find(Boolean)?.member.sandbox_id).toBe(w.created[0]);
		await w.service.sweep();
		expect(w.created).toHaveLength(2);
		expect((await w.members()).map((m) => m.state)).toEqual(['claimed', 'ready']);
	});

	it('publishes ownership before compute creation, including failed boot recovery', async () => {
		const w = setup();
		const create = w.compute.create.bind(w.compute);
		vi.spyOn(w.compute, 'create').mockImplementation((id, options) => {
			const sandbox = create(id, options);
			return {
				...sandbox,
				ready: async () => {
					expect((await w.members()).find((m) => m.sandbox_id === id)?.state).toBe('creating');
					await sandbox.ready!();
					throw new Error('boot failed');
				},
			};
		});
		await w.service.sweep();
		expect(w.live.size).toBe(0);
		expect(w.destroyed).toHaveLength(1);
		await w.service.sweep();
		expect(w.created).toHaveLength(1);
		w.advance(5_000);
		await w.service.sweep();
		expect(w.created).toHaveLength(2);
		expect((await w.service.store.read()).pools[0].retry_at).toBeGreaterThan(Date.now() + 10_000);
	});

	it.each([
		{ image: 'other-image' },
		{ profile: 'other-profile' },
		{ userHome: { key: 'alice', path: '/home/alice' } },
		{ restoreSnapshotId: 'snapshot' },
	])('bypasses incompatible launches: %j', async (extra) => {
		const w = setup();
		await w.service.sweep();
		expect(await w.service.claim({ ...w.request(), ...extra })).toBeUndefined();
		expect((await w.members())[0].state).toBe('ready');
	});

	it('falls back after a missing sandbox or failed command probe', async () => {
		const w = setup();
		await w.service.sweep();
		w.live.clear();
		expect(await w.service.claim(w.request())).toBeUndefined();
		await w.service.sweep();
		vi.spyOn(w.live.values().next().value!, 'exec').mockResolvedValue(
			execResult(false, '', 'failed'),
		);
		expect(await w.service.claim(w.request())).toBeUndefined();
		expect((await w.members())[0].state).toBe('retiring');
	});

	it('falls back on unavailable pool storage', async () => {
		const w = setup();
		vi.spyOn(w.bucket, 'get').mockRejectedValue(new Error('unavailable'));
		expect(await w.service.claim(w.request())).toBeUndefined();
		expect(w.created).toHaveLength(0);
	});

	it('keeps a published session safe if its publisher dies before handoff', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await w.service.claim(request))!;
		await w.sessions.createSession({
			...request.destination,
			user_id: ACTOR,
			sandbox_id: claim.member.sandbox_id,
		});
		w.advance(61_000);
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).not.toContain(claim.member.sandbox_id);
		await expect(w.service.handoff(claim)).rejects.toThrow('expired');
	});

	it('hands off to session teardown and removes the record only after reclamation', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await w.service.claim(request))!;
		await w.sessions.createSession({
			...request.destination,
			user_id: ACTOR,
			sandbox_id: claim.member.sandbox_id,
		});
		await w.service.handoff(claim);
		w.advance(WARM_POOL_MAX_IDLE_MS);
		await w.replica({ enabled: false }).sweep();
		expect((await w.members())[0].assigned).toBe(true);
		expect(w.destroyed).toEqual([]);
		await w.sessions.markSandboxReclaimed(
			request.destination.project_id,
			request.destination.session_id,
			new Date().toISOString(),
		);
		await w.replica({ enabled: false }).sweep();
		expect(await w.members()).toEqual([]);
	});

	it('destroys abandoned transfers and fences a delayed publisher', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await w.service.claim(request))!;
		w.advance(61_000);
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).toContain(claim.member.sandbox_id);
		await w.sessions.createSession({
			...request.destination,
			user_id: ACTOR,
			sandbox_id: claim.member.sandbox_id,
		});
		await expect(w.service.handoff(claim)).rejects.toThrow('expired');
		expect(w.created).toHaveLength(1);
	});

	it('protects an app reservation before its session record is published', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await w.service.claim(request))!;
		await new AppPoolStore(w.bucket).mutate(
			request.destination.project_id,
			request.destination.notebook_id,
			(pool) => {
				pool.members.push({
					session_id: request.destination.session_id,
					sandbox_id: claim.member.sandbox_id,
					user_id: ACTOR,
					source_version_id: createVersionId(),
					state: 'starting',
					created_at: Date.now(),
					operation_token: 'app',
					operation_expires_at: Date.now() + 900_000,
				});
				return { pool, value: undefined };
			},
		);
		w.advance(61_000);
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).toEqual([]);
		w.advance(900_000);
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).toContain(claim.member.sandbox_id);
	});

	it('does not reclaim a transfer if session ownership cannot be read', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await w.service.claim(w.request()))!;
		w.advance(61_000);
		vi.spyOn(w.sessions, 'getSession').mockRejectedValue(new Error('storage unavailable'));
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).not.toContain(claim.member.sandbox_id);
	});

	it('retains failed destruction for retry and never returns claims to ready', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await w.service.claim(w.request()))!;
		const create = w.compute.create.bind(w.compute);
		const spy = vi.spyOn(w.compute, 'create').mockImplementation((id, options) => ({
			...create(id, options),
			destroy: async () => {
				throw new Error('delete failed');
			},
		}));
		await expect(w.service.abandon(claim)).rejects.toThrow('delete failed');
		expect((await w.members())[0].state).toBe('retiring');
		spy.mockRestore();
		await w.replica({ enabled: false }).sweep();
		expect(await w.members()).toEqual([]);
		expect(w.destroyed).toContain(claim.member.sandbox_id);
	});

	it('protects a concurrent claim from a stale failing health check', async () => {
		const w = setup();
		await w.service.sweep();
		w.advance(30_001);
		let reject!: (error: Error) => void;
		const probe = vi.spyOn(w.live.values().next().value!, 'exec');
		probe.mockImplementationOnce(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		);
		const sweep = w.service.sweep();
		await vi.waitFor(() => expect(reject).toBeDefined());
		const claim = (await w.replica().claim(w.request()))!;
		reject(new Error('late probe failure'));
		await sweep;
		expect(w.destroyed).not.toContain(claim.member.sandbox_id);
		expect((await w.members()).find((m) => m.sandbox_id === claim.member.sandbox_id)?.state).toBe(
			'claimed',
		);
	});

	it('retires changed configurations and excess idle capacity', async () => {
		const w = setup({ size: 2 });
		await w.service.sweep();
		await w.replica({ size: 1 }).sweep();
		expect(w.live.size).toBe(1);
		await w
			.replica({ size: 1, profiles: [{ key: 'new-image', image: 'new-image', resources: {} }] })
			.sweep();
		expect(w.live.size).toBe(1);
		expect(w.created).toHaveLength(3);
		expect(w.destroyed).toHaveLength(2);
	});

	it.each([
		{ providerLifetimeMs: undefined, age: WARM_POOL_MAX_IDLE_MS },
		{ providerLifetimeMs: 90_000, age: 30_000 },
	])('rotates before idle/provider lifetime expires: %j', async ({ providerLifetimeMs, age }) => {
		const w = setup({ providerLifetimeMs });
		await w.service.sweep();
		const original = w.created[0];
		w.advance(age);
		expect(await w.service.claim(w.request())).toBeUndefined();
		await w.service.sweep();
		expect(w.destroyed).toContain(original);
		expect(w.created).toHaveLength(2);
	});

	it('rejects unreadable pool ownership rather than reporting an empty set', async () => {
		const w = setup();
		await w.bucket.put(paths.warmPool('test-provider'), '{invalid');
		await expect(w.service.store.ownedSandboxIds()).rejects.toThrow();
	});
});

describe('warm pool recovery races', () => {
	it('cannot retire a handed-off session using an earlier missing-session read', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await w.service.claim(request))!;
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const get = vi.spyOn(w.sessions, 'getSession').mockImplementationOnce(async () => {
			await gate;
			throw new NotFoundError('missing');
		});
		const sweep = w.replica({ enabled: false }).sweep();
		await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
		await w.sessions.createSession({
			...request.destination,
			user_id: ACTOR,
			sandbox_id: claim.member.sandbox_id,
		});
		await w.service.handoff(claim);
		w.advance(61_000);
		finish();
		await sweep;
		expect(w.destroyed).not.toContain(claim.member.sandbox_id);
		expect((await w.members())[0]).toMatchObject({ state: 'claimed', assigned: true });
	});

	it('destroys a late create after another replica removed its expired reservation', async () => {
		const w = setup();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const create = w.compute.create.bind(w.compute);
		vi.spyOn(w.compute, 'create').mockImplementation((id, options) => {
			const instance = create(id, options);
			return {
				...instance,
				ready: async () => {
					await gate;
					await instance.ready!();
				},
			};
		});
		const first = w.service.sweep();
		await vi.waitFor(async () => expect(await w.members()).toHaveLength(1));
		const id = (await w.members())[0].sandbox_id;
		w.advance(300_001);
		await w.replica({ enabled: false }).sweep();
		expect(await w.members()).toEqual([]);
		finish();
		await first;
		expect(w.live.size).toBe(0);
		expect(w.destroyed.filter((sandboxId) => sandboxId === id)).toHaveLength(2);
	});

	it('retains a late create whose cleanup fails after the caller timed out', async () => {
		vi.useFakeTimers();
		try {
			const w = setup({ creationTimeoutMs: 20 });
			let finish!: () => void;
			const gate = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const create = w.compute.create.bind(w.compute);
			const spy = vi.spyOn(w.compute, 'create').mockImplementation((id, options) => {
				const instance = create(id, options);
				return {
					...instance,
					ready: async () => {
						await gate;
						await instance.ready!();
					},
					destroy: async () => {
						if (w.live.has(id)) throw new Error('late cleanup failed');
						await instance.destroy();
					},
				};
			});
			const sweep = w.service.sweep();
			await vi.advanceTimersByTimeAsync(21);
			await sweep;
			finish();
			await vi.advanceTimersByTimeAsync(0);
			expect(w.live.size).toBe(1);
			expect((await w.members())[0].state).toBe('retiring');
			spy.mockRestore();
			await w.replica({ enabled: false }).sweep();
			expect(w.live.size).toBe(0);
			expect(await w.members()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('warm pool failure boundaries', () => {
	it.each([
		{ deadline: 'provider lifetime', providerLifetimeMs: 90_000, elapsed: 30_000 },
		{ deadline: 'claim lease', providerLifetimeMs: undefined, elapsed: 60_000 },
	])(
		'falls back if the $deadline expires during the claim probe',
		async ({ providerLifetimeMs, elapsed }) => {
			const w = setup({ providerLifetimeMs });
			await w.service.sweep();
			const id = w.created[0];
			vi.spyOn(w.live.get(id)!, 'exec').mockImplementationOnce(async () => {
				w.advance(elapsed);
				return execResult(true, '', '');
			});
			expect(await w.service.claim(w.request())).toBeUndefined();
			expect((await w.members())[0].state).toBe('retiring');
			await w.replica({ enabled: false }).sweep();
			expect(w.destroyed).toEqual([id]);
			expect(await w.members()).toEqual([]);
		},
	);

	it('fills each selected profile without exceeding shared targets across replicas', async () => {
		const profiles = ['small', 'large', 'gpu'].map((name) => ({
			name,
			key: name,
			resources: {},
		}));
		const w = setup({ size: 2, profiles });
		for (let tick = 0; tick < 3; tick++) {
			await Promise.all([w.service.sweep(), w.replica().sweep()]);
		}
		expect(w.created).toHaveLength(6);
		const pools = (await w.service.store.read()).pools;
		for (const pool of pools) expect(pool.members).toHaveLength(2);
		const claim = (await w.service.claim({ ...w.request(), profile: 'large' }))!;
		expect(
			pools.find((pool) => pool.key === 'large')!.members.map((member) => member.sandbox_id),
		).toContain(claim.member.sandbox_id);
	});

	it('does not contact compute when the creation reservation cannot be persisted', async () => {
		const w = setup();
		vi.spyOn(w.bucket, 'put').mockRejectedValue(new Error('bucket unavailable'));
		const create = vi.spyOn(w.compute, 'create');
		await expect(w.service.sweep()).rejects.toThrow('bucket unavailable');
		expect(create).not.toHaveBeenCalled();
		expect(await w.members()).toEqual([]);
	});

	it('recovers a committed reservation whose write response was lost without creating twice', async () => {
		const w = setup();
		const put = w.bucket.put.bind(w.bucket);
		vi.spyOn(w.bucket, 'put').mockImplementationOnce(async (...args) => {
			await put(...args);
			throw new Error('response lost');
		});
		await expect(w.service.sweep()).rejects.toThrow('response lost');
		const reserved = (await w.members())[0];
		await w.replica().sweep();
		expect(w.created).toEqual([]);
		w.advance(300_000);
		await w.replica().sweep();
		expect(w.destroyed).toContain(reserved.sandbox_id);
		expect(w.created).toHaveLength(1);
		expect(w.created[0]).not.toBe(reserved.sandbox_id);
		expect((await w.members())[0].state).toBe('ready');
	});

	it('never reassigns a claim whose successful write response was lost', async () => {
		const w = setup();
		await w.service.sweep();
		const id = w.created[0];
		const put = w.bucket.put.bind(w.bucket);
		vi.spyOn(w.bucket, 'put').mockImplementationOnce(async (...args) => {
			await put(...args);
			throw new Error('response lost');
		});
		expect(await w.service.claim(w.request())).toBeUndefined();
		expect(await w.replica().claim(w.request())).toBeUndefined();
		expect((await w.members())[0].state).toBe('claimed');
		w.advance(60_000);
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).toEqual([id]);
		expect(await w.members()).toEqual([]);
	});

	it('bounds a hanging claim probe and retires it before another claimant can use it', async () => {
		vi.useFakeTimers();
		try {
			const w = setup();
			await w.service.sweep();
			vi.spyOn(w.live.values().next().value!, 'exec').mockImplementation(
				() => new Promise(() => {}),
			);
			const claim = w.service.claim(w.request());
			await vi.advanceTimersByTimeAsync(2_000);
			expect(await claim).toBeUndefined();
			expect((await w.members())[0].state).toBe('retiring');
			expect(await w.replica().claim(w.request())).toBeUndefined();
			await w.replica({ enabled: false }).sweep();
			expect(w.live.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects a booted sandbox whose command probe fails', async () => {
		const w = setup();
		const create = w.compute.create.bind(w.compute);
		vi.spyOn(w.compute, 'create').mockImplementation((id, options) => ({
			...create(id, options),
			exec: async () => execResult(false, '', 'bootstrap failed'),
		}));
		await w.service.sweep();
		expect(w.created).toHaveLength(1);
		expect(w.destroyed).toEqual(w.created);
		expect(await w.members()).toEqual([]);
		expect(await w.service.claim(w.request())).toBeUndefined();
	});

	it('caps repeated creation backoff and resets it after a successful boot', async () => {
		const w = setup();
		const create = w.compute.create.bind(w.compute);
		const spy = vi.spyOn(w.compute, 'create').mockImplementation((id, options) => ({
			...create(id, options),
			ready: async () => {
				throw new Error('provider unavailable');
			},
		}));
		let now = w.now();
		for (let attempt = 1; attempt <= 11; attempt++) {
			await w.service.sweep();
			const pool = (await w.service.store.read()).pools[0];
			const delay = Math.min(300_000, 5_000 * 2 ** (attempt - 1));
			expect(pool.failures).toBe(Math.min(attempt, 10));
			expect(pool.retry_at - now).toBe(delay);
			const calls = spy.mock.calls.length;
			w.advance(delay - 1);
			await w.service.sweep();
			expect(spy).toHaveBeenCalledTimes(calls);
			w.advance(1);
			now += delay;
		}
		spy.mockRestore();
		await w.service.sweep();
		expect((await w.service.store.read()).pools[0]).toMatchObject({ failures: 0, retry_at: 0 });
		expect((await w.members())[0].state).toBe('ready');
	});

	it.each(['wrong sandbox', 'failed session', 'stale token', 'expired claim', 'expired lifetime'])(
		'fences handoff with %s',
		async (reason) => {
			const w = setup({ providerLifetimeMs: reason === 'expired lifetime' ? 90_000 : undefined });
			await w.service.sweep();
			const request = w.request();
			const claim = (await w.service.claim(request))!;
			await w.sessions.createSession({
				...request.destination,
				user_id: ACTOR,
				sandbox_id: reason === 'wrong sandbox' ? createSandboxId() : claim.member.sandbox_id,
			});
			if (reason === 'failed session') {
				await w.sessions.markFailed(
					request.destination.project_id,
					request.destination.session_id,
					{ code: 'STARTUP_FAILED', message: 'failed' },
				);
			}
			if (reason === 'stale token') claim.member.token = 'stale';
			if (reason === 'expired claim') w.advance(60_000);
			if (reason === 'expired lifetime') w.advance(30_000);
			await expect(w.service.handoff(claim)).rejects.toThrow();
			expect((await w.members())[0].assigned).toBe(false);
		},
	);

	it('does not destroy the current claim when an old token tries to abandon it', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await w.service.claim(w.request()))!;
		await w.service.abandon({ ...claim, member: { ...claim.member, token: 'stale' } });
		expect(w.destroyed).toEqual([]);
		expect((await w.members())[0]).toMatchObject({ state: 'claimed', token: claim.member.token });
	});

	it('retries cleanup when provider deletion succeeded but its bucket update failed', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await w.service.claim(w.request()))!;
		const put = w.bucket.put.bind(w.bucket);
		vi.spyOn(w.bucket, 'put')
			.mockImplementationOnce(put)
			.mockRejectedValueOnce(new Error('bucket unavailable'));
		await expect(w.service.abandon(claim)).rejects.toThrow('bucket unavailable');
		expect(w.live.size).toBe(0);
		expect((await w.members())[0].state).toBe('retiring');
		await w.replica({ enabled: false }).sweep();
		expect(await w.members()).toEqual([]);
		expect(w.destroyed).toEqual([claim.member.sandbox_id, claim.member.sandbox_id]);
	});
});
