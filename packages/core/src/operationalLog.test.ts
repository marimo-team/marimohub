import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
