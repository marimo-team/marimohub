import { BoundedLruMap, UnavailableError } from '@marimo-hub/core';
import type { TempS3Creds } from '@marimo-hub/core';
import type { WifConfig } from './context';

const REFRESH_MARGIN_MS = 20 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

type DatedCreds = TempS3Creds & { expiration: string };

interface CacheEntry {
	creds: Promise<TempS3Creds>;
	reuseUntil: number;
}

export class WifCredentialCache {
	private readonly entries: BoundedLruMap<string, CacheEntry>;

	constructor(
		private readonly now: () => number = () => Date.now(),
		maxEntries = DEFAULT_MAX_ENTRIES,
	) {
		this.entries = new BoundedLruMap(maxEntries);
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	get(key: string, exchange: () => Promise<TempS3Creds>): Promise<DatedCreds> {
		return this.load(key, exchange) as Promise<DatedCreds>;
	}

	getShared(key: string, exchange: () => Promise<TempS3Creds>): Promise<TempS3Creds> {
		return this.load(`shared\0${key}`, exchange, 45 * 60_000);
	}

	private load(
		key: string,
		exchange: () => Promise<TempS3Creds>,
		minimumLifetimeMs?: number,
	): Promise<TempS3Creds> {
		const hit = this.entries.get(key);
		if (hit && hit.reuseUntil > this.now()) return hit.creds;
		const entry: CacheEntry = {
			// Pending exchanges coalesce even if the broker is slow.
			reuseUntil: Infinity,
			creds: Promise.resolve()
				.then(exchange)
				.then((creds) => {
					const expiresAt = Date.parse(creds.expiration ?? '');
					const remaining = expiresAt - this.now();
					// Static delivery accepts undated credentials, but they cannot be reused.
					if (minimumLifetimeMs !== undefined && creds.expiration === undefined) {
						if (this.entries.peek(key) === entry) this.entries.delete(key);
						return { ...creds };
					}
					if (!Number.isFinite(expiresAt) || remaining <= 0) {
						throw new UnavailableError('WIF credentials require a valid future expiration');
					}
					// Session endpoints can refresh short-lived credentials; shared starts need the full margin.
					const margin = minimumLifetimeMs ?? Math.min(REFRESH_MARGIN_MS, remaining / 2);
					entry.reuseUntil = expiresAt - margin;
					return { ...creds, expiration: new Date(expiresAt).toISOString() };
				}),
		};
		entry.creds.catch(() => {
			if (this.entries.peek(key) === entry) this.entries.delete(key);
		});
		this.entries.set(key, entry);
		return entry.creds;
	}
}

// Keyed by the config object so every createApi() over the same deps (and the
// session launch path that primes it) shares one cache.
const caches = new WeakMap<WifConfig, WifCredentialCache>();

export function wifCredentialCacheFor(wif: WifConfig): WifCredentialCache {
	let cache = caches.get(wif);
	if (!cache) {
		cache = new WifCredentialCache();
		caches.set(wif, cache);
	}
	return cache;
}
