import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { HostRetryStore, HOST_RETRY_WINDOW_MS } from './HostRetryStore';
import type { HostRetryClaim } from './HostRetryStore';
import { paths } from '../../paths';

const reply = { status: 201, body: { id: 'one-notebook' } };
async function claim(store: HostRetryStore, key = 'key', fingerprint = 'create') {
	const result = await store.acquire('user', key, fingerprint, false);
	expect(result.kind).toBe('claimed');
	return (result as { kind: 'claimed'; claim: HostRetryClaim }).claim;
}
afterEach(() => vi.useRealTimers());

describe('shared host retry receipts', () => {
	it('admits one of 32 concurrent independent instances and replays its receipt after restart', async () => {
		const bucket = new MemoryBucket();
		const read = bucket.get.bind(bucket);
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let readers = 0;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			const object = await read(key);
			if (readers < 32) {
				if (++readers === 32) release();
				await barrier;
			}
			return object;
		});
		const stores = Array.from({ length: 32 }, () => new HostRetryStore(bucket));
		const results = await Promise.all(
			stores.map((store) => store.acquire('user', 'key', 'create', false)),
		);
		expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
		expect(results.filter((result) => result.kind === 'pending')).toHaveLength(31);
		const winner = results.findIndex((result) => result.kind === 'claimed');
		const acquired = results[winner];
		if (acquired.kind !== 'claimed') throw new Error('Missing claim');
		await stores[winner].dispatch(acquired.claim);
		await stores[winner].finish(acquired.claim, reply);
		expect(await new HostRetryStore(bucket).acquire('user', 'key', 'create', false)).toEqual({
			kind: 'reply',
			reply,
		});
		await expect(stores[0].acquire('user', 'key', 'rename', false)).rejects.toThrow(
			'different request',
		);
		expect((await stores[0].acquire('other', 'key', 'create', false)).kind).toBe('claimed');
	});

	it('keeps an unresolved dispatched claim past the retry window', async () => {
		vi.useFakeTimers();
		const bucket = new MemoryBucket();
		const store = new HostRetryStore(bucket);
		const acquired = await claim(store);
		await store.dispatch(acquired);
		await store.finish(acquired);
		vi.advanceTimersByTime(HOST_RETRY_WINDOW_MS * 10);
		expect(await store.compactExpired()).toBe(0);
		expect(await new HostRetryStore(bucket).acquire('user', 'key', 'create', false)).toEqual({
			kind: 'pending',
		});
	});

	it('retains claims after a receipt write failure, even when the side effect succeeded', async () => {
		const bucket = new MemoryBucket();
		const store = new HostRetryStore(bucket);
		const acquired = await claim(store);
		await store.dispatch(acquired);
		const put = vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('Storage unavailable'));
		await expect(store.finish(acquired, reply)).rejects.toThrow('Storage unavailable');
		put.mockRestore();
		expect(await new HostRetryStore(bucket).acquire('user', 'key', 'create', false)).toEqual({
			kind: 'pending',
		});
		await store.finish(acquired, reply);
		expect(await store.acquire('user', 'key', 'create', false)).toEqual({ kind: 'reply', reply });
	});

	it('releases pre-dispatch failures and definitive rejected requests', async () => {
		const store = new HostRetryStore(new MemoryBucket());
		await store.finish(await claim(store));
		const corrected = await claim(store, 'key', 'corrected');
		await store.dispatch(corrected);
		await store.finish(corrected, { status: 412, body: {} });
		expect((await store.acquire('user', 'key', 'new-request', false)).kind).toBe('claimed');
	});

	it('persists runtime bindings across instances and expires them only after settlement', async () => {
		vi.useFakeTimers();
		const bucket = new MemoryBucket();
		const store = new HostRetryStore(bucket);
		const acquired = await claim(store);
		await store.dispatch(acquired, 'original-session');
		await store.finish(acquired);
		const recovered = await claim(new HostRetryStore(bucket));
		expect(recovered.sessionId).toBe('original-session');
		await expect(store.dispatch(recovered, 'replacement')).rejects.toThrow('another runtime');
		await store.finish(recovered, { status: 503, body: {} });
		vi.advanceTimersByTime(HOST_RETRY_WINDOW_MS + 1);
		const next = await claim(store, 'key', 'new-run');
		expect(next.sessionId).toBeUndefined();
		await expect(store.finish(recovered, reply)).rejects.toThrow('no longer owned');
		expect(await store.acquire('user', 'key', 'new-run', false)).toEqual({ kind: 'pending' });
	});

	it('fails closed on malformed stored receipts and hashes client-controlled keys', async () => {
		const bucket = new MemoryBucket();
		const store = new HostRetryStore(bucket);
		const acquired = await claim(store, '../unsafe/\n?token');
		expect(acquired.key).toMatch(/^_system\/host-retries\/[a-f0-9]{64}\.json$/);
		for (const record of [
			{ schema_version: 1 },
			{ schema_version: 1, fingerprint: 'create', dispatched: true },
			{ schema_version: 1, fingerprint: 'create', dispatched: true, owner: '' },
		]) {
			await bucket.put(acquired.key, JSON.stringify(record));
			await expect(store.acquire('user', '../unsafe/\n?token', 'create', false)).rejects.toThrow();
		}
	});

	it('compacts expired replies without deleting heads or accepting a stale writer', async () => {
		vi.useFakeTimers();
		const bucket = new MemoryBucket();
		const store = new HostRetryStore(bucket);
		const acquired = await claim(store);
		await store.finish(acquired, reply);
		vi.advanceTimersByTime(HOST_RETRY_WINDOW_MS + 1);
		expect(await store.compactExpired()).toBe(1);
		const compacted = await (await bucket.get(acquired.key))!.json();
		expect(compacted).not.toHaveProperty('reply');
		expect(compacted).toMatchObject({ expires: 0 });
		await expect(store.finish(acquired, reply)).rejects.toThrow('no longer owned');
		const next = await claim(store, 'key', 'another-create');
		await store.dispatch(next);
		expect(await store.compactExpired()).toBe(0);
		expect((await bucket.list({ prefix: paths.hostRetriesPrefix })).objects).toHaveLength(1);
	});

	it('does not let expiry cleanup overwrite a concurrently renewed claim', async () => {
		vi.useFakeTimers();
		const bucket = new MemoryBucket();
		const store = new HostRetryStore(bucket);
		const acquired = await claim(store);
		await store.finish(acquired, reply);
		vi.advanceTimersByTime(HOST_RETRY_WINDOW_MS + 1);
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementationOnce(async (key, value, options) => {
			await claim(new HostRetryStore(bucket), 'key', 'renewed');
			return put(key, value, options);
		});
		expect(await store.compactExpired()).toBe(0);
		expect(await store.acquire('user', 'key', 'renewed', false)).toEqual({ kind: 'pending' });
	});

	it('continues bounded cleanup across service restarts and preserves corrupt records', async () => {
		vi.useFakeTimers();
		const bucket = new MemoryBucket();
		const store = new HostRetryStore(bucket);
		await Promise.all(
			Array.from({ length: 101 }, async (_, index) => {
				await store.finish(await claim(store, String(index)), reply);
			}),
		);
		const corruptKey = paths.hostRetry('0'.repeat(64));
		await bucket.put(corruptKey, 'invalid json');
		vi.advanceTimersByTime(HOST_RETRY_WINDOW_MS + 1);
		expect(await store.compactExpired()).toBe(99);
		expect(await new HostRetryStore(bucket).compactExpired()).toBe(2);
		expect(await new HostRetryStore(bucket).compactExpired()).toBe(0);
		expect(await (await bucket.get(corruptKey))!.text()).toBe('invalid json');
	});
});
