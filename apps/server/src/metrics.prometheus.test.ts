import { createServer } from 'node:http';
import { once } from 'node:events';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { createServices } from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import { expect, it } from 'vitest';
import { DeferredWorkQueue } from './backgroundWork';
import { fanoutMetrics, OtelMetrics, WideEventMetrics } from './metrics';

it('serves cache outcomes and deferred-work depth at /metrics', async () => {
	const exporter = new PrometheusExporter({ preventServerStart: true, withoutScopeInfo: true });
	const provider = new MeterProvider({ readers: [exporter] });
	const wide = new WideEventMetrics();
	const metrics = fanoutMetrics(wide, new OtelMetrics(provider));
	const server = createServer((request, response) =>
		exporter.getMetricsRequestHandler(request, response),
	);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected TCP address');
	const gate = Promise.withResolvers<void>();
	const queue = new DeferredWorkQueue(metrics, { concurrency: 1 });
	try {
		const services = createServices(new MemoryBucket(), metrics);
		await services.catalog.initialize(ACTOR);
		await services.catalog.getCurrentSnapshot();
		await services.catalog.getCurrentSnapshot();
		void queue.defer('teardown', () => gate.promise);
		void queue.defer('teardown', async () => {});
		const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toMatch(/cache_snapshot_reads_total\{result="miss"\} 1/);
		expect(text).toMatch(/cache_snapshot_reads_total\{result="hit"\} 1/);
		expect(text).toMatch(
			/cache_metadata_reads_total\{cache="catalog",service="CatalogService",result="miss",consistency="validated"\} 1/,
		);
		expect(text).toMatch(
			/cache_metadata_reads_total\{cache="catalog",service="CatalogService",result="hit",consistency="validated"\} 1/,
		);
		expect(text).toContain('cache_conditional_reads_total{result="not_modified"} 1');
		expect(text).toContain('background_queue_depth{label="teardown"} 1');
		expect(text).toContain('background_running{label="teardown"} 1');
		expect(wide.collect()).toMatchObject({
			'counter.cache.snapshot.reads{"result":"miss"}': 1,
			'counter.cache.snapshot.reads{"result":"hit"}': 1,
			'counter.cache.metadata.reads{"cache":"catalog","consistency":"validated","result":"miss","service":"CatalogService"}': 1,
			'counter.cache.metadata.reads{"cache":"catalog","consistency":"validated","result":"hit","service":"CatalogService"}': 1,
			'counter.cache.conditional.reads{"result":"not_modified"}': 1,
		});
	} finally {
		gate.resolve();
		await queue.drain();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await provider.shutdown();
	}
});
