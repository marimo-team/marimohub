import type { Bucket, BucketObject, BucketPutOptions } from '../../ports/bucket';
import { sleep } from '../../duration';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../errors';
import { logOperationalError } from '../../operationalLog';
import { readStoredJson } from '../../schema';

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
	/** Run when a conditional write through `CasWriter` loses the race. */
	onConflict?: (attempt: number, error: PreconditionFailedError) => void;
	/** Run once when all attempts are exhausted, before throwing `ConflictError`. */
	onExhausted?: (error: PreconditionFailedError | undefined) => void;
}

type CasPutOptions = Omit<BucketPutOptions, 'onlyIfEtagMatches' | 'onlyIfNotExists'> &
	(
		| { onlyIfEtagMatches: string; onlyIfNotExists?: never }
		| { onlyIfEtagMatches?: never; onlyIfNotExists: true }
	);

export interface CasWriter {
	put(key: string, value: string | Uint8Array, options: CasPutOptions): Promise<BucketObject>;
}

class CasWriteConflictError extends Error {
	constructor(readonly precondition: PreconditionFailedError) {
		super(precondition.message, { cause: precondition });
		this.name = 'CasWriteConflictError';
	}
}

const casWriterFor = (bucket: Bucket): CasWriter => ({
	async put(key, value, options) {
		try {
			return await bucket.put(key, value, options);
		} catch (err) {
			if (err instanceof PreconditionFailedError) throw new CasWriteConflictError(err);
			throw err;
		}
	},
});

/**
 * Retry conditional writes made through `CasWriter` with backoff. Errors thrown
 * directly by the attempt propagate, including client-facing precondition errors.
 */
export async function withCasRetry<T>(
	bucket: Bucket,
	attempt: (writer: CasWriter) => Promise<T>,
	options: CasRetryOptions = {},
): Promise<T> {
	const {
		retries = DEFAULT_RETRIES,
		backoffMs = DEFAULT_BACKOFF,
		onAttempt,
		onConflict,
		onExhausted,
	} = options;
	const writer = casWriterFor(bucket);
	let lastConflict: PreconditionFailedError | undefined;
	for (let i = 0; i < retries; i++) {
		onAttempt?.(i);
		try {
			return await attempt(writer);
		} catch (err) {
			if (err instanceof CasWriteConflictError) {
				lastConflict = err.precondition;
				onConflict?.(i, err.precondition);
				await sleep(backoffMs(i));
				continue;
			}
			throw err;
		}
	}
	onExhausted?.(lastConflict);
	throw new ConflictError('Write conflict: max retries exceeded', { cause: lastConflict });
}

export interface SingletonClaimConfig {
	bucket: Bucket;
	/** The one object anchoring the singleton (e.g. `_system/apps/{pid}/{nid}.json`). */
	key: string;
	/** Serialize a holder id into the stored claim body; `null` writes the free marker. */
	serialize: (holder: string | null) => string;
	/** Extract the holder id from a stored claim (`null` = released); throw on a corrupt body. */
	parseHolder: (raw: unknown) => string | null;
	/**
	 * Whether a holder still owns the claim. A claim whose holder is not live is
	 * stale and gets replaced — the self-healing that makes a leaked claim (crash
	 * between claim and release) harmless.
	 */
	isHolderLive: (holder: string) => Promise<boolean>;
	/**
	 * Observe a release that failed for a reason OTHER than losing the CAS race
	 * (bucket outage, corrupt claim body). The release still swallows it — every
	 * caller is unguarded and a leaked claim self-heals on the next acquire — so
	 * this hook is the only signal that it happened.
	 */
	onReleaseError?: (err: unknown) => void;
	retry?: CasRetryOptions;
}

/**
 * Acquire a single-holder claim over one bucket object: create-if-absent when
 * the key is absent (exactly one concurrent acquirer wins), replace via ETag CAS
 * when the standing claim is released, stale, or corrupt, no-op when `holder`
 * already owns it. Returns `{ acquired: false, holder }` when someone live holds it.
 */
