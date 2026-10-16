import { UnavailableError } from '@marimo-hub/core';
import type { TempS3Creds } from '@marimo-hub/core';

const REFRESH_MARGIN_MS = 20 * 60_000;

type DatedCreds = TempS3Creds & { expiration: string };

interface CacheEntry {
	creds: Promise<DatedCreds>;
	reuseUntil: number;
}

export class WifCredentialCache {
	private readonly entries = new Map<string, CacheEntry>();

	constructor(private readonly now: () => number = () => Date.now()) {}

	delete(key: string): void {
		this.entries.delete(key);
	}

	get(key: string, exchange: () => Promise<TempS3Creds>): Promise<DatedCreds> {
		const now = this.now();
		const hit = this.entries.get(key);
		if (hit && hit.reuseUntil > now) return hit.creds;
		for (const [id, entry] of this.entries) {
			if (entry.reuseUntil <= now) this.entries.delete(id);
		}
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
			if (this.entries.get(key) === entry) this.entries.delete(key);
		});
		this.entries.set(key, entry);
		return entry.creds;
	}
}
