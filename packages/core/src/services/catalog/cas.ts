import type { Bucket } from '../../ports/bucket';
import { sleep } from '../../duration';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../errors';

// Compare-and-swap helpers for the object store — one tested retry loop shared by
// the catalog pointer and session records.

const DEFAULT_RETRIES = 5;
/** Exponential backoff: 50ms, 100ms, 150ms, … */
const DEFAULT_BACKOFF = (attempt: number) => 50 * (attempt + 1);

export interface CasRetryOptions {
	/** Max attempts before giving up (default 5). */
	retries?: number;
	/** Backoff before the next attempt, in ms (default `50·(n+1)`). */
	backoffMs?: (attempt: number) => number;
	/** Run at the start of each attempt (e.g. bump a metrics counter). */
	onAttempt?: (attempt: number) => void;
	/** Run when an attempt loses the race (a `PreconditionFailedError`). */
	onConflict?: (attempt: number) => void;
	/** Run once when all attempts are exhausted, before throwing `ConflictError`. */
	onExhausted?: () => void;
}

/**
 * Retry a CAS `attempt` with backoff. `attempt` throws `PreconditionFailedError` to
 * signal a losing race (retried); any other error propagates. Throws
 * `ConflictError` once retries are exhausted.
 */
export async function withCasRetry<T>(
	attempt: () => Promise<T>,
	options: CasRetryOptions = {},
): Promise<T> {
	const {
		retries = DEFAULT_RETRIES,
		backoffMs = DEFAULT_BACKOFF,
		onAttempt,
		onConflict,
		onExhausted,
	} = options;
	for (let i = 0; i < retries; i++) {
		onAttempt?.(i);
		try {
			return await attempt();
		} catch (err) {
			if (err instanceof PreconditionFailedError) {
				onConflict?.(i);
				await sleep(backoffMs(i));
				continue;
			}
			throw err;
		}
	}
	onExhausted?.();
	throw new ConflictError('Write conflict: max retries exceeded');
}

/**
 * Atomic read-modify-write of one JSON object via CAS. `apply` returns the next
 * value, or `null` to skip the write. On a losing race `apply` re-runs against the
 * fresh value (so it can no-op rather than clobber a concurrent writer).
 */
export async function mutateObject<T>(
	bucket: Bucket,
	key: string,
	parse: (raw: unknown) => T,
	apply: (current: T) => T | null,
	options: CasRetryOptions & { notFound?: () => Error } = {},
): Promise<T> {
	return withCasRetry(async () => {
		const obj = await bucket.get(key);
		if (!obj) throw options.notFound?.() ?? new NotFoundError(`Object ${key} not found`);
		const current = parse(await obj.json());
		const next = apply(current);
		if (!next) return current;
		await bucket.put(key, JSON.stringify(next), { onlyIfEtagMatches: obj.etag });
		return next;
	}, options);
}
