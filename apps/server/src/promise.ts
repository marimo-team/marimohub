import { withDeadline } from '@marimo-hub/core';

export type SettleWithinResult = 'settled' | 'timed-out';

class SettleWithinTimeoutError extends Error {
	readonly name = 'SettleWithinTimeoutError';
}

export function onceAsync<T>(work: () => T | Promise<T>): () => Promise<T> {
	let result: Promise<T> | undefined;
	// Cache rejection too: forced cleanup must not repeat a failed operation.
	return () => (result ??= Promise.resolve().then(work));
}

export async function settleAllWithin(
	promises: Iterable<PromiseLike<unknown>>,
	timeoutMs: number,
): Promise<SettleWithinResult> {
	return withDeadline(
		Promise.allSettled(promises).then(() => 'settled' as const),
		{
			timeoutMs,
			timeoutError: () => new SettleWithinTimeoutError(),
		},
	).catch((error): SettleWithinResult => {
		if (error instanceof SettleWithinTimeoutError) return 'timed-out';
		throw error;
	});
}
