/** How long a successful reply and a runtime binding stay replayable. */
export const HOST_RETRY_WINDOW_MS = 5 * 60_000;
// Runtimes keep their own receipts for the same window, started on a later clock. Re-dispatching
// a run after this age could reach an expired upstream receipt and execute it again.
export const HOST_RETRY_REFRESH_MS = 4 * 60_000;
/**
 * How long an undispatched claim is honoured. Nothing irreversible happens before `dispatch`,
 * so a holder that crashed before it proves no mutation started; a slow holder that dispatches
 * after the lease fails its owner check instead of writing.
 */
export const HOST_CLAIM_LEASE_MS = 5 * 60_000;
/**
 * How long a claim dispatched to a runtime is honoured. A retry after it re-dispatches to the
 * same runtime with the same upstream Idempotency-Key, which the runtime answers from its own
 * receipt. That holds only while the receipt is younger than `HOST_RETRY_REFRESH_MS`, so this
 * lease is shorter, and an older bound claim stays held like an unbound one.
 */
export const HOST_BOUND_CLAIM_LEASE_MS = 2 * 60_000;

export interface HostRetryReply {
	status: number;
	body: unknown;
}

export interface HostRetryClaim {
	/** Storage key of the record; opaque to the caller. */
	key: string;
	/** Owner token of this attempt; a later attempt invalidates it. */
	owner: string;
	/** Runtime the request was bound to by an earlier attempt, if any. */
	sessionId?: string;
}

export type HostRetryAcquisition =
	| { kind: 'claimed'; claim: HostRetryClaim }
	| { kind: 'reply'; reply: HostRetryReply }
	| { kind: 'pending' };

/**
 * Durable Idempotency-Key records shared by every host instance.
 *
 * Contract: a key's first request claims it. A later request with the same scope and key
 * sees `pending` while a claim is held, the stored `reply` after a success, or a conflict
 * (an error the platform maps to 409) when the fingerprint differs from a live record.
 * `refresh` asks to redo work whose receipt is younger than the runtime's own retry window,
 * so the runtime answers from its receipt instead of repeating the work. Receipts and
 * session bindings expire after `HOST_RETRY_WINDOW_MS`. A claim released by `finish` without
 * a reply frees the key unless it was dispatched without a session binding, because that
 * outcome is unknown. A claim that never dispatched is reclaimable after `HOST_CLAIM_LEASE_MS`,
 * and one bound to a runtime after `HOST_BOUND_CLAIM_LEASE_MS`, keeping its binding;
 * `dispatch` and `finish` must then reject the stale owner. A claim dispatched without a
 * binding never expires. Stores implement these rules with `decideHostRetryAcquire` and
 * `settleHostRetryClaim`.
 */
export interface HostRetryStore {
	acquire(
		scope: string,
		key: string,
		fingerprint: string,
		refresh: boolean,
	): Promise<HostRetryAcquisition>;
	dispatch(claim: HostRetryClaim, sessionId?: string): Promise<void>;
	finish(claim: HostRetryClaim, reply?: HostRetryReply): Promise<void>;
}

/** A store-neutral view of one key's record; each store maps its own encoding to it. */
export interface HostRetryRecord {
	fingerprint: string;
	owner?: string;
	claimedAt: number;
	sessionId?: string;
	dispatched: boolean;
	expires?: number;
	reply?: HostRetryReply;
}

export type HostRetryAcquireDecision =
	| { kind: 'conflict' }
	| { kind: 'pending' }
	| { kind: 'reply'; reply: HostRetryReply }
	| { kind: 'claim'; record: HostRetryRecord };

export function decideHostRetryAcquire(
	previous: HostRetryRecord | null,
	fingerprint: string,
	refresh: boolean,
	owner: string,
	now: number,
): HostRetryAcquireDecision {
	const lease = previous?.owner ? leaseState(previous, now) : 'free';
	const held = lease === 'held';
	const retained = !!previous && (lease === 'rebind' || (previous.expires ?? 0) > now);
	if (previous && (held || retained) && previous.fingerprint !== fingerprint)
		return { kind: 'conflict' };
	if (held) return { kind: 'pending' };
	if (
		previous?.reply &&
		retained &&
		(!refresh || receiptAge(previous, now) >= HOST_RETRY_REFRESH_MS)
	)
		return { kind: 'reply', reply: previous.reply };
	return {
		kind: 'claim',
		record: {
			fingerprint,
			owner,
			claimedAt: now,
			dispatched: false,
			...(previous && retained
				? {
						sessionId: previous.sessionId,
						// Anchoring a recovered binding to the original claim keeps a chain of crashed
						// holders from stretching it past the runtime's receipt.
						expires: previous.expires ?? previous.claimedAt + HOST_RETRY_WINDOW_MS,
					}
				: {}),
		},
	};
}

/** The record `finish` writes; returning it unchanged keeps the claim held. */
export function settleHostRetryClaim(
	record: HostRetryRecord,
	reply: HostRetryReply | undefined,
	now: number,
): HostRetryRecord {
	// An unacknowledged mutation cannot be safely re-executed after a crash or lost reply.
	if (!reply && record.dispatched && !record.sessionId) return record;
	const kept = reply && reply.status < 400 ? reply : undefined;
	// A runtime's receipt dates from dispatch, so a bound record's window starts at its claim; a
	// slow reply must not extend the age within which `refresh` re-dispatches. An unbound reply is
	// the only receipt, so it is kept for a full window after it lands.
	const anchor = record.sessionId ? record.claimedAt : now;
	return {
		...record,
		owner: undefined,
		expires: record.sessionId || kept ? (record.expires ?? anchor + HOST_RETRY_WINDOW_MS) : 0,
		reply: kept,
	};
}

function leaseState(record: HostRetryRecord, now: number): 'held' | 'rebind' | 'free' {
	if (!record.dispatched) return record.claimedAt + HOST_CLAIM_LEASE_MS <= now ? 'free' : 'held';
	if (!record.sessionId) return 'held';
	return record.claimedAt + HOST_BOUND_CLAIM_LEASE_MS <= now &&
		receiptAge(record, now) < HOST_RETRY_REFRESH_MS
		? 'rebind'
		: 'held';
}

function receiptAge(record: HostRetryRecord, now: number): number {
	return record.expires === undefined
		? now - record.claimedAt
		: HOST_RETRY_WINDOW_MS - (record.expires - now);
}
