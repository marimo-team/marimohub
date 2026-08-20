import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
	InMemoryLogRecordExporter,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emitLogRecord } from './logs';

// Must run before the provider is registered below: the facade must no-op when
// nothing is wired (as in a Worker), and priming the cached proxy logger here is
// safe — it binds its delegate lazily, so the later registration still takes.
describe('emitLogRecord without a provider', () => {
	it('is a no-op that never throws', () => {
		expect(() => emitLogRecord({ level: 'error', event: 'boot_failed' })).not.toThrow();
	});
});

describe('emitLogRecord with a registered provider', () => {
	const exporter = new InMemoryLogRecordExporter();
	const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
	logs.setGlobalLoggerProvider(provider);

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
