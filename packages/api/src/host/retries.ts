import { ConflictError, sleep } from '@marimo-hub/core';
import type { HostRetryReply, HostRetryStore } from '@marimo-hub/core';
import { HostProblemError } from './protocol';

async function storage<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ConflictError) throw error;
		throw HostProblemError.unavailable('Host retry storage is unavailable');
	}
}

const MAX_REQUESTS = 10_000;
export type HostMutationReply = HostRetryReply;
export interface HostRetryAttempt {
	readonly sessionId?: string;
	bindSession(sessionId: string): Promise<void>;
	dispatch(): Promise<void>;
}

export class HostRetries {
	private readonly pending = new Map<
		string,
		{ fingerprint: string; result: Promise<HostMutationReply> }
	>();

	constructor(private readonly store: HostRetryStore) {}

	execute(
		scope: string,
		key: string,
		fingerprint: string,
		work: (attempt: HostRetryAttempt) => Promise<HostMutationReply>,
		refresh = false,
		signal?: AbortSignal,
	): Promise<HostMutationReply> {
		const id = JSON.stringify([scope, key]);
		const existing = this.pending.get(id);
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				return Promise.reject(
					HostProblemError.conflict('Idempotency-Key was used for a different request'),
				);
			return existing.result;
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

	private async run(
		scope: string,
		key: string,
		fingerprint: string,
		work: (attempt: HostRetryAttempt) => Promise<HostMutationReply>,
		refresh: boolean,
		signal?: AbortSignal,
	): Promise<HostMutationReply> {
		for (let poll = 0; poll < 50; poll++) {
			const entry = await storage(() => this.store.acquire(scope, key, fingerprint, refresh));
			if (entry.kind === 'reply') return entry.reply;
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
					bindSession: (sessionId) => storage(() => this.store.dispatch(claim, sessionId)),
					dispatch: () => storage(() => this.store.dispatch(claim)),
				});
			} catch (error) {
				await storage(() => this.store.finish(claim));
				throw error;
			}
			// A failed receipt write must leave the claim pending, not release it for duplicate work.
			await storage(() => this.store.finish(claim, reply));
			return reply;
		}
		throw HostProblemError.unavailable(
			'This Idempotency-Key has an unresolved request; retry later',
		);
	}
}