export async function acquireSingletonClaim(
	cfg: SingletonClaimConfig,
	holder: string,
): Promise<{ acquired: boolean; holder: string }> {
	const body = cfg.serialize(holder);
	return withCasRetry(
		cfg.bucket,
		async (cas) => {
			const existing = await cfg.bucket.get(cfg.key);
			if (!existing) {
				await cas.put(cfg.key, body, { onlyIfNotExists: true });
				return { acquired: true, holder };
			}
			let current: string | null | undefined;
			try {
				current = cfg.parseHolder(await readStoredJson(existing, cfg.key));
			} catch (err) {
				logOperationalError(
					'corrupt_singleton_claim_replaced',
					{ operation: 'singleton_claim.acquire', object: cfg.key },
					err,
				);
				// Corrupt claim — stale by definition; replaced below.
			}
			if (current === holder) return { acquired: true, holder };
			if (current && (await cfg.isHolderLive(current))) {
				return { acquired: false, holder: current };
			}
			// CAS the replacement so two concurrent stale-claim replacers can't both win.
			await cas.put(cfg.key, body, { onlyIfEtagMatches: existing.etag });
			return { acquired: true, holder };
		},
		cfg.retry,
	);
}

/**
 * Release a claim held by `holder`; a no-op when someone else holds it. CAS'd to
 * the free marker rather than deleted — the bucket port has no conditional
 * delete, so a read-then-delete would drop a claim a new holder acquired in that
 * window, handing the singleton to a third acquirer while that holder runs. The
 * cost is a pointer outliving the app; deleting the notebook or project reaps it.
 */
export async function releaseSingletonClaim(
	cfg: Pick<
		SingletonClaimConfig,
		'bucket' | 'key' | 'serialize' | 'parseHolder' | 'onReleaseError'
	>,
	holder: string,
): Promise<void> {
	try {
		const existing = await cfg.bucket.get(cfg.key);
		if (!existing) return;
		if (cfg.parseHolder(await readStoredJson(existing, cfg.key)) !== holder) return;
		await cfg.bucket.put(cfg.key, cfg.serialize(null), { onlyIfEtagMatches: existing.etag });
	} catch (err) {
		// A losing CAS means someone re-acquired underneath us — exactly the claim
		// this release must not touch. Anything else (bucket read failure, corrupt
		// body) is a real failure, still swallowed so an unguarded caller's stop or
		// reconciliation pass survives it, but never silently.
		if (err instanceof PreconditionFailedError) return;
		if (cfg.onReleaseError) cfg.onReleaseError(err);
		else {
			logOperationalError(
				'singleton_claim_release_failed',
				{ operation: 'singleton_claim.release', object: cfg.key },
				err,
			);
		}
	}
}

export interface ObjectMutationOutcome<T> {
	value: T;
	written: boolean;
}

/** Use when a caller must distinguish a committed write from an unchanged value. */
export async function mutateObjectWithOutcome<T>(
	bucket: Bucket,
	key: string,
	parse: (raw: unknown) => T,
	apply: (current: T) => T | null,
	options: CasRetryOptions & { notFound?: () => Error } = {},
): Promise<ObjectMutationOutcome<T>> {
	return withCasRetry(
		bucket,
		async (cas) => {
			const obj = await bucket.get(key);
			if (!obj) throw options.notFound?.() ?? new NotFoundError(`Object ${key} not found`);
			const current = parse(await readStoredJson(obj, key));
			const next = apply(current);
			if (next === null) return { value: current, written: false };
			await cas.put(key, JSON.stringify(next), { onlyIfEtagMatches: obj.etag });
			return { value: next, written: true };
		},
		options,
	);
}

/**
 * Atomic read-modify-write of one JSON object. On a losing race, `apply` re-runs
 * against the fresh value and the committed or unchanged value is returned.
 */
export async function mutateObject<T>(
	bucket: Bucket,
	key: string,
	parse: (raw: unknown) => T,
	apply: (current: T) => T | null,
	options: CasRetryOptions & { notFound?: () => Error } = {},
): Promise<T> {
	return (await mutateObjectWithOutcome(bucket, key, parse, apply, options)).value;
}
