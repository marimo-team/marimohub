import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeCatalogRefreshes } from './runtimeCatalogRefreshes';

afterEach(() => vi.restoreAllMocks());

it('coalesces concurrent refreshes and limits each session to one refresh per five seconds', async () => {
	const cache = new RuntimeCatalogRefreshes();
	const signal = new AbortController().signal;
	const now = vi.spyOn(Date, 'now').mockReturnValue(0);
	let finish!: () => void;
	const work = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const first = cache.refresh('session', work, signal);
	const second = cache.refresh('session', work, signal);
	await Promise.resolve();
	expect(work).toHaveBeenCalledTimes(1);
	finish();
	await Promise.all([first, second]);
	now.mockReturnValue(4_999);
	await cache.refresh('session', work, signal);
	expect(work).toHaveBeenCalledTimes(1);
	now.mockReturnValue(5_000);
	work.mockResolvedValue();
	await cache.refresh('session', work, signal);
	await cache.refresh('other', work, signal);
	expect(work).toHaveBeenCalledTimes(3);
});

it('lets a subscriber disconnect without canceling the shared refresh', async () => {
	const cache = new RuntimeCatalogRefreshes();
	const subscriber = new AbortController();
	let finish!: () => void;
	let refreshSignal!: AbortSignal;
	const work = vi.fn((signal: AbortSignal) => {
		refreshSignal = signal;
		return new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const first = cache.refresh('session', work, subscriber.signal);
	const second = cache.refresh('session', work, new AbortController().signal);
	await Promise.resolve();
	subscriber.abort();
	await expect(first).rejects.toThrow();
	expect(refreshSignal.aborted).toBe(false);
	finish();
	await second;
	expect(work).toHaveBeenCalledTimes(1);
});

it('does not cache a failed authorization check from another subscriber', async () => {
	const cache = new RuntimeCatalogRefreshes();
	const signal = new AbortController().signal;
	const denied = vi.fn(async () => {
		throw new Error('Forbidden');
	});
	await expect(cache.refresh('session', denied, signal)).rejects.toThrow('Forbidden');
	const allowed = vi.fn(async () => {});
	await cache.refresh('session', allowed, signal);
	expect(allowed).toHaveBeenCalledTimes(1);
});
