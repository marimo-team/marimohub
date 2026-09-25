import { afterEach, describe, expect, it, vi } from 'vitest';
import { devApiTarget, waitForDevApi } from '../devProxy';

describe('devApiTarget', () => {
	it.each([
		[{}, 'http://127.0.0.1:3000'],
		[{ DEV_HOST: '127.42.0.1', PORT: '4100' }, 'http://127.42.0.1:4100'],
		[{ DEV_HOST: '::1' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0:0:0:0:0:0:0:1' }, 'http://[0:0:0:0:0:0:0:1]:3000'],
		[{ DEV_HOST: '2001:db8::5' }, 'http://[2001:db8::5]:3000'],
		[{ DEV_HOST: '0.0.0.0' }, 'http://127.0.0.1:3000'],
		[{ DEV_HOST: '::' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0:0:0:0:0:0:0:0' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0::0' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '::0' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0000::0000' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '::0.0.0.0' }, 'http://[::1]:3000'],
	])('uses the API bind host for %j', (env, expected) => {
		expect(devApiTarget(env)).toBe(expected);
	});
});

describe('waitForDevApi', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('waits through connection errors and unhealthy responses before allowing startup', async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce(Response.json({ status: 'ok' }, { status: 503 }))
			.mockResolvedValueOnce(new Response('not JSON'))
			.mockResolvedValueOnce(Response.json({ status: 'starting' }))
			.mockResolvedValueOnce(Response.json({ status: 'ok' }));
		vi.stubGlobal('fetch', fetchMock);
		const ready = vi.fn();
		const waiting = waitForDevApi('http://127.42.0.1:4100').then(ready);
		await vi.advanceTimersByTimeAsync(999);
		expect(ready).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(ready).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(fetchMock).toHaveBeenLastCalledWith(new URL('http://127.42.0.1:4100/api/health'), {
			signal: expect.any(AbortSignal),
		});
	});

	it('does not delay startup when the API is already healthy', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'ok' }));
		vi.stubGlobal('fetch', fetchMock);
		await waitForDevApi('http://[::1]:4100');
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('reports the health URL when the API never starts', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')));
		const waiting = expect(waitForDevApi('http://127.0.0.1:4100', 500)).rejects.toThrow(
			'Timed out waiting for the development API at http://127.0.0.1:4100/api/health. Check the API server logs.',
		);
		await vi.advanceTimersByTimeAsync(500);
		await waiting;
	});

	it('bounds a health request that never responds', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>().mockImplementation(
				(_url, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')), {
							once: true,
						});
					}),
			),
		);
		await expect(waitForDevApi('http://127.0.0.1:4100', 20)).rejects.toThrow('Timed out waiting');
	});
});
