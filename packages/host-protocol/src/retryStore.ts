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
 * outcome is unknown. A claim that never dispatched is reclaimable after `HOST_CLAIM_LEASE_MS`;
 * `dispatch` and `finish` must then reject the stale owner.
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
