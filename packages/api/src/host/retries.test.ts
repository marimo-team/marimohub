import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostRetries } from './retries';
import type { HostMutationReply, HostRetryAttempt } from './retries';

afterEach(() => vi.useRealTimers());

describe('host retry bindings', () => {
	it('retains a run binding across repeated failures and rejects changed requests', async () => {
		const retries = new HostRetries();
		const attempts: (string | undefined)[] = [];
		const run = async (attempt: HostRetryAttempt) => {
			attempts.push(attempt.sessionId);
			attempt.bindSession('original');
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
					attempt.bindSession('replacement');
					return { status: 202, body: {} };
				},
				true,
			),
		).rejects.toThrow('The request is bound to another runtime');
	});

	it('shares concurrent attempts, including after an ambiguous failure', async () => {
		const retries = new HostRetries();
		const failure = new Error('Reply lost');
		await expect(
			retries.execute(
				'user',
				'key',
				'run',
				async (attempt) => {
					attempt.bindSession('original');
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
		const retries = new HostRetries();
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
				attempt.bindSession('first-user');
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
				attempt.bindSession('second-user');
				return { status: 202, body: {} };
			},
			true,
		);
	});

	it('retains bound error responses only for the documented retry window', async () => {
		vi.useFakeTimers();
		const retries = new HostRetries();
		const work = vi.fn(async (attempt: HostRetryAttempt) => {
			const prior = attempt.sessionId;
			attempt.bindSession('original');
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
});
