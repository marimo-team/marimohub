/**
 * OTEL logs bridge. Like ./tracing, `@opentelemetry/api-logs` is a pure facade:
 * with no LoggerProvider registered every emit is a no-op, so this is safe in any
 * entrypoint. Only the Node server registers a provider, which makes the stdout
 * wide-events durable instead of dying with the pod on the next deploy.
 */
import type { AnyValue, AnyValueMap } from '@opentelemetry/api-logs';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const SEVERITY: Record<string, SeverityNumber> = {
	debug: SeverityNumber.DEBUG,
	info: SeverityNumber.INFO,
	warn: SeverityNumber.WARN,
	error: SeverityNumber.ERROR,
};

// The proxy binds to the real provider once registered, so caching before startup
// is safe — and getLogger is not free per the api-logs docs.
let cachedLogger: ReturnType<typeof logs.getLogger> | undefined;

/**
 * Mirror a `logEvent` record to the OTEL logs pipeline: `level` sets the
 * severity, `message`/`event` the body, every field an attribute. Never throws —
 * stdout already holds the line. Fields are JSON-serializable, hence valid
 * AnyValue.
 */
export function emitLogRecord(fields: Record<string, unknown>): void {
	try {
		cachedLogger ??= logs.getLogger('@marimo-hub/core');
		const level = typeof fields.level === 'string' ? fields.level : undefined;
		cachedLogger.emit({
			severityNumber: SEVERITY[level ?? ''] ?? SeverityNumber.UNSPECIFIED,
			severityText: level,
			body: (fields.message ?? fields.event ?? level ?? 'log') as AnyValue,
			attributes: fields as AnyValueMap,
		});
	} catch {}
}
