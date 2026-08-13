import { withDeadline } from '@marimo-hub/core';

export type SettleWithinResult = 'settled' | 'timed-out';

export async function settleAllWithin(
	promises: Iterable<PromiseLike<unknown>>,
	timeoutMs: number,
): Promise<SettleWithinResult> {
	return withDeadline(
		Promise.allSettled(promises).then(() => 'settled' as const),
		{
			timeoutMs,
			timeoutError: () => new Error('timed-out'),
		},
	).catch((error): SettleWithinResult => {
		if (error instanceof Error && error.message === 'timed-out') return 'timed-out';
		throw error;
	});
}
