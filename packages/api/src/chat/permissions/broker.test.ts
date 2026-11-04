import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionBroker } from './broker';

describe('PermissionBroker', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('delivers a same-process decision at once', async () => {
		const broker = new PermissionBroker();
		const pending = broker.wait('k', { timeoutMs: 10_000 });
		expect(broker.decide('k', 'allow')).toBe(true);
		await expect(pending).resolves.toBe('allow');
		expect(broker.decide('k', 'deny')).toBe(false);
	});

	it('polls the durable record for decisions made elsewhere', async () => {
		const broker = new PermissionBroker();
		const saved = vi
			.fn<() => Promise<'allow' | undefined>>()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce('allow');
		const pending = broker.wait('k', { timeoutMs: 10_000, pollMs: 100, readDecision: saved });
		await vi.advanceTimersByTimeAsync(250);
		await expect(pending).resolves.toBe('allow');
		expect(saved).toHaveBeenCalledTimes(2);
	});

	it('expires, cancels on abort, and refuses a duplicate waiter', async () => {
		const broker = new PermissionBroker();
		const expired = broker.wait('a', { timeoutMs: 500 });
		expect(() => broker.wait('a', { timeoutMs: 500 })).toThrow(/already pending/);
		await vi.advanceTimersByTimeAsync(500);
		await expect(expired).resolves.toBe('expired');
		const controller = new AbortController();
		const cancelled = broker.wait('b', { timeoutMs: 10_000, signal: controller.signal });
		controller.abort();
		await expect(cancelled).resolves.toBe('cancelled');
		// A waiter that is gone no longer claims its key.
		expect(() => broker.wait('b', { timeoutMs: 10 })).not.toThrow();
	});

	it('reads the record one last time before giving up', async () => {
		const broker = new PermissionBroker();
		const saved = vi
			.fn<() => Promise<'deny' | undefined>>()
			.mockResolvedValue(undefined)
			.mockResolvedValueOnce(undefined);
		const pending = broker.wait('k', { timeoutMs: 1000, pollMs: 400, readDecision: saved });
		await vi.advanceTimersByTimeAsync(900);
		saved.mockResolvedValue('deny');
		await vi.advanceTimersByTimeAsync(100);
		await expect(pending).resolves.toBe('deny');
		const failing = broker.wait('f', {
			timeoutMs: 100,
			pollMs: 1000,
			readDecision: () => Promise.reject(new Error('down')),
		});
		await vi.advanceTimersByTimeAsync(100);
		await expect(failing).resolves.toBe('expired');
	});

	it('surfaces a read failure instead of waiting for the timeout', async () => {
		const broker = new PermissionBroker();
		const pending = broker.wait('k', {
			timeoutMs: 10_000,
			pollMs: 50,
			readDecision: () => Promise.reject(new Error('bucket down')),
		});
		const rejected = expect(pending).rejects.toThrow('bucket down');
		await vi.advanceTimersByTimeAsync(60);
		await rejected;
		expect(broker.decide('k', 'allow')).toBe(false);
	});
});
