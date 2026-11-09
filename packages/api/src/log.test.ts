import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundWorkFrom } from '@marimo-hub/core';
import { queuedBackgroundWork } from '@marimo-hub/core/testing/background-work';
import { appendAudit, bestEffort, describeError, errorMetadataChain, logEvent } from './log';

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

describe('errorMetadataChain', () => {
	it('keeps enum-ish codes down the cause chain but never free-form text', () => {
		// The shape undici throws for a failed proxy fetch: a bland TypeError whose
		// cause carries the diagnostic code — and whose message can quote the
		// requested URL, token-bearing path included.
		const cause = Object.assign(
			new Error('connect ECONNRESET http://kernel:2718/proxy/secret-token/assets/app.js'),
			{ code: 'ECONNRESET' },
		);
		const err = Object.assign(new TypeError('fetch failed'), { cause });

		const out = errorMetadataChain(err);

		expect(out).toEqual({
			error_name: 'TypeError',
			cause: { error_name: 'Error', error_code: 'ECONNRESET' },
		});
		expect(JSON.stringify(out)).not.toContain('secret-token');
	});

	it('renders a non-Error cause without echoing it, and stops at the depth limit', () => {
		const err = Object.assign(new Error('outer'), {
			cause: Object.assign(new Error('inner'), { cause: 'raw secret string' }),
		});
		expect(errorMetadataChain(err)).toEqual({
			error_name: 'Error',
			cause: { error_name: 'Error', cause: { error_name: 'non-error(string)' } },
		});
		expect(errorMetadataChain(err, 1)).toEqual({
			error_name: 'Error',
			cause: { error_name: 'Error' },
		});
	});
});

describe('bestEffort', () => {
	it('logs failures without arbitrary error messages', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		await bestEffort('audit_append', { audit_event: 'integration.create' }, () =>
			Promise.reject(new Error('bucket credential do-not-log')),
		);

		expect(spy).toHaveBeenCalledOnce();
		const line = spy.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toMatchObject({
			level: 'error',
			event: 'best_effort_operation_failed',
			operation: 'audit_append',
			audit_event: 'integration.create',
			error: { error_name: 'Error' },
		});
		expect(line).not.toContain('do-not-log');
	});

	it('does not let context fields override reserved event fields', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		await bestEffort(
			'audit_append',
			{ level: 'info', event: 'spoofed', operation: 'spoofed', error: 'spoofed', safe: true },
			() => Promise.reject(new Error('hidden')),
		);

		expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
			level: 'error',
			event: 'best_effort_operation_failed',
			operation: 'audit_append',
			safe: true,
			error: { error_name: 'Error' },
		});
	});
});

describe('appendAudit', () => {
	const auditLine = () =>
		vi
			.mocked(console.log)
			.mock.calls.map(([line]) => String(line))
			.find((line) => line.includes('background_work_failed'));

	it.each([false, true])('records running audit metrics and failures (fail=%s)', async (fail) => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const gate = Promise.withResolvers<void>();
		const host = queuedBackgroundWork();
		await appendAudit(
			{ metrics, backgroundWork: host.work },
			{ method: 'POST', path: '/test', userId: 'test' },
			'test.event',
			() => gate.promise,
		);
		expect(metrics.gauge).not.toHaveBeenCalled();
		const pending = host.runAll();
		await Promise.resolve();
		expect(metrics.gauge).toHaveBeenCalledExactlyOnceWith('background.in_flight', 1, {
			label: 'audit_append',
		});
		if (fail)
			gate.reject(
				Object.assign(new Error('secret audit credential'), {
					reason: 'secret audit credential',
					object: 'secret audit credential',
				}),
			);
		else gate.resolve();
		await pending;
		expect(metrics.gauge).toHaveBeenLastCalledWith('background.in_flight', 0, {
			label: 'audit_append',
		});
		expect(metrics.histogram).toHaveBeenCalledExactlyOnceWith(
			'background.duration_ms',
			expect.any(Number),
			{ label: 'audit_append' },
		);
		if (fail) {
			expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('background.failed', 1, {
				label: 'audit_append',
			});
			expect(JSON.parse(auditLine()!)).toMatchObject({
				level: 'error',
				event: 'background_work_failed',
				operation: 'audit_append',
				audit_event: 'test.event',
			});
			expect(auditLine()).not.toContain('secret audit credential');
		} else expect(metrics.increment).not.toHaveBeenCalled();
	});

	it('hands an unstarted audit to the lazy scheduler', async () => {
		const host = queuedBackgroundWork();
		const action = vi.fn(async () => {});
		await appendAudit(
			{ backgroundWork: host.work },
			{ method: 'POST', path: '/test', userId: 'test' },
			'test',
			action,
		);
		expect(action).not.toHaveBeenCalled();
		expect(host.labels).toEqual(['audit_append']);
		await host.runAll();
		expect(action).toHaveBeenCalledOnce();
	});

	it.each(['reject', 'queue-then-reject', 'start-then-reject'] as const)(
		'awaits fallback exactly once when the lazy scheduler does %s',
		async (mode) => {
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const action = vi.fn(() => {
				entered.resolve();
				return gate.promise;
			});
			const queued: (() => Promise<unknown>)[] = [];
			let settled = false;
			const pending = appendAudit(
				{
					backgroundWork: {
						defer: async (_label, task) => {
							if (mode === 'queue-then-reject') queued.push(task);
							if (mode === 'start-then-reject') void task();
							throw new Error('scheduler closed');
						},
					},
				},
				{ method: 'POST', path: '/test', userId: 'test' },
				'test',
				action,
			).then(() => {
				settled = true;
			});
			await entered.promise;
			expect(settled).toBe(false);
			gate.resolve();
			await pending;
			for (const task of queued) await task();
			expect(action).toHaveBeenCalledOnce();
			expect(auditLine()).toContain('audit_append');
		},
	);

	it('awaits and contains audit failure without a scheduler', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const gate = Promise.withResolvers<void>();
		let settled = false;
		const pending = appendAudit(
			{},
			{ method: 'POST', path: '/test', userId: 'test' },
			'test',
			() => gate.promise,
		).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		gate.reject(new Error('storage unavailable'));
		await expect(pending).resolves.toBeUndefined();
		expect(auditLine()).toContain('audit_append');
	});

	it('defers audit completion through a promise sink', async () => {
		const gate = Promise.withResolvers<void>();
		const kept: Promise<unknown>[] = [];
		let completed = false;
		await appendAudit(
			{ backgroundWork: backgroundWorkFrom((work) => kept.push(work)) },
			{ method: 'POST', path: '/test', userId: 'test' },
			'test',
			async () => {
				await gate.promise;
				completed = true;
			},
		);
		expect(completed).toBe(false);
		gate.resolve();
		await Promise.all(kept);
		expect(completed).toBe(true);
	});
});
