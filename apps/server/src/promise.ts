import { withDeadline } from '@marimo-hub/core';

export type SettleWithinResult = 'settled' | 'timed-out';

class SettleWithinTimeoutError extends Error {
	readonly name = 'SettleWithinTimeoutError';
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
