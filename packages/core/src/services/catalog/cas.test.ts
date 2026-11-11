import { describe, expect, it, vi } from 'vitest';
import {
	assertVersionMatch,
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
} from '../../errors';
import { MemoryBucket } from '../../testing';
import {
	acquireSingletonClaim,
	mutateObject,
	mutateObjectWithOutcome,
	putIfMatch,
	releaseSingletonClaim,
	withCasRetry,
} from './cas';

describe('withCasRetry', () => {
	it('jitters each retry delay and does not sleep after exhaustion', async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.51);
		try {
			const bucket = new MemoryBucket();
			await bucket.put('k', 'seed');
			const attempt = vi.fn(async (cas: Parameters<Parameters<typeof withCasRetry>[1]>[0]) =>
				cas.put('k', 'loser', { onlyIfEtagMatches: 'stale' }),
			);
			const result = expect(withCasRetry(bucket, attempt, { retries: 3 })).rejects.toBeInstanceOf(
				ConflictError,
			);
			await vi.advanceTimersByTimeAsync(24);
			expect(attempt).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(attempt).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(74);
			expect(attempt).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1);
			await result;
			expect(attempt).toHaveBeenCalledTimes(3);
			expect(random).toHaveBeenCalledTimes(2);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			random.mockRestore();
			vi.useRealTimers();
		}
	});

	it.each([
		{ random: 0, delay: 25 },
		{ random: 0.999999, delay: 49 },
	])('keeps retry delays integral at the jitter boundary $random', async ({ random, delay }) => {
		vi.useFakeTimers();
		const draw = vi.spyOn(Math, 'random').mockReturnValue(random);
		try {
			const bucket = new MemoryBucket();
			await bucket.put('key', 'seed');
			let attempts = 0;
			const pending = withCasRetry(bucket, async (cas) => {
				if (attempts++ === 0) await cas.put('key', 'value', { onlyIfNotExists: true });
				return 'done';
			});
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(attempts).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toBe('done');
			expect(attempts).toBe(2);
			expect(draw).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			draw.mockRestore();
			vi.useRealTimers();
		}
	});

	it('returns the first successful attempt', async () => {
		const bucket = new MemoryBucket();
		const attempt = vi.fn().mockResolvedValue('ok');
		expect(await withCasRetry(bucket, attempt)).toBe('ok');
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('retries a conditional-write conflict then succeeds', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', 'seed');
		const onConflict = vi.fn();
		let n = 0;
		const result = await withCasRetry(
			bucket,
			async (cas) => {
				if (n++ < 2) {
					await cas.put('k', 'loser', { onlyIfEtagMatches: 'stale' });
				}
				return 'won';
			},
			{ backoffMs: () => 0, onConflict },
		);
		expect(result).toBe('won');
		expect(onConflict).toHaveBeenCalledTimes(2);
	});

	it('throws ConflictError once retries are exhausted', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', 'seed');
		const precondition = new PreconditionFailedError('lost race');
		vi.spyOn(bucket, 'put').mockRejectedValue(precondition);
		const onConflict = vi.fn();
		const onExhausted = vi.fn();
		const result = withCasRetry(
			bucket,
			async (cas) => {
				return cas.put('k', 'loser', { onlyIfEtagMatches: 'stale' });
			},
			{
				retries: 3,
				backoffMs: () => 0,
				onConflict,
				onExhausted,
			},
		);
		await expect(result).rejects.toMatchObject({
			name: 'ConflictError',
			cause: precondition,
		});
		expect(onConflict).toHaveBeenNthCalledWith(1, 0, precondition);
		expect(onConflict).toHaveBeenNthCalledWith(2, 1, precondition);
		expect(onConflict).toHaveBeenNthCalledWith(3, 2, precondition);
		expect(onExhausted).toHaveBeenCalledOnce();
		expect(onExhausted).toHaveBeenCalledWith(precondition);
	});

	it('does not attach a cause when zero retries run', async () => {
		const bucket = new MemoryBucket();
		const onExhausted = vi.fn();
		const attempt = vi.fn();
		const result = withCasRetry(bucket, attempt, { retries: 0, onExhausted });

		await expect(result).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && error.cause === undefined,
		);
		expect(attempt).not.toHaveBeenCalled();
		expect(onExhausted).toHaveBeenCalledWith(undefined);
	});

	it('keeps callback-thrown preconditions out of conflict hooks', async () => {
		const bucket = new MemoryBucket();
		const precondition = new PreconditionFailedError('stale client version');
		const onConflict = vi.fn();
		const onExhausted = vi.fn();

		await expect(
			withCasRetry(
				bucket,
				async () => {
					throw precondition;
				},
				{
					backoffMs: () => 0,
					onConflict,
					onExhausted,
				},
			),
		).rejects.toBe(precondition);
		expect(onConflict).not.toHaveBeenCalled();
		expect(onExhausted).not.toHaveBeenCalled();
	});

	it('propagates a non-precondition error immediately (no retry)', async () => {
		const bucket = new MemoryBucket();
		const attempt = vi.fn().mockRejectedValue(new TypeError('boom'));
		await expect(withCasRetry(bucket, attempt, { backoffMs: () => 0 })).rejects.toBeInstanceOf(
			TypeError,
		);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('propagates a client precondition error immediately (no retry)', async () => {
		const bucket = new MemoryBucket();
		const precondition = new PreconditionFailedError('stale client version');
		const attempt = vi.fn().mockRejectedValue(precondition);
		await expect(withCasRetry(bucket, attempt, { backoffMs: () => 0 })).rejects.toBe(precondition);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('throws ConflictError immediately when retries is 0 (attempt never runs)', async () => {
		const bucket = new MemoryBucket();
		const attempt = vi.fn();
		await expect(withCasRetry(bucket, attempt, { retries: 0 })).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(attempt).not.toHaveBeenCalled();
	});
});

describe('mutateObject', () => {
	const parse = (raw: unknown) => raw as { n: number };

	it('reads, applies, and conditionally writes', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ n: 1 }));
		const result = await mutateObject(bucket, 'k', parse, (cur) => ({ n: cur.n + 1 }));
		expect(result).toEqual({ n: 2 });
		expect(JSON.parse(await (await bucket.get('k'))!.text())).toEqual({ n: 2 });
	});

	it('skips the write when apply returns null (no-op)', async () => {
		const bucket = new MemoryBucket();
		const before = await bucket.put('k', JSON.stringify({ n: 1 }));
		const result = await mutateObject(bucket, 'k', parse, () => null);
		expect(result).toEqual({ n: 1 });
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
		expect(result).toEqual({ n: 100 });
	});
});

