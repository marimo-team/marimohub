/**
 * Shared behavioural contract for any `HostRetryStore`, run through `HostRetries` and directly.
 *
 * Imports `vitest`; only invoke it from a `*.test.ts`. Exposed at the
 * `@marimo-hub/host-protocol/testing` subpath so it never reaches runtime code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, HostProblemError } from './protocol';
import type { ErrorStatus } from './protocol';
import { HostRetries } from './retries';
import type { HostMutationReply, HostRetryAttempt } from './retries';
import {
	HOST_BOUND_CLAIM_LEASE_MS,
	HOST_CLAIM_LEASE_MS,
	HOST_RETRY_REFRESH_MS,
	HOST_RETRY_WINDOW_MS,
} from './retryStore';
import type { HostRetryClaim, HostRetryStore } from './retryStore';

/** The orchestrator `createHostApp` runs over a store, for tests that drive a store through it. */
export function hostRetriesFor(store: HostRetryStore, errorStatus?: ErrorStatus): HostRetries {
	return new HostRetries(store, (error) => errorResponse(error, errorStatus));
}

export function hostRetryStoreContract(
	name: string,
	makeStore: () => HostRetryStore,
	options: { errorStatus?: ErrorStatus } = {},
): void {
	const retriesFor = (store: HostRetryStore) => hostRetriesFor(store, options.errorStatus);
	const reply = { status: 201, body: { id: 'one-notebook' } };
	async function claim(store: HostRetryStore, fingerprint = 'create') {
		const result = await store.acquire('user', 'key', fingerprint, false);
		expect(result.kind).toBe('claimed');
		return (result as { kind: 'claimed'; claim: HostRetryClaim }).claim;
	}

	describe(`HostRetryStore contract: ${name}`, () => {
		afterEach(() => vi.useRealTimers());

		it('retains a run binding across repeated failures and rejects changed requests', async () => {
			const retries = retriesFor(makeStore());
			const attempts: (string | undefined)[] = [];
			const run = async (attempt: HostRetryAttempt) => {
				attempts.push(attempt.sessionId);
				await attempt.bindSession('original');
				throw new Error('Reply lost');
			};
			for (let index = 0; index < 2; index++) {
				await expect(retries.execute('user', 'key', 'run', run, true)).rejects.toThrow(
					'Reply lost',
				);
			}
			const work = vi.fn(async () => ({ status: 202, body: {} }));
			await expect(retries.execute('user', 'key', 'changed', work, true)).rejects.toThrow(
				'Idempotency-Key was used for a different request',
			);
			expect(work).not.toHaveBeenCalled();
			expect(attempts).toEqual([undefined, 'original']);
			await expect(
				retries.execute(
					'user',
					'key',
					'run',
					async (attempt) => {
						await attempt.bindSession('replacement');
						return { status: 202, body: {} };
					},
					true,
				),
			).resolves.toMatchObject({
				status: 409,
				body: { detail: 'The request is bound to another runtime' },
			});
		});

		it('answers definitive rejections and frees the key while unknown outcomes stay pending', async () => {
			const store = makeStore();
			const retries = retriesFor(store);
			const rejected = await retries.execute('user', 'key', 'create', async (attempt) => {
				await attempt.dispatch();
				throw HostProblemError.conflict('Name in use');
			});
			expect(rejected).toMatchObject({
				status: 409,
				replayed: false,
				body: { type: 'tag:marimo.io,2026:host/conflict', detail: 'Name in use' },
			});
			const work = vi.fn(async (attempt: HostRetryAttempt) => {
				await attempt.dispatch();
				return { status: 201, body: { id: 'created' } };
			});
			expect(await retries.execute('user', 'key', 'create', work)).toMatchObject({
				status: 201,
				replayed: false,
			});
			expect(await retries.execute('user', 'key', 'create', work)).toMatchObject({
				status: 201,
				replayed: true,
				body: { id: 'created' },
			});
			expect(work).toHaveBeenCalledOnce();
			await expect(
				retries.execute('user', 'unknown', 'create', async (attempt) => {
					await attempt.dispatch();
					throw new Error('Reply lost');
				}),
			).rejects.toThrow('Reply lost');
			expect((await store.acquire('user', 'unknown', 'create', false)).kind).toBe('pending');
		});

		it('shares concurrent attempts, including after an ambiguous failure', async () => {
			const retries = retriesFor(makeStore());
			const failure = new Error('Reply lost');
			await expect(
				retries.execute(
					'user',
					'key',
					'run',
					async (attempt) => {
						await attempt.bindSession('original');
						throw failure;
					},
					true,
				),
			).rejects.toBe(failure);

			let finish!: (reply: HostMutationReply) => void;
			const pending = new Promise<HostMutationReply>((resolve) => {
				finish = resolve;
			});
			const work = vi.fn(async (attempt: HostRetryAttempt) => {
				expect(attempt.sessionId).toBe('original');
				return pending;
			});
			const first = retries.execute('user', 'key', 'run', work, true);
			const second = retries.execute('user', 'key', 'run', work, true);
			finish({ status: 202, body: { id: 'same-run' } });
			expect(await Promise.all([first, second])).toEqual([
				{ status: 202, body: { id: 'same-run' }, replayed: false },
				{ status: 202, body: { id: 'same-run' }, replayed: false },
			]);
			expect(work).toHaveBeenCalledOnce();
		});

		it('releases failures before dispatch and scopes bindings to the caller', async () => {
			const retries = retriesFor(makeStore());
			await expect(
				retries.execute(
					'user',
					'key',
					'run',
					async () => {
						throw new Error('Admission failed');
					},
					true,
				),
			).rejects.toThrow('Admission failed');
			await retries.execute(
				'user',
				'key',
				'corrected',
				async (attempt) => {
					expect(attempt.sessionId).toBeUndefined();
					await attempt.bindSession('first-user');
					return { status: 202, body: {} };
				},
				true,
			);
			await retries.execute(
				'other',
				'key',
				'run',
				async (attempt) => {
					expect(attempt.sessionId).toBeUndefined();
					await attempt.bindSession('second-user');
					return { status: 202, body: {} };
				},
				true,
			);
		});

		it('retains bound error responses only for the documented retry window', async () => {
			vi.useFakeTimers();
			const retries = retriesFor(makeStore());
			const work = vi.fn(async (attempt: HostRetryAttempt) => {
				const prior = attempt.sessionId;
				await attempt.bindSession('original');
				return { status: 503, body: { prior } };
			});
			expect(await retries.execute('user', 'key', 'run', work, true)).toMatchObject({
				body: { prior: undefined },
			});
			vi.advanceTimersByTime(4 * 60_000);
			expect(await retries.execute('user', 'key', 'run', work, true)).toMatchObject({
				body: { prior: 'original' },
			});
			vi.advanceTimersByTime(60_001);
			expect(await retries.execute('user', 'key', 'run', work, true)).toMatchObject({
				body: { prior: undefined },
			});
		});

		it('retains the original runtime binding across host instances sharing a store', async () => {
			const store = makeStore();
			await expect(
				retriesFor(store).execute('user', 'save', 'fingerprint', async (attempt) => {
					await attempt.bindSession('original');
					throw new Error('Lost runtime reply');
				}),
			).rejects.toThrow('Lost runtime reply');
			const result = await retriesFor(store).execute(
				'user',
				'save',
				'fingerprint',
				async (attempt) => {
					expect(attempt.sessionId).toBe('original');
					return { status: 200, body: {} };
				},
			);
			expect(result.status).toBe(200);
		});

		it('releases an acquired claim without work when its caller has already disconnected', async () => {
			const store = makeStore();
			const disconnect = new AbortController();
			const acquire = store.acquire.bind(store);
			vi.spyOn(store, 'acquire').mockImplementationOnce(async (...args) => {
				const acquired = await acquire(...args);
				disconnect.abort();
				return acquired;
			});
			const work = vi.fn(async () => ({ status: 201, body: {} }));
			await expect(
				retriesFor(store).execute('user', 'key', 'create', work, false, disconnect.signal),
			).rejects.toThrow();
			expect(work).not.toHaveBeenCalled();
			expect((await store.acquire('user', 'key', 'create', false)).kind).toBe('claimed');
		});

		it('refreshes a stored reply only while the runtime still holds its receipt', async () => {
			vi.useFakeTimers();
			const store = makeStore();
			const run = { status: 202, body: { id: 'run' } };
			const acquired = await claim(store, 'run');
			await store.dispatch(acquired, 'session');
			await store.finish(acquired, run);
			vi.advanceTimersByTime(HOST_RETRY_REFRESH_MS - 1);
			const refreshed = await store.acquire('user', 'key', 'run', true);
			expect(refreshed.kind).toBe('claimed');
			await store.finish((refreshed as { kind: 'claimed'; claim: HostRetryClaim }).claim, run);
			vi.advanceTimersByTime(1);
			expect(await store.acquire('user', 'key', 'run', true)).toEqual({
				kind: 'reply',
				reply: run,
			});
		});

		it('measures a late reply from its claim, not from when it finished', async () => {
			vi.useFakeTimers();
			const store = makeStore();
			const run = { status: 202, body: { id: 'run' } };
			const acquired = await claim(store, 'run');
			await store.dispatch(acquired, 'session');
			vi.advanceTimersByTime(HOST_RETRY_REFRESH_MS - 1);
			await store.finish(acquired, run);
			vi.advanceTimersByTime(1);
			expect(await store.acquire('user', 'key', 'run', true)).toEqual({
				kind: 'reply',
				reply: run,
			});
		});

		it('reclaims an undispatched claim after its lease and fences the stale owner', async () => {
			vi.useFakeTimers();
			const store = makeStore();
			const stale = await claim(store);
			vi.advanceTimersByTime(HOST_CLAIM_LEASE_MS - 1);
			expect((await store.acquire('user', 'key', 'create', false)).kind).toBe('pending');
			vi.advanceTimersByTime(1);
			const recovered = await claim(store, 'other');
			expect(recovered.sessionId).toBeUndefined();
			await expect(store.dispatch(stale)).rejects.toThrow('no longer owned');
			await expect(store.finish(stale, reply)).rejects.toThrow('no longer owned');
		});

		it('reclaims a bound claim after its lease only while the runtime holds its receipt', async () => {
			vi.useFakeTimers();
			const store = makeStore();
			const stale = await claim(store, 'run');
			await store.dispatch(stale, 'session');
			vi.advanceTimersByTime(HOST_BOUND_CLAIM_LEASE_MS - 1);
			expect((await store.acquire('user', 'key', 'run', true)).kind).toBe('pending');
			vi.advanceTimersByTime(1);
			await expect(store.acquire('user', 'key', 'other', true)).rejects.toThrow(
				'different request',
			);
			const recovered = await claim(store, 'run');
			expect(recovered.sessionId).toBe('session');
			await expect(store.finish(stale, reply)).rejects.toThrow('no longer owned');
			await expect(store.dispatch(recovered, 'replacement')).rejects.toThrow('another runtime');
			await store.dispatch(recovered, 'session');
			// The recovered holder crashed too; by its lease the first dispatch's receipt may be gone.
			vi.advanceTimersByTime(HOST_BOUND_CLAIM_LEASE_MS);
			expect((await store.acquire('user', 'key', 'run', true)).kind).toBe('pending');
			vi.advanceTimersByTime(HOST_RETRY_WINDOW_MS * 10);
			expect((await store.acquire('user', 'key', 'run', true)).kind).toBe('pending');
		});

		it('never expires a claim dispatched without a runtime binding', async () => {
			vi.useFakeTimers();
			const store = makeStore();
			const stale = await claim(store);
			await store.dispatch(stale);
			vi.advanceTimersByTime(HOST_RETRY_WINDOW_MS * 10);
			await expect(store.acquire('user', 'key', 'other', false)).rejects.toThrow(
				'different request',
			);
			expect((await store.acquire('user', 'key', 'create', false)).kind).toBe('pending');
			await store.finish(stale, reply);
			expect(await store.acquire('user', 'key', 'create', false)).toEqual({ kind: 'reply', reply });
		});
	});
}
