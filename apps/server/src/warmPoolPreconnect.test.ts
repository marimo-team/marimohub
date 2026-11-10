import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiDeps } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { createSandboxId, WarmPoolService, WarmPoolStore } from '@marimo-hub/core';
type WarmPoolMember = Awaited<
	ReturnType<WarmPoolStore['read']>
>['pools'][number]['members'][number];
import { BackgroundLoops } from './backgroundLoops';
import { startWarmPoolPreconnect } from './warmPoolPreconnect';

async function fixture() {
	const deps = makeTestDeps(await createInitializedBucket());
	delete deps.compute.preconnect;
	const store = new WarmPoolStore(deps.bucket, 'coreweave');
	deps.warmPool = new WarmPoolService(store, deps.compute, deps.services.sessions, {
		enabled: true,
		size: 5,
		profiles: [{ key: 'configured', image: 'image', resources: {} }],
		creationTimeoutMs: 300_000,
		minimumRemainingMs: 0,
	});
	const member = (overrides: Partial<WarmPoolMember> = {}): WarmPoolMember => ({
		sandbox_id: createSandboxId(),
		state: 'ready',
		token: 'ownership-token',
		created_at: Date.now(),
		ready_until: Date.now() + 60_000,
		operation_until: 0,
		checked_at: Date.now(),
		assigned: false,
		reconnect_reference: 'saved-reference',
		...overrides,
	});
	return { deps, store, member };
}

afterEach(() => vi.useRealTimers());

type Connect = NonNullable<ApiDeps['compute']['preconnect']>;

describe('API warm pool preconnection', () => {
	it('prepares eligible references independently per replica without changing ownership', async () => {
		vi.useFakeTimers();
		const { deps, store, member } = await fixture();
		const ready = Array.from({ length: 9 }, () => member());
		await store.mutate((record) => {
			record.pools.push({
				key: 'configured',
				failures: 0,
				retry_at: 0,
				members: [
					member({ state: 'claimed' }),
					member({ ready_until: 0 }),
					member({ reconnect_reference: undefined }),
					...ready,
				],
			});
			record.pools.push({ key: 'other-image', failures: 0, retry_at: 0, members: [member()] });
		});
		const before = await store.read();
		const connect = vi.fn<Connect>(async () => true);
		deps.compute.preconnect = connect;
		const first = startWarmPoolPreconnect(deps)!;
		const second = startWarmPoolPreconnect(deps)!;
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(16);
		expect(new Set(connect.mock.calls.map((args) => args[0]))).toEqual(
			new Set(ready.slice(0, 8).map((item) => item.sandbox_id)),
		);
		expect(await store.read()).toEqual(before);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(connect).toHaveBeenCalledTimes(16);
		first.stop();
		second.stop();
		await Promise.all([first.drain(), second.drain()]);
	});

	it('shares eight slots across profiles and rotates when profiles exceed that budget', async () => {
		vi.useFakeTimers();
		const { deps, store, member } = await fixture();
		const first = Array.from({ length: 9 }, () => member());
		const last = member();
		deps.warmPool!.config.profiles = [
			...deps.warmPool!.config.profiles,
			{ key: 'second', image: 'other', resources: {} },
		];
		await store.mutate((record) => {
			record.pools.push({ key: 'configured', failures: 0, retry_at: 0, members: first });
			record.pools.push({ key: 'second', failures: 0, retry_at: 0, members: [last] });
		});
		const connect = vi.fn<Connect>(async () => true);
		deps.compute.preconnect = connect;
		const handle = startWarmPoolPreconnect(deps)!;
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(8);
		expect(connect.mock.calls.map(([id]) => id)).toContain(last.sandbox_id);
		handle.stop();
		await handle.drain();
		await store.mutate((record) => {
			record.pools = [];
			deps.warmPool!.config.profiles = [];
			for (let i = 0; i < 10; i++) {
				const key = `profile-${i}`;
				deps.warmPool!.config.profiles = [
					...deps.warmPool!.config.profiles,
					{ key, image: key, resources: {} },
				];
				record.pools.push({ key, failures: 0, retry_at: 0, members: [member()] });
			}
		});
		connect.mockClear();
		const rotating = startWarmPoolPreconnect(deps)!;
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(8);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(new Set(connect.mock.calls.map(([id]) => id)).size).toBe(10);
		rotating.stop();
		await rotating.drain();
	});

	it('retains in-flight work during shutdown until every admitted connection settles', async () => {
		vi.useFakeTimers();
		const { deps, store, member } = await fixture();
		await store.mutate((record) =>
			record.pools.push({
				key: 'configured',
				failures: 0,
				retry_at: 0,
				members: [member(), member(), member()],
			}),
		);
		let releaseSecond!: () => void;
		const connect = vi
			.fn<Connect>()
			.mockImplementationOnce(
				async (_id, options) =>
					new Promise<boolean>((_resolve, reject) => {
						options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
							once: true,
						});
					}),
			)
			.mockImplementationOnce(
				async () =>
					new Promise<boolean>((resolve) => {
						releaseSecond = () => resolve(true);
					}),
			);
		deps.compute.preconnect = connect;
		const loops = new BackgroundLoops();
		const handle = startWarmPoolPreconnect(deps, loops)!;
		await vi.advanceTimersByTimeAsync(0);
		handle.stop();
		let drained = false;
		const draining = loops.drain().then(() => {
			drained = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(drained).toBe(false);
		expect(connect).toHaveBeenCalledTimes(2);
		releaseSecond();
		await draining;
		expect(drained).toBe(true);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it('backs off failures, refreshes changed references and skips disabled/unsupported providers', async () => {
		vi.useFakeTimers();
		const { deps, store, member } = await fixture();
		const ready = member();
		await store.mutate((record) =>
			record.pools.push({ key: 'configured', failures: 0, retry_at: 0, members: [ready] }),
		);
		expect(startWarmPoolPreconnect(deps)).toBeUndefined();
		const connect = vi.fn<Connect>(async () => {
			throw new Error('unreachable');
		});
		deps.compute.preconnect = connect;
		deps.warmPool!.config.preconnect = false;
		expect(startWarmPoolPreconnect(deps)).toBeUndefined();
		deps.warmPool!.config.preconnect = true;
		const loops = new BackgroundLoops();
		const handle = startWarmPoolPreconnect(deps, loops)!;
		await vi.advanceTimersByTimeAsync(25_000);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(loops.health().loops.warm_pool_preconnect.status).toBe('ok');
		expect((await store.read()).pools[0].members[0].state).toBe('ready');
		await store.mutate((record) => {
			record.pools[0].members[0].reconnect_reference = 'replacement-reference';
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(connect.mock.calls[1][1].reconnectReference).toBe('replacement-reference');
		handle.stop();
		await handle.drain();
	});

	it('limits concurrent connections and cancels queued work on shutdown', async () => {
		vi.useFakeTimers();
		const { deps, store, member } = await fixture();
		await store.mutate((record) =>
			record.pools.push({
				key: 'configured',
				failures: 0,
				retry_at: 0,
				members: [member(), member(), member()],
			}),
		);
		const signals: AbortSignal[] = [];
		const connect = vi.fn(
			(_id, options) =>
				new Promise<boolean>((_resolve, reject) => {
					signals.push(options.signal);
					options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true,
					});
				}),
		);
		deps.compute.preconnect = connect;
		const handle = startWarmPoolPreconnect(deps)!;
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(2);
		handle.stop();
		await handle.drain();
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(connect).toHaveBeenCalledTimes(2);
		expect((await store.read()).pools[0].members.every((item) => item.state === 'ready')).toBe(
			true,
		);
	});
});
