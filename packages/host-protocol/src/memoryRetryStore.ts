import { HostProblemError } from './protocol';
import { HOST_CLAIM_LEASE_MS, HOST_RETRY_REFRESH_MS, HOST_RETRY_WINDOW_MS } from './retryStore';
import type {
	HostRetryAcquisition,
	HostRetryClaim,
	HostRetryReply,
	HostRetryStore,
} from './retryStore';

export { HOST_CLAIM_LEASE_MS, HOST_RETRY_REFRESH_MS, HOST_RETRY_WINDOW_MS };

interface Record {
	fingerprint: string;
	owner?: string;
	claimedAt: number;
	sessionId?: string;
	dispatched: boolean;
	expires?: number;
	reply?: HostRetryReply;
}

/** The retry contract for a single process; shared storage is needed across host instances. */
export class MemoryHostRetryStore implements HostRetryStore {
	private readonly records = new Map<string, Record>();

	async acquire(
		scope: string,
		key: string,
		fingerprint: string,
		refresh: boolean,
	): Promise<HostRetryAcquisition> {
		const now = Date.now();
		this.sweep(now);
		const id = JSON.stringify([scope, key]);
		const previous = this.records.get(id);
		const held = !!previous?.owner && !expiredLease(previous, now);
		const retained = !!previous && (previous.expires ?? 0) > now;
		if (previous && (held || retained) && previous.fingerprint !== fingerprint)
			throw HostProblemError.conflict('Idempotency-Key was used for a different request');
		if (held) return { kind: 'pending' };
		if (previous && retained && previous.reply) {
			const age = HOST_RETRY_WINDOW_MS - ((previous.expires ?? 0) - now);
			if (!refresh || age >= HOST_RETRY_REFRESH_MS) return { kind: 'reply', reply: previous.reply };
		}
		const owner = crypto.randomUUID();
		const record: Record = {
			fingerprint,
			owner,
			claimedAt: now,
			dispatched: false,
			...(previous && retained ? { sessionId: previous.sessionId, expires: previous.expires } : {}),
		};
		this.records.set(id, record);
		return { kind: 'claimed', claim: { key: id, owner, sessionId: record.sessionId } };
	}

	async dispatch(claim: HostRetryClaim, sessionId?: string): Promise<void> {
		const record = this.owned(claim);
		if (record.sessionId && sessionId !== record.sessionId)
			throw HostProblemError.conflict('The request is bound to another runtime');
		this.records.set(claim.key, { ...record, dispatched: true, sessionId });
		claim.sessionId = sessionId;
	}

	async finish(claim: HostRetryClaim, reply?: HostRetryReply): Promise<void> {
		const record = this.owned(claim);
		// An unacknowledged mutation cannot be safely re-executed after a crash or lost reply.
		if (!reply && record.dispatched && !record.sessionId) return;
		const keep = record.sessionId || (reply && reply.status < 400);
		this.records.set(claim.key, {
			...record,
			owner: undefined,
			expires: keep ? (record.expires ?? Date.now() + HOST_RETRY_WINDOW_MS) : 0,
			reply: reply && reply.status < 400 ? reply : undefined,
		});
	}

	private owned(claim: HostRetryClaim): Record {
		const record = this.records.get(claim.key);
		if (!record || record.owner !== claim.owner)
			throw HostProblemError.unavailable('Host retry claim is no longer owned by this request');
		return record;
	}

	/** Settled records past their window hold nothing a retry could use. */
	private sweep(now: number) {
		for (const [id, record] of this.records) {
			if (!record.owner && (record.expires ?? 0) <= now) this.records.delete(id);
		}
	}
}

function expiredLease(record: Record, now: number): boolean {
	return !record.dispatched && record.claimedAt + HOST_CLAIM_LEASE_MS <= now;
}
