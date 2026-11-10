/** Without a LoggerProvider, the OpenTelemetry facade exports no logs. */
import type { AnyValue, AnyValueMap } from '@opentelemetry/api-logs';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { traceContext } from './tracing';

const SEVERITY = new Map<string, SeverityNumber>([
	['debug', SeverityNumber.DEBUG],
	['info', SeverityNumber.INFO],
	['warn', SeverityNumber.WARN],
	['error', SeverityNumber.ERROR],
]);

let minimumSeverity = SeverityNumber.INFO;

/** Entrypoints pass LOG_LEVEL. Missing or unknown levels use info. */
export function configureLogLevel(level?: string): void {
	minimumSeverity = SEVERITY.get(level?.trim().toLowerCase() ?? '') ?? SeverityNumber.INFO;
}

// The proxy binds after provider registration, so it is safe to cache before startup.
let cachedLogger: ReturnType<typeof logs.getLogger> | undefined;

/**
 * Writes one JSON line with active trace IDs and exports the fields to OpenTelemetry.
 * The level filter applies before serialization. The console channel does not change severity.
 */
export function logEvent(
	fields: Record<string, unknown>,
	options?: { channel?: 'log' | 'warn' },
): void {
	const severity =
		SEVERITY.get(typeof fields.level === 'string' ? fields.level : '') ?? SeverityNumber.INFO;
	if (severity < minimumSeverity) return;
	const record = { ts: new Date().toISOString(), ...traceContext(), ...fields };
	// Unserializable fields must still leave a line that names the lost event.
	let line: string;
	try {
		// A custom toJSON can return a scalar or undefined without throwing.
		const serialized: unknown = JSON.stringify(record);
		if (typeof serialized !== 'string' || !serialized.startsWith('{')) {
			throw new TypeError('record did not serialize to an object');
		}
		line = serialized;
	} catch {
		const attempted = fields.event;
		try {
			line = JSON.stringify({
				ts: record.ts,
				level: 'error',
				event: 'log_event_serialization_failed',
				attempted_event: typeof attempted === 'string' ? attempted.slice(0, 128) : 'unknown',
			});
		} catch {
			line = '{"level":"error","event":"log_event_serialization_failed"}';
		}
	}
	try {
		(options?.channel === 'warn' ? console.warn : console.log)(line);
	} catch {}
	emitLogRecord(record);
}

/** Exports the original fields even if console output fails. Export failures do not escape. */
export function emitLogRecord(fields: Record<string, unknown>): void {
	try {
		cachedLogger ??= logs.getLogger('@marimo-hub/core');
		const level = typeof fields.level === 'string' ? fields.level : undefined;
		cachedLogger.emit({
			severityNumber: SEVERITY.get(level ?? '') ?? SeverityNumber.UNSPECIFIED,
			severityText: level,
			body: (fields.message ?? fields.event ?? level ?? 'log') as AnyValue,
			attributes: fields as AnyValueMap,
		});
	} catch {}
}
