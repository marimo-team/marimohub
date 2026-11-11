import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Bucket, BucketMultipart } from '@marimo-hub/core/ports/bucket';
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

	it('drains rejected measurements and chained siblings before allowing another measurement', async () => {
		const inner = new MemoryBucket();
		const bucket = new RoundTripBucket(inner);
		const failure = new Error('action failed');
		let sibling: Promise<unknown> | undefined;
		const failed = bucket.measure(async () => {
			sibling = bucket.put('first', 'a').then(async () => {
				for (let i = 0; i < 100; i++) await Promise.resolve();
				return bucket.put('second', 'b');
			});
			throw failure;
		});
		await expect(bucket.measure(async () => null)).rejects.toThrow('cannot overlap');
		await expect(failed).rejects.toBe(failure);
		expect(await inner.head('second')).not.toBeNull();
		await sibling;
		const { cost } = await bucket.measure(() => bucket.get('fresh'));
		expect(cost).toMatchObject({ requests: 1, rounds: 1, requestsPerRound: [1] });
	});

	it('rejects unawaited operations even after their scheduling round was released', async () => {
		const inner = new MemoryBucket();
		let finish!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		vi.spyOn(inner, 'head').mockImplementation(async () => {
			await held;
			return null;
		});
		const bucket = new RoundTripBucket(inner);
		const failed = bucket.measure(async () => {
			void bucket.head('held');
			await setImmediate();
		});
		const assertion = expect(failed).rejects.toThrow('Unawaited storage operations');
		await setImmediate();
		await expect(bucket.measure(async () => null)).rejects.toThrow('cannot overlap');
		finish();
		await assertion;
		expect((await bucket.measure(async () => 'cached')).cost.rounds).toBe(0);
	});

	it('keeps a rejected measurement locked until released inner I/O and its continuation settle', async () => {
		const inner = new MemoryBucket();
		let finish!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		vi.spyOn(inner, 'head').mockImplementation(async () => {
			await held;
			return null;
		});
		const bucket = new RoundTripBucket(inner);
		const failure = new Error('action failed after release');
		const failed = bucket.measure(async () => {
			void bucket.head('held').then(() => bucket.put('continued', 'done'));
			await setImmediate();
			throw failure;
		});
		const assertion = expect(failed).rejects.toBe(failure);
		await setImmediate();
		expect(inner.head).toHaveBeenCalled();
		await expect(bucket.measure(async () => null)).rejects.toThrow('cannot overlap');
		finish();
		await assertion;
		expect(await inner.get('continued')).not.toBeNull();
		expect((await bucket.measure(() => bucket.get('fresh'))).cost).toMatchObject({
			requests: 1,
			rounds: 1,
			requestsPerRound: [1],
		});
	});

	it('preserves missing optional capabilities', () => {
		const bucket = new RoundTripBucket(new MemoryBucket());
		expect(bucket.putStream).toBeUndefined();
		expect(bucket.multipart).toBeUndefined();
	});

	it('forwards and measures streaming and multipart calls without changing their receivers', async () => {
		const inner: Bucket = new MemoryBucket();
		const object = await inner.put('object', 'data');
		const chunks = (async function* () {
			yield new Uint8Array([1, 2]);
		})();
		const options = { customMetadata: { source: 'fixture' } };
		inner.putStream = vi.fn(async function (this: Bucket, key, stream, size, opts) {
			expect(this).toBe(inner);
			expect([key, stream, size, opts]).toEqual(['stream', chunks, 2, options]);
			return object;
		});
		const part = { partNumber: 1, etag: 'part' };
		const multipart: BucketMultipart = {
			isolatedSessions: true,
			create: vi.fn(async function (this: BucketMultipart) {
				expect(this).toBe(multipart);
				return { uploadId: 'upload' };
			}),
			putPart: vi.fn(async function (this: BucketMultipart) {
				expect(this).toBe(multipart);
				return part;
			}),
			complete: vi.fn(async function (this: BucketMultipart) {
				expect(this).toBe(multipart);
				return object;
			}),
			abort: vi.fn(async function (this: BucketMultipart) {
				expect(this).toBe(multipart);
			}),
		};
		inner.multipart = multipart;
		const bucket = new RoundTripBucket(inner);
		expect(bucket.multipart?.isolatedSessions).toBe(true);
		const bytes = new Uint8Array([1, 2]);
		const { cost } = await bucket.measure(async () => {
			expect(await bucket.putStream!('stream', chunks, 2, options)).toBe(object);
			expect(await bucket.multipart!.create('key', options)).toEqual({ uploadId: 'upload' });
			expect(await bucket.multipart!.putPart('key', 'upload', 1, bytes)).toBe(part);
			expect(await bucket.multipart!.complete('key', 'upload', [part])).toBe(object);
			await bucket.multipart!.abort('key', 'upload');
		});
		expect(cost).toMatchObject({
			requests: 5,
			rounds: 5,
			byOperation: {
				putStream: 1,
				multipartCreate: 1,
				multipartPutPart: 1,
				multipartComplete: 1,
				multipartAbort: 1,
			},
		});
		expect(multipart.create).toHaveBeenCalledWith('key', options);
		expect(multipart.putPart).toHaveBeenCalledWith('key', 'upload', 1, bytes);
		expect(multipart.complete).toHaveBeenCalledWith('key', 'upload', [part]);
		expect(multipart.abort).toHaveBeenCalledWith('key', 'upload');
	});

	it('preserves optional-capability failures and resets their measurement', async () => {
		const inner: Bucket = new MemoryBucket();
		const failure = new Error('stream failed');
		inner.putStream = async () => {
			throw failure;
		};
		const bucket = new RoundTripBucket(inner);
		const chunks = (async function* () {
			yield new Uint8Array([1]);
		})();
		await expect(bucket.measure(() => bucket.putStream!('key', chunks, 1))).rejects.toBe(failure);
		expect((await bucket.measure(() => bucket.get('key'))).cost).toMatchObject({
			requests: 1,
			rounds: 1,
		});
	});
});
