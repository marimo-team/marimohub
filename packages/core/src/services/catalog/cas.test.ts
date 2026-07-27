import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../errors';
import { MemoryBucket } from '../../testing';
import { acquireSingletonClaim, mutateObject, releaseSingletonClaim, withCasRetry } from './cas';

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

	it('throws ConflictError immediately when retries is 0 (attempt never runs)', async () => {
		const attempt = vi.fn();
		await expect(withCasRetry(attempt, { retries: 0 })).rejects.toBeInstanceOf(ConflictError);
		expect(attempt).not.toHaveBeenCalled();
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

	it('throws the default NotFoundError when no notFound option is given', async () => {
		const bucket = new MemoryBucket();
		await expect(mutateObject(bucket, 'missing', parse, (c) => c)).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	it('exhausts retries and throws ConflictError under perpetual conflict', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ n: 1 }));
		vi.spyOn(bucket, 'put').mockRejectedValue(new PreconditionFailedError('always'));

		await expect(
			mutateObject(bucket, 'k', parse, (cur) => ({ n: cur.n + 1 }), {
				retries: 3,
				backoffMs: () => 0,
			}),
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('propagates a parse error without retrying', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ n: 1 }));
		const getSpy = vi.spyOn(bucket, 'get');
		const boom = new Error('parse boom');

		await expect(
			mutateObject(
				bucket,
				'k',
				() => {
					throw boom;
				},
				(c) => c,
				{ backoffMs: () => 0 },
			),
		).rejects.toBe(boom);
		expect(getSpy).toHaveBeenCalledTimes(1);
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

describe('releaseSingletonClaim', () => {
	const KEY = 'claim';
	const serialize = (holder: string | null) => JSON.stringify({ session_id: holder });
	const parseHolder = (raw: unknown) => (raw as { session_id: string | null }).session_id;

	const claimCfg = (bucket: MemoryBucket) => ({
		bucket,
		key: KEY,
		serialize,
		parseHolder,
		isHolderLive: async () => true,
	});

	const holderAt = async (bucket: MemoryBucket) => {
		const obj = await bucket.get(KEY);
		return obj ? parseHolder(await obj.json()) : null;
	};

	/** Let B replace the claim in the window between release's read and its write. */
	const raceReacquire = (bucket: MemoryBucket, next: string) => {
		const realGet = bucket.get.bind(bucket);
		let raced = false;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			const obj = await realGet(key);
			if (!raced && key === KEY) {
				raced = true;
				await bucket.put(KEY, serialize(next));
			}
			return obj;
		});
	};

	it('marks the claim free instead of deleting it', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('A'));

		await releaseSingletonClaim(claimCfg(bucket), 'A');

		expect(await bucket.get(KEY)).not.toBeNull();
		expect(await holderAt(bucket)).toBeNull();
	});

	it('leaves a claim another session holds untouched', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('B'));

		await releaseSingletonClaim(claimCfg(bucket), 'A');

		expect(await holderAt(bucket)).toBe('B');
	});

	it('does not delete a claim a new holder acquired mid-release', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('A'));
		raceReacquire(bucket, 'B');

		await releaseSingletonClaim(claimCfg(bucket), 'A');
		vi.restoreAllMocks();

		expect(await holderAt(bucket)).toBe('B');
	});

	it('a release racing a re-acquire cannot hand the singleton to a third session', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('A'));
		raceReacquire(bucket, 'B');

		await releaseSingletonClaim(claimCfg(bucket), 'A');
		vi.restoreAllMocks();

		// B is live, so C must lose.
		expect(await acquireSingletonClaim(claimCfg(bucket), 'C')).toEqual({
			acquired: false,
			holder: 'B',
		});
	});

	it('keeps exactly one holder when a stale release lands after the winner re-asserts its claim', async () => {
		// The create saga's `app_claim_recheck` ordering, where A provisioned slowly
		// and B stole the claim: B re-asserts, then A's compensation releases late.
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('A'));
		expect(await acquireSingletonClaim(claimCfg(bucket), 'B')).toEqual({
			acquired: false,
			holder: 'A',
		});

		// A's saga aborts and releases; B then wins the free key and re-asserts.
		await releaseSingletonClaim(claimCfg(bucket), 'A');
		expect(await acquireSingletonClaim(claimCfg(bucket), 'B')).toEqual({
			acquired: true,
			holder: 'B',
		});
		// A's compensation fires a second, stale release.
		await releaseSingletonClaim(claimCfg(bucket), 'A');

		expect(await holderAt(bucket)).toBe('B');
	});

	it('reports a non-race failure instead of passing it off as a release', async () => {
		// A bucket outage or a corrupt claim body is NOT the re-acquire race the
		// swallow is for; the claim is still held afterwards, so it must be visible.
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('A'));
		const boom = new Error('bucket down');
		vi.spyOn(bucket, 'get').mockRejectedValue(boom);
		const onReleaseError = vi.fn();

		await releaseSingletonClaim({ ...claimCfg(bucket), onReleaseError }, 'A');
		vi.restoreAllMocks();

		expect(onReleaseError).toHaveBeenCalledWith(boom);
		expect(await holderAt(bucket)).toBe('A'); // unchanged: the release never happened
	});

	it('stays silent on a losing CAS (the expected re-acquire race)', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('A'));
		vi.spyOn(bucket, 'put').mockRejectedValue(new PreconditionFailedError('race'));
		const onReleaseError = vi.fn();

		await releaseSingletonClaim({ ...claimCfg(bucket), onReleaseError }, 'A');
		vi.restoreAllMocks();

		expect(onReleaseError).not.toHaveBeenCalled();
	});

	it('a released claim is free for the next acquirer even though the object remains', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(KEY, serialize('A'));
		await releaseSingletonClaim(claimCfg(bucket), 'A');

		expect(await acquireSingletonClaim(claimCfg(bucket), 'C')).toEqual({
			acquired: true,
			holder: 'C',
		});
		expect(await holderAt(bucket)).toBe('C');
	});
});
