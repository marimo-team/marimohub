import type { MeterProvider } from '@opentelemetry/api';
import { metrics as metricsApi } from '@opentelemetry/api';
import type { Metrics, MetricTags } from '@marimo-hub/core';

const MAX_SERIES_PER_KIND = 2048;

function instrumentCache<T>(create: (name: string) => T): (name: string) => T {
	const instruments = new Map<string, T>();
	return (name) => {
		let instrument = instruments.get(name);
		if (instrument === undefined) {
			instrument = create(name);
			instruments.set(name, instrument);
		}
		return instrument;
	};
}

function seriesKey(name: string, tags?: MetricTags): string {
	const entries = Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b));
	return entries.length > 0 ? `${name}${JSON.stringify(Object.fromEntries(entries))}` : name;
}

/** Cumulative counters, histogram summaries, and latest gauges, keyed by labels. */
export class WideEventMetrics implements Metrics {
	private droppedSamples = 0;
	private counters = new Map<string, number>();
	private gauges = new Map<string, number>();
	private histograms = new Map<string, { count: number; sum: number; max: number }>();

	increment(name: string, value = 1, tags?: MetricTags): void {
		const key = this.key(name, tags, this.counters);
		if (key === undefined) return;
		this.counters.set(key, (this.counters.get(key) ?? 0) + value);
	}

	gauge(name: string, value: number, tags?: MetricTags): void {
		const key = this.key(name, tags, this.gauges);
		if (key === undefined) return;
		this.gauges.set(key, value);
	}

	histogram(name: string, value: number, tags?: MetricTags): void {
		const key = this.key(name, tags, this.histograms);
		if (key === undefined) return;
		const current = this.histograms.get(key);
		this.histograms.set(key, {
			count: (current?.count ?? 0) + 1,
			sum: (current?.sum ?? 0) + value,
			max: Math.max(current?.max ?? Number.NEGATIVE_INFINITY, value),
		});
	}

	private key(
		name: string,
		tags: MetricTags | undefined,
		series: ReadonlyMap<string, unknown>,
	): string | undefined {
		const key = seriesKey(name, tags);
		// Object-ID labels must not cause unbounded growth in memory or log size.
		if (series.has(key) || series.size < MAX_SERIES_PER_KIND) return key;
		this.droppedSamples++;
		return undefined;
	}

	collect(): Record<string, number> {
		const out: Record<string, number> = {};
		if (this.droppedSamples > 0) out['counter.metrics.dropped_samples'] = this.droppedSamples;
		for (const [k, v] of this.counters) out[`counter.${k}`] = v;
		for (const [k, v] of this.gauges) out[`gauge.${k}`] = v;
		for (const [k, v] of this.histograms) {
			out[`histogram.${k}.count`] = v.count;
			out[`histogram.${k}.sum`] = v.sum;
			out[`histogram.${k}.max`] = v.max;
		}
		return out;
	}
}

/**
 * Construct after startOtel(). A meter created before provider registration remains a no-op.
 */
export class OtelMetrics implements Metrics {
	private readonly meter;
	private readonly counters = instrumentCache((name) => this.meter.createCounter(name));
	private readonly gauges = instrumentCache((name) => this.meter.createGauge(name));
	private readonly histograms = instrumentCache((name) => this.meter.createHistogram(name));

	constructor(provider: MeterProvider = metricsApi.getMeterProvider()) {
		this.meter = provider.getMeter('@marimo-hub/server');
	}

	increment(name: string, value = 1, tags?: MetricTags): void {
		this.counters(name).add(value, tags);
	}

	gauge(name: string, value: number, tags?: MetricTags): void {
		this.gauges(name).record(value, tags);
	}

	histogram(name: string, value: number, tags?: MetricTags): void {
		this.histograms(name).record(value, tags);
	}
}

export function fanoutMetrics(...targets: Metrics[]): Metrics {
	const fanout: Metrics = {
		increment(name, value, tags) {
			for (const t of targets) t.increment(name, value, tags);
		},
		gauge(name, value, tags) {
			for (const t of targets) t.gauge(name, value, tags);
		},
	};

	if (targets.some((target) => target.histogram !== undefined)) {
		fanout.histogram = (name, value, tags) => {
			for (const t of targets) t.histogram?.(name, value, tags);
		};
	}

	return fanout;
}
