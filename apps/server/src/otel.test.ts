import { httpInstrumentationMiddleware } from '@hono/otel';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

	it('disables tracing for unimplemented exporters instead of exporting over OTLP', () => {
		expect(
			isOtelEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_TRACES_EXPORTER: 'console',
			}),
		).toBe(false);
	});
});

describe('startOtel', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('returns null and registers nothing when disabled', () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
		vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '');
		const register = vi.spyOn(NodeTracerProvider.prototype, 'register');
		expect(startOtel()).toBeNull();
		expect(register).not.toHaveBeenCalled();
	});

	it('registers a provider with the env-configured service name when enabled', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
		vi.stubEnv('OTEL_SERVICE_NAME', 'marimohub-test');
		// Stubbed so the test never mutates the process-wide tracer provider.
		const register = vi
			.spyOn(NodeTracerProvider.prototype, 'register')
			.mockImplementation(() => {});
		const handle = startOtel();
		expect(handle).not.toBeNull();
		expect(register).toHaveBeenCalledOnce();
		const provider = register.mock.instances[0] as NodeTracerProvider;
		// Never ended — an ended span would enter the batch exporter and make
		// shutdown() block on flushing to the (nonexistent) endpoint.
		const span = provider.getTracer('test').startSpan('probe');
		expect((span as unknown as ReadableSpan).resource.attributes['service.name']).toBe(
			'marimohub-test',
		);
		await handle?.shutdown();
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
