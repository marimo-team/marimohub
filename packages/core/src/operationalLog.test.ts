import { context, trace, TraceFlags } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	InMemoryLogRecordExporter,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logOperationalError } from './operationalLog';
import { StoredObjectError } from './schema';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('logOperationalError', () => {
	it('emits a structured error without arbitrary exception text', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		logOperationalError(
			'stored_object_skipped',
			{ operation: 'session.scan' },
			new Error('credential=do-not-log'),
		);

		expect(spy).toHaveBeenCalledOnce();
		const line = spy.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toMatchObject({
			level: 'error',
			event: 'stored_object_skipped',
			operation: 'session.scan',
			error: { name: 'Error' },
		});
		expect(line).not.toContain('do-not-log');
	});

	it('keeps safe stored-object location and schema issue metadata', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		logOperationalError(
			'stored_object_skipped',
			{ operation: 'event.list' },
			new StoredObjectError('_system/events/bad.json', 'schema_mismatch', {
				issues: [{ path: 'actor', code: 'invalid_type' }],
			}),
		);

		expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
			error: {
				name: 'StoredObjectError',
				reason: 'schema_mismatch',
				object: '_system/events/bad.json',
				issues: [{ path: 'actor', code: 'invalid_type' }],
			},
		});
	});

	it('caps issue metadata, omits non-finite numbers, and protects reserved fields', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = Object.assign(new Error('hidden'), {
			status: Number.POSITIVE_INFINITY,
			issues: Array.from({ length: 50 }, (_, i) => ({ path: `items.${i}`, code: 'invalid_type' })),
		});

		logOperationalError(
			'stored_object_skipped',
			{ level: 'info', event: 'spoofed', error: 'spoofed' },
			err,
		);

		const line = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, any>;
		expect(line.level).toBe('error');
		expect(line.event).toBe('stored_object_skipped');
		expect(line.error.status).toBeUndefined();
		expect(line.error.issues).toHaveLength(20);
	});

	it('falls back to a safe payload when context serialization fails', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fields: Record<string, unknown> = { secret: 'do-not-log' };
		fields.self = fields;

		expect(() =>
			logOperationalError('stored_object_skipped', fields, new Error('also-do-not-log')),
		).not.toThrow();

		const line = spy.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toMatchObject({
			level: 'error',
			event: 'operational_log_serialization_failed',
			attempted_event: 'stored_object_skipped',
		});
		expect(line).not.toContain('do-not-log');
	});
});

describe('exported operational errors', () => {
	const exporter = new InMemoryLogRecordExporter();
	const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
	const spanContext = {
		traceId: '1234567890abcdef1234567890abcdef',
		spanId: '1234567890abcdef',
		traceFlags: TraceFlags.SAMPLED,
	};

	beforeAll(() => {
		logs.setGlobalLoggerProvider(provider);
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
	});
	beforeEach(() => {
		exporter.reset();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterAll(async () => {
		logs.disable();
		context.disable();
		await provider.shutdown();
	});

	it('exports a stored-object error once with matching console fields and trace context', () => {
		const error = new StoredObjectError('previews/bad.json', 'schema_mismatch', {
			issues: [{ path: 'status', code: 'invalid_type' }],
		});
		error.message = 'credential=do-not-log';
		error.cause = new Error('also-do-not-log');
		context.with(trace.setSpanContext(context.active(), spanContext), () => {
			logOperationalError(
				'preview_work_scan_failed',
				{ operation: 'preview.scan', trace_id: 'spoofed', span_id: 'spoofed' },
				error,
			);
		});

		const records = exporter.getFinishedLogRecords();
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record.body).toBe('preview_work_scan_failed');
		expect(record.severityNumber).toBe(SeverityNumber.ERROR);
		expect(record.severityText).toBe('error');
		expect(record.spanContext).toEqual(spanContext);
		expect(record.attributes).toMatchObject({
			operation: 'preview.scan',
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
			error: {
				name: 'StoredObjectError',
				reason: 'schema_mismatch',
				object: 'previews/bad.json',
				issues: [{ path: 'status', code: 'invalid_type' }],
			},
		});
		expect(console.error).toHaveBeenCalledOnce();
		const line = vi.mocked(console.error).mock.calls[0][0] as string;
		expect(record.attributes).toEqual(JSON.parse(line));
		expect(JSON.stringify(record.attributes)).not.toContain('do-not-log');
	});

	it('exports errors outside a trace without accepting caller-supplied trace identifiers', () => {
		logOperationalError(
			'work_failed',
			{ trace_id: 'spoofed', span_id: 'spoofed' },
			new Error('hidden'),
		);
		const records = exporter.getFinishedLogRecords();
		expect(records).toHaveLength(1);
		expect(records[0].spanContext).toBeUndefined();
		expect(records[0].attributes).not.toHaveProperty('trace_id');
		expect(records[0].attributes).not.toHaveProperty('span_id');
	});

	it('exports only the safe fallback when serialization fails', () => {
		const fields: Record<string, unknown> = { secret: 'do-not-log' };
		fields.self = fields;
		context.with(trace.setSpanContext(context.active(), spanContext), () => {
			logOperationalError('work_failed', fields, new Error('also-do-not-log'));
		});
		const records = exporter.getFinishedLogRecords();
		expect(records).toHaveLength(1);
		expect(records[0].body).toBe('operational_log_serialization_failed');
		expect(records[0].attributes).toEqual(
			JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string),
		);
		expect(records[0].attributes).toMatchObject({
			attempted_event: 'work_failed',
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
		});
		expect(JSON.stringify(records[0].attributes)).not.toContain('do-not-log');
	});

	it('ignores a context serializer that would replace the sanitized record', () => {
		logOperationalError(
			'work_failed',
			{ toJSON: () => ({ secret: 'do-not-log' }) },
			new Error('hidden'),
		);
		const records = exporter.getFinishedLogRecords();
		expect(records).toHaveLength(1);
		expect(records[0].body).toBe('work_failed');
		expect(JSON.stringify(records[0].attributes)).not.toContain('do-not-log');
	});

	it('exports even when console output throws', () => {
		vi.mocked(console.error).mockImplementation(() => {
			throw new Error('console unavailable');
		});
		expect(() => logOperationalError('work_failed', {}, new Error('hidden'))).not.toThrow();
		expect(exporter.getFinishedLogRecords()).toHaveLength(1);
	});

	it('preserves console output when the log pipeline throws', () => {
		vi.spyOn(provider.getLogger('@marimo-hub/core'), 'emit').mockImplementation(() => {
			throw new Error('logger unavailable');
		});
		expect(() => logOperationalError('work_failed', {}, new Error('hidden'))).not.toThrow();
		expect(console.error).toHaveBeenCalledOnce();
	});
});
