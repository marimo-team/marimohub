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

	it('release does not clobber a lease stolen between its read and write', async () => {
		expect(await lock.acquire('A', 1000)).toBe(true);
		const stale = (await bucket.get(paths.maintenanceLock))!;
		vi.spyOn(bucket, 'get').mockImplementationOnce(async () => {
			clock.set(2000);
			expect(await lock.acquire('B', 10_000)).toBe(true);
			return stale;
		});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		await lock.release('A');

		expect(await (await bucket.get(paths.maintenanceLock))!.json()).toMatchObject({ holder: 'B' });
		expect(error).not.toHaveBeenCalled();
	});

	it.each(['get', 'body'] as const)(
		'does not release a successor after an aborted %s resumes',
		async (phase) => {
			await lock.acquire('A', 1000);
			const oldRecord = (await bucket.get(paths.maintenanceLock))!;
			const read = Promise.withResolvers<void>();
			vi.spyOn(bucket, 'get').mockImplementationOnce(async () => {
				if (phase === 'get') await read.promise;
				return {
					...oldRecord,
					text: async () => {
						await read.promise;
						return oldRecord.text();
					},
				};
			});
			const controller = new AbortController();
			const releasing = lock.release('A', controller.signal);
			await Promise.resolve();
			controller.abort();
			clock.set(2000);
			expect(await lock.acquire('B', 1000)).toBe(true);
			read.resolve();
			await releasing;
			expect(await (await bucket.get(paths.maintenanceLock))!.json()).toMatchObject({
				holder: 'B',
			});
		},
	);

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