describe('mutateObjectWithOutcome', () => {
	const parse = (raw: unknown) => raw as { n: number };

	it('reports a committed write', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ n: 1 }));

		const result = await mutateObjectWithOutcome(bucket, 'k', parse, (current) => ({
			n: current.n + 1,
		}));

		expect(result).toEqual({ value: { n: 2 }, written: true });
	});

	it('reports an unchanged value', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ n: 1 }));

		const result = await mutateObjectWithOutcome(bucket, 'k', parse, () => null);

		expect(result).toEqual({ value: { n: 1 }, written: false });
	});
});

describe('mutateObject preconditions', () => {
	it('does not retry a stale client precondition inside mutateObject', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('k', JSON.stringify({ updated_at: 'v2' }));
		const onAttempt = vi.fn();

		await expect(
			mutateObject(
				bucket,
				'k',
				(raw) => raw as { updated_at: string },
				(current) => {
					assertVersionMatch(current.updated_at, 'v1');
					return current;
				},
				{
					onAttempt,
					backoffMs: () => {
						throw new Error('unexpected retry');
					},
				},
			),
		).rejects.toBeInstanceOf(PreconditionFailedError);
		expect(onAttempt).toHaveBeenCalledTimes(1);
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
			etag: expect.any(String),
			holder: 'B',
		});
		// A's compensation fires a second, stale release.
		await releaseSingletonClaim(claimCfg(bucket), 'A');

		expect(await holderAt(bucket)).toBe('B');
	});

	it('releases with the acquired ETag without another read', async () => {
		const bucket = new MemoryBucket();
		const claim = await acquireSingletonClaim(claimCfg(bucket), 'A');
		if (!claim.acquired) throw new Error('claim not acquired');
		const get = vi.spyOn(bucket, 'get');
		await releaseSingletonClaim(claimCfg(bucket), 'A', claim.etag);
		expect(get).not.toHaveBeenCalled();
		expect(await holderAt(bucket)).toBeNull();
	});

	it('reports a failed fast-path release and leaves the claim held', async () => {
		const bucket = new MemoryBucket();
		const claim = await acquireSingletonClaim(claimCfg(bucket), 'A');
		if (!claim.acquired) throw new Error('claim not acquired');
		const failure = new Error('storage unavailable');
		const get = vi.spyOn(bucket, 'get');
		vi.spyOn(bucket, 'put').mockRejectedValueOnce(failure);
		const onReleaseError = vi.fn();
		await releaseSingletonClaim({ ...claimCfg(bucket), onReleaseError }, 'A', claim.etag);
		expect(onReleaseError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(get).not.toHaveBeenCalled();
		expect(await holderAt(bucket)).toBe('A');
	});

	it.each(['A', 'B'])('rechecks a stale release ETag with holder %s', async (holder) => {
		const bucket = new MemoryBucket();
		const claim = await acquireSingletonClaim(claimCfg(bucket), 'A');
		if (!claim.acquired) throw new Error('claim not acquired');
		await bucket.put(KEY, serialize(holder));
		await releaseSingletonClaim(claimCfg(bucket), 'A', claim.etag);
		expect(await holderAt(bucket)).toBe(holder === 'A' ? null : 'B');
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
			etag: expect.any(String),
			holder: 'C',
		});
		expect(await holderAt(bucket)).toBe('C');
	});
});

