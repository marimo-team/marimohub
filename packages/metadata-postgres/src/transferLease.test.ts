import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { TransferLease } from './transferState';
import { withTransferLease } from './transferLease';

const identity = { namespace: 'test', id: 'transfer' };
const lease = { lease_id: 'lease', revision: '7' } as TransferLease;
afterEach(() => vi.useRealTimers());

describe('reference audit lease', () => {
	it('renews throughout an audit longer than one lease and stops after completion', async () => {
		vi.useFakeTimers();
		const query = vi.fn(async () => ({ rowCount: 1 }));
		const work = Promise.withResolvers<string>();
		const result = withTransferLease(
			{ query } as unknown as PoolClient,
			identity,
			lease,
			() => work.promise,
		);
		await vi.advanceTimersByTimeAsync(65000);
		expect(query).toHaveBeenCalledTimes(14);
		work.resolve('done');
		await expect(result).resolves.toBe('done');
		expect(query).toHaveBeenCalledTimes(15);
		await vi.advanceTimersByTimeAsync(65000);
		expect(query).toHaveBeenCalledTimes(15);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each(['lost lease', 'database error'])('fails closed on %s', async (failure) => {
		vi.useFakeTimers();
		const query = vi.fn(async () => ({ rowCount: 1 }));
		const work = Promise.withResolvers<void>();
		const result = withTransferLease(
			{ query } as unknown as PoolClient,
			identity,
			lease,
			() => work.promise,
		);
		await vi.advanceTimersByTimeAsync(0);
		if (failure === 'lost lease') query.mockResolvedValueOnce({ rowCount: 0 });
		else query.mockRejectedValueOnce(new Error('database error'));
		await vi.advanceTimersByTimeAsync(5000);
		const assertion = expect(result).rejects.toThrow();
		work.resolve();
		await assertion;
		expect(query).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('drains an in-flight renewal before propagating an audit failure', async () => {
		vi.useFakeTimers();
		const heartbeat = Promise.withResolvers<{ rowCount: number }>();
		const query = vi
			.fn(async () => ({ rowCount: 1 }))
			.mockImplementationOnce(async () => ({ rowCount: 1 }))
			.mockImplementationOnce(() => heartbeat.promise);
		const work = Promise.withResolvers<void>();
		const result = withTransferLease(
			{ query } as unknown as PoolClient,
			identity,
			lease,
			() => work.promise,
		);
		await vi.advanceTimersByTimeAsync(5000);
		const settled = vi.fn();
		const assertion = expect(result.finally(settled)).rejects.toThrow('audit failed');
		work.reject(new Error('audit failed'));
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();
		heartbeat.resolve({ rowCount: 1 });
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});
});
