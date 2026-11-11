import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryBucket, useFakeClock } from '../../testing';
import { PreconditionFailedError } from '../../errors';
import { paths } from '../../paths';
import { MaintenanceLock } from './MaintenanceLock';

describe('MaintenanceLock', () => {
	let bucket: MemoryBucket;
	let lock: MaintenanceLock;
	let clock: ReturnType<typeof useFakeClock>;

	beforeEach(() => {
		clock = useFakeClock(0);
		bucket = new MemoryBucket();
		lock = new MaintenanceLock(bucket);
	});

	afterEach(() => {
		clock.restore();
		vi.restoreAllMocks();
	});

	it('retains a lease without bucket I/O and renews with its owned ETag', async () => {
		expect(await lock.hold('A', 3000, 1000)).toBe(true);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		clock.set(1000);
		expect(await lock.hold('A', 3000, 1000)).toBe(true);
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		clock.set(2001);
		expect(await lock.hold('A', 3000, 1000)).toBe(true);
		expect(get).not.toHaveBeenCalled();
		expect(put).toHaveBeenCalledOnce();
		await lock.release('A');
		expect(await new MaintenanceLock(bucket).acquire('B')).toBe(true);
	});

	it('does not reuse an expired lease or recover ownership after losing renewal CAS', async () => {
		await lock.hold('A', 1000, 500);
		clock.set(1000);
		await new MaintenanceLock(bucket).acquire('B', 2000);
		expect(await lock.hold('A', 1000, 500)).toBe(false);
		clock.set(3000);
		expect(await lock.hold('A', 1000, 500)).toBe(true);
		clock.set(3600);
		vi.spyOn(bucket, 'put').mockRejectedValueOnce(new PreconditionFailedError('lost'));
		expect(await lock.hold('A', 1000, 500)).toBe(false);
		const get = vi.spyOn(bucket, 'get');
		await lock.hold('A', 1000, 500);
		expect(get).toHaveBeenCalledOnce();
	});

	it('acquires a free lease', async () => {
		expect(await lock.acquire('A', 1000)).toBe(true);
		expect(await bucket.get(paths.maintenanceLock)).not.toBeNull();
	});

	it('refuses a second holder while held and unexpired', async () => {
		expect(await lock.acquire('A', 10_000)).toBe(true);
		expect(await lock.acquire('B', 10_000)).toBe(false);
	});

	it('lets the same holder renew (and extend) its own lease', async () => {
		expect(await lock.acquire('A', 10_000)).toBe(true);
		clock.set(5000); // still within the original TTL
		expect(await lock.acquire('A', 10_000)).toBe(true); // renew, not lock-out
		// The renewal extended the expiry; another holder still can't take it.
		clock.set(12_000);
		expect(await lock.acquire('B', 10_000)).toBe(false);
	});

	it('lets a new holder steal an expired lease', async () => {
		expect(await lock.acquire('A', 1000)).toBe(true);
		clock.set(2000); // past A's expiry
		expect(await lock.acquire('B', 1000)).toBe(true);
	});

	it('release by the holder frees the lease', async () => {
		expect(await lock.acquire('A', 10_000)).toBe(true);
		await lock.release('A');
		expect(await (await bucket.get(paths.maintenanceLock))!.json()).toEqual({
			holder: 'A',
			expires_at: new Date(0).toISOString(),
		});
		expect(await lock.acquire('B', 10_000)).toBe(true);
	});

	it('treats a lease released while acquisition reads the lease as free', async () => {
		expect(await lock.acquire('A', 10_000)).toBe(true);
		const originalGet = bucket.get.bind(bucket);
		let released = false;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (!released) {
				released = true;
				clock.set(500);
				await lock.release('A');
			}
			return originalGet(key);
		});

		expect(await lock.acquire('B', 10_000)).toBe(true);
	});

	it('uses three operations per tick without a failed create', async () => {
		await lock.acquire('initial');
		await lock.release('initial');
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		expect(await lock.acquire('next')).toBe(true);
		await lock.release('next');
		expect(get).toHaveBeenCalledOnce();
		expect(put).toHaveBeenCalledTimes(2);
		expect(put.mock.calls.every(([, , opts]) => opts?.onlyIfEtagMatches)).toBe(true);
	});

	it('a delayed release cannot overwrite another replica after expiry', async () => {
		await lock.acquire('A', 1000);
		const originalPut = bucket.put.bind(bucket);
		const pending = Promise.withResolvers<void>();
		vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
			await pending.promise;
			return originalPut(...args);
		});
		const releasing = lock.release('A');
		clock.set(2000);
		expect(await new MaintenanceLock(bucket).acquire('B', 10_000)).toBe(true);
		pending.resolve();
		await releasing;
		expect(await (await bucket.get(paths.maintenanceLock))!.json()).toMatchObject({ holder: 'B' });
	});

	it('does not write a release when already aborted', async () => {
		await lock.acquire('A', 1000);
		const put = vi.spyOn(bucket, 'put');
		await lock.release('A', AbortSignal.abort());
		expect(put).not.toHaveBeenCalled();
	});

	it('release by a non-holder is a no-op', async () => {
		expect(await lock.acquire('A', 10_000)).toBe(true);
		await lock.release('B'); // not the holder
		expect(await bucket.get(paths.maintenanceLock)).not.toBeNull();
		expect(await lock.acquire('B', 10_000)).toBe(false); // A still holds it
	});

	it('steals a lock whose stored record is malformed', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await bucket.put(paths.maintenanceLock, 'not-json-do-not-log');

		expect(await lock.acquire('A', 1000)).toBe(true);
		const stored = await bucket.get(paths.maintenanceLock);
		expect((await stored!.json<{ holder: string }>()).holder).toBe('A');
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain('corrupt_maintenance_lock_ignored');
		expect(line).not.toContain('not-json-do-not-log');
	});

	it('returns false when it loses the CAS on a contended steal', async () => {
		expect(await lock.acquire('A', 1000)).toBe(true);
		clock.set(2000); // A's lease expired → eligible to steal

		const originalPut = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, opts) => {
			// Another writer wins the steal first: the conditional CAS fails.
			if (opts?.onlyIfEtagMatches) throw new PreconditionFailedError('lost the steal');
			return originalPut(key, value, opts);
		});

		expect(await lock.acquire('B', 1000)).toBe(false);
	});

	it('allows exactly one concurrent creator and ignores the losing holder release', async () => {
		const other = new MaintenanceLock(bucket);
		const results = await Promise.all([lock.acquire('A', 1000), other.acquire('B', 1000)]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const winner = results[0] ? 'A' : 'B';
		await (results[0] ? other : lock).release(results[0] ? 'B' : 'A');
		expect(await (await bucket.get(paths.maintenanceLock))!.json()).toMatchObject({
			holder: winner,
			expires_at: new Date(1000).toISOString(),
		});
	});

	it('does not turn a failed lease read into permission to run', async () => {
		vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('bucket unavailable'));
		const put = vi.spyOn(bucket, 'put');
		await expect(lock.acquire('A')).rejects.toThrow('bucket unavailable');
		await lock.release('A');
		expect(put).not.toHaveBeenCalled();
		expect(await lock.acquire('A')).toBe(true);
	});

	it('retains the lease after a release write fails and permits takeover exactly at expiry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await lock.acquire('A', 1000);
		vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('write unavailable'));
		await expect(lock.release('A')).resolves.toBeUndefined();
		const other = new MaintenanceLock(bucket);
		clock.set(999);
		expect(await other.acquire('B', 1000)).toBe(false);
		clock.set(1000);
		expect(await other.acquire('B', 1000)).toBe(true);
	});

	it('releases using the renewed ETag', async () => {
		await lock.acquire('A', 1000);
		clock.set(500);
		await lock.acquire('A', 2000);
		await lock.release('A');
		expect(await new MaintenanceLock(bucket).acquire('B')).toBe(true);
	});
	it('release does not delete a lease another holder stole after a TTL overrun', async () => {
		expect(await lock.acquire('A', 1000)).toBe(true);
		clock.set(2000); // A overran its TTL
		expect(await lock.acquire('B', 10_000)).toBe(true); // B steals the expired lease

		await lock.release('A'); // must not delete B's freshly-acquired lease

		const stored = await bucket.get(paths.maintenanceLock);
		expect(stored).not.toBeNull();
		expect((await stored!.json<{ holder: string }>()).holder).toBe('B');
	});
});
