import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { systemKeys } from '@/api/queryKeys';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { DEFAULT_BASE_IMAGE, baseImageOptions, useSandboxImages } from './baseImage';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('baseImageOptions', () => {
	it('offers only Default, undescribed, when no images are configured', () => {
		expect(baseImageOptions([])).toEqual([
			{ value: DEFAULT_BASE_IMAGE, label: 'Default', description: undefined },
		]);
	});

	it('describes Default with the first image and lists every image in order', () => {
		expect(baseImageOptions(['a', 'b'])).toEqual([
			{ value: DEFAULT_BASE_IMAGE, label: 'Default', description: 'a' },
			{ value: 'a', label: 'a' },
			{ value: 'b', label: 'b' },
		]);
	});
});

describe('useSandboxImages', () => {
	it('returns an empty list until the capabilities query resolves', async () => {
		let resolveCapabilities: (response: Response) => void = () => {};
		const inFlight = new Promise<Response>((resolve) => {
			resolveCapabilities = resolve;
		});
		const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) => inFlight);
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useSandboxImages(), { toaster: false });

		expect(result.current).toEqual([]);
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/capabilities');

		resolveCapabilities(jsonOk({ sandbox_images: ['img-a', 'img-b'] }));

		await waitFor(() => expect(result.current).toEqual(['img-a', 'img-b']));
	});

	it('returns an empty list when the capabilities query fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonError('INTERNAL', 'capabilities unavailable', 500)),
		);

		const { result, client } = renderHookWithClient(() => useSandboxImages(), { toaster: false });

		await waitFor(() =>
			expect(client.getQueryState(systemKeys.capabilities())?.status).toBe('error'),
		);
		expect(result.current).toEqual([]);
	});
});
