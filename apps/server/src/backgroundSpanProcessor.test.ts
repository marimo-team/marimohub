import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { BatchSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundSpanProcessor } from './backgroundSpanProcessor';

const routineNames = [
	'Bucket.get',
	'Bucket.list',
	'Bucket.put',
	'Bucket.delete',
	'SessionService.getSession',
	'MaintenanceLock.acquire',
	'MaintenanceLock.release',
];

describe('BackgroundSpanProcessor', () => {
	let exporter: InMemorySpanExporter;
	let provider: NodeTracerProvider;
	let tracer: Tracer;

	beforeEach(() => {
		exporter = new InMemorySpanExporter();
		provider = new NodeTracerProvider({
			spanProcessors: [new BackgroundSpanProcessor(new BatchSpanProcessor(exporter))],
		});
		provider.register();
		tracer = provider.getTracer('test');
	});

	afterEach(async () => {
		await provider.shutdown();
		trace.disable();
		context.disable();
	});

	function child(name: string, parent: Span) {
		return tracer.startSpan(name, {}, trace.setSpan(ROOT_CONTEXT, parent));
	}

	it('drops routine background operations at any depth, keeping summaries and other work', async () => {
		const loop = tracer.startSpan('loop.warm_pool');
		const reconcile = child('WarmPoolService.reconcile', loop);
		for (const parent of [loop, reconcile]) {
			for (const name of routineNames) child(name, parent).end();
		}
		child('SessionService.createSession', reconcile).end();
		reconcile.end();
		loop.end();
		await provider.forceFlush();

		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
			'SessionService.createSession',
			'WarmPoolService.reconcile',
			'loop.warm_pool',
		]);
	});

	it.each(['status', 'exception'] as const)(
		'retains routine spans with an error %s',
		async (error) => {
			const loop = tracer.startSpan('loop.maintenance');
			for (const name of routineNames) {
				const span = child(name, loop);
				if (error === 'status') span.setStatus({ code: SpanStatusCode.ERROR });
				else span.recordException(new Error('operation failed'));
				span.end();
			}
			loop.end();
			await provider.forceFlush();

			const spans = exporter.getFinishedSpans();
			expect(spans.map((span) => span.name)).toEqual([...routineNames, 'loop.maintenance']);
			for (const span of spans.slice(0, -1)) {
				expect(span.parentSpanContext?.spanId).toBe(loop.spanContext().spanId);
				if (error === 'status') expect(span.status.code).toBe(SpanStatusCode.ERROR);
				else {
					expect(span.events).toContainEqual(
						expect.objectContaining({
							name: 'exception',
							attributes: expect.objectContaining({ 'exception.message': 'operation failed' }),
						}),
					);
				}
			}
		},
	);

	it('keeps foreground and standalone operations even while a background loop is active', async () => {
		const loop = tracer.startSpan('loop.maintenance');
		const request = tracer.startSpan('GET /notebooks');
		for (const name of routineNames) {
			tracer.startSpan(name).end();
			child(name, request).end();
			child(name, loop).end();
		}
		request.end();
		loop.end();
		await provider.forceFlush();

		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
			...routineNames.flatMap((name) => [name, name]),
			'GET /notebooks',
			'loop.maintenance',
		]);
	});

	it('propagates background ancestry through asynchronous work without affecting sibling requests', async () => {
		await Promise.all([
			tracer.startActiveSpan('loop.warm_pool', async (loop) => {
				await tracer.startActiveSpan('WarmPoolService.reconcile', async (reconcile) => {
					await Promise.resolve();
					tracer.startSpan('Bucket.get').end();
					reconcile.end();
				});
				loop.end();
			}),
			tracer.startActiveSpan('GET /notebooks', async (request) => {
				await Promise.resolve();
				tracer.startSpan('Bucket.get').end();
				request.end();
			}),
		]);
		await provider.forceFlush();

		const spans = exporter.getFinishedSpans();
		const reads = spans.filter((span) => span.name === 'Bucket.get');
		expect(reads).toHaveLength(1);
		expect(reads[0].parentSpanContext?.spanId).toBe(
			spans.find((span) => span.name === 'GET /notebooks')?.spanContext().spanId,
		);
	});

	it('filters late work after its ancestors end and preserves late failures', async () => {
		const loop = tracer.startSpan('loop.maintenance');
		const work = child('Maintenance.sweep', loop);
		loop.setStatus({ code: SpanStatusCode.ERROR, message: 'deadline exceeded' });
		loop.end();
		work.end();
		await provider.forceFlush();
		child('Bucket.get', work).end();
		const failed = child('Bucket.list', work);
		failed.setStatus({ code: SpanStatusCode.ERROR });
		failed.end();
		await provider.forceFlush();

		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
			'loop.maintenance',
			'Maintenance.sweep',
			'Bucket.list',
		]);
	});
});
