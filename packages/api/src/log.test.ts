import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, logEvent } from './log';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('logEvent', () => {
	it('emits a single JSON line with a timestamp merged with the fields', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

		logEvent({ event: 'session.start', sid: 'sess-1' });

		expect(spy).toHaveBeenCalledTimes(1);
		const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, any>;
		expect(line).toMatchObject({ event: 'session.start', sid: 'sess-1' });
		expect(typeof line.ts).toBe('string');
		expect(() => new Date(line.ts).toISOString()).not.toThrow();
	});

	it('lets caller fields override nothing reserved but coexist with ts', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		logEvent({ level: 'error', count: 3 });
		const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, any>;
		expect(line.level).toBe('error');
		expect(line.count).toBe(3);
	});
});

describe('describeError', () => {
	it('wraps non-Error values under `value`', () => {
		expect(describeError('boom')).toEqual({ value: 'boom' });
		expect(describeError(42)).toEqual({ value: '42' });
		expect(describeError(null)).toEqual({ value: 'null' });
	});

	it('extracts name, message and stack from an Error', () => {
		const out = describeError(new TypeError('bad arg'));
		expect(out.name).toBe('TypeError');
		expect(out.message).toBe('bad arg');
		expect(typeof out.stack).toBe('string');
	});

	it('duck-types vendor fields (code, transportCode, operation) without an SDK import', () => {
		const err = Object.assign(new Error('grpc down'), {
			code: 14,
			transportCode: 'UNAVAILABLE',
			operation: 'CreateSandbox',
		});
		expect(describeError(err)).toMatchObject({
			code: 14,
			transportCode: 'UNAVAILABLE',
			operation: 'CreateSandbox',
		});
	});

	it('omits vendor fields that are not present', () => {
		const out = describeError(new Error('plain'));
		expect('code' in out).toBe(false);
		expect('transportCode' in out).toBe(false);
		expect('operation' in out).toBe(false);
	});

	it('recurses into the cause chain', () => {
		const root = new Error('root cause');
		const wrapped = Object.assign(new Error('wrapper'), { cause: root });
		const out = describeError(wrapped);
		expect((out.cause as Record<string, unknown>).message).toBe('root cause');
	});

	it('stops recursing at the depth limit', () => {
		// depth 1: top error described, its cause described, but the cause's cause is dropped.
		const inner = Object.assign(new Error('inner'), {
			cause: new Error('deepest'),
		});
		const outer = Object.assign(new Error('outer'), { cause: inner });

		const out = describeError(outer, 1);
		const cause = out.cause as Record<string, unknown>;
		expect(cause.message).toBe('inner');
		expect('cause' in cause).toBe(false);
	});

	it('does not add a cause key when there is none', () => {
		expect('cause' in describeError(new Error('lonely'))).toBe(false);
	});

	it('surfaces ZodError-style issue paths (duck-typed, no zod import)', () => {
		const err = Object.assign(new Error('schema mismatch'), {
			name: 'ZodError',
			issues: [
				{ path: ['meta', 'title'], message: 'Required' },
				{ path: ['status'], message: 'Invalid enum value' },
			],
		});
		expect(describeError(err).issues).toEqual([
			{ path: 'meta.title', message: 'Required' },
			{ path: 'status', message: 'Invalid enum value' },
		]);
	});
});
