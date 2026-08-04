/**
 * OpenTelemetry tracing + metrics, driven entirely by standard OTEL_* env vars:
 * each pillar is enabled iff its exporter has somewhere to send data. Sampling
 * and exporter endpoint/headers come from the SDK's own env handling; the
 * resource from env/host/process detectors. Manual setup only —
 * auto-instrumentation patches modules via require/import hooks, which cannot
 * work in the single-file bundle (no node_modules at runtime).
 */
import { metrics as metricsApi } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
	defaultResource,
	detectResources,
	envDetector,
	hostDetector,
	processDetector,
	serviceInstanceIdDetector,
} from '@opentelemetry/resources';
import type { IMetricReader } from '@opentelemetry/sdk-metrics';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { logEvent } from './log';

export interface OtelHandle {
	/** True when the request middleware should create SERVER spans. */
	tracing: boolean;
	/** True when a global MeterProvider is registered and exporting. */
	metrics: boolean;
	/** Flush buffered telemetry and stop exporting. */
	shutdown(): Promise<void>;
}

export function isTracingEnabled(env: Record<string, string | undefined> = process.env): boolean {
	if (env.OTEL_SDK_DISABLED === 'true') return false;
	// Only the OTLP exporter (the spec default) is implemented. Any other
	// OTEL_TRACES_EXPORTER selection disables tracing rather than silently
	// exporting somewhere the operator did not choose.
	if ((env.OTEL_TRACES_EXPORTER ?? 'otlp') !== 'otlp') return false;
	return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

/**
 * The exporter OTEL_METRICS_EXPORTER selects, or null when metrics are off.
 * `otlp` (the spec default) also needs an OTLP endpoint; `prometheus` is
 * pull-based and needs none. Unimplemented selections disable metrics.
 */
export function metricsExporter(
	env: Record<string, string | undefined> = process.env,
): 'otlp' | 'prometheus' | null {
	if (env.OTEL_SDK_DISABLED === 'true') return null;
	const exporter = env.OTEL_METRICS_EXPORTER ?? 'otlp';
	if (exporter === 'prometheus') return 'prometheus';
	if (exporter !== 'otlp') return null;
	return env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ? 'otlp' : null;
}

function envMillis(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function otlpMetricReader(): PeriodicExportingMetricReader {
	// Only the full sdk-node reads these env vars. The reader rejects a timeout
	// longer than the interval, so clamp rather than crash boot.
	const interval = envMillis('OTEL_METRIC_EXPORT_INTERVAL', 60_000);
	return new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter(),
		exportIntervalMillis: interval,
		exportTimeoutMillis: Math.min(envMillis('OTEL_METRIC_EXPORT_TIMEOUT', 30_000), interval),
	});
}

/**
 * Reads process.env only — the exporters and resource detectors do their own
 * env reading, so an injectable env here would be misleading.
 */
export function startOtel(): OtelHandle | null {
	const tracing = isTracingEnabled();
	const metricsKind = metricsExporter();
	if (!tracing && !metricsKind) return null;

	// Only envDetector reads OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES
	// (defaultResource() ignores them). Later detectors win on merge, so it goes
	// last: operator-set attributes override detected ones like the random-UUID
	// service.instance.id.
	const resource = defaultResource().merge(
		detectResources({
			detectors: [hostDetector, processDetector, serviceInstanceIdDetector, envDetector],
		}),
	);

	const shutdowns: (() => Promise<void>)[] = [];

	if (tracing) {
		const provider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
		});
		// Global tracer provider + AsyncLocalStorage context + W3C propagation.
		provider.register();
		shutdowns.push(() => provider.shutdown());
	}

	if (metricsKind) {
		const reader: IMetricReader =
			metricsKind === 'prometheus'
				? // Serves /metrics itself; reads OTEL_EXPORTER_PROMETHEUS_HOST/PORT
					// (default: all interfaces, :9464).
					new PrometheusExporter()
				: otlpMetricReader();
		const meterProvider = new MeterProvider({ resource, readers: [reader] });
		// Lights up the RED metrics the @hono/otel middleware records.
		metricsApi.setGlobalMeterProvider(meterProvider);
		shutdowns.push(() => meterProvider.shutdown());
	}

	logEvent({
		level: 'info',
		event: 'otel_started',
		tracing,
		metrics: metricsKind ?? 'off',
		endpoint:
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
			process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
	});
	return {
		tracing,
		metrics: metricsKind !== null,
		shutdown: async () => {
			await Promise.allSettled(shutdowns.map((fn) => fn()));
		},
	};
}
