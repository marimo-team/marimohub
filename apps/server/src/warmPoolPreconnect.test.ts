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
					member({ state: 'creating' }),
					member({ state: 'claimed' }),
					member({ state: 'retiring' }),
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

	it('shares the member budget across profiles without cycling prepared members', async () => {
		vi.useFakeTimers();
		const { deps, store, member } = await fixture();
		deps.warmPool!.config.profiles = [
			{ key: 'first', resources: {} },
			{ key: 'second', resources: {} },
		];
		const first = Array.from({ length: 8 }, () => member());
		const second = Array.from({ length: 8 }, () => member());
		await store.mutate((record) => {
			record.pools.push(
				{ key: 'first', failures: 0, retry_at: 0, members: first },
				{ key: 'second', failures: 0, retry_at: 0, members: second },
			);
		});
		const connect = vi.fn<Connect>(async () => true);
		deps.compute.preconnect = connect;
		const handle = startWarmPoolPreconnect(deps)!;
		await vi.advanceTimersByTimeAsync(0);
		expect(connect.mock.calls.map(([id]) => id)).toEqual(
			first.slice(0, 4).flatMap((item, i) => [item.sandbox_id, second[i].sandbox_id]),
		);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(connect).toHaveBeenCalledTimes(8);
		handle.stop();
		await handle.drain();
	});

	it('rotates excess profiles every refresh interval without bypassing failure backoff', async () => {
		vi.useFakeTimers();
		const { deps, store, member } = await fixture();
		const profiles = Array.from({ length: 10 }, (_, i) => ({ key: `profile-${i}`, resources: {} }));
		deps.warmPool!.config.profiles = profiles;
		const ready = profiles.map(() => member({ ready_until: Date.now() + 180_000 }));
		await store.mutate((record) => {
			record.pools.push(
				...profiles.map((profile, i) => ({
					key: profile.key,
					failures: 0,
					retry_at: 0,
					members: [ready[i]],
				})),
			);
		});
		const connect = vi.fn<Connect>(async () => false);
		deps.compute.preconnect = connect;
		const handle = startWarmPoolPreconnect(deps)!;
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(8);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(connect).toHaveBeenCalledTimes(8);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(connect).toHaveBeenCalledTimes(16);
		expect(new Set(connect.mock.calls.map(([id]) => id))).toEqual(
			new Set(ready.map((item) => item.sandbox_id)),
		);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(connect).toHaveBeenCalledTimes(16);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(connect).toHaveBeenCalledTimes(24);
		handle.stop();
		await handle.drain();
	});

	it.each(['reject', 'fallback'])(
		'backs off %s results, refreshes changed references and skips disabled/unsupported providers',
		async (failure) => {
			vi.useFakeTimers();
			const { deps, store, member } = await fixture();
			const ready = member();
			await store.mutate((record) =>
				record.pools.push({ key: 'configured', failures: 0, retry_at: 0, members: [ready] }),
			);
			expect(startWarmPoolPreconnect(deps)).toBeUndefined();
			const connect = vi.fn<Connect>(async () => {
				if (failure === 'fallback') return false;
				throw new Error('unreachable');
			});
			deps.compute.preconnect = connect;
			deps.warmPool!.config.enabled = false;
			expect(startWarmPoolPreconnect(deps)).toBeUndefined();
			deps.warmPool!.config.enabled = true;
			deps.warmPool!.config.preconnect = false;
			expect(startWarmPoolPreconnect(deps)).toBeUndefined();
			deps.warmPool!.config.preconnect = true;
			const loops = new BackgroundLoops();
			const handle = startWarmPoolPreconnect(deps, loops)!;
			await vi.advanceTimersByTimeAsync(20_000);
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
		},
	);

	it('awaits every in-flight cleanup and cancels queued work on shutdown', async () => {
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
		const cleanup = Promise.withResolvers<void>();
		const connect = vi.fn<Connect>(
			(_id, options) =>
				new Promise<boolean>((_resolve, reject) => {
					signals.push(options.signal);
					const delayCleanup = signals.length === 2;
					options.signal.addEventListener(
						'abort',
						() => {
							if (delayCleanup) void cleanup.promise.then(() => reject(new Error('aborted')));
							else reject(new Error('aborted'));
						},
						{
							once: true,
						},
					);
				}),
		);
		deps.compute.preconnect = connect;
		const loops = new BackgroundLoops();
		const handle = startWarmPoolPreconnect(deps, loops)!;
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(2);
		handle.stop();
		await handle.drain();
		const drained = vi.fn();
		const draining = loops.drain().then(drained);
		await vi.advanceTimersByTimeAsync(0);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(drained).not.toHaveBeenCalled();
		expect(connect).toHaveBeenCalledTimes(2);
		cleanup.resolve();
		await draining;
		expect(drained).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(connect).toHaveBeenCalledTimes(2);
		expect((await store.read()).pools[0].members.every((item) => item.state === 'ready')).toBe(
			true,
		);
	});
});
