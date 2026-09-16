import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeInActiveKernel, KernelDiscoveryTimeoutError } from './activeKernel';

const base = 'https://kernel.example';
const rejected = () => Response.json({ detail: 'Invalid session id: old' }, { status: 500 });
const done = () =>
	new Response('event: done\ndata: {"success":true}\n\n', {
		headers: { 'content-type': 'text/event-stream' },
	});
afterEach(() => vi.useRealTimers());

describe('active kernel execution', () => {
	it('shares a deadline across discovery, rejection, and rediscovery', async () => {
		vi.useFakeTimers();
		const initial = Date.now();
		let requests = 0;
		let discoverySignal: AbortSignal | null | undefined;
		const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			requests++;
			if (requests === 1) {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return Response.json({ old: {} });
			}
			if (requests === 2) return rejected();
			discoverySignal = init?.signal;
			return new Promise<Response>(() => {});
		});
		const pending = executeInActiveKernel(
			base,
			{ code: 'side_effect()' },
			{ fetchImpl, deadlineAt: initial + 100 },
		);
		const assertion = expect(pending).rejects.toBeInstanceOf(KernelDiscoveryTimeoutError);
		await vi.advanceTimersByTimeAsync(100);
		await assertion;
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(discoverySignal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([true, false])(
		'does not dispatch when canceled (before discovery: %s)',
		async (beforeDiscovery) => {
			const controller = new AbortController();
			const fetchImpl = vi.fn(async () => {
				controller.abort(new Error('Stopped'));
				return Response.json({ old: {} });
			});
			if (beforeDiscovery) controller.abort(new Error('Stopped'));
			await expect(
				executeInActiveKernel(
					base,
					{ code: 'side_effect()' },
					{ fetchImpl, signal: controller.signal, deadlineAt: Date.now() + 1000 },
				),
			).rejects.toThrow('Stopped');
			expect(fetchImpl).toHaveBeenCalledTimes(beforeDiscovery ? 0 : 1);
		},
	);
	it('does not dispatch after discovery consumes the deadline', async () => {
		vi.useFakeTimers();
		const deadlineAt = Date.now() + 100;
		const fetchImpl = vi.fn(async () => {
			vi.setSystemTime(deadlineAt);
			return Response.json({ old: {} });
		});
		await expect(
			executeInActiveKernel(base, { code: 'side_effect()' }, { fetchImpl, deadlineAt }),
		).rejects.toBeInstanceOf(KernelDiscoveryTimeoutError);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});
	it.each([{}, { old: {} }])(
		'does not replay a stale ID after rediscovery returns %j',
		async (sessions) => {
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(Response.json({ old: {} }))
				.mockResolvedValueOnce(rejected())
				.mockResolvedValueOnce(Response.json(sessions));
			const pending = executeInActiveKernel(
				base,
				{ code: 'side_effect()' },
				{ fetchImpl, deadlineAt: Date.now() + 1000 },
			);
			if ('old' in sessions) await expect(pending).rejects.toThrow('Invalid session id: old');
			else await expect(pending).resolves.toBeUndefined();
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		},
	);
	it('preserves authentication and code when retrying a definitively rejected request', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ old: {} }))
			.mockResolvedValueOnce(rejected())
			.mockResolvedValueOnce(Response.json({ new: {} }))
			.mockResolvedValueOnce(done());
		expect(
			await executeInActiveKernel(
				base,
				{ code: 'side_effect()' },
				{ fetchImpl, kernelAuthToken: 'test-token', deadlineAt: Date.now() + 1000 },
			),
		).toMatchObject({ sessionId: 'new', executed: { success: true } });
		for (const [, init] of fetchImpl.mock.calls)
			expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
		for (const index of [1, 3])
			expect(fetchImpl.mock.calls[index][1].body).toBe('{"code":"side_effect()"}');
	});
});
