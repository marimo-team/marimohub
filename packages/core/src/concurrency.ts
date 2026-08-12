import { assertPositiveInteger } from './internal/validation';

/**
 * Counting semaphore that gates async work to at most `permits` in-flight
 * tasks. Waiters are released in FIFO order.
 */
export class Semaphore {
	private readonly maxPermits: number;
	private permits: number;
	private waiters: (() => void)[] = [];

	constructor(permits: number) {
		if (!Number.isInteger(permits) || permits < 1) {
			throw new Error(`Semaphore permits must be a positive integer, got ${permits}`);
		}
		this.maxPermits = permits;
		this.permits = permits;
	}

	/** Permits currently available. */
	get available(): number {
		return this.permits;
	}

	/** Number of waiters queued for a permit. */
	get pending(): number {
		return this.waiters.length;
	}

	acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits--;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
			return;
		}
		if (this.permits >= this.maxPermits) {
			throw new Error(
				'Semaphore.release() called more times than acquire() — refusing to exceed initial permit count',
			);
		}
		this.permits++;
	}

	/** Acquire a permit, run `fn`, then release the permit. */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

/**
 * Map over `items` with bounded parallelism. Preserves input order in the
 * result. Rejects as soon as the first task rejects (like `Promise.all`);
 * already-started tasks keep running to completion in the background but
 * their results are dropped.
 */
// oxlint-disable-next-line marimo/prefer-object-params -- map-style helper, mirrors Array.prototype.map
export function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	// Validate concurrency before the empty-input fast path so misconfiguration
	// is never silently accepted.
	const sem = new Semaphore(concurrency);
	if (items.length === 0) {
		return Promise.resolve([]);
	}
	return Promise.all(items.map((item, index) => sem.run(() => fn(item, index))));
}

export class KeyedAdmission<K> {
	private active = 0;
	private readonly activeByKey = new Map<K, number>();

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxConcurrentPerKey: number,
		private readonly errors: { global: () => Error; perKey: () => Error },
	) {
		assertPositiveInteger('maxConcurrent', maxConcurrent);
		assertPositiveInteger('maxConcurrentPerKey', maxConcurrentPerKey);
	}

	async run<T>(key: K, work: () => Promise<T>): Promise<T> {
		const keyActive = this.activeByKey.get(key) ?? 0;
		if (keyActive >= this.maxConcurrentPerKey) throw this.errors.perKey();
		if (this.active >= this.maxConcurrent) throw this.errors.global();
		this.active++;
		this.activeByKey.set(key, keyActive + 1);
		try {
			return await work();
		} finally {
			this.active--;
			const remaining = (this.activeByKey.get(key) ?? 1) - 1;
			if (remaining === 0) this.activeByKey.delete(key);
			else this.activeByKey.set(key, remaining);
		}
	}
}

export class InFlightWork {
	private readonly work = new Set<Promise<unknown>>();

	async track<T>(promise: Promise<T>): Promise<T> {
		this.work.add(promise);
		try {
			return await promise;
		} finally {
			this.work.delete(promise);
		}
	}

	async drain(): Promise<void> {
		await Promise.allSettled(this.work);
	}
}
