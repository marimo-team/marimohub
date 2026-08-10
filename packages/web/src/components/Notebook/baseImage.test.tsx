import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { systemKeys } from '@/api/queryKeys';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import {
	DEFAULT_BASE_IMAGE,
	baseImageOptions,
	imageLabel,
	parseImageRef,
	useSandboxImages,
} from './baseImage';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('parseImageRef', () => {
	it('splits a tagged reference', () => {
		expect(parseImageRef('ghcr.io/marimo-team/marimo-sandbox:py3.13-marimo0.23.16')).toEqual({
			repository: 'ghcr.io/marimo-team/marimo-sandbox',
			tag: 'py3.13-marimo0.23.16',
			digest: undefined,
		});
	});

	it('splits a digest pin', () => {
		expect(parseImageRef('ghcr.io/marimo-team/marimo-sandbox@sha256:abc123')).toEqual({
			repository: 'ghcr.io/marimo-team/marimo-sandbox',
			tag: undefined,
			digest: 'sha256:abc123',
		});
	});

	it('does not mistake a registry port for a tag', () => {
		expect(parseImageRef('localhost:5000/img')).toEqual({
			repository: 'localhost:5000/img',
			tag: undefined,
			digest: undefined,
		});
	});
});

describe('imageLabel', () => {
	it('prettifies the published marimo tag convention', () => {
		expect(imageLabel('ghcr.io/marimo-team/marimo-sandbox:py3.13-marimo0.23.16')).toBe(
			'marimo 0.23.16 · Python 3.13',
		);
	});

	it('falls back to the bare tag for any other convention', () => {
		expect(imageLabel('ghcr.io/acme/kernel:cuda12')).toBe('cuda12');
	});

	it('names the image and abbreviates the hash for a digest pin', () => {
		expect(
			imageLabel(
				'ghcr.io/marimo-team/marimo-sandbox@sha256:574845a49db05398e1ebfb06182affe0fcfd6d9e',
			),
		).toBe('marimo-sandbox@574845a49db0');
	});

	it('uses the bare name when there is no tag or digest', () => {
		expect(imageLabel('ghcr.io/acme/kernel')).toBe('kernel');
	});
});

describe('baseImageOptions', () => {
	it('offers only Default, undescribed, when no images are configured', () => {
		expect(baseImageOptions([])).toEqual([
			{ value: DEFAULT_BASE_IMAGE, label: 'Default', description: undefined },
		]);
	});

	it('names the default image and shows the full reference under each option', () => {
		const latest = 'ghcr.io/marimo-team/marimo-sandbox:py3.13-marimo0.23.16';
		const previous = 'ghcr.io/marimo-team/marimo-sandbox:py3.13-marimo0.23.11';
		expect(baseImageOptions([latest, previous])).toEqual([
			{
				value: DEFAULT_BASE_IMAGE,
				label: 'Default (marimo 0.23.16 · Python 3.13)',
				description: latest,
			},
			{ value: latest, label: 'marimo 0.23.16 · Python 3.13', description: latest },
			{ value: previous, label: 'marimo 0.23.11 · Python 3.13', description: previous },
		]);
	});

	it('omits a description that would merely repeat the label', () => {
		expect(baseImageOptions(['a', 'b'])).toEqual([
			{ value: DEFAULT_BASE_IMAGE, label: 'Default (a)', description: 'a' },
			{ value: 'a', label: 'a', description: undefined },
			{ value: 'b', label: 'b', description: undefined },
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

	it('falls back to no images on a capabilities failure instead of throwing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonError('INTERNAL', 'capabilities unavailable', 500)),
		);

		const { result, client } = renderHookWithClient(() => useSandboxImages(), {
			toaster: false,
			errorBoundary: true,
		});

		await waitFor(() =>
			expect(client.getQueryState(systemKeys.capabilities())?.status).toBe('error'),
		);
		// The grant-nothing fallback: consumers render without profile choices
		// rather than crashing the page into the boundary.
		expect(screen.queryByText('Request failed')).not.toBeInTheDocument();
		expect(result.current).toEqual([]);
	});
});
