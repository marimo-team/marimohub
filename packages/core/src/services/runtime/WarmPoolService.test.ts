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
import { claimWarm } from '../../testing/warmPool';

/** Session start's sequence: a failed probe retires the member and falls back to a cold boot. */
function setup(overrides: Partial<WarmPoolConfig> = {}, referenceFor?: (id: SandboxId) => string) {
	const bucket = new MemoryBucket();
	const sessions = new SessionService(bucket);
	const live = new Map<SandboxId, SandboxInstance>();
	const created: SandboxId[] = [];
	const destroyed: SandboxId[] = [];
	const compute: SandboxProvider = {
		create(id) {
			const instance = {
				...makeFakeSandbox().instance,
				...(referenceFor ? { reconnectReference: referenceFor(id) } : {}),
			};
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
	it('reserves without probing, then retires a failed probe', async () => {
		const w = setup();
		await w.service.sweep();
		const sandbox = [...w.live.values()][0];
		const probe = vi.spyOn(sandbox, 'exec').mockRejectedValue(new Error('transport failed'));
		const claim = (await w.service.reserve(w.request()))!;
		expect(probe).not.toHaveBeenCalled();
		expect((await w.members())[0]).toMatchObject({ state: 'claimed', token: claim.member.token });
		await expect(w.service.probe(claim)).rejects.toThrow('readiness failed');
		expect((await w.members())[0].state).toBe('retiring');
	});

	it('checks claim expiry after an overlapping probe completes', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await w.service.reserve(w.request()))!;
		vi.spyOn(claim.sandbox, 'exec').mockImplementationOnce(async () => {
			w.advance(60_000);
			return { success: true, stdout: '', stderr: '', exitCode: 0 };
		});
		await expect(w.service.probe(claim)).rejects.toThrow('expired');
		expect((await w.members())[0].state).toBe('retiring');
	});

	it('publishes provider references and claims them from another replica', async () => {
		const w = setup({}, (id) => `provider-reference:${id}`);
		await w.service.sweep();
		const member = (await w.members())[0];
		expect(member.reconnect_reference).toBe(`provider-reference:${member.sandbox_id}`);
		const connect = vi.spyOn(w.compute, 'connectExisting');
		const request = { ...w.request(), reconnectReference: 'untrusted-request-reference' };
		const claim = await claimWarm(w.replica(), request);
		expect(claim?.member.sandbox_id).toBe(member.sandbox_id);
		expect(connect).toHaveBeenCalledWith(member.sandbox_id, {
			...w.config.profiles[0],
			reconnectReference: member.reconnect_reference,
		});
		expect(w.created).toHaveLength(1);
	});

	it('drains claim diagnostics before handing the sandbox to provisioning', async () => {
		const w = setup();
		await w.service.sweep();
		const sandbox = w.live.get((await w.members())[0].sandbox_id)!;
		let timings = { get_ms: 125 };
		let counters = { execs: 1 };
		sandbox.drainTimings = vi.fn(function (this: SandboxInstance) {
			expect(this).toBe(sandbox);
			const result = timings;
			timings = { get_ms: 0 };
			return result;
		});
		sandbox.drainCounters = vi.fn(function (this: SandboxInstance) {
			expect(this).toBe(sandbox);
			const result = counters;
			counters = { execs: 0 };
			return result;
		});
		const claim = await claimWarm(w.service, w.request());
		expect(claim?.sandbox).toBe(sandbox);
		expect(sandbox.drainTimings).toHaveBeenCalledTimes(1);
		expect(sandbox.drainCounters).toHaveBeenCalledTimes(1);
		expect(claim!.sandbox.drainTimings!()).toEqual({ get_ms: 0 });
		expect(claim!.sandbox.drainCounters!()).toEqual({ execs: 0 });
	});

	it('keeps healthy claims when optional diagnostic drains fail', async () => {
		const w = setup();
		await w.service.sweep();
		const sandbox = w.live.get((await w.members())[0].sandbox_id)!;
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		sandbox.drainTimings = vi.fn(() => {
			throw new Error('secret-provider-request');
		});
		sandbox.drainCounters = vi.fn(() => ({}));
		expect((await claimWarm(w.service, w.request()))?.sandbox).toBe(sandbox);
		expect(sandbox.drainCounters).toHaveBeenCalledTimes(1);
		expect((await w.members())[0].state).toBe('claimed');
		expect(log.mock.calls.flat().join('')).toContain('warm_pool_diagnostics_failed');
		expect(log.mock.calls.flat().join('')).not.toContain('secret-provider-request');
	});

	it('backfills legacy entries during successful health checks without replacing their container', async () => {
		const w = setup();
		await w.service.sweep();
		const member = (await w.members())[0];
		expect(member.reconnect_reference).toBeUndefined();
		Object.defineProperty(w.live.get(member.sandbox_id)!, 'reconnectReference', {
			value: 'new-reference',
		});
		const connect = vi.spyOn(w.compute, 'connectExisting');
		w.advance(30_001);
		await w.replica().sweep();
		expect((await w.members())[0].reconnect_reference).toBe('new-reference');
		expect(connect).toHaveBeenCalledWith(member.sandbox_id, {});
		connect.mockClear();
		w.advance(30_001);
		await w.replica().sweep();
		expect(connect).toHaveBeenCalledWith(member.sandbox_id, {
			reconnectReference: 'new-reference',
		});
		expect(w.created).toHaveLength(1);
	});

	it('ignores a request reference when the stored member has no reference', async () => {
		const w = setup();
		await w.service.sweep();
		const connect = vi.spyOn(w.compute, 'connectExisting');
		const request = { ...w.request(), reconnectReference: 'untrusted-reference' };
		const claim = await claimWarm(w.replica(), request);
		expect(claim).toBeDefined();
		expect(connect).toHaveBeenCalledExactlyOnceWith(claim!.member.sandbox_id, w.config.profiles[0]);
		expect(claim!.member.reconnect_reference).toBeUndefined();
	});

	it('does not let a stale successful health check backfill a concurrently claimed member', async () => {
		const w = setup();
		await w.service.sweep();
		const member = (await w.members())[0];
		const sandbox = w.live.get(member.sandbox_id)!;
		Object.defineProperty(sandbox, 'reconnectReference', { value: 'discovered-reference' });
		let finishHealth!: () => void;
		vi.spyOn(sandbox, 'exec').mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishHealth = () => resolve(execResult(true, '', ''));
				}),
		);
		w.advance(30_001);
		const sweep = w.service.sweep();
		await vi.waitFor(() => expect(finishHealth).toBeDefined());
		const claim = (await claimWarm(w.replica(), w.request()))!;
		finishHealth();
		await sweep;
		const current = (await w.members()).find((item) => item.sandbox_id === member.sandbox_id)!;
		expect(current).toMatchObject({ state: 'claimed', token: claim.member.token });
		expect(current.reconnect_reference).toBeUndefined();
		expect(w.destroyed).not.toContain(member.sandbox_id);
	});

	it('retires a missing referenced sandbox rather than replacing it inside the claim', async () => {
		const w = setup({}, () => 'saved-reference');
		await w.service.sweep();
		w.live.clear();
		expect(await claimWarm(w.service, w.request())).toBeUndefined();
		expect((await w.members())[0].state).toBe('retiring');
		expect(w.created).toHaveLength(1);
	});

	it.each(['', 'x'.repeat(4097)])(
		'does not publish invalid provider references (%#)',
		async (reference) => {
			const w = setup({}, () => reference);
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			await w.service.sweep();
			expect(await w.members()).toEqual([]);
			expect(w.destroyed).toEqual(w.created);
			expect(log.mock.calls.flat().join('')).not.toContain('x'.repeat(4097));
		},
	);

	it('preserves a maximum-length reference when a later handle omits it', async () => {
		const reference = 'x'.repeat(4096);
		const w = setup({}, () => reference);
		await w.service.sweep();
		const member = (await w.members())[0];
		expect(member.reconnect_reference).toBe(reference);
		Object.defineProperty(w.live.get(member.sandbox_id)!, 'reconnectReference', {
			value: undefined,
		});
		w.advance(30_001);
		await w.replica().sweep();
		expect((await w.members())[0]).toMatchObject({
			sandbox_id: member.sandbox_id,
			state: 'ready',
			checked_at: w.now(),
			reconnect_reference: reference,
		});
		expect(w.created).toHaveLength(1);
		expect(w.destroyed).toEqual([]);
	});

	it('retires an invalid backfill without publishing it, even when cleanup fails', async () => {
		const w = setup();
		await w.service.sweep();
		const member = (await w.members())[0];
		Object.defineProperty(w.live.get(member.sandbox_id)!, 'reconnectReference', { value: '' });
		const create = w.compute.create.bind(w.compute);
		vi.spyOn(w.compute, 'create').mockImplementation((id, options) => ({
			...create(id, options),
			destroy: async () => {
				throw new Error('delete unavailable');
			},
		}));
		w.advance(30_001);
		await w.replica().sweep();
		const current = (await w.members()).find((item) => item.sandbox_id === member.sandbox_id)!;
		expect(current).toMatchObject({ state: 'retiring', checked_at: member.checked_at });
		expect(current.reconnect_reference).toBeUndefined();
		const claim = await claimWarm(w.service, w.request());
		expect(claim).toBeDefined();
		expect(claim!.member.sandbox_id).not.toBe(member.sandbox_id);
	});

	it('does not read or publish a backfill reference after a failed health probe', async () => {
		const w = setup();
		await w.service.sweep();
		const member = (await w.members())[0];
		const sandbox = w.live.get(member.sandbox_id)!;
		const reference = vi.fn(() => 'unproven-reference');
		Object.defineProperty(sandbox, 'reconnectReference', { get: reference });
		vi.spyOn(sandbox, 'exec').mockRejectedValue(new Error('probe unavailable'));
		w.advance(30_001);
		await w.replica().sweep();
		expect(reference).not.toHaveBeenCalled();
		expect(w.destroyed).toContain(member.sandbox_id);
		expect((await w.members()).some((item) => item.sandbox_id === member.sandbox_id)).toBe(false);
	});

	it('claims the resources requested when two profiles share a name', async () => {
		const w = setup({
			profiles: [
				{ key: 'editing', name: 'small', resources: { cpu: 2 } },
				{ key: 'app', name: 'small', resources: { cpu: 1 } },
			],
		});
		await w.service.sweep();
		const pools = (await w.service.store.read()).pools;
		const appSandbox = pools.find((p) => p.key === 'app')?.members[0]?.sandbox_id;
		const claim = await claimWarm(w.service, {
			...w.request(),
			profile: 'small',
			resources: { cpu: 1 },
		});
		expect(appSandbox).toBeDefined();
		expect(claim?.member.sandbox_id).toBe(appSandbox);
		expect(
			await claimWarm(w.service, { ...w.request(), profile: 'small', resources: { cpu: 3 } }),
		).toBeUndefined();
	});

	it('bounds provider lifetime from readiness and does not extend it during health checks', async () => {
		const lifetime = 60 * 60_000;
		const w = setup({ providerLifetimeMs: lifetime });
		const create = w.compute.create.bind(w.compute);
		vi.spyOn(w.compute, 'create').mockImplementation((...args) => {
			const instance = create(...args);
			return {
				...instance,
				ready: async () => {
					w.advance(20_000);
					await instance.ready?.();
				},
			};
		});
		await w.service.sweep();
		const original = (await w.members())[0];
		expect(original.sandbox_deadline_at).toBe(w.now() + lifetime);
		expect(original.sandbox_deadline_at).toBeGreaterThan(original.created_at + lifetime);
		w.advance(60_000);
		await w.service.sweep();
		const checked = (await w.members())[0];
		expect(checked.checked_at).toBe(w.now());
		expect(checked.sandbox_deadline_at).toBe(original.sandbox_deadline_at);
	});

	it('does not invent a deadline for an unbounded provider', async () => {
		const w = setup();
		await w.service.sweep();
		expect((await w.members())[0].sandbox_deadline_at).toBeUndefined();
	});

	it('does no provider or claim work when disabled', async () => {
		const w = setup({ enabled: false });
		const get = vi.spyOn(w.bucket, 'get');
		expect(await claimWarm(w.service, w.request())).toBeUndefined();
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

	it.each([
		{ name: 'disabled', options: { enabled: false }, remaining: 0 },
		{ name: 'downsized', options: { size: 1 }, remaining: 1 },
	])('retires $name in-flight reservations before they publish', async ({ options, remaining }) => {
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
		const filling = w.service.sweep();
		await vi.waitFor(async () => expect(await w.members()).toHaveLength(2));
		await w.replica(options).sweep();
		expect((await w.members()).map((member) => member.state)).toEqual(
			Array.from({ length: remaining }, () => 'creating'),
		);
		release();
		await filling;
		expect((await w.members()).map((member) => member.state)).toEqual(
			Array.from({ length: remaining }, () => 'ready'),
		);
		expect(w.live.size).toBe(remaining);
		expect((await w.service.store.read()).pools[0]).toMatchObject({ failures: 0, retry_at: 0 });
		await w.replica(options).sweep();
		expect((await w.members()).filter((member) => member.state === 'ready')).toHaveLength(
			remaining,
		);
	});

	it('lets only one replica claim a sandbox and replenishes it', async () => {
		const w = setup();
		await w.service.sweep();
		const claims = await Promise.all([
			claimWarm(w.service, w.request()),
			claimWarm(w.replica(), w.request()),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(claims.find(Boolean)?.member.sandbox_id).toBe(w.created[0]);
		await w.service.sweep();
		expect(w.created).toHaveLength(2);
		expect((await w.members()).map((m) => m.state)).toEqual(['claimed', 'ready']);
	});

	it('does not back off provider creation after a publication storage failure', async () => {
		const w = setup();
		vi.spyOn(w.service.store, 'updateMember').mockRejectedValueOnce(
			new Error('bucket unavailable'),
		);
		await w.service.sweep();
		expect(w.destroyed).toHaveLength(1);
		expect((await w.service.store.read()).pools[0]).toMatchObject({ failures: 0, retry_at: 0 });
		await w.service.sweep();
		expect((await w.members()).map((member) => member.state)).toEqual(['ready']);
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
		expect(await claimWarm(w.service, { ...w.request(), ...extra })).toBeUndefined();
		expect((await w.members())[0].state).toBe('ready');
	});

	it.each([undefined, 'saved-reference'])(
		'falls back after a missing sandbox or failed command probe (%#)',
		async (reference) => {
			const w = setup({}, reference === undefined ? undefined : () => reference);
			await w.service.sweep();
			w.live.clear();
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
			await w.service.sweep();
			vi.spyOn(w.live.values().next().value!, 'exec').mockResolvedValue(
				execResult(false, '', 'failed'),
			);
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
			expect((await w.members())[0].state).toBe('retiring');
		},
	);

	it('falls back on unavailable pool storage', async () => {
		const w = setup();
		vi.spyOn(w.bucket, 'get').mockRejectedValue(new Error('unavailable'));
		expect(await claimWarm(w.service, w.request())).toBeUndefined();
		expect(w.created).toHaveLength(0);
	});

	it('keeps a published session safe if its publisher dies before handoff', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await claimWarm(w.service, request))!;
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
		const claim = (await claimWarm(w.service, request))!;
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

	it.each([true, false])(
		'forgets assigned members after session retention (enabled: %s)',
		async (enabled) => {
			const w = setup();
			await w.service.sweep();
			const request = w.request();
			const claim = (await claimWarm(w.service, request))!;
			const session = await w.sessions.createSession({
				...request.destination,
				user_id: ACTOR,
				sandbox_id: claim.member.sandbox_id,
			});
			await w.service.handoff(claim);
			await w.sessions.markFailed(session.project_id, session.session_id, {
				code: 'STARTUP_FAILED',
				message: 'failed',
			});
			await w.compute.create(claim.member.sandbox_id).destroy();
			await w.sessions.markSandboxReclaimed(
				session.project_id,
				session.session_id,
				new Date().toISOString(),
			);
			const elapsed = 25 * 60 * 60_000;
			vi.spyOn(Date, 'now').mockReturnValue(Date.parse(session.last_heartbeat) + elapsed);
			w.advance(elapsed);
			expect(await w.sessions.reapTerminated()).toBe(1);
			expect((await w.members())[0]).toMatchObject({ state: 'claimed', assigned: true });
			await w.replica({ enabled }).sweep();
			expect((await w.members()).map((member) => member.state)).toEqual(enabled ? ['ready'] : []);
			expect(w.destroyed).toEqual([claim.member.sandbox_id]);
		},
	);

	it('retains assigned ownership when the destination read fails', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await claimWarm(w.service, request))!;
		await w.sessions.createSession({
			...request.destination,
			user_id: ACTOR,
			sandbox_id: claim.member.sandbox_id,
		});
		await w.service.handoff(claim);
		vi.spyOn(w.sessions, 'getSession').mockRejectedValue(new Error('storage unavailable'));
		w.advance(61_000);
		await w.replica({ enabled: false }).sweep();
		expect((await w.members())[0]).toMatchObject({ state: 'claimed', assigned: true });
		expect(w.destroyed).toEqual([]);
	});

	it('destroys abandoned transfers and fences a delayed publisher', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await claimWarm(w.service, request))!;
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
		const claim = (await claimWarm(w.service, request))!;
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
		const claim = (await claimWarm(w.service, w.request()))!;
		w.advance(61_000);
		vi.spyOn(w.sessions, 'getSession').mockRejectedValue(new Error('storage unavailable'));
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).not.toContain(claim.member.sandbox_id);
	});

	it('retains failed destruction for retry and never returns claims to ready', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await claimWarm(w.service, w.request()))!;
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

	it('retains the destination until a failed reclamation marker can be retried', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await claimWarm(w.service, request))!;
		await w.sessions.createSession({
			...request.destination,
			user_id: ACTOR,
			mode: 'edit',
			sandbox_id: claim.member.sandbox_id,
		});
		const marker = vi
			.spyOn(w.sessions, 'markSandboxReclaimed')
			.mockRejectedValueOnce(new Error('session storage unavailable'));
		await expect(w.service.abandon(claim)).rejects.toThrow('session storage unavailable');
		expect((await w.members())[0]).toMatchObject({
			state: 'retiring',
			destination: request.destination,
		});
		await w.replica({ enabled: false }).sweep();
		expect(marker).toHaveBeenCalledTimes(2);
		expect(await w.members()).toEqual([]);
		expect(
			await w.sessions.getSession(request.destination.project_id, request.destination.session_id),
		).toHaveProperty('sandbox_reclaimed_at');
	});

	it('does not mark a different sandbox reclaimed at the claim destination', async () => {
		const w = setup();
		await w.service.sweep();
		const request = w.request();
		const claim = (await claimWarm(w.service, request))!;
		await w.sessions.createSession({
			...request.destination,
			user_id: ACTOR,
			mode: 'edit',
			sandbox_id: createSandboxId(),
		});
		await w.service.abandon(claim);
		expect(await w.members()).toEqual([]);
		expect(
			(await w.sessions.getSession(request.destination.project_id, request.destination.session_id))
				.sandbox_reclaimed_at,
		).toBeUndefined();
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
		const claim = (await claimWarm(w.replica(), w.request()))!;
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
		{ providerLifetimeMs: undefined, expectedAge: 6 * 60 * 60_000 },
		{ providerLifetimeMs: 8 * 60 * 60_000, expectedAge: (3 * 60 + 48) * 60_000 },
	])(
		'migrates a legacy idle deadline without replacing the sandbox: %j',
		async ({ providerLifetimeMs, expectedAge }) => {
			const w = setup({ providerLifetimeMs, minimumRemainingMs: (4 * 60 + 12) * 60_000 });
			await w.service.sweep();
			const original = (await w.members())[0];
			await w.service.store.updateMember(original, 'ready', (member) => {
				member.ready_until = member.created_at + 30 * 60_000;
			});
			w.advance(30 * 60_000);
			await w.service.sweep();
			expect(w.created).toEqual([original.sandbox_id]);
			expect(w.destroyed).toEqual([]);
			expect((await w.members())[0]).toMatchObject({
				...original,
				ready_until: original.created_at + expectedAge,
				checked_at: w.now(),
			});
			w.advance(expectedAge - 30 * 60_000 - 1);
			await w.service.sweep();
			expect(w.created).toEqual([original.sandbox_id]);
			w.advance(1);
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
			await w.service.sweep();
			expect(w.destroyed).toEqual([original.sandbox_id]);
		},
	);

	it('does not extend a legacy deadline after a session claims the sandbox', async () => {
		const w = setup();
		await w.service.sweep();
		const original = (await w.members())[0];
		const legacyDeadline = original.created_at + 30 * 60_000;
		await w.service.store.updateMember(original, 'ready', (member) => {
			member.ready_until = legacyDeadline;
		});
		const claim = (await w.service.reserve(w.request()))!;
		await w.service.sweep();
		expect(await w.service.store.getMember(original.sandbox_id)).toMatchObject({
			state: 'claimed',
			token: claim.member.token,
			ready_until: legacyDeadline,
		});
	});

	it.each(['disabled', 'changed', 'unhealthy', 'expired'] as const)(
		'retires a legacy member when its pool or sandbox is %s',
		async (reason) => {
			const w = setup();
			await w.service.sweep();
			const original = (await w.members())[0];
			await w.service.store.updateMember(original, 'ready', (member) => {
				member.ready_until = member.created_at + 30 * 60_000;
			});
			if (reason === 'unhealthy') {
				vi.spyOn(w.live.get(original.sandbox_id)!, 'exec').mockRejectedValue(
					new Error('unhealthy'),
				);
			}
			w.advance(reason === 'expired' ? 6 * 60 * 60_000 : 30 * 60_000);
			const config =
				reason === 'disabled'
					? { enabled: false }
					: reason === 'changed'
						? { profiles: [{ key: 'new-image', image: 'new-image', resources: {} }] }
						: {};
			await w.replica(config).sweep();
			expect(w.destroyed).toEqual([original.sandbox_id]);
			expect(await w.service.store.getMember(original.sandbox_id)).toBeUndefined();
		},
	);

	it.each([undefined, 8 * 60 * 60_000])(
		'keeps a healthy sandbox claimable after several idle hours with provider lifetime %s',
		async (providerLifetimeMs) => {
			const w = setup({ providerLifetimeMs, minimumRemainingMs: (4 * 60 + 12) * 60_000 });
			await w.service.sweep();
			const original = (await w.members())[0];
			for (let interval = 0; interval < 6; interval++) {
				w.advance(30 * 60_000);
				await w.service.sweep();
			}
			expect(w.created).toEqual([original.sandbox_id]);
			expect(w.destroyed).toEqual([]);
			expect((await w.members())[0]).toMatchObject({
				sandbox_id: original.sandbox_id,
				ready_until: original.ready_until,
				checked_at: w.now(),
			});
			expect((await claimWarm(w.service, w.request()))?.member.sandbox_id).toBe(
				original.sandbox_id,
			);
		},
	);

	it.each([
		{ providerLifetimeMs: undefined, minimumRemainingMs: 60_000, age: 6 * 60 * 60_000 },
		{ providerLifetimeMs: 90_000, minimumRemainingMs: 60_000, age: 30_000 },
		{
			providerLifetimeMs: 8 * 60 * 60_000,
			minimumRemainingMs: (4 * 60 + 12) * 60_000,
			age: (3 * 60 + 48) * 60_000,
		},
	])(
		'rotates before idle/provider lifetime expires: %j',
		async ({ providerLifetimeMs, minimumRemainingMs, age }) => {
			const w = setup({ providerLifetimeMs, minimumRemainingMs });
			await w.service.sweep();
			const original = w.created[0];
			w.advance(age - 1);
			await w.service.sweep();
			expect(w.created).toEqual([original]);
			expect(w.destroyed).toEqual([]);
			w.advance(1);
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
			await w.service.sweep();
			expect(w.destroyed).toContain(original);
			expect(w.created).toHaveLength(2);
		},
	);

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
		const claim = (await claimWarm(w.service, request))!;
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
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
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
		const claim = (await claimWarm(w.service, { ...w.request(), profile: 'large' }))!;
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
		expect(await claimWarm(w.service, w.request())).toBeUndefined();
		expect(await claimWarm(w.replica(), w.request())).toBeUndefined();
		expect((await w.members())[0].state).toBe('claimed');
		w.advance(60_000);
		await w.replica({ enabled: false }).sweep();
		expect(w.destroyed).toEqual([id]);
		expect(await w.members()).toEqual([]);
	});

	it.each([
		{ reconnectMs: 1_500, commandMs: 1_000 },
		{ reconnectMs: 4_999, commandMs: 1_999 },
	])(
		'allows a $reconnectMs ms reconnect followed by a $commandMs ms command',
		async ({ reconnectMs, commandMs }) => {
			vi.useFakeTimers();
			try {
				const w = setup();
				await w.service.sweep();
				const sandbox = w.live.values().next().value!;
				sandbox.ready = vi.fn(
					() => new Promise<void>((resolve) => setTimeout(resolve, reconnectMs)),
				);
				const exec = vi
					.spyOn(sandbox, 'exec')
					.mockImplementation(
						() =>
							new Promise((resolve) =>
								setTimeout(() => resolve(execResult(true, '', '')), commandMs),
							),
					);
				const claim = claimWarm(w.service, w.request());
				await vi.advanceTimersByTimeAsync(reconnectMs - 1);
				expect(exec).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(commandMs + 1);
				expect((await claim)?.sandbox).toBe(sandbox);
				expect(exec).toHaveBeenCalledWith('true', { timeout: 2_000 });
				expect(w.destroyed).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it('also separates reconnect and command budgets for maintenance health checks', async () => {
		vi.useFakeTimers();
		try {
			const w = setup();
			await w.service.sweep();
			const sandbox = w.live.values().next().value!;
			sandbox.ready = () => new Promise<void>((resolve) => setTimeout(resolve, 1_500));
			vi.spyOn(sandbox, 'exec').mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve(execResult(true, '', '')), 1_000)),
			);
			w.advance(30_001);
			const sweep = w.service.sweep();
			await vi.advanceTimersByTimeAsync(2_500);
			await sweep;
			expect(w.destroyed).toEqual([]);
			expect((await w.members())[0]).toMatchObject({ state: 'ready', checked_at: w.now() });
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(['resolve', 'reject'] as const)(
		'does not probe a reconnect that settles with %s after timeout',
		async (settlement) => {
			vi.useFakeTimers();
			try {
				const w = setup();
				await w.service.sweep();
				const sandbox = w.live.values().next().value!;
				let ready!: () => void;
				sandbox.ready = () =>
					new Promise((resolve, reject) => {
						ready = () =>
							settlement === 'resolve' ? resolve() : reject(new Error('late reconnect failure'));
					});
				const exec = vi.spyOn(sandbox, 'exec');
				const log = vi.spyOn(console, 'error').mockImplementation(() => {});
				const claim = claimWarm(w.service, w.request());
				await vi.advanceTimersByTimeAsync(4_999);
				expect((await w.members())[0].state).toBe('claimed');
				expect(log).not.toHaveBeenCalled();
				w.advance(5_000);
				await vi.advanceTimersByTimeAsync(1);
				expect(await claim).toBeUndefined();
				expect((await w.members())[0].state).toBe('retiring');
				expect(await claimWarm(w.replica(), w.request())).toBeUndefined();
				const failure = log.mock.calls
					.map(([line]) => JSON.parse(line))
					.find(
						(event) =>
							typeof event === 'object' &&
							event !== null &&
							'event' in event &&
							event.event === 'warm_pool_claim_failed',
					);
				expect(failure).toMatchObject({
					sandbox_id: (await w.members())[0].sandbox_id,
					elapsed_ms: 5_000,
					error: { name: 'WarmPoolReadinessError', reason: 'reconnect_timeout' },
				});
				ready();
				await vi.advanceTimersByTimeAsync(0);
				expect(exec).not.toHaveBeenCalled();
				expect((await w.members())[0].state).toBe('retiring');
				await w.replica({ enabled: false }).sweep();
				expect(w.live.size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it.each([
		{ deadline: 'provider lifetime', providerLifetimeMs: 90_000, elapsed: 30_000 },
		{ deadline: 'claim lease', providerLifetimeMs: undefined, elapsed: 60_000 },
	])(
		'rejects a claim when its $deadline expires during reconnect',
		async ({ providerLifetimeMs, elapsed }) => {
			const w = setup({ providerLifetimeMs });
			await w.service.sweep();
			const sandbox = w.live.values().next().value!;
			sandbox.ready = async () => w.advance(elapsed);
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
			expect((await w.members())[0].state).toBe('retiring');
			expect(await claimWarm(w.replica(), w.request())).toBeUndefined();
			await w.replica({ enabled: false }).sweep();
			expect(w.live.size).toBe(0);
		},
	);

	it.each(['reconnect_failed', 'reconnect_timeout'] as const)(
		'replaces an idle member after a maintenance %s',
		async (reason) => {
			vi.useFakeTimers();
			try {
				const w = setup();
				await w.service.sweep();
				const id = w.created[0];
				const sandbox = w.live.get(id)!;
				sandbox.ready =
					reason === 'reconnect_failed'
						? async () => {
								throw new Error('private provider error');
							}
						: () => new Promise(() => {});
				const exec = vi.spyOn(sandbox, 'exec');
				const log = vi.spyOn(console, 'error').mockImplementation(() => {});
				w.advance(30_001);
				const sweep = w.service.sweep();
				await vi.advanceTimersByTimeAsync(5_000);
				await sweep;
				expect(exec).not.toHaveBeenCalled();
				expect(w.destroyed).toEqual([id]);
				expect(w.created).toHaveLength(2);
				expect(await w.members()).toEqual([
					expect.objectContaining({ sandbox_id: w.created[1], state: 'ready' }),
				]);
				expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
					event: 'warm_pool_health_failed',
					sandbox_id: id,
					readiness_reason: reason,
					error:
						reason === 'reconnect_timeout'
							? { name: 'WarmPoolReadinessError', reason }
							: { name: 'Error' },
				});
				expect(log.mock.calls.flat().join('')).not.toContain('private provider error');
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it('preserves a concurrent claim when a maintenance reconnect times out', async () => {
		vi.useFakeTimers();
		try {
			const w = setup();
			await w.service.sweep();
			const sandbox = w.live.values().next().value!;
			sandbox.ready = vi
				.fn<NonNullable<SandboxInstance['ready']>>()
				.mockImplementationOnce(() => new Promise(() => {}))
				.mockResolvedValue(undefined);
			w.advance(30_001);
			const sweep = w.service.sweep();
			await vi.advanceTimersByTimeAsync(0);
			expect(sandbox.ready).toHaveBeenCalledTimes(1);
			const claim = (await claimWarm(w.replica(), w.request()))!;
			await vi.advanceTimersByTimeAsync(5_000);
			await sweep;
			expect(w.destroyed).not.toContain(claim.member.sandbox_id);
			expect(await w.service.store.getMember(claim.member.sandbox_id)).toMatchObject({
				state: 'claimed',
				token: claim.member.token,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('lets initial creation exceed the reconnect deadline', async () => {
		vi.useFakeTimers();
		try {
			const w = setup({ creationTimeoutMs: 10_000 });
			const create = w.compute.create.bind(w.compute);
			vi.spyOn(w.compute, 'create').mockImplementation((...args) => {
				const sandbox = create(...args);
				return {
					...sandbox,
					ready: async () => {
						await new Promise((resolve) => setTimeout(resolve, 6_000));
						await sandbox.ready!();
					},
				};
			});
			const sweep = w.service.sweep();
			await vi.advanceTimersByTimeAsync(5_000);
			expect((await w.members())[0].state).toBe('creating');
			await vi.advanceTimersByTimeAsync(1_000);
			await sweep;
			expect((await w.members())[0].state).toBe('ready');
			expect(w.destroyed).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(['reconnect_failed', 'command_transport_failed', 'command_failed'] as const)(
		'logs a safe reason for %s without provider output',
		async (reason) => {
			const w = setup();
			await w.service.sweep();
			const sandbox = w.live.values().next().value!;
			const secret = 'provider-error-with-private-credentials';
			const providerError = Object.assign(new Error(secret, { cause: new Error(secret) }), {
				request: { token: secret },
				response: { body: secret },
			});
			if (reason === 'reconnect_failed') {
				sandbox.ready = async () => {
					throw providerError;
				};
			} else if (reason === 'command_transport_failed') {
				vi.spyOn(sandbox, 'exec').mockRejectedValue(providerError);
			} else {
				vi.spyOn(sandbox, 'exec').mockResolvedValue(execResult(false, secret, secret));
			}
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
			expect((await w.members())[0].state).toBe('retiring');
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
				event: 'warm_pool_claim_failed',
				readiness_reason: reason,
				error:
					reason === 'command_failed'
						? { name: 'WarmPoolReadinessError', reason }
						: { name: 'Error' },
			});
			expect(log.mock.calls.flat().join('')).not.toContain(secret);
		},
	);

	it.each(['reconnect', 'command'] as const)(
		'retains safe provider diagnostics for a %s failure',
		async (phase) => {
			const w = setup();
			await w.service.sweep();
			const sandbox = w.live.values().next().value!;
			const secret = 'private-provider-token';
			const cause = Object.assign(new Error(secret), {
				code: 'UNAVAILABLE',
				status: 503,
				request: { token: secret },
			});
			if (phase === 'reconnect')
				sandbox.ready = async () => {
					throw cause;
				};
			else vi.spyOn(sandbox, 'exec').mockRejectedValue(cause);
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			expect(await claimWarm(w.service, w.request())).toBeUndefined();
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
				readiness_reason: phase === 'reconnect' ? 'reconnect_failed' : 'command_transport_failed',
				error: { name: 'Error', code: 'UNAVAILABLE', status: 503 },
			});
			expect(log.mock.calls.flat().join('')).not.toContain(secret);
		},
	);

	it.each(['resolve', 'reject'] as const)(
		'keeps a claim retired when its command settles with %s after timeout',
		async (settlement) => {
			vi.useFakeTimers();
			try {
				const w = setup();
				await w.service.sweep();
				let finish!: () => void;
				vi.spyOn(w.live.values().next().value!, 'exec').mockImplementation(
					() =>
						new Promise((resolve, reject) => {
							finish = () =>
								settlement === 'resolve'
									? resolve(execResult(true, '', ''))
									: reject(new Error('late command failure'));
						}),
				);
				const log = vi.spyOn(console, 'error').mockImplementation(() => {});
				const claim = claimWarm(w.service, w.request());
				await vi.advanceTimersByTimeAsync(2_000);
				expect(await claim).toBeUndefined();
				expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
					event: 'warm_pool_claim_failed',
					error: { name: 'WarmPoolReadinessError', reason: 'command_timeout' },
				});
				expect((await w.members())[0].state).toBe('retiring');
				expect(await claimWarm(w.replica(), w.request())).toBeUndefined();
				finish();
				await vi.advanceTimersByTimeAsync(0);
				expect((await w.members())[0].state).toBe('retiring');
				await w.replica({ enabled: false }).sweep();
				expect(w.live.size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it('still requires a successful command when the adapter has no ready hook', async () => {
		const w = setup();
		await w.service.sweep();
		const sandbox = w.live.values().next().value!;
		delete sandbox.ready;
		const exec = vi.spyOn(sandbox, 'exec').mockResolvedValue(execResult(false, '', 'unhealthy'));
		expect(await claimWarm(w.service, w.request())).toBeUndefined();
		expect(exec).toHaveBeenCalledWith('true', { timeout: 2_000 });
		expect((await w.members())[0].state).toBe('retiring');
	});

	it('rejects a booted sandbox whose command probe fails', async () => {
		const w = setup();
		const create = w.compute.create.bind(w.compute);
		const reference = vi.fn(() => 'unproven-reference');
		vi.spyOn(w.compute, 'create').mockImplementation((id, options) => ({
			...create(id, options),
			get reconnectReference() {
				return reference();
			},
			exec: async () => execResult(false, '', 'bootstrap failed'),
		}));
		await w.service.sweep();
		expect(reference).not.toHaveBeenCalled();
		expect(w.created).toHaveLength(1);
		expect(w.destroyed).toEqual(w.created);
		expect(await w.members()).toEqual([]);
		expect(await claimWarm(w.service, w.request())).toBeUndefined();
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

	it.each(['stopping', 'terminated', 'failed', 'replaced', 'deleted'])(
		'rejects handoff when the session is %s during the warm probe',
		async (change) => {
			const w = setup();
			await w.service.sweep();
			const request = w.request();
			const claim = (await w.service.reserve(request))!;
			const session = await w.sessions.createSession({
				...request.destination,
				user_id: ACTOR,
				sandbox_id: claim.member.sandbox_id,
			});
			let finishProbe!: () => void;
			const probeGate = new Promise<void>((resolve) => {
				finishProbe = resolve;
			});
			const exec = vi.spyOn(claim.sandbox, 'exec').mockImplementationOnce(async () => {
				await probeGate;
				return execResult(true, '', '');
			});
			const probe = w.service.probe(claim);
			await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
			switch (change) {
				case 'stopping':
					await w.sessions.beginTerminating(session.project_id, session.session_id);
					break;
				case 'terminated':
					await w.sessions.terminate(session.project_id, session.session_id);
					break;
				case 'failed':
					await w.sessions.markFailed(session.project_id, session.session_id);
					break;
				case 'replaced':
					await w.sessions.replaceStartingSandbox(
						session.project_id,
						session.session_id,
						claim.member.sandbox_id,
						createSandboxId(),
					);
					break;
				case 'deleted':
					await w.bucket.delete(paths.session(session.project_id, session.session_id));
					break;
			}
			finishProbe();
			await probe;
			expect(session).toMatchObject({ status: 'starting', sandbox_id: claim.member.sandbox_id });
			await expect(w.service.handoff(claim)).rejects.toThrow(
				change === 'deleted' ? 'not found' : 'no longer starting',
			);
			expect((await w.members())[0]).toMatchObject({ state: 'claimed', assigned: false });
		},
	);

	it('leaves the warm claim unassigned when the session read fails', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await claimWarm(w.service, w.request()))!;
		vi.spyOn(w.sessions, 'getSession').mockRejectedValue(new Error('storage unavailable'));
		await expect(w.service.handoff(claim)).rejects.toThrow('storage unavailable');
		expect((await w.members())[0]).toMatchObject({ state: 'claimed', assigned: false });
	});

	it.each(['wrong sandbox', 'failed session', 'stale token', 'expired claim', 'expired lifetime'])(
		'fences handoff with %s',
		async (reason) => {
			const w = setup({ providerLifetimeMs: reason === 'expired lifetime' ? 90_000 : undefined });
			await w.service.sweep();
			const request = w.request();
			const claim = (await claimWarm(w.service, request))!;
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
		const claim = (await claimWarm(w.service, w.request()))!;
		await w.service.abandon({ ...claim, member: { ...claim.member, token: 'stale' } });
		expect(w.destroyed).toEqual([]);
		expect((await w.members())[0]).toMatchObject({ state: 'claimed', token: claim.member.token });
	});

	it('retries cleanup when provider deletion succeeded but its bucket update failed', async () => {
		const w = setup();
		await w.service.sweep();
		const claim = (await claimWarm(w.service, w.request()))!;
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

it.each([false, true])(
	'preinstalls the bridge before publishing a warm member (mapped=%s)',
	async (mapped) => {
		const w = setup();
		const created = w.compute.create.bind(w.compute);
		const states: string[] = [];
		const writes = vi.fn(async (_files: Parameters<SandboxInstance['writeFiles']>[0]) => {
			states.push((await w.members())[0].state);
		});
		const exec = vi.fn(async (command: string) => {
			if (command.includes('--install-only')) states.push((await w.members())[0].state);
			return execResult(true, '', '');
		});
		w.compute.create = (id, options) => ({
			...created(id, options),
			writeFiles: writes,
			exec,
			...(mapped ? { resolveProcessPath: (path: string) => `/mapped${path}` } : {}),
		});
		const service = new WarmPoolService(
			w.service.store,
			w.compute,
			w.sessions,
			w.config,
			undefined,
			undefined,
			undefined,
			{ launcher: 'bridge.py', files: [{ name: 'bridge.py', content: 'launcher' }] },
		);
		await service.sweep();
		expect(writes).toHaveBeenCalledOnce();
		const member = (await w.members())[0];
		const path = `/tmp/marimohub-bridge/${member.sandbox_id}/bridge.py`;
		expect(writes).toHaveBeenCalledWith([{ path, content: 'launcher' }]);
		expect(exec).toHaveBeenCalledWith(`python '${mapped ? '/mapped' : ''}${path}' --install-only`, {
			timeout: 10_000,
			maxOutputBytes: 4096,
		});
		expect(states).toEqual(['creating', 'creating']);
		expect(member.state).toBe('ready');
	},
);

it.each(['write', 'throw', 'exit'] as const)(
	'reports a bridge preinstall %s failure without discarding the warm member',
	async (failure) => {
		const w = setup();
		const create = w.compute.create.bind(w.compute);
		w.compute.create = (id, options) => ({
			...create(id, options),
			async writeFiles() {
				if (failure === 'write') throw new Error('private-write-detail');
			},
			async exec(command) {
				if (command.includes('--install-only')) {
					if (failure === 'throw') throw new Error('private-exec-detail');
					return execResult(false, 'private-output', 'private-error');
				}
				return execResult(true, '', '');
			},
		});
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const service = new WarmPoolService(
			w.service.store,
			w.compute,
			w.sessions,
			w.config,
			metrics,
			w.now,
			undefined,
			{ launcher: 'bridge.py', files: [{ name: 'bridge.py', content: 'launcher' }] },
		);
		await service.sweep();
		const member = (await w.members())[0];
		expect(member.state).toBe('ready');
		expect(metrics.increment).toHaveBeenCalledWith('warm_pool.bridge_install_failed');
		expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toContainEqual(
			expect.objectContaining({
				event: 'warm_pool_bridge_install_failed',
				sandbox_id: member.sandbox_id,
			}),
		);
		expect(log.mock.calls.flat().join(' ')).not.toContain('private-');
		expect(w.destroyed).toEqual([]);
	},
);

it.each(['resolve', 'reject'] as const)(
	'keeps a warm member after a timed-out bridge write and late %s',
	async (settlement) => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<void>();
		try {
			const w = setup();
			const create = w.compute.create.bind(w.compute);
			const writes = vi.fn(() => pending.promise);
			const exec = vi.fn(async () => execResult(true, '', ''));
			w.compute.create = (id, options) => ({ ...create(id, options), writeFiles: writes, exec });
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const service = new WarmPoolService(
				w.service.store,
				w.compute,
				w.sessions,
				w.config,
				metrics,
				w.now,
				undefined,
				{ launcher: 'bridge.py', files: [{ name: 'bridge.py', content: 'launcher' }] },
			);
			const sweep = service.sweep();
			await vi.advanceTimersByTimeAsync(9_999);
			expect(writes).toHaveBeenCalledOnce();
			expect((await w.members())[0].state).toBe('creating');
			await vi.advanceTimersByTimeAsync(1);
			await sweep;
			expect((await w.members())[0].state).toBe('ready');
			expect(metrics.increment).toHaveBeenCalledWith('warm_pool.bridge_install_failed');
			expect(w.destroyed).toEqual([]);
			if (settlement === 'resolve') pending.resolve();
			else pending.reject(new Error('late write failure'));
			await vi.advanceTimersByTimeAsync(0);
			expect(exec).toHaveBeenCalledOnce();
			expect((await w.members())[0].state).toBe('ready');
		} finally {
			pending.resolve();
			vi.useRealTimers();
		}
	},
);
