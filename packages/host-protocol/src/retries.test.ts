import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryHostRetryStore } from './memoryRetryStore';
import { HostRetries } from './retries';
import type { HostMutationReply } from './retries';
import { hostRetryStoreContract } from './testing';

afterEach(() => vi.useRealTimers());

hostRetryStoreContract('MemoryHostRetryStore', () => new MemoryHostRetryStore());

describe('host retry orchestration', () => {
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
});
