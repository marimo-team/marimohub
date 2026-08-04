import { httpInstrumentationMiddleware } from '@hono/otel';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isOtelEnabled, startOtel } from './otel';

describe('isOtelEnabled', () => {
	it('is off without an OTLP endpoint', () => {
		expect(isOtelEnabled({})).toBe(false);
	});

	it('is on when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
		expect(isOtelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
	});

	it('is on with only the traces-specific endpoint', () => {
		expect(
			isOtelEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/v1/traces' }),
		).toBe(true);
	});

	it('honors OTEL_SDK_DISABLED', () => {
		expect(
			isOtelEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_SDK_DISABLED: 'true',
			}),
		).toBe(false);
	});

	it('honors OTEL_TRACES_EXPORTER=none', () => {
		expect(
			isOtelEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_TRACES_EXPORTER: 'none',
			}),
		).toBe(false);
	});
});

describe('startOtel', () => {
	it('returns null (and registers nothing) when disabled', () => {
		expect(startOtel({})).toBeNull();
	});
});

describe('tracing middleware', () => {
	it('emits a span per request with route name and status', async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		const app = new Hono();
		app.use('*', httpInstrumentationMiddleware({ tracerProvider: provider }));
		app.get('/api/health', (c) => c.json({ ok: true }));

		const res = await app.request('/api/health');
		expect(res.status).toBe(200);

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('GET /api/health');
		expect(spans[0]?.attributes['http.response.status_code']).toBe(200);
	});
});
