import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_CLAIM_LEASE_MS, MemoryHostRetryStore } from './memoryRetryStore';
import { HostProblemError } from './protocol';
import { HostRetries } from './retries';
import type { HostMutationReply, HostRetryAttempt } from './retries';

afterEach(() => vi.useRealTimers());

describe('host retry bindings', () => {
	it('retains a run binding across repeated failures and rejects changed requests', async () => {
		const retries = new HostRetries(new MemoryHostRetryStore());
		const attempts: (string | undefined)[] = [];
		const run = async (attempt: HostRetryAttempt) => {
			attempts.push(attempt.sessionId);
			await attempt.bindSession('original');
			throw new Error('Reply lost');
		};
		for (let index = 0; index < 2; index++) {
			await expect(retries.execute('user', 'key', 'run', run, true)).rejects.toThrow('Reply lost');
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
		const store = new MemoryHostRetryStore();
		const retries = new HostRetries(store);
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
		const retries = new HostRetries(new MemoryHostRetryStore());
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
		const retries = new HostRetries(new MemoryHostRetryStore());
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
		const retries = new HostRetries(new MemoryHostRetryStore());
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
		const store = new MemoryHostRetryStore();
		const first = new HostRetries(store);
		await expect(
			first.execute('user', 'save', 'fingerprint', async (attempt) => {
				await attempt.bindSession('original');
				throw new Error('Lost runtime reply');
			}),
		).rejects.toThrow('Lost runtime reply');
		const restarted = new HostRetries(store);
		const result = await restarted.execute('user', 'save', 'fingerprint', async (attempt) => {
			expect(attempt.sessionId).toBe('original');
			return { status: 200, body: {} };
		});
		expect(result.status).toBe(200);
	});

	it('returns 503 without invoking work when retry storage is unavailable', async () => {
		const store = new MemoryHostRetryStore();
		vi.spyOn(store, 'acquire').mockRejectedValue(new Error('private storage details'));
		const work = vi.fn(async () => ({ status: 201, body: {} }));
		const retries = new HostRetries(store);
		await expect(retries.execute('user', 'key', 'create', work)).rejects.toMatchObject({
			status: 503,
		});
		expect(work).not.toHaveBeenCalled();
	});

	it('bounds waits for unresolved claims without duplicating work', async () => {
		vi.useFakeTimers();
		const store = new MemoryHostRetryStore();
		vi.spyOn(store, 'acquire').mockResolvedValue({ kind: 'pending' });
		const work = vi.fn(async () => ({ status: 201, body: {} }));
		const pending = new HostRetries(store).execute('user', 'key', 'create', work);
		const assertion = expect(pending).rejects.toMatchObject({ status: 503 });
		await vi.runAllTimersAsync();
		await assertion;
		expect(work).not.toHaveBeenCalled();
	});

	it('lets a duplicate caller disconnect without cancelling the shared attempt', async () => {
		const retries = new HostRetries(new MemoryHostRetryStore());
		let finish!: (reply: HostMutationReply) => void;
		const work = vi.fn(
			() =>
				new Promise<HostMutationReply>((resolve) => {
					finish = resolve;
				}),
		);
		const first = retries.execute('user', 'key', 'create', work);
		const duplicate = new AbortController();
		const second = retries.execute('user', 'key', 'create', work, false, duplicate.signal);
		duplicate.abort();
		await expect(second).rejects.toThrow();
		finish({ status: 201, body: {} });
		expect(await first).toMatchObject({ status: 201, replayed: false });
		expect(work).toHaveBeenCalledOnce();
	});

	it('reclaims an undispatched claim after its lease and fences the stale owner', async () => {
		vi.useFakeTimers();
		const store = new MemoryHostRetryStore();
		const retries = new HostRetries(store);
		let stale!: HostRetryAttempt;
		const stuck = retries.execute('user', 'key', 'create', async (attempt) => {
			stale = attempt;
			await new Promise(() => {});
			return { status: 201, body: {} };
		});
		await vi.advanceTimersByTimeAsync(0);
		expect((await store.acquire('user', 'key', 'create', false)).kind).toBe('pending');
		vi.advanceTimersByTime(HOST_CLAIM_LEASE_MS);
		const recovered = await new HostRetries(store).execute(
			'user',
			'key',
			'create',
			async (attempt) => {
				await attempt.dispatch();
				return { status: 201, body: { id: 'second' } };
			},
		);
		expect(recovered).toMatchObject({ status: 201, body: { id: 'second' } });
		await expect(stale.dispatch()).rejects.toMatchObject({ status: 503 });
		void stuck.catch(() => {});
	});

	it('releases an acquired claim without work when its caller has already disconnected', async () => {
		const store = new MemoryHostRetryStore();
		const work = vi.fn(async () => ({ status: 201, body: {} }));
		const retries = new HostRetries(store);
		await expect(
			retries.execute('user', 'key', 'create', work, false, AbortSignal.abort()),
		).rejects.toThrow();
		expect(work).not.toHaveBeenCalled();
		expect((await store.acquire('user', 'key', 'create', false)).kind).toBe('claimed');
	});
});
