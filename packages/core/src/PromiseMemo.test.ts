import { describe, expect, it, vi } from 'vitest';
import { PromiseMemo } from './async';

describe('PromiseMemo', () => {
	it('shares concurrent and sequential reads without a TTL, but never across scopes', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const memo = new PromiseMemo();
			const pending = Promise.withResolvers<number>();
			const load = vi.fn(() => pending.promise);
			const first = memo.read(['project', 'p'], load);
			expect(memo.read(['project', 'p'], load)).toBe(first);
			pending.resolve(42);
			await expect(first).resolves.toBe(42);
			vi.setSystemTime(Date.now() + 60_000);
			expect(memo.read(['project', 'p'], load)).toBe(first);
			expect(load).toHaveBeenCalledOnce();
			await new PromiseMemo().read(['project', 'p'], load);
			expect(load).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps namespaces, tuple boundaries, and object identities separate', async () => {
		const memo = new PromiseMemo();
		const keys = [['a', 'b:c'], ['a:b', 'c'], ['a'], ['a', undefined], [{}], [{}]];
		for (const [index, key] of keys.entries()) {
			await expect(memo.read(key, () => index)).resolves.toBe(index);
		}
		for (const [index, key] of keys.entries()) {
			await expect(memo.read(key, () => -1)).resolves.toBe(index);
		}
	});

	it('uses Map value equality for primitive key elements', async () => {
		const memo = new PromiseMemo();
		const load = vi.fn(() => 42);
		for (const [first, second] of [
			[Number.NaN, Number.NaN],
			[0, -0],
			['key', 'key'],
		]) {
			const initial = memo.read([first], load);
			expect(memo.read([second], load)).toBe(initial);
			await initial;
		}
		expect(load).toHaveBeenCalledTimes(3);
		await expect(memo.read(['0'], () => 99)).resolves.toBe(99);
	});

	it.each([undefined, null, false, 0, ''])('retains the fulfilled value %s', async (value) => {
		const memo = new PromiseMemo();
		const load = vi.fn(() => value);
		await expect(memo.read(['key'], load)).resolves.toBe(value);
		await expect(memo.read(['key'], load)).resolves.toBe(value);
		expect(load).toHaveBeenCalledOnce();
	});

	it.each(['sync', 'async'])('shares a %s failure and retries the next read', async (mode) => {
		const memo = new PromiseMemo();
		const failure = new Error('unavailable');
		const load = vi.fn(() => {
			if (mode === 'sync') throw failure;
			return Promise.reject(failure);
		});
		const first = memo.read(['key'], load);
		const second = memo.read(['key'], load);
		expect(second).toBe(first);
		expect(await Promise.allSettled([first, second])).toEqual([
			{ status: 'rejected', reason: failure },
			{ status: 'rejected', reason: failure },
		]);
		await expect(memo.read(['key'], () => 2)).resolves.toBe(2);
		expect(load).toHaveBeenCalledOnce();
	});

	it('rechecks validity before reusing a settled value', async () => {
		const memo = new PromiseMemo();
		let valid = true;
		const load = vi.fn(() => 1);
		const options = { isValid: () => valid };
		await memo.read(['key'], load, options);
		valid = false;
		await Promise.all([memo.read(['key'], load, options), memo.read(['key'], load, options)]);
		expect(load).toHaveBeenCalledTimes(2);
		valid = true;
		await memo.read(['key'], load, options);
		expect(load).toHaveBeenCalledTimes(3);
	});

	it.each(['initial', 'cached'])('evicts a rejected %s validity check', async (stage) => {
		const memo = new PromiseMemo();
		const isValid = vi.fn(() => true);
		const load = vi.fn(() => 1);
		if (stage === 'cached') await memo.read(['key'], load, { isValid });
		const failure = new Error('validity check failed');
		isValid.mockImplementationOnce(() => {
			throw failure;
		});
		await expect(memo.read(['key'], load, { isValid })).rejects.toBe(failure);
		await expect(memo.read(['key'], load, { isValid })).resolves.toBe(1);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it.each(['resolve', 'reject'] as const)(
		'an invalidated read cannot replace a newer entry when it later %ss',
		async (settlement) => {
			const memo = new PromiseMemo();
			const pending = Promise.withResolvers<number>();
			const first = memo.read(['key'], () => pending.promise);
			const outcome = Promise.allSettled([first]);
			memo.clear();
			const replacement = memo.read(['key'], () => 2);
			await replacement;
			if (settlement === 'resolve') pending.resolve(1);
			else pending.reject(new Error('old read failed'));
			await outcome;
			expect(memo.read(['key'], () => 3)).toBe(replacement);
		},
	);

	it.each([false, true])('invalidates before and after a mutation (failure: %s)', async (fails) => {
		const memo = new PromiseMemo();
		let stored = 1;
		const load = vi.fn(() => stored);
		await memo.read(['key'], load);
		const failure = new Error('write response lost');
		const mutation = memo.mutate(async () => {
			expect(await memo.read(['key'], load)).toBe(1);
			stored = 2;
			expect(await memo.read(['key'], load)).toBe(2);
			if (fails) throw failure;
		});
		if (fails) await expect(mutation).rejects.toBe(failure);
		else await mutation;
		await expect(memo.read(['key'], load)).resolves.toBe(2);
		await expect(memo.read(['key'], load)).resolves.toBe(2);
		expect(load).toHaveBeenCalledTimes(4);
	});

	it('bypasses caching until all overlapping mutations settle', async () => {
		const memo = new PromiseMemo();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const writes = [memo.mutate(() => first.promise), memo.mutate(() => second.promise)];
		first.resolve();
		await writes[0];
		const load = vi.fn(() => 1);
		await memo.read(['key'], load);
		await memo.read(['key'], load);
		expect(load).toHaveBeenCalledTimes(2);
		second.resolve();
		await writes[1];
		await memo.read(['key'], load);
		await memo.read(['key'], load);
		expect(load).toHaveBeenCalledTimes(3);
	});
});
