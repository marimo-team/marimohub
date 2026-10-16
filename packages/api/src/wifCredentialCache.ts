import { BoundedLruMap, UnavailableError } from '@marimo-hub/core';
import type { TempS3Creds } from '@marimo-hub/core';
import type { WifConfig } from './context';

const REFRESH_MARGIN_MS = 20 * 60_000;
export const WIF_ELIGIBILITY_TTL_MS = 10_000;
const DEFAULT_MAX_ENTRIES = 10_000;

type DatedCreds = TempS3Creds & { expiration: string };

interface CacheEntry {
	creds: Promise<DatedCreds>;
	reuseUntil: number;
}

export class WifCredentialCache {
	private readonly entries: BoundedLruMap<string, CacheEntry>;
	private readonly eligibleUntil: BoundedLruMap<string, number>;

	constructor(
		private readonly now: () => number = () => Date.now(),
		maxEntries = DEFAULT_MAX_ENTRIES,
	) {
		this.entries = new BoundedLruMap(maxEntries);
		this.eligibleUntil = new BoundedLruMap(maxEntries);
	}

	/** Forgets both the credentials and the eligibility verdict. */
	delete(key: string): void {
		this.entries.delete(key);
		this.eligibleUntil.delete(key);
	}

	isEligible(key: string): boolean {
		const until = this.eligibleUntil.get(key);
		if (until === undefined) return false;
		if (until > this.now()) return true;
		this.eligibleUntil.delete(key);
		return false;
	}

	/** Remembers an allow verdict for at most the TTL, or until `deadline` if sooner. */
	markEligible(key: string, deadline = Infinity): void {
		this.eligibleUntil.set(key, Math.min(this.now() + WIF_ELIGIBILITY_TTL_MS, deadline));
	}

	get(key: string, exchange: () => Promise<TempS3Creds>): Promise<DatedCreds> {
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
					if (!Number.isFinite(expiresAt) || remaining <= 0) {
						throw new UnavailableError(
							'WIF endpoint delivery requires a valid future credential expiration',
						);
					}
					// A fixed margin would make short-lived credentials miss the cache immediately.
					entry.reuseUntil = expiresAt - Math.min(REFRESH_MARGIN_MS, remaining / 2);
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
