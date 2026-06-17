import { describe, expect, it, vi } from 'vitest';
import { probeKernelLiveness } from './kernelProbe';

/** A `fetch` stub that returns the given status, recording call count. */
function statusFetch(status: number) {
	const fn = vi.fn(async () => new Response(null, { status }));
	return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const URL = 'http://kernel.local';

describe('probeKernelLiveness', () => {
	it.each([200, 204, 302, 401, 403, 404])('reports alive on HTTP %i', async (status) => {
		const fetchImpl = statusFetch(status);
		expect(await probeKernelLiveness(URL, { fetchImpl })).toBe('alive');
		// Alive on the first attempt → single round-trip, no retry.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it.each([502, 503, 504])('reports dead on gateway status %i', async (status) => {
		const fetchImpl = statusFetch(status);
		expect(await probeKernelLiveness(URL, { fetchImpl, attempts: 2, retryDelayMs: 0 })).toBe(
			'dead',
		);
		// Dead is only declared after the last attempt.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('reports dead when fetch throws (connection refused)', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		expect(await probeKernelLiveness(URL, { fetchImpl, attempts: 1 })).toBe('dead');
	});

	it('reports dead when the request is aborted by the timeout', async () => {
		// Honor the abort signal so the AbortController + timeout path is exercised.
		const fetchImpl = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			})) as unknown as typeof fetch;
		expect(await probeKernelLiveness(URL, { fetchImpl, attempts: 1, timeoutMs: 5 })).toBe('dead');
	});

	it('retries a transient gateway blip, then reports alive', async () => {
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			return new Response(null, { status: calls === 1 ? 503 : 200 });
		}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
		expect(await probeKernelLiveness(URL, { fetchImpl, attempts: 2, retryDelayMs: 0 })).toBe(
			'alive',
		);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('GETs the bare url with manual redirect (no /health, no body)', async () => {
		const fetchImpl = vi.fn(
			async () => new Response(null, { status: 200 }),
		) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
		await probeKernelLiveness(URL, { fetchImpl });
		expect(fetchImpl).toHaveBeenCalledWith(
			URL,
			expect.objectContaining({ method: 'GET', redirect: 'manual' }),
		);
	});
});
