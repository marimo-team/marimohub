import { HostProblemError } from './protocol';
import { decideHostRetryAcquire, settleHostRetryClaim } from './retryStore';
import type {
	HostRetryAcquisition,
	HostRetryClaim,
	HostRetryRecord,
	HostRetryReply,
	HostRetryStore,
} from './retryStore';

/** The retry contract for a single process; shared storage is needed across host instances. */
export class MemoryHostRetryStore implements HostRetryStore {
	private readonly records = new Map<string, HostRetryRecord>();

	async acquire(
		scope: string,
		key: string,
		fingerprint: string,
		refresh: boolean,
	): Promise<HostRetryAcquisition> {
		const now = Date.now();
		this.sweep(now);
		const id = JSON.stringify([scope, key]);
		const owner = crypto.randomUUID();
		const previous = this.records.get(id) ?? null;
		const decision = decideHostRetryAcquire(previous, fingerprint, refresh, owner, now);
		if (decision.kind === 'conflict')
			throw HostProblemError.conflict('Idempotency-Key was used for a different request');
		if (decision.kind !== 'claim') return decision;
		this.records.set(id, decision.record);
		return { kind: 'claimed', claim: { key: id, owner, sessionId: decision.record.sessionId } };
	}

	async dispatch(claim: HostRetryClaim, sessionId?: string): Promise<void> {
		const record = this.owned(claim);
		if (record.sessionId && sessionId !== record.sessionId)
			throw HostProblemError.conflict('The request is bound to another runtime');
		this.records.set(claim.key, { ...record, dispatched: true, sessionId });
		claim.sessionId = sessionId;
	}

	async finish(claim: HostRetryClaim, reply?: HostRetryReply): Promise<void> {
		this.records.set(claim.key, settleHostRetryClaim(this.owned(claim), reply, Date.now()));
	}

	private owned(claim: HostRetryClaim): HostRetryRecord {
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
