import { sleep, withAbortSignal } from './async';
import { errorResponse, HostProblemError } from './protocol';
import type { ErrorResponder } from './protocol';
import type { HostRetryReply, HostRetryStore } from './retryStore';

export type {
	HostRetryAcquisition,
	HostRetryClaim,
	HostRetryReply,
	HostRetryStore,
} from './retryStore';

const MAX_REQUESTS = 10_000;
export type HostMutationReply = HostRetryReply;
export interface HostMutationResult extends HostMutationReply {
	/** The reply came from a stored receipt rather than from this request's work. */
	replayed: boolean;
}
export interface HostRetryAttempt {
	readonly sessionId?: string;
	bindSession(sessionId: string): Promise<void>;
	dispatch(): Promise<void>;
}

export class HostRetries {
	private readonly pending = new Map<
		string,
		{ fingerprint: string; result: Promise<HostMutationResult> }
	>();

	constructor(
		private readonly store: HostRetryStore,
		private readonly toResponse: ErrorResponder = (error) => errorResponse(error),
	) {}

	execute(
		scope: string,
		key: string,
		fingerprint: string,
		work: (attempt: HostRetryAttempt) => Promise<HostMutationReply>,
		refresh = false,
		signal?: AbortSignal,
	): Promise<HostMutationResult> {
		const id = JSON.stringify([scope, key]);
		const existing = this.pending.get(id);
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				return Promise.reject(
					HostProblemError.conflict('Idempotency-Key was used for a different request'),
				);
			return withAbortSignal(existing.result, signal);
		}
		if (this.pending.size >= MAX_REQUESTS)
			return Promise.reject(
				HostProblemError.unavailable('The host retry window is full; retry later'),
			);
		const result = this.run(scope, key, fingerprint, work, refresh, signal).finally(() =>
			this.pending.delete(id),
		);
		this.pending.set(id, { fingerprint, result });
		return result;
	}

	private async storage<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			if (this.toResponse(error).status === 409) throw error;
			throw HostProblemError.unavailable('Host retry storage is unavailable');
		}
	}

	private async run(
		scope: string,
		key: string,
		fingerprint: string,
		work: (attempt: HostRetryAttempt) => Promise<HostMutationReply>,
		refresh: boolean,
		signal?: AbortSignal,
	): Promise<HostMutationResult> {
		for (let poll = 0; poll < 50; poll++) {
			signal?.throwIfAborted();
			const entry = await this.storage(() => this.store.acquire(scope, key, fingerprint, refresh));
			if (entry.kind === 'reply') return { ...entry.reply, replayed: true };
			if (entry.kind === 'pending') {
				await sleep(100, signal);
				continue;
			}
			const { claim } = entry;
			let reply: HostMutationReply;
			try {
				signal?.throwIfAborted();
				reply = await work({
					get sessionId() {
						return claim.sessionId;
					},
					bindSession: (sessionId) => this.storage(() => this.store.dispatch(claim, sessionId)),
					dispatch: () => this.storage(() => this.store.dispatch(claim)),
				});
			} catch (error) {
				// A definitive rejection proves nothing was mutated, so the key is free again. Only an
				// unknown outcome keeps a dispatched claim pending.
				const response = this.toResponse(error);
				if (response.status >= 500) {
					await this.storage(() => this.store.finish(claim));
					throw error;
				}
				reply = { status: response.status, body: await response.json() };
			}
			// A failed receipt write must leave the claim pending, not release it for duplicate work.
			await this.storage(() => this.store.finish(claim, reply));
			return { ...reply, replayed: false };
		}
		throw HostProblemError.unavailable(
			'This Idempotency-Key has an unresolved request; retry later',
		);
	}
}
