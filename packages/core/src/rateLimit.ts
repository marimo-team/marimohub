export interface SlidingWindowBudgetOptions {
	limit: number;
	windowMs: number;
	now?: () => number;
}

export interface SlidingWindowAdmission {
	refund(): void;
}

export interface SlidingWindowBudget<Key> {
	/** Consume refundable capacity at `timestamp`, or at the configured clock's current time. */
	admit(key: Key, timestamp?: number): SlidingWindowAdmission | null;
	/** Consume capacity at `timestamp`, or at the configured clock's current time when omitted. */
	consume(key: Key, timestamp?: number): boolean;
	tracked(): number;
}

interface BudgetEntry {
	timestamp: number;
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
	const recentByKey = new Map<Key, BudgetEntry[]>();
	const lastObservedByKey = new Map<Key, number>();
	let lastSweptAt: number | undefined;

	const admit = (key: Key, timestamp?: number): SlidingWindowAdmission | null => {
		const currentTime = timestamp ?? now();
		const lastObservedAt = lastObservedByKey.get(key);
		const clockRolledBack = lastObservedAt !== undefined && currentTime < lastObservedAt;
		if (clockRolledBack) {
			recentByKey.delete(key);
		}
		if (lastSweptAt === undefined || currentTime - lastSweptAt >= options.windowMs) {
			lastSweptAt = currentTime;
			for (const [trackedKey, entries] of recentByKey) {
				if (entries.every((entry) => currentTime - entry.timestamp >= options.windowMs)) {
					recentByKey.delete(trackedKey);
					lastObservedByKey.delete(trackedKey);
				}
			}
		}
		lastObservedByKey.set(key, currentTime);
		const recent = (recentByKey.get(key) ?? []).filter(
			(entry) => currentTime - entry.timestamp < options.windowMs,
		);
		if (recent.length >= options.limit) return null;
		const entry = { timestamp: currentTime };
		recent.push(entry);
		recentByKey.set(key, recent);
		let refundable = true;
		return {
			refund() {
				if (!refundable) return;
				refundable = false;
				const current = recentByKey.get(key);
				if (!current) return;
				const remaining = current.filter((candidate) => candidate !== entry);
				if (remaining.length > 0) {
					recentByKey.set(key, remaining);
				} else {
					recentByKey.delete(key);
					lastObservedByKey.delete(key);
				}
			},
		};
	};

	return {
		admit,
		consume: (key, timestamp) => admit(key, timestamp) !== null,
		tracked: () => recentByKey.size,
	};
}
