import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeKernelLiveness } from './kernelProbe';

const URL = 'http://kernel.local';
type Outcome = number | 'refused' | 'timeout';

function sequenceFetch(...outcomes: Outcome[]) {
	const fetchImpl = vi.fn<typeof fetch>();
	for (const outcome of outcomes) {
		fetchImpl.mockImplementationOnce(async (_url, init) => {
			if (outcome === 'refused') throw new Error('ECONNREFUSED');
			if (outcome === 'timeout') {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true,
					});
				});
			}
			return new Response(null, { status: outcome });
		});
	}
	return fetchImpl;
}

describe('probeKernelLiveness', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it.each([200, 204, 302, 401, 403, 404, 500])('reports alive on HTTP %i', async (status) => {
		const fetchImpl = sequenceFetch(status);
		expect(await probeKernelLiveness(URL, { fetchImpl })).toBe('alive');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	const outcomes = [200, 502, 503, 504, 'refused', 'timeout'] as const;
	it.each(outcomes.flatMap((first) => outcomes.map((second) => ({ first, second }))))(
		'classifies $first followed by $second',
		async ({ first, second }) => {
			const fetchImpl = sequenceFetch(first, second);
			const result = probeKernelLiveness(URL, { fetchImpl });
			await vi.runAllTimersAsync();

			const expected =
				first === 200 || second === 200
					? 'alive'
					: first === 'timeout' && second === 'timeout'
						? 'unresponsive'
						: 'dead';
			expect(await result).toBe(expected);
			expect(fetchImpl).toHaveBeenCalledTimes(first === 200 ? 1 : 2);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([
		{ outcomes: ['refused', 'timeout', 'timeout'], expected: 'dead' },
		{ outcomes: ['timeout', 'refused', 200], expected: 'alive' },
		{ outcomes: ['timeout', 'timeout', 'timeout'], expected: 'unresponsive' },
	] satisfies { outcomes: Outcome[]; expected: string }[])(
		'classifies three attempts: $outcomes',
		async ({ outcomes, expected }) => {
			const fetchImpl = sequenceFetch(...outcomes);
			const result = probeKernelLiveness(URL, { fetchImpl, attempts: 3 });
			await vi.runAllTimersAsync();
			expect(await result).toBe(expected);
			expect(fetchImpl).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([-1, 0, 1])('makes one attempt when attempts is %i', async (attempts) => {
		const fetchImpl = sequenceFetch('timeout');
		const result = probeKernelLiveness(URL, { fetchImpl, attempts, timeoutMs: 5 });
		await vi.advanceTimersByTimeAsync(5);
		expect(await result).toBe('unresponsive');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('waits for the retry delay after an attempt times out', async () => {
		const fetchImpl = sequenceFetch('timeout', 200);
		const result = probeKernelLiveness(URL, { fetchImpl, timeoutMs: 50, retryDelayMs: 25 });
		await vi.advanceTimersByTimeAsync(74);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toBe('alive');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([new Error('synchronous failure'), new DOMException('aborted', 'AbortError')])(
		'does not mistake an unrelated fetch failure for its own timeout: %s',
		async (error) => {
			const fetchImpl = vi.fn<typeof fetch>(() => {
				throw error;
			});
			expect(await probeKernelLiveness(URL, { fetchImpl, attempts: 1 })).toBe('dead');
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('GETs the bare url with manual redirect (no /health, no body)', async () => {
		const fetchImpl = sequenceFetch(200);
		await probeKernelLiveness(URL, { fetchImpl });
		expect(fetchImpl).toHaveBeenCalledWith(
			URL,
			expect.objectContaining({ method: 'GET', redirect: 'manual' }),
		);
	});
});
