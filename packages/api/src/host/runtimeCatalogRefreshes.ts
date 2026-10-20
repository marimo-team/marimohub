import { withAbortSignal } from '@marimo-hub/core';

export class RuntimeCatalogRefreshes {
	private readonly entries = new Map<string, { expires: number; result: Promise<void> }>();

	refresh(
		sessionId: string,
		work: (signal: AbortSignal) => Promise<void>,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		for (const [id, entry] of this.entries) {
			if (entry.expires <= Date.now()) this.entries.delete(id);
		}
		let entry = this.entries.get(sessionId);
		if (!entry) {
			const pending = { expires: Infinity, result: Promise.resolve() };
			// A disconnected subscriber must not cancel another subscriber's shared refresh.
			pending.result = Promise.resolve()
				.then(() => work(AbortSignal.timeout(35_000)))
				.catch((error: unknown) => {
					this.entries.delete(sessionId);
					throw error;
				})
				.finally(() => {
					pending.expires = Date.now() + 5_000;
				});
			this.entries.set(sessionId, pending);
			entry = pending;
		}
		return withAbortSignal(entry.result, signal);
	}
}
