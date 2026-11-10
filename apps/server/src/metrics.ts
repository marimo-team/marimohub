import type { MeterProvider } from '@opentelemetry/api';
import { metrics as metricsApi } from '@opentelemetry/api';
import type { Metrics, MetricTags } from '@marimo-hub/core';

const MAX_SERIES_PER_METRIC = 2048;
type MetricSeries<T> = Map<string, Map<string, T>>;

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
	private counters: MetricSeries<number> = new Map();
	private gauges: MetricSeries<number> = new Map();
	private histograms: MetricSeries<{ count: number; sum: number; max: number }> = new Map();

	increment(name: string, value = 1, tags?: MetricTags): void {
		const series = this.series(name, tags, this.counters);
		if (!series) return;
		const { key, values } = series;
		values.set(key, (values.get(key) ?? 0) + value);
	}

	gauge(name: string, value: number, tags?: MetricTags): void {
		const series = this.series(name, tags, this.gauges);
		if (!series) return;
		series.values.set(series.key, value);
	}

	histogram(name: string, value: number, tags?: MetricTags): void {
		const series = this.series(name, tags, this.histograms);
		if (!series) return;
		const { key, values } = series;
		const current = values.get(key);
		values.set(key, {
			count: (current?.count ?? 0) + 1,
			sum: (current?.sum ?? 0) + value,
			max: Math.max(current?.max ?? Number.NEGATIVE_INFINITY, value),
		});
	}

	private series<T>(
		name: string,
		tags: MetricTags | undefined,
		metrics: MetricSeries<T>,
	): { key: string; values: Map<string, T> } | undefined {
		let values = metrics.get(name);
		if (!values) {
			values = new Map();
			metrics.set(name, values);
		}
		const key = seriesKey(name, tags);
		// Bound object-ID labels without suppressing unrelated metric names.
		if (values.has(key) || values.size < MAX_SERIES_PER_METRIC) return { key, values };
		this.droppedSamples++;
		return undefined;
	}

	collect(): Record<string, number> {
		const out: Record<string, number> = {};
		if (this.droppedSamples > 0) out['counter.metrics.dropped_samples'] = this.droppedSamples;
		for (const series of this.counters.values()) {
			for (const [key, value] of series) out[`counter.${key}`] = value;
		}
		for (const series of this.gauges.values()) {
			for (const [key, value] of series) out[`gauge.${key}`] = value;
		}
		for (const series of this.histograms.values()) {
			for (const [key, value] of series) {
				out[`histogram.${key}.count`] = value.count;
				out[`histogram.${key}.sum`] = value.sum;
				out[`histogram.${key}.max`] = value.max;
			}
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
