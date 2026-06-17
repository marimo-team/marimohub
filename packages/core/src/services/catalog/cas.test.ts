import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../errors';
import { MemoryBucket } from '../../testing';
import { mutateObject, withCasRetry } from './cas';

describe('withCasRetry', () => {
	it('returns the first successful attempt', async () => {
		const attempt = vi.fn().mockResolvedValue('ok');
		expect(await withCasRetry(attempt)).toBe('ok');
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('retries on PreconditionFailedError then succeeds', async () => {
		const onConflict = vi.fn();
		let n = 0;
		const result = await withCasRetry(
			async () => {
				if (n++ < 2) throw new PreconditionFailedError('race');
				return 'won';
			},
			{ backoffMs: () => 0, onConflict },
		);
		expect(result).toBe('won');
		expect(onConflict).toHaveBeenCalledTimes(2);
	});

	it('throws ConflictError once retries are exhausted', async () => {
		const onExhausted = vi.fn();
		await expect(
			withCasRetry(async () => Promise.reject(new PreconditionFailedError('race')), {
				retries: 3,
				backoffMs: () => 0,
				onExhausted,
			}),
		).rejects.toBeInstanceOf(ConflictError);
		expect(onExhausted).toHaveBeenCalledTimes(1);
	});

	it('propagates a non-precondition error immediately (no retry)', async () => {
		const attempt = vi.fn().mockRejectedValue(new TypeError('boom'));
		await expect(withCasRetry(attempt, { backoffMs: () => 0 })).rejects.toBeInstanceOf(TypeError);
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});

describe('mutateObject', () => {
	const parse = (raw: unknown) => raw as { n: number };

	it('reads, applies, and conditionally writes', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ n: 1 }));
		const result = await mutateObject(bucket, 'k', parse, (cur) => ({ n: cur.n + 1 }));
		expect(result.n).toBe(2);
		expect(JSON.parse(await (await bucket.get('k'))!.text())).toEqual({ n: 2 });
	});

	it('skips the write when apply returns null (no-op)', async () => {
		const bucket = new MemoryBucket();
		const before = await bucket.put('k', JSON.stringify({ n: 1 }));
		const result = await mutateObject(bucket, 'k', parse, () => null);
		expect(result.n).toBe(1);
		// ETag unchanged → no write happened.
		expect((await bucket.head('k'))!.etag).toBe(before.etag);
	});

	it('throws the provided notFound error for a missing key', async () => {
		const bucket = new MemoryBucket();
		await expect(
			mutateObject(bucket, 'missing', parse, (c) => c, {
				notFound: () => new NotFoundError('nope'),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('CAS: a racing write makes apply re-run against the fresh value', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ n: 0 }));

		// Sneak a competing write in before the first conditional put commits, so the
		// first attempt loses the ETag race and apply re-runs against n=99.
		const realPut = bucket.put.bind(bucket);
		let raced = false;
		const seen: number[] = [];
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, opts) => {
			if (!raced && opts?.onlyIfEtagMatches) {
				raced = true;
				await realPut('k', JSON.stringify({ n: 99 })); // bumps the ETag
			}
			return realPut(key, value, opts);
		});

		const result = await mutateObject(
			bucket,
			'k',
			parse,
			(cur) => {
				seen.push(cur.n);
				return { n: cur.n + 1 };
			},
			{ backoffMs: () => 0 },
		);

		expect(seen).toEqual([0, 99]); // applied to the stale value, then re-applied to fresh
		expect(result.n).toBe(100);
	});
});
