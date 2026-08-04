import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserId } from './ids';
import { createServices } from './services';
import { MemoryBucket } from './testing/MemoryBucket';
import { traced } from './tracing';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

afterEach(() => exporter.reset());

class Fake {
	calls = 0;

	async fetch(id: string): Promise<string> {
		this.calls++;
		return `got:${id}`;
	}

	async explode(): Promise<never> {
		throw new Error('boom');
	}

	syncDouble(n: number): number {
		return n * 2;
	}

	async secretive(_bearer: string): Promise<void> {}
}

describe('traced', () => {
	it('wraps async methods in a span with allowlisted attributes', async () => {
		const svc = traced('Fake', new Fake(), { fetch: (id) => ({ 'test.id': id }) });
		await expect(svc.fetch('abc')).resolves.toBe('got:abc');

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('Fake.fetch');
		expect(spans[0]?.attributes).toEqual({ 'test.id': 'abc' });
	});

	it('marks the span as an error on rejection and rethrows', async () => {
		const svc = traced('Fake', new Fake());
		await expect(svc.explode()).rejects.toThrow('boom');

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.status.code).toBe(2); // SpanStatusCode.ERROR
		expect(spans[0]?.events.some((e) => e.name === 'exception')).toBe(true);
	});

	it('keeps sync methods sync', () => {
		const svc = traced('Fake', new Fake());
		expect(svc.syncDouble(21)).toBe(42);
		expect(exporter.getFinishedSpans()).toHaveLength(1);
	});

	it('records no attributes for methods without an extractor', async () => {
		const svc = traced('Fake', new Fake());
		await svc.secretive('mhub_pat_supersecret');

		const spans = exporter.getFinishedSpans();
		expect(spans[0]?.attributes).toEqual({});
	});

	it('preserves internal state access (`this` is the raw instance)', async () => {
		const raw = new Fake();
		const svc = traced('Fake', raw);
		await svc.fetch('x');
		expect(raw.calls).toBe(1);
	});
});

describe('createServices tracing option', () => {
	it('spans service and bucket calls with id/key attributes when enabled', async () => {
		const services = createServices(new MemoryBucket(), undefined, { tracing: true });
		await services.identities.get('user-1' as UserId);

		const spans = exporter.getFinishedSpans();
		const names = spans.map((s) => s.name);
		expect(names).toContain('IdentityService.get');
		expect(names).toContain('Bucket.get');
		const service = spans.find((s) => s.name === 'IdentityService.get');
		expect(service?.attributes).toEqual({ 'marimohub.user_id': 'user-1' });
		const bucket = spans.find((s) => s.name === 'Bucket.get');
		expect(String(bucket?.attributes['bucket.key'])).toContain('user-1');
	});

	it('leaves everything unwrapped by default', async () => {
		const services = createServices(new MemoryBucket());
		await services.identities.get('user-1' as UserId);
		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});
});
