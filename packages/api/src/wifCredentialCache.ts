import { BoundedLruMap, UnavailableError, weakMemo } from '@marimo-hub/core';
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
	readonly scopeId = crypto.randomUUID();
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
		return this.load(`shared\0${key}`, exchange, true);
	}

	private load(
		key: string,
		exchange: () => Promise<TempS3Creds>,
		allowUndated = false,
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
					if (allowUndated && creds.expiration === undefined) {
						if (this.entries.peek(key) === entry) this.entries.delete(key);
						return { ...creds };
					}
					if (!Number.isFinite(expiresAt) || remaining <= 0) {
						throw new UnavailableError('WIF credentials require a valid future expiration');
					}
					const margin = Math.min(REFRESH_MARGIN_MS, remaining / 2);
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
export const wifCredentialCacheFor = weakMemo((_wif: WifConfig) => new WifCredentialCache());
