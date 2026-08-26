import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
	InMemoryLogRecordExporter,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitLogRecord, logEvent } from './logs';

// Runs first, before the beforeAll below registers a provider (that registration
// is a hook, so it fires in the run phase — not at collection time like a bare
// describe-body statement would), so this exercises the real no-op path a Worker
// relies on. The emit also primes the module's cached proxy logger, which is
// safe: it binds its delegate lazily once a provider is registered.
describe('emitLogRecord without a provider', () => {
	it('is a no-op that never throws', () => {
		expect(() => emitLogRecord({ level: 'error', event: 'boot_failed' })).not.toThrow();
	});
});

describe('emitLogRecord with a registered provider', () => {
	const exporter = new InMemoryLogRecordExporter();
	const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });

	beforeAll(() => logs.setGlobalLoggerProvider(provider));
	beforeEach(() => exporter.reset());
	afterAll(async () => {
		logs.disable();
		await provider.shutdown();
	});

	const only = () => {
		const records = exporter.getFinishedLogRecords();
		expect(records).toHaveLength(1);
		return records[0];
	};

	it('maps level to severity and keeps every field as an attribute', () => {
		emitLogRecord({ ts: 't', level: 'error', event: 'boot_failed', reason: 'oom' });
		const record = only();
		expect(record.severityNumber).toBe(SeverityNumber.ERROR);
		expect(record.severityText).toBe('error');
		expect(record.body).toBe('boot_failed');
		expect(record.attributes).toMatchObject({
			level: 'error',
			event: 'boot_failed',
			reason: 'oom',
		});
	});

	it('maps each known level', () => {
		const cases: [string, SeverityNumber][] = [
			['debug', SeverityNumber.DEBUG],
			['info', SeverityNumber.INFO],
			['warn', SeverityNumber.WARN],
			['error', SeverityNumber.ERROR],
		];
		for (const [level, expected] of cases) {
			exporter.reset();
			emitLogRecord({ level, event: 'e' });
			expect(only().severityNumber).toBe(expected);
		}
	});

	it('leaves severity unspecified for an unknown or missing level', () => {
		emitLogRecord({ event: 'plain' });
		expect(only().severityNumber).toBe(SeverityNumber.UNSPECIFIED);
	});

	it('prefers message over event for the body, then falls back to a constant', () => {
		emitLogRecord({ message: 'hi', event: 'e' });
		expect(only().body).toBe('hi');
		exporter.reset();
		emitLogRecord({ foo: 'bar' });
		expect(only().body).toBe('log');
	});

	it('preserves nested attribute structure', () => {
		emitLogRecord({ level: 'error', event: 'op_failed', error: { name: 'Err', code: 'E1' } });
		expect(only().attributes.error).toMatchObject({ name: 'Err', code: 'E1' });
	});
});

describe('logEvent', () => {
	it('writes one JSON line with the event fields', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			logEvent({ level: 'info', event: 'session.start', sid: 'sess-1' });
			expect(log).toHaveBeenCalledTimes(1);
			expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
				event: 'session.start',
				sid: 'sess-1',
			});
		} finally {
			log.mockRestore();
		}
	});

	it('writes via console.warn on the warn channel', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			logEvent({ level: 'warn', event: 'slow' }, { channel: 'warn' });
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it('still emits a line naming the event when fields are not serializable', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const circular: Record<string, unknown> = { event: 'sandbox_setup_slow' };
			circular.self = circular;
			logEvent(circular);
			expect(log).toHaveBeenCalledTimes(1);
			expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
				level: 'error',
				event: 'log_event_serialization_failed',
				attempted_event: 'sandbox_setup_slow',
			});
		} finally {
			log.mockRestore();
		}
	});

	it('falls back when a toJSON field makes the record serialize to a non-object', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			logEvent({ event: 'wide', toJSON: () => {} });
			expect(log).toHaveBeenCalledTimes(1);
			expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
				event: 'log_event_serialization_failed',
				attempted_event: 'wide',
			});
		} finally {
			log.mockRestore();
		}
	});

	it('survives a BigInt field with a non-string event', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			logEvent({ count: 1n });
			expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
				event: 'log_event_serialization_failed',
				attempted_event: 'unknown',
			});
		} finally {
			log.mockRestore();
		}
	});
});
