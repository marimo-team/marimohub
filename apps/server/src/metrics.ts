import type { Counter, Gauge, MeterProvider } from '@opentelemetry/api';
import { metrics as metricsApi } from '@opentelemetry/api';
import type { Metrics, MetricTags } from '@marimo-hub/core';

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

/**
 * Bridges the `Metrics` port to OpenTelemetry instruments, so the domain
 * signals export alongside the HTTP RED metrics. Construct only after
 * `startOtel()`: unlike traces, the metrics API has no late-registration proxy,
 * so a meter resolved before the provider registers stays a no-op forever.
 */
export class OtelMetrics implements Metrics {
	private readonly meter;
	private readonly counters = new Map<string, Counter>();
	private readonly gauges = new Map<string, Gauge>();

	constructor(provider: MeterProvider = metricsApi.getMeterProvider()) {
		this.meter = provider.getMeter('@marimo-hub/server');
	}

	increment(name: string, value = 1, tags?: MetricTags): void {
		let counter = this.counters.get(name);
		if (!counter) {
			counter = this.meter.createCounter(name);
			this.counters.set(name, counter);
		}
		counter.add(value, tags);
	}

	gauge(name: string, value: number, tags?: MetricTags): void {
		let gauge = this.gauges.get(name);
		if (!gauge) {
			gauge = this.meter.createGauge(name);
			this.gauges.set(name, gauge);
		}
		gauge.record(value, tags);
	}
}

/** Emit every signal to all targets (e.g. wide-event flush + OTEL export). */
export function fanoutMetrics(...targets: Metrics[]): Metrics {
	return {
		increment(name, value, tags) {
			for (const t of targets) t.increment(name, value, tags);
		},
		gauge(name, value, tags) {
			for (const t of targets) t.gauge(name, value, tags);
		},
	};
}
