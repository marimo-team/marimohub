import { httpInstrumentationMiddleware } from '@hono/otel';
import { metrics as metricsApi } from '@opentelemetry/api';
import { logs as logsApi } from '@opentelemetry/api-logs';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLogsEnabled, isTracingEnabled, metricsExporter, startOtel } from './otel';

describe('isTracingEnabled', () => {
	it('is off without an OTLP endpoint', () => {
		expect(isTracingEnabled({})).toBe(false);
	});

	it('is on when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
		expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
	});

	it('is on with only the traces-specific endpoint', () => {
		expect(
			isTracingEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/v1/traces' }),
		).toBe(true);
	});

	it('honors OTEL_SDK_DISABLED', () => {
		expect(
			isTracingEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_SDK_DISABLED: 'true',
			}),
		).toBe(false);
	});

	it('honors OTEL_TRACES_EXPORTER=none', () => {
		expect(
			isTracingEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_TRACES_EXPORTER: 'none',
			}),
		).toBe(false);
	});

	it('disables tracing for unimplemented exporters instead of exporting over OTLP', () => {
		expect(
			isTracingEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_TRACES_EXPORTER: 'console',
			}),
		).toBe(false);
	});
});

describe('metricsExporter', () => {
	it('is off without an OTLP endpoint (otlp is the default exporter)', () => {
		expect(metricsExporter({})).toBeNull();
	});

	it('selects otlp when the shared OTLP endpoint is set', () => {
		expect(metricsExporter({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe('otlp');
	});

	it('selects otlp with only the metrics-specific endpoint', () => {
		expect(
			metricsExporter({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:4318/v1/metrics' }),
		).toBe('otlp');
	});

	it('selects prometheus without needing any endpoint', () => {
		expect(metricsExporter({ OTEL_METRICS_EXPORTER: 'prometheus' })).toBe('prometheus');
	});

	it('honors OTEL_METRICS_EXPORTER=none', () => {
		expect(
			metricsExporter({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_METRICS_EXPORTER: 'none',
			}),
		).toBeNull();
	});

	it('honors OTEL_SDK_DISABLED', () => {
		expect(
			metricsExporter({ OTEL_METRICS_EXPORTER: 'prometheus', OTEL_SDK_DISABLED: 'true' }),
		).toBeNull();
	});

	it('disables metrics for unimplemented exporters', () => {
		expect(
			metricsExporter({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_METRICS_EXPORTER: 'console',
			}),
		).toBeNull();
	});
});

describe('isLogsEnabled', () => {
	it('is off without an OTLP endpoint', () => {
		expect(isLogsEnabled({})).toBe(false);
	});

	it('is on when OTEL_EXPORTER_OTLP_ENDPOINT is set (otlp is the default exporter)', () => {
		expect(isLogsEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
	});

	it('is on with only the logs-specific endpoint', () => {
		expect(
			isLogsEnabled({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:4318/v1/logs' }),
		).toBe(true);
	});

	it('honors OTEL_LOGS_EXPORTER=none', () => {
		expect(
			isLogsEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_LOGS_EXPORTER: 'none',
			}),
		).toBe(false);
	});

	it('honors OTEL_SDK_DISABLED', () => {
		expect(
			isLogsEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_SDK_DISABLED: 'true',
			}),
		).toBe(false);
	});

	it('disables logs for unimplemented exporters', () => {
		expect(
			isLogsEnabled({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
				OTEL_LOGS_EXPORTER: 'console',
			}),
		).toBe(false);
	});
});

describe('startOtel', () => {
	beforeEach(() => {
		// Any endpoint-set test now also enables logs, so the otel_started event
		// becomes a log record. Intercept the flush so shutdown never blocks on the
		// (nonexistent) endpoint — order-independent, unlike a per-test mock.
		vi.spyOn(OTLPLogExporter.prototype, 'export').mockImplementation((_logs, callback) => {
			callback({ code: ExportResultCode.SUCCESS });
		});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		metricsApi.disable();
		logsApi.disable();
	});

	it('returns null and registers nothing when disabled', () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
		vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '');
		vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', '');
		vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', '');
		const register = vi.spyOn(NodeTracerProvider.prototype, 'register');
		expect(startOtel()).toBeNull();
		expect(register).not.toHaveBeenCalled();
	});

	it('starts logs-only when only an OTLP endpoint and OTEL_LOGS_EXPORTER apply', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
		vi.stubEnv('OTEL_TRACES_EXPORTER', 'none');
		vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
		const register = vi.spyOn(NodeTracerProvider.prototype, 'register');
		const setGlobal = vi.spyOn(logsApi, 'setGlobalLoggerProvider');
		const handle = startOtel();
		expect(handle).not.toBeNull();
		expect(handle?.tracing).toBe(false);
		expect(handle?.metrics).toBe(false);
		expect(handle?.logs).toBe(true);
		expect(register).not.toHaveBeenCalled();
		expect(setGlobal).toHaveBeenCalledOnce();
		await handle?.shutdown();
	});

	it('registers a provider with the env-configured service name when enabled', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
		vi.stubEnv('OTEL_SERVICE_NAME', 'marimohub-test');
		vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
		// Stubbed so the test never mutates the process-wide tracer provider.
		const register = vi
			.spyOn(NodeTracerProvider.prototype, 'register')
			.mockImplementation(() => {});
		const handle = startOtel();
		expect(handle).not.toBeNull();
		expect(handle?.tracing).toBe(true);
		expect(handle?.metrics).toBe(false);
		expect(register).toHaveBeenCalledOnce();
		const provider = register.mock.instances[0] as NodeTracerProvider;
		// Never ended — an ended span would enter the batch exporter and make
		// shutdown() block on flushing to the (nonexistent) endpoint.
		const span = provider.getTracer('test').startSpan('probe');
		const resource = (span as unknown as ReadableSpan).resource;
		await resource.waitForAsyncAttributes?.();
		expect(resource.attributes['service.name']).toBe('marimohub-test');
		expect(resource.attributes['process.pid']).toBe(process.pid);
		expect(resource.attributes['host.name']).toBeDefined();
		expect(resource.attributes['service.instance.id']).toBeDefined();
		await handle?.shutdown();
	});

	it('falls back to the marimohub service name when OTEL_SERVICE_NAME is unset', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
		vi.stubEnv('OTEL_SERVICE_NAME', '');
		vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
		vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
		const register = vi
			.spyOn(NodeTracerProvider.prototype, 'register')
			.mockImplementation(() => {});
		const handle = startOtel();
		const provider = register.mock.instances[0] as NodeTracerProvider;
		const span = provider.getTracer('test').startSpan('probe');
		const resource = (span as unknown as ReadableSpan).resource;
		await resource.waitForAsyncAttributes?.();
		expect(resource.attributes['service.name']).toBe('marimohub');
		await handle?.shutdown();
	});

	it('lets OTEL_RESOURCE_ATTRIBUTES override detected resource attributes', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
		vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'service.instance.id=pod-7');
		vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
		const register = vi
			.spyOn(NodeTracerProvider.prototype, 'register')
			.mockImplementation(() => {});
		const handle = startOtel();
		const provider = register.mock.instances[0] as NodeTracerProvider;
		const span = provider.getTracer('test').startSpan('probe');
		const resource = (span as unknown as ReadableSpan).resource;
		await resource.waitForAsyncAttributes?.();
		expect(resource.attributes['service.instance.id']).toBe('pod-7');
		await handle?.shutdown();
	});

	it('clamps the export timeout when OTEL_METRIC_EXPORT_INTERVAL is shorter', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
		vi.stubEnv('OTEL_TRACES_EXPORTER', 'none');
		vi.stubEnv('OTEL_METRIC_EXPORT_INTERVAL', '1000');
		// Intercepted so shutdown's final flush never hits the network.
		vi.spyOn(OTLPMetricExporter.prototype, 'export').mockImplementation((_metrics, callback) => {
			callback({ code: ExportResultCode.SUCCESS });
		});
		const handle = startOtel();
		expect(handle).not.toBeNull();
		await handle?.shutdown();
	});

	it('starts metrics-only in prometheus mode, without a tracer provider', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
		vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '');
		vi.stubEnv('OTEL_METRICS_EXPORTER', 'prometheus');
		// Stubbed so the test never binds the scrape port.
		const startServer = vi
			.spyOn(PrometheusExporter.prototype, 'startServer')
			.mockResolvedValue(undefined);
		const register = vi.spyOn(NodeTracerProvider.prototype, 'register');
		const setGlobal = vi.spyOn(metricsApi, 'setGlobalMeterProvider');
		const handle = startOtel();
		expect(handle).not.toBeNull();
		expect(handle?.tracing).toBe(false);
		expect(handle?.metrics).toBe(true);
		expect(register).not.toHaveBeenCalled();
		expect(startServer).toHaveBeenCalledOnce();
		expect(setGlobal).toHaveBeenCalledOnce();
		await handle?.shutdown();
	});
});

describe('instrumentation middleware', () => {
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

	it('records request-duration metrics even with tracing disabled', async () => {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const meterProvider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
		const app = new Hono();
		app.use('*', httpInstrumentationMiddleware({ meterProvider, disableTracing: true }));
		app.get('/api/health', (c) => c.json({ ok: true }));

		const res = await app.request('/api/health');
		expect(res.status).toBe(200);

		await meterProvider.forceFlush();
		const recorded = exporter
			.getMetrics()
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics);
		const duration = recorded.find((m) => m.descriptor.name === 'http.server.request.duration');
		expect(duration).toBeDefined();
		const point = duration?.dataPoints[0];
		expect(point?.attributes['http.route']).toBe('/api/health');
		expect(point?.attributes['http.response.status_code']).toBe(200);
		await meterProvider.shutdown();
	});
});
