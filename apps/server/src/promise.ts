export type SettleWithinResult = 'settled' | 'timed-out';

export async function settleAllWithin(
	promises: Iterable<PromiseLike<unknown>>,
	timeoutMs: number,
): Promise<SettleWithinResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'timed-out'>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), timeoutMs);
	});
	const settled = Promise.allSettled(promises).then(() => 'settled' as const);

	try {
		return await Promise.race([settled, timedOut]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