describe('known mutation snapshots', () => {
	it.each([false, true])('reuses a known ETag and retries conflicts (stale: %s)', async (stale) => {
		const bucket = new MemoryBucket();
		const original = await bucket.put('counter', '1');
		if (stale) await bucket.put('counter', '5');
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		const result = await mutateObjectWithOutcome(bucket, 'counter', Number, (n) => n + 1, {
			known: { value: 1, etag: original.etag },
			backoffMs: () => 0,
		});
		expect(result).toEqual({ value: stale ? 6 : 2, written: true });
		expect(get).toHaveBeenCalledTimes(stale ? 1 : 0);
		expect(put).toHaveBeenCalledTimes(stale ? 2 : 1);
		expect(put.mock.calls[0][2]).toEqual({ onlyIfEtagMatches: original.etag });
	});

	it('does not recreate an object deleted after the known snapshot', async () => {
		const bucket = new MemoryBucket();
		const original = await bucket.put('counter', '1');
		await bucket.delete('counter');
		const put = vi.spyOn(bucket, 'put');
		await expect(
			mutateObjectWithOutcome(bucket, 'counter', Number, (n) => n + 1, {
				known: { value: 1, etag: original.etag },
				backoffMs: () => 0,
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(put).toHaveBeenCalledTimes(1);
		expect(await bucket.get('counter')).toBeNull();
	});

	it('stops retrying when a fresh value makes the mutation unnecessary', async () => {
		const bucket = new MemoryBucket();
		const original = await bucket.put('counter', '1');
		await bucket.put('counter', '5');
		const put = vi.spyOn(bucket, 'put');
		await expect(
			mutateObjectWithOutcome(bucket, 'counter', Number, (n) => (n >= 5 ? null : n + 1), {
				known: { value: 1, etag: original.etag },
				backoffMs: () => 0,
			}),
		).resolves.toEqual({ value: 5, written: false });
		expect(put).toHaveBeenCalledTimes(1);
	});

	it('propagates a storage failure on the known write without retrying', async () => {
		const bucket = new MemoryBucket();
		const failure = new Error('storage unavailable');
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put').mockRejectedValue(failure);
		await expect(
			mutateObjectWithOutcome(bucket, 'counter', Number, (n) => n + 1, {
				known: { value: 1, etag: 'known' },
			}),
		).rejects.toBe(failure);
		expect(put).toHaveBeenCalledTimes(1);
		expect(get).not.toHaveBeenCalled();
	});

	it('exhausts the retry budget after a known snapshot keeps losing CAS', async () => {
		const bucket = new MemoryBucket();
		const original = await bucket.put('counter', '1');
		const put = vi.spyOn(bucket, 'put').mockRejectedValue(new PreconditionFailedError('conflict'));
		const get = vi.spyOn(bucket, 'get');
		await expect(
			mutateObjectWithOutcome(bucket, 'counter', Number, (n) => n + 1, {
				known: { value: 1, etag: original.etag },
				retries: 3,
				backoffMs: () => 0,
			}),
		).rejects.toBeInstanceOf(ConflictError);
		expect(put).toHaveBeenCalledTimes(3);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it('does no I/O when the known value needs no change', async () => {
		const bucket = new MemoryBucket();
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		expect(
			await mutateObjectWithOutcome(bucket, 'counter', Number, () => null, {
				known: { value: 1, etag: 'known' },
			}),
		).toEqual({ value: 1, written: false });
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});
});

describe('putIfMatch', () => {
	it('creates once, then writes only against the current ETag', async () => {
		const bucket = new MemoryBucket();
		const created = await putIfMatch(bucket, 'k', 'a');
		expect(created).toBeDefined();
		expect(await putIfMatch(bucket, 'k', 'b')).toBeUndefined();
		const updated = await putIfMatch(bucket, 'k', 'c', created);
		expect(updated).toBeDefined();
		expect(await putIfMatch(bucket, 'k', 'd', created)).toBeUndefined();
		expect(await (await bucket.get('k'))!.text()).toBe('c');
	});

	it('propagates storage failures', async () => {
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'put').mockRejectedValue(new Error('unavailable'));
		await expect(putIfMatch(bucket, 'k', 'a')).rejects.toThrow('unavailable');
	});
});
