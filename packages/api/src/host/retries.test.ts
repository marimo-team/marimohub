import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostRetryStore } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { HostRetries } from './retries';
import type { HostMutationReply, HostRetryAttempt } from './retries';

afterEach(() => vi.useRealTimers());

describe('host retry bindings', () => {
	it('retains a run binding across repeated failures and rejects changed requests', async () => {
		const retries = new HostRetries(new HostRetryStore(new MemoryBucket()));
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
		).rejects.toThrow('The request is bound to another runtime');
	});

	it('shares concurrent attempts, including after an ambiguous failure', async () => {
		const retries = new HostRetries(new HostRetryStore(new MemoryBucket()));
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
			{ status: 202, body: { id: 'same-run' } },
			{ status: 202, body: { id: 'same-run' } },
		]);
		expect(work).toHaveBeenCalledOnce();
	});

	it('releases failures before dispatch and scopes bindings to the caller', async () => {
		const retries = new HostRetries(new HostRetryStore(new MemoryBucket()));
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
		const retries = new HostRetries(new HostRetryStore(new MemoryBucket()));
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

	it('retains the original runtime binding when a retry reaches another API process', async () => {
		const bucket = new MemoryBucket();
		const first = new HostRetries(new HostRetryStore(bucket));
		await expect(
			first.execute('user', 'save', 'fingerprint', async (attempt) => {
				await attempt.bindSession('original');
				throw new Error('Lost runtime reply');
			}),
		).rejects.toThrow('Lost runtime reply');
		const restarted = new HostRetries(new HostRetryStore(bucket));
		const result = await restarted.execute('user', 'save', 'fingerprint', async (attempt) => {
			expect(attempt.sessionId).toBe('original');
			return { status: 200, body: {} };
		});
		expect(result.status).toBe(200);
	});

	it('returns 503 without invoking work when retry storage is unavailable', async () => {
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'get').mockRejectedValue(new Error('private storage details'));
		const work = vi.fn(async () => ({ status: 201, body: {} }));
		const retries = new HostRetries(new HostRetryStore(bucket));
		await expect(retries.execute('user', 'key', 'create', work)).rejects.toMatchObject({
			status: 503,
		});
		expect(work).not.toHaveBeenCalled();
	});

	it('bounds waits for unresolved claims without duplicating work', async () => {
		vi.useFakeTimers();
		const store = new HostRetryStore(new MemoryBucket());
		vi.spyOn(store, 'acquire').mockResolvedValue({ kind: 'pending' });
		const work = vi.fn(async () => ({ status: 201, body: {} }));
		const pending = new HostRetries(store).execute('user', 'key', 'create', work);
		const assertion = expect(pending).rejects.toMatchObject({ status: 503 });
		await vi.runAllTimersAsync();
		await assertion;
		expect(work).not.toHaveBeenCalled();
	});

	it('releases an acquired claim without work when its caller has already disconnected', async () => {
		const store = new HostRetryStore(new MemoryBucket());
		const work = vi.fn(async () => ({ status: 201, body: {} }));
		const retries = new HostRetries(store);
		await expect(
			retries.execute('user', 'key', 'create', work, false, AbortSignal.abort()),
		).rejects.toThrow();
		expect(work).not.toHaveBeenCalled();
		expect((await store.acquire('user', 'key', 'create', false)).kind).toBe('claimed');
	});
});
