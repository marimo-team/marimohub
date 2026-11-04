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

	it('keeps waiting through failed reads and still takes a local decision', async () => {
		const broker = new PermissionBroker();
		const saved = vi.fn(() => Promise.reject(new Error('bucket down')));
		const pending = broker.wait('k', { timeoutMs: 10_000, pollMs: 50, readDecision: saved });
		await vi.advanceTimersByTimeAsync(160);
		expect(saved.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(broker.decide('k', 'allow')).toBe(true);
		await expect(pending).resolves.toBe('allow');
		// With no decision anywhere, an unreadable record expires like a silent one.
		const silent = broker.wait('s', { timeoutMs: 100, pollMs: 1000, readDecision: saved });
		await vi.advanceTimersByTimeAsync(100);
		await expect(silent).resolves.toBe('expired');
	});

	it('bounds the final read at the deadline', async () => {
		const broker = new PermissionBroker();
		const hanging = broker.wait('h', {
			timeoutMs: 100,
			pollMs: 1000,
			readDecision: () => new Promise(() => {}),
		});
		await vi.advanceTimersByTimeAsync(100);
		let settled = false;
		void hanging.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(1999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(hanging).resolves.toBe('expired');
	});
});
