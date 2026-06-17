import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryBucket, useFakeClock } from '../testing';
import { paths } from '../paths';
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
		expect(await bucket.get(paths.maintenanceLock)).toBeNull();
		expect(await lock.acquire('B', 10_000)).toBe(true);
	});

	it('release by a non-holder is a no-op', async () => {
		expect(await lock.acquire('A', 10_000)).toBe(true);
		await lock.release('B'); // not the holder
		expect(await bucket.get(paths.maintenanceLock)).not.toBeNull();
		expect(await lock.acquire('B', 10_000)).toBe(false); // A still holds it
	});
});
