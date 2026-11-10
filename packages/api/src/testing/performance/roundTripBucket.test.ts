import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { RoundTripBucket } from './roundTripBucket';

describe('storage round-trip model', () => {
	it('distinguishes serial and parallel calls with the same request count', async () => {
		const bucket = new RoundTripBucket(new MemoryBucket());
		const serial = await bucket.measure(async () => {
			await bucket.get('a');
			await bucket.get('b');
			await bucket.get('c');
		});
		const parallel = await bucket.measure(() =>
			Promise.all(['a', 'b', 'c'].map((key) => bucket.get(key))),
		);
		expect(serial.cost).toMatchObject({ requests: 3, rounds: 3, estimatedMs: 75 });
		expect(parallel.cost).toMatchObject({ requests: 3, rounds: 1, estimatedMs: 25 });
	});

	it('counts the longest branch plus its join, not the sum of branch depths', async () => {
		const bucket = new RoundTripBucket(new MemoryBucket());
		const { cost } = await bucket.measure(async () => {
			await Promise.all([
				(async () => {
					await bucket.get('a');
					await bucket.get('b');
					await bucket.get('c');
				})(),
				(async () => {
					// Synchronous CPU work/promise plumbing must not create another RTT.
					for (let i = 0; i < 100; i++) await Promise.resolve();
					await bucket.head('d');
				})(),
			]);
			await bucket.put('joined', 'done');
		});
		expect(cost).toMatchObject({
			requests: 5,
			rounds: 4,
			estimatedMs: 100,
			requestsPerRound: [2, 1, 1, 1],
		});
	});

	it('models bounded fan-out and excludes seeding operations', async () => {
		const bucket = new RoundTripBucket(new MemoryBucket());
		await bucket.put('seed', 'data');
		const { cost } = await bucket.measure(() =>
			mapWithConcurrency(['a', 'b', 'c', 'd', 'e'], 2, (key) => bucket.get(key)),
		);
		expect(cost).toMatchObject({
			requests: 5,
			rounds: 3,
			estimatedMs: 75,
			requestsPerRound: [2, 2, 1],
		});
	});

	it('charges conditional GETs, missing objects, list pages and batch deletes as port calls', async () => {
		const bucket = new RoundTripBucket(new MemoryBucket());
		const object = await bucket.put('a', 'data');
		await bucket.put('b', 'data');
		const { cost } = await bucket.measure(async () => {
			await bucket.get('a', { ifNoneMatch: object.etag });
			await bucket.get('missing');
			const page = await bucket.list({ limit: 1 });
			expect(page.truncated).toBe(true);
			await bucket.list({ limit: 1, cursor: page.cursor });
			await bucket.delete(['a', 'b']);
		});
		expect(cost).toMatchObject({
			requests: 5,
			rounds: 5,
			byOperation: { get: 1, get304: 1, head: 0, list: 2, put: 0, delete: 1 },
		});
	});

	it('resets between measurements including after a rejected operation', async () => {
		const bucket = new RoundTripBucket(new MemoryBucket());
		await bucket.put('a', 'exists');
		await expect(
			bucket.measure(() => bucket.put('a', 'conflict', { onlyIfNotExists: true })),
		).rejects.toThrow();
		const { cost } = await bucket.measure(async () => 'cached');
		expect(cost).toMatchObject({ requests: 0, rounds: 0, estimatedMs: 0, requestsPerRound: [] });
	});
});
