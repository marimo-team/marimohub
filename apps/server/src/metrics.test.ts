import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { MetricData } from '@opentelemetry/sdk-metrics';
import { describe, expect, it, vi } from 'vitest';
import type { Metrics } from '@marimo-hub/core';
import { fanoutMetrics, OtelMetrics, WideEventMetrics } from './metrics';

describe('WideEventMetrics', () => {
	it('accumulates repeated increments', () => {
		const metrics = new WideEventMetrics();
		metrics.increment('cas_conflicts');
		metrics.increment('cas_conflicts', 2);
		expect(metrics.collect()).toMatchObject({ 'counter.cas_conflicts': 3 });
	});

	it('keeps only the latest gauge value', () => {
		const metrics = new WideEventMetrics();
		metrics.gauge('live_sessions', 5);
		metrics.gauge('live_sessions', 8);
		expect(metrics.collect()).toMatchObject({ 'gauge.live_sessions': 8 });
	});

	it('summarizes histogram observations', () => {
		const metrics = new WideEventMetrics();
		metrics.histogram('object_browser.latency_ms', 4);
		metrics.histogram('object_browser.latency_ms', 10);
		expect(metrics.collect()).toMatchObject({
			'histogram.object_browser.latency_ms.count': 2,
			'histogram.object_browser.latency_ms.sum': 14,
			'histogram.object_browser.latency_ms.max': 10,
		});
	});

	it('flattens counters and gauges under prefixed keys', () => {
		const metrics = new WideEventMetrics();
		metrics.increment('a');
		metrics.gauge('b', 1);
		expect(metrics.collect()).toEqual({ 'counter.a': 1, 'gauge.b': 1 });
	});
});

async function collect(
	provider: MeterProvider,
	exporter: InMemoryMetricExporter,
): Promise<Map<string, MetricData>> {
	await provider.forceFlush();
	const metrics = exporter
		.getMetrics()
		.flatMap((rm) => rm.scopeMetrics)
		.flatMap((sm) => sm.metrics);
	return new Map(metrics.map((m) => [m.descriptor.name, m]));
}

describe('OtelMetrics', () => {
	function setup() {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const provider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		return { exporter, provider, metrics: new OtelMetrics(provider) };
	}

	it('accumulates counters per name with tags', async () => {
		const { exporter, provider, metrics } = setup();
		metrics.increment('catalog.cas.conflict');
		metrics.increment('catalog.cas.conflict', 2);
		metrics.increment('sessions.reaped', 3, { reason: 'expired' });

		const byName = await collect(provider, exporter);
		expect(byName.get('catalog.cas.conflict')?.dataPoints[0]?.value).toBe(3);
		const reaped = byName.get('sessions.reaped')?.dataPoints[0];
		expect(reaped?.value).toBe(3);
		expect(reaped?.attributes).toEqual({ reason: 'expired' });
		await provider.shutdown();
	});

	it('records the latest gauge value', async () => {
		const { exporter, provider, metrics } = setup();
		metrics.gauge('sessions.live', 5);
		metrics.gauge('sessions.live', 2);

		const byName = await collect(provider, exporter);
		expect(byName.get('sessions.live')?.dataPoints[0]?.value).toBe(2);
		await provider.shutdown();
	});

	it('records histogram distributions with tags', async () => {
		const { exporter, provider, metrics } = setup();
		metrics.histogram('object_browser.s3.latency_ms', 12, { operation: 'list_objects' });
		metrics.histogram('object_browser.s3.latency_ms', 20, { operation: 'list_objects' });

		const byName = await collect(provider, exporter);
		const point = byName.get('object_browser.s3.latency_ms')?.dataPoints[0];
		expect(point?.attributes).toEqual({ operation: 'list_objects' });
		expect(point?.value).toMatchObject({ count: 2, sum: 32 });
		await provider.shutdown();
	});
});

describe('fanoutMetrics', () => {
	it('forwards every call to all targets', () => {
		const target: Metrics = { increment: vi.fn(), gauge: vi.fn() };
		const wide = new WideEventMetrics();
		const fan = fanoutMetrics(target, wide);

		fan.increment('catalog.cas.conflict', 2, { source: 'test' });
		fan.gauge('sessions.live', 7);

		expect(target.increment).toHaveBeenCalledWith('catalog.cas.conflict', 2, { source: 'test' });
		expect(target.gauge).toHaveBeenCalledWith('sessions.live', 7, undefined);
		expect(wide.collect()).toEqual({
			'counter.catalog.cas.conflict': 2,
			'gauge.sessions.live': 7,
		});
	});
});
