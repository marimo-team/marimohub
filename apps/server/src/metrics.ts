import type { Metrics } from '@marimo-hub/core';

/**
 * A `Metrics` implementation that accumulates counters and latest gauge values
 * in memory, to be emitted as a single "wide event" (canonical log line) per
 * maintenance cycle — see logging-best-practices. Counters are cumulative since
 * boot; an operator derives rates (e.g. CAS conflicts/min) from deltas between
 * lines, and reads gauges (snapshot count/size, live sessions) directly.
 *
 * Emitting one fat line per cycle — rather than a line per metric call — keeps
 * the request path quiet while still surfacing CAS contention that happens
 * there: those increments land in the same totals and show up at the next flush.
 */
export class WideEventMetrics implements Metrics {
	private counters = new Map<string, number>();
	private gauges = new Map<string, number>();

	increment(name: string, value = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + value);
	}

	gauge(name: string, value: number): void {
		this.gauges.set(name, value);
	}

	/** Snapshot current totals + latest gauges as flat fields for a wide event. */
	collect(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [k, v] of this.counters) out[`counter.${k}`] = v;
		for (const [k, v] of this.gauges) out[`gauge.${k}`] = v;
		return out;
	}
}
