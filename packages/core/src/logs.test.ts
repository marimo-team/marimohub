import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
	InMemoryLogRecordExporter,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogLevel, emitLogRecord, logEvent } from './logs';

afterEach(() => {
	configureLogLevel();
	vi.restoreAllMocks();
});

// Prime the proxy before provider registration to check that it binds later.
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

	it('filters both stdout and the OTel pipeline', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		configureLogLevel('warn');
		logEvent({ level: 'info', event: 'hidden' });
		expect(log).not.toHaveBeenCalled();
		expect(exporter.getFinishedLogRecords()).toHaveLength(0);
		logEvent({ level: 'error', event: 'visible' });
		expect(only().body).toBe('visible');
	});

	it('still exports the log record when stdout throws', () => {
		vi.spyOn(console, 'log').mockImplementation(() => {
			throw new Error('stdout closed');
		});
		expect(() => logEvent({ level: 'error', event: 'cleanup_failed' })).not.toThrow();
		expect(only().body).toBe('cleanup_failed');
	});

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
	it.each([
		[undefined, ['info', 'warn', 'error']],
		['invalid', ['info', 'warn', 'error']],
		['__proto__', ['info', 'warn', 'error']],
		['', ['info', 'warn', 'error']],
		['debug', ['debug', 'info', 'warn', 'error']],
		[' WARN ', ['warn', 'error']],
		['error', ['error']],
	])('filters before serialization for LOG_LEVEL=%s', (level, expected) => {
		configureLogLevel(level);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const serialize = vi.fn(() => {
			throw new Error('must not serialize');
		});
		if (level !== 'debug') logEvent({ level: 'debug', toJSON: serialize });
		for (const level of ['debug', 'info', 'warn', 'error']) logEvent({ level, event: level });
		expect(serialize).not.toHaveBeenCalled();
		expect(
			log.mock.calls.map(([line]) => (JSON.parse(line as string) as { level: string }).level),
		).toEqual(expected);
	});

	it('writes one JSON line with the event fields', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		logEvent({ level: 'info', event: 'session.start', sid: 'sess-1' });
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
			event: 'session.start',
			sid: 'sess-1',
		});
	});

	it('filters unknown levels as info and applies the threshold to the warn channel', () => {
		configureLogLevel('error');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		logEvent({ event: 'missing_level' }, { channel: 'warn' });
		logEvent({ level: '__proto__', event: 'unknown_level' }, { channel: 'warn' });
		logEvent({ level: 'warn', event: 'filtered_warning' }, { channel: 'warn' });
		expect(warn).not.toHaveBeenCalled();
		logEvent({ level: 'error', event: 'visible' }, { channel: 'warn' });
		expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('visible'));
	});

	it('writes via console.warn on the warn channel', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		logEvent({ level: 'warn', event: 'slow' }, { channel: 'warn' });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('still emits a line naming the event when fields are not serializable', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const circular: Record<string, unknown> = { event: 'sandbox_setup_slow' };
		circular.self = circular;
		logEvent(circular);
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
			level: 'error',
			event: 'log_event_serialization_failed',
			attempted_event: 'sandbox_setup_slow',
		});
	});

	it('falls back when a toJSON field makes the record serialize to a non-object', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		logEvent({ event: 'wide', toJSON: () => {} });
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
			event: 'log_event_serialization_failed',
			attempted_event: 'wide',
		});
	});

	it('survives a BigInt field with a non-string event', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		logEvent({ count: 1n });
		expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
			event: 'log_event_serialization_failed',
			attempted_event: 'unknown',
		});
	});
});
