import { describe, expect, it, vi } from 'vitest';
import type { TempS3Creds } from '@marimo-hub/core';
import { makeTestWif } from './testing';
import { WifCredentialCache, wifCredentialCacheFor } from './wifCredentialCache';

const MINUTE = 60_000;

function fixture(lifetimeMs = 60 * MINUTE) {
	let now = Date.parse('2026-01-01T00:00:00Z');
	const cache = new WifCredentialCache(() => now);
	const exchange = vi.fn(async () => ({
		accessKeyId: `AK${exchange.mock.calls.length}`,
		secretAccessKey: 'SK',
		expiration: new Date(now + lifetimeMs).toISOString(),
	}));
	return {
		cache,
		exchange,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe('WifCredentialCache', () => {
	it('refreshes at the cache boundary before the SDK refresh window', async () => {
		const { cache, exchange, advance } = fixture();
		const first = await cache.get('session', exchange);
		advance(40 * MINUTE - 1);
		expect(await cache.get('session', exchange)).toEqual(first);
		advance(1);
		expect((await cache.get('session', exchange)).accessKeyId).toBe('AK2');
		expect(exchange).toHaveBeenCalledTimes(2);
	});

	it('caches short-lived credentials without extending their expiration', async () => {
		const { cache, exchange, advance } = fixture(10 * MINUTE);
		const first = await cache.get('session', exchange);
		advance(5 * MINUTE - 1);
		expect(await cache.get('session', exchange)).toEqual(first);
		advance(1);
		const refreshed = await cache.get('session', exchange);
		expect(Date.parse(refreshed.expiration) - Date.parse(first.expiration)).toBe(5 * MINUTE);
		expect(exchange).toHaveBeenCalledTimes(2);
	});

	it('coalesces slow concurrent exchanges', async () => {
		const { cache, advance } = fixture();
		const pending = Promise.withResolvers<TempS3Creds>();
		const exchange = vi.fn(() => pending.promise);
		const first = cache.get('session', exchange);
		await Promise.resolve();
		advance(6 * MINUTE);
		const second = cache.get('session', exchange);
		pending.resolve({
			accessKeyId: 'AK',
			secretAccessKey: 'SK',
			expiration: '2026-01-01T01:00:00Z',
		});
		expect(await first).toEqual(await second);
		expect(exchange).toHaveBeenCalledOnce();
	});

	it.each([undefined, 'invalid', '2025-12-31T23:59:59Z', '2026-01-01T00:00:00Z'])(
		'rejects unusable expiration %s and retries',
		async (expiration) => {
			const { cache, exchange } = fixture();
			exchange.mockResolvedValueOnce({
				accessKeyId: 'AK',
				secretAccessKey: 'SK',
				expiration: expiration!,
			});
			await expect(cache.get('session', exchange)).rejects.toThrow(/expiration/);
			expect((await cache.get('session', exchange)).accessKeyId).toBe('AK2');
		},
	);

	it('rejects credentials that expire while the exchange is pending', async () => {
		const { cache, advance } = fixture();
		const pending = Promise.withResolvers<TempS3Creds>();
		const result = cache.get('session', () => pending.promise);
		advance(60 * MINUTE);
		pending.resolve({
			accessKeyId: 'AK',
			secretAccessKey: 'SK',
			expiration: '2026-01-01T01:00:00Z',
		});
		await expect(result).rejects.toThrow(/expiration/);
	});

	it('does not let an invalidated exchange evict its replacement', async () => {
		const { cache, exchange } = fixture();
		const pending = Promise.withResolvers<TempS3Creds>();
		const first = cache.get('session', () => pending.promise);
		const failed = expect(first).rejects.toThrow('failed');
		cache.delete('session');
		const replacement = await cache.get('session', exchange);
		pending.reject(new Error('failed'));
		await failed;
		expect(await cache.get('session', exchange)).toEqual(replacement);
		expect(exchange).toHaveBeenCalledOnce();
	});

	it('shares an exchange failure with concurrent callers and retries afterward', async () => {
		const { cache, exchange } = fixture();
		const pending = Promise.withResolvers<TempS3Creds>();
		const run = vi.fn(() => pending.promise);
		const results = Promise.allSettled([cache.get('session', run), cache.get('session', run)]);
		const error = new Error('broker unavailable');
		pending.reject(error);
		expect(await results).toEqual([
			{ status: 'rejected', reason: error },
			{ status: 'rejected', reason: error },
		]);
		expect(run).toHaveBeenCalledOnce();
		expect((await cache.get('session', exchange)).accessKeyId).toBe('AK1');
	});

	it('recovers from a synchronous broker error', async () => {
		const { cache, exchange } = fixture();
		await expect(
			cache.get('session', () => {
				throw new Error('broker failed');
			}),
		).rejects.toThrow('broker failed');
		expect((await cache.get('session', exchange)).accessKeyId).toBe('AK1');
	});

	it('does not serve stale credentials after a refresh fails', async () => {
		const { cache, exchange, advance } = fixture();
		await cache.get('session', exchange);
		advance(60 * MINUTE);
		exchange.mockRejectedValueOnce(new Error('refresh failed'));
		await expect(cache.get('session', exchange)).rejects.toThrow('refresh failed');
		expect((await cache.get('session', exchange)).accessKeyId).toBe('AK3');
	});

	it('does not let a successful invalidated exchange replace newer credentials', async () => {
		const { cache, exchange } = fixture();
		const pending = Promise.withResolvers<TempS3Creds>();
		const first = cache.get('session', () => pending.promise);
		cache.delete('session');
		const replacement = await cache.get('session', exchange);
		pending.resolve({
			accessKeyId: 'old',
			secretAccessKey: 'SK',
			expiration: replacement.expiration,
		});
		await first;
		expect(await cache.get('session', exchange)).toEqual(replacement);
		expect(exchange).toHaveBeenCalledOnce();
	});

	it('isolates sessions and evicts an explicitly invalidated entry', async () => {
		const { cache, exchange } = fixture();
		const first = await cache.get('one', exchange);
		const second = await cache.get('two', exchange);
		expect(second.accessKeyId).not.toBe(first.accessKeyId);
		cache.delete('one');
		expect(await cache.get('two', exchange)).toEqual(second);
		expect((await cache.get('one', exchange)).accessKeyId).toBe('AK3');
	});
});

describe('wifCredentialCacheFor', () => {
	it('shares one cache per WIF config', () => {
		const a = makeTestWif();
		expect(wifCredentialCacheFor(a)).toBe(wifCredentialCacheFor(a));
		expect(wifCredentialCacheFor(makeTestWif())).not.toBe(wifCredentialCacheFor(a));
	});
});
