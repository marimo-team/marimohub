import { HostProblemError } from './protocol';

const RETRY_WINDOW_MS = 5 * 60_000;
const MAX_REQUESTS = 10_000;
export type HostMutationReply = { status: number; body: unknown };
export interface HostRetryAttempt {
	readonly sessionId?: string;
	bindSession(sessionId: string): void;
}
interface Entry {
	fingerprint: string;
	expires: number;
	result: Promise<HostMutationReply>;
	sessionId?: string;
	settled: boolean;
}

export class HostRetries {
	private entries = new Map<string, Entry>();

	async execute(
		scope: string,
		key: string,
		fingerprint: string,
		work: (attempt: HostRetryAttempt) => Promise<HostMutationReply>,
		refresh = false,
	): Promise<HostMutationReply> {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (entry.settled && entry.expires <= now) this.entries.delete(id);
		}
		const id = JSON.stringify([scope, key]);
		const existing = this.entries.get(id);
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw HostProblemError.conflict('Idempotency-Key was used for a different request');
			if (!refresh || !existing.settled) return existing.result;
			return this.run(id, existing, work);
		}
		if (this.entries.size >= MAX_REQUESTS)
			throw HostProblemError.unavailable('The host retry window is full; retry later');
		const entry: Entry = {
			fingerprint,
			expires: Infinity,
			result: Promise.resolve().then(() => this.run(id, entry, work)),
			settled: false,
		};
		this.entries.set(id, entry);
		return entry.result;
	}

	private run(
		id: string,
		entry: Entry,
		work: (attempt: HostRetryAttempt) => Promise<HostMutationReply>,
	): Promise<HostMutationReply> {
		entry.settled = false;
		entry.result = Promise.resolve()
			.then(() =>
				work({
					sessionId: entry.sessionId,
					bindSession(sessionId) {
						if (entry.sessionId && entry.sessionId !== sessionId)
							throw HostProblemError.conflict('The request is bound to another runtime');
						// A lost reply cannot prove that the runtime did not execute the run.
						entry.sessionId = sessionId;
					},
				}),
			)
			.then((result) => {
				if (result.status >= 400 && !entry.sessionId) this.entries.delete(id);
				return result;
			})
			.catch((error: unknown) => {
				if (!entry.sessionId) this.entries.delete(id);
				throw error;
			})
			.finally(() => {
				entry.settled = true;
				if (entry.expires === Infinity) entry.expires = Date.now() + RETRY_WINDOW_MS;
			});
		return entry.result;
	}
}
