import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub, IacError, integration, IntegrationPlan } from './index';

const spec = integration('agent_context', 'context', { instructions: 'private-config' });
const planned = {
	name: spec.name,
	kind: spec.kind,
	action: 'create',
	changed_paths: ['config'],
	precondition: { state: 'absent' },
	org_override: false,
};
const outcome = {
	name: spec.name,
	kind: spec.kind,
	id: 'i',
	action: 'created',
	current_version: 1,
	config_changed: true,
};
const ok = (data: unknown) => Response.json({ success: true, data });
const scope = (fetch: typeof globalThis.fetch, options = {}) =>
	createHub({ url: 'https://hub.example', token: 'private-token', fetch, ...options }).project('p')
		.integrations;
afterEach(() => vi.useRealTimers());

describe('transport failures', () => {
	it.each([401, 403, 422])('never retries HTTP %i or includes provider details', async (status) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async () => new Response('private-provider', { status }));
		const error = await scope(fetch)
			.upsert(spec)
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ status, uncertain: false });
		expect(String(error)).not.toContain('private');
		expect(fetch).toHaveBeenCalledOnce();
	});
	it.each(['2', 'Thu, 01 Jan 2026 00:00:02 GMT'])('honors Retry-After %s', async (retryAfter) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } }),
			)
			.mockResolvedValueOnce(ok(planned));
		const pending = scope(fetch).plan([spec]);
		await vi.advanceTimersByTimeAsync(1999);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toMatchObject({ items: [planned] });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it('uses backoff for malformed Retry-After and bounds attempts', async () => {
		vi.useFakeTimers();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(
				async () => new Response(null, { status: 429, headers: { 'Retry-After': 'nonsense' } }),
			);
		const pending = scope(fetch, { maxAttempts: 2 }).plan([spec]);
		const rejected = expect(pending).rejects.toMatchObject({ status: 429 });
		await vi.advanceTimersByTimeAsync(49);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it('does not overflow large Retry-After delays and cancels waiting', async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
			async () =>
				new Response(null, {
					status: 429,
					headers: { 'Retry-After': '999999999999999999999999999999999999999999' },
				}),
		);
		const pending = scope(fetch).plan([spec], { signal: abort.signal });
		const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledOnce();
		abort.abort();
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([
		null,
		{},
		{ success: false, data: planned },
		{ success: true, data: { ...planned, changed_paths: [1] } },
		{ success: true, data: { ...planned, precondition: { state: 'existing', id: 'i' } } },
	])('rejects malformed plan envelopes %# without retrying', async (body) => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body));
		await expect(scope(fetch).plan([spec])).rejects.toMatchObject({
			code: 'PARSE_ERROR',
			uncertain: false,
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
	it.each([
		'not-json',
		JSON.stringify({ success: true, data: { ...outcome, current_version: '1' } }),
		JSON.stringify({ success: true, data: { ...outcome, current_version: -1 } }),
	])('marks malformed mutation responses uncertain %#', async (body) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockResolvedValueOnce(new Response(body));
		await expect(scope(fetch).insert(spec)).rejects.toMatchObject({
			code: 'PARSE_ERROR',
			uncertain: true,
			report: { failed: { uncertain: true } },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it.each(['', () => Promise.reject(new Error('private-token'))])(
		'rejects missing or failed tokens before fetching %#',
		async (token) => {
			const fetch = vi.fn<typeof globalThis.fetch>();
			await expect(scope(fetch, { token }).plan([spec])).rejects.toMatchObject({
				code: 'AUTH_ERROR',
				uncertain: false,
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it('retains mutation uncertainty when a later read fails', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockRejectedValueOnce(new Error('lost response'))
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		await expect(scope(fetch).upsert(spec)).rejects.toMatchObject({
			code: 'FORBIDDEN',
			uncertain: true,
		});
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it('retains mutation uncertainty when cancelled during recovery delay', async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockRejectedValueOnce(new Error('lost response'));
		const pending = scope(fetch).upsert(spec, { signal: abort.signal });
		const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED', uncertain: true });
		await vi.advanceTimersByTimeAsync(1);
		abort.abort();
		await rejected;
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe('local input and plan boundaries', () => {
	it.each([0, -1, 0.5, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects unsupported timeout %s as IacError',
		(timeoutMs) => {
			expect(() => createHub({ url: 'https://hub.example', token: 't', timeoutMs })).toThrow(
				IacError,
			);
		},
	);
	it.each([0, 1.5, 11, Number.NaN])('rejects unsupported attempt count %s', (maxAttempts) => {
		expect(() => createHub({ url: 'https://hub.example', token: 't', maxAttempts })).toThrow(
			IacError,
		);
	});
	it.each([
		'bad-url',
		'file:///private-token',
		'https://user:private-token@hub.example',
		'https://hub.example?token=private-token',
		'https://hub.example#private-token',
	])('rejects unsafe URL %# without echoing it', (url) => {
		try {
			createHub({ url, token: 't' });
			throw new Error('Expected validation');
		} catch (error) {
			expect(error).toBeInstanceOf(IacError);
			expect(String(error)).not.toContain('private-token');
		}
	});
	it('applies empty plans without fetching and rejects forged plans', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const target = scope(fetch);
		expect(await target.apply(await target.plan([]))).toEqual({ completed: [], notAttempted: [] });
		await expect(target.apply(new IntegrationPlan([]))).rejects.toMatchObject({
			code: 'INVALID_PLAN',
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it('snapshots declarations before asynchronous planning and preserves reviewed preconditions on replay', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockResolvedValueOnce(ok(outcome))
			.mockResolvedValueOnce(new Response(null, { status: 412 }));
		const target = scope(fetch);
		const input = { ...spec, config: { instructions: 'original' } };
		const pending = target.plan([input]);
		input.config.instructions = 'changed';
		const plan = await pending;
		await target.apply(plan);
		await expect(target.apply(plan)).rejects.toMatchObject({
			code: 'PRECONDITION_FAILED',
			uncertain: false,
		});
		for (const [, init] of fetch.mock.calls.slice(1))
			expect(JSON.parse(String(init?.body))).toMatchObject({
				desired: { config: { instructions: 'original' } },
				expected: { state: 'absent' },
			});
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it('projects safe response fields rather than leaking unknown server data', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				ok({
					...planned,
					config: 'private-config',
					precondition: { state: 'absent', token: 'private-token' },
				}),
			)
			.mockResolvedValueOnce(ok({ ...outcome, config: 'private-config' }));
		const target = scope(fetch);
		const plan = await target.plan([spec]);
		expect(JSON.stringify(plan)).not.toContain('private');
		expect(await target.apply(plan)).toEqual({ completed: [outcome], notAttempted: [] });
	});
	it('sanitizes custom validation failures and snapshots successful custom declarations', () => {
		expect(() =>
			integration.custom('custom', 'name', {}, () => {
				throw new Error('private-config');
			}),
		).toThrow('Custom integration validation failed.');
		const config = { nested: { value: 1 } };
		const custom = integration.custom('custom', 'name', config, () => {});
		config.nested.value = 2;
		expect(custom.config).toEqual({ nested: { value: 1 } });
		expect(Object.isFrozen(custom.config.nested)).toBe(true);
	});
});

it.each([401, 403, 422])(
	'does not retry definitive apply status %i or mark it uncertain',
	async (status) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockResolvedValueOnce(new Response(null, { status }));
		await expect(scope(fetch).upsert(spec)).rejects.toMatchObject({
			status,
			uncertain: false,
			report: { failed: { uncertain: false } },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	},
);
it('reports uncertainty consistently if recovery reaches another rejected apply', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(ok(planned))
		.mockRejectedValueOnce(new Error('lost response'))
		.mockResolvedValueOnce(ok(planned))
		.mockResolvedValueOnce(new Response(null, { status: 403 }));
	await expect(scope(fetch).upsert(spec)).rejects.toMatchObject({
		status: 403,
		uncertain: true,
		report: { failed: { uncertain: true } },
	});
	expect(fetch).toHaveBeenCalledTimes(4);
});
it('does not mark a failed token refresh before apply as an uncertain write', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(ok(planned));
	const token = vi
		.fn()
		.mockResolvedValueOnce('t')
		.mockRejectedValueOnce(new Error('private-token'));
	await expect(scope(fetch, { token }).upsert(spec)).rejects.toMatchObject({
		code: 'AUTH_ERROR',
		uncertain: false,
		report: { failed: { uncertain: false } },
	});
	expect(fetch).toHaveBeenCalledOnce();
});
