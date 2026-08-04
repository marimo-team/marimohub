/**
 * OpenTelemetry tracing, driven entirely by standard OTEL_* env vars: enabled
 * iff an OTLP endpoint is set; service name, resource attributes, sampling, and
 * exporter headers come from the SDK's own env handling. Manual setup only —
 * auto-instrumentation patches modules via require/import hooks, which cannot
 * work in the single-file bundle (no node_modules at runtime).
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { logEvent } from './log';

export interface OtelHandle {
	/** Flush buffered spans and stop exporting. */
	shutdown(): Promise<void>;
}

export function isOtelEnabled(env: Record<string, string | undefined> = process.env): boolean {
	if (env.OTEL_SDK_DISABLED === 'true') return false;
	if (env.OTEL_TRACES_EXPORTER === 'none') return false;
	return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

export function startOtel(
	env: Record<string, string | undefined> = process.env,
): OtelHandle | null {
	if (!isOtelEnabled(env)) return null;
	const provider = new NodeTracerProvider({
		spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
	});
	// Global tracer provider + AsyncLocalStorage context + W3C propagation.
	provider.register();
	logEvent({
		level: 'info',
		event: 'otel_started',
		endpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
	});
	return { shutdown: () => provider.shutdown() };
}
