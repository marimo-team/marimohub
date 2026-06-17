/** Wall-clock durations in milliseconds, keyed by phase name. */
export type Timings = Record<string, number>;

/**
 * A timing span that records its elapsed ms when disposed — use with `using` so a
 * phase is timed for its whole scope and recorded on exit, even if the body throws:
 *
 * ```ts
 * using _ = stopwatch.span('reachable');
 * await sandbox.exec('true'); // → stopwatch.timings.reachable
 * ```
 */
export interface Span extends Disposable {
	/** Stop and return elapsed ms. Idempotent; also runs on `using` scope exit. */
	stop(): number;
}

/** Accumulates named phase durations into `timings`, for one-line observability. */
export class Stopwatch {
	readonly timings: Timings = {};

	/** `now` defaults to `Date.now`; inject a clock in tests. */
	constructor(private readonly now: () => number = Date.now) {}

	/** Start a span; stop it with `using` (preferred) or `span.stop()`. */
	span(name: string): Span {
		const start = this.now();
		let elapsed: number | undefined;
		const stop = (): number => {
			if (elapsed === undefined) {
				elapsed = this.now() - start;
				this.timings[name] = elapsed;
			}
			return elapsed;
		};
		return { stop, [Symbol.dispose]: stop };
	}

	/** Time an async op into `name`, recording even if it rejects. */
	async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
		using _span = this.span(name);
		return await fn();
	}
}
