/**
 * OpenTelemetry tracing, driven entirely by standard OTEL_* env vars: enabled
 * iff an OTLP endpoint is set; sampling and exporter endpoint/headers come from
 * the SDK's own env handling, the resource from `envDetector`. Manual setup
 * only — auto-instrumentation patches modules via require/import hooks, which
 * cannot work in the single-file bundle (no node_modules at runtime).
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, detectResources, envDetector } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { logEvent } from './log';

export interface OtelHandle {
	/** Flush buffered spans and stop exporting. */
	shutdown(): Promise<void>;
}

export function isOtelEnabled(env: Record<string, string | undefined> = process.env): boolean {
	if (env.OTEL_SDK_DISABLED === 'true') return false;
	// Only the OTLP exporter (the spec default) is implemented. Any other
	// OTEL_TRACES_EXPORTER selection disables tracing rather than silently
	// exporting somewhere the operator did not choose.
	if ((env.OTEL_TRACES_EXPORTER ?? 'otlp') !== 'otlp') return false;
	return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

/**
 * Reads process.env only — the exporter and resource detectors do their own
 * env reading, so an injectable env here would be misleading.
 */
export function startOtel(): OtelHandle | null {
	if (!isOtelEnabled()) return null;
	const provider = new NodeTracerProvider({
		// defaultResource() ignores OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES;
		// only envDetector reads them, so merge it in explicitly.
		resource: defaultResource().merge(detectResources({ detectors: [envDetector] })),
		spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
	});
	// Global tracer provider + AsyncLocalStorage context + W3C propagation.
	provider.register();
	logEvent({
		level: 'info',
		event: 'otel_started',
		endpoint:
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
	});
	return { shutdown: () => provider.shutdown() };
}
