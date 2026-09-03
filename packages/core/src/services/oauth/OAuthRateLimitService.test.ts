import { describe, expect, it, vi } from 'vitest';
import { PreconditionFailedError } from '../../errors';
import { paths } from '../../paths';
import { MemoryBucket } from '../../testing';
import { OAUTH_RATE_LIMITS, OAuthRateLimitService } from './OAuthRateLimitService';

describe('OAuthRateLimitService', () => {
	it('shares admissions across service instances', async () => {
		const bucket = new MemoryBucket();
		const put = vi.spyOn(bucket, 'put');
		const first = new OAuthRateLimitService(bucket, { retry: { backoffMs: () => 0 } });
		const second = new OAuthRateLimitService(bucket, { retry: { backoffMs: () => 0 } });

		expect(await Promise.all([first.consume('authorize'), second.consume('authorize')])).toEqual([
			true,
			true,
		]);
		expect(
			await bucket.get(paths.oauthRateLimit('authorize')).then((object) => object?.json()),
		).toEqual({ timestamps: [expect.any(Number), expect.any(Number)] });
		expect(put).toHaveBeenCalledTimes(3);
	});

	it('enforces the shared endpoint limit', async () => {
		const bucket = new MemoryBucket();
		const first = new OAuthRateLimitService(bucket);
		const second = new OAuthRateLimitService(bucket);

		for (let index = 0; index < OAUTH_RATE_LIMITS.authorize.limit; index += 1) {
			expect(await (index % 2 === 0 ? first : second).consume('authorize')).toBe(true);
		}
		expect(await first.consume('authorize')).toBe(false);
		expect(await second.consume('authorize')).toBe(false);
	});

	it('prunes expired timestamps when admitting a request', async () => {
		const bucket = new MemoryBucket();
		let now = 1;
		const limiter = new OAuthRateLimitService(bucket, { now: () => now });
		for (let index = 0; index < OAUTH_RATE_LIMITS.authorize.limit; index += 1) {
			expect(await limiter.consume('authorize')).toBe(true);
		}
		expect(await limiter.consume('authorize')).toBe(false);

		now += OAUTH_RATE_LIMITS.authorize.windowMs;
		expect(await limiter.consume('authorize')).toBe(true);
		expect(
			await bucket.get(paths.oauthRateLimit('authorize')).then((object) => object?.json()),
		).toEqual({ timestamps: [now] });
	});

	it('fails closed when every conditional write loses its race', async () => {
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'put').mockRejectedValue(new PreconditionFailedError('lost race'));
		const limiter = new OAuthRateLimitService(bucket, {
			retry: { retries: 2, backoffMs: () => 0 },
		});

		await expect(limiter.consume('authorize')).resolves.toBe(false);
	});

	it('propagates corrupt records and bucket outages', async () => {
		const corruptBucket = new MemoryBucket();
		await corruptBucket.put(paths.oauthRateLimit('authorize'), '{invalid');
		await expect(new OAuthRateLimitService(corruptBucket).consume('authorize')).rejects.toThrow();

		const unavailableBucket = new MemoryBucket();
		vi.spyOn(unavailableBucket, 'get').mockRejectedValue(new Error('bucket unavailable'));
		await expect(new OAuthRateLimitService(unavailableBucket).consume('authorize')).rejects.toThrow(
			'bucket unavailable',
		);
	});
});
