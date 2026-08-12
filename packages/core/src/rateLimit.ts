export interface SlidingWindowBudgetOptions {
	limit: number;
	windowMs: number;
	now?: () => number;
}

export interface SlidingWindowBudget<Key> {
	consume(key: Key): boolean;
	tracked(): number;
}

export function createSlidingWindowBudget<Key>(
	options: SlidingWindowBudgetOptions,
): SlidingWindowBudget<Key> {
	if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
		throw new RangeError('Sliding-window limit must be a positive integer');
	}
	if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
		throw new RangeError('Sliding-window duration must be positive');
	}
	const now = options.now ?? (() => Date.now());
	const recentByKey = new Map<Key, number[]>();
	let lastSweptAt: number | undefined;

	return {
		consume(key): boolean {
			const currentTime = now();
			if (lastSweptAt !== undefined && currentTime < lastSweptAt) {
				recentByKey.clear();
			}
			if (
				lastSweptAt === undefined ||
				currentTime < lastSweptAt ||
				currentTime - lastSweptAt >= options.windowMs
			) {
				lastSweptAt = currentTime;
				for (const [trackedKey, timestamps] of recentByKey) {
					if (timestamps.every((timestamp) => currentTime - timestamp >= options.windowMs)) {
						recentByKey.delete(trackedKey);
					}
				}
			}
			const recent = (recentByKey.get(key) ?? []).filter(
				(timestamp) => currentTime - timestamp < options.windowMs,
			);
			if (recent.length >= options.limit) return false;
			recent.push(currentTime);
			recentByKey.set(key, recent);
			return true;
		},
		tracked: () => recentByKey.size,
	};
}
