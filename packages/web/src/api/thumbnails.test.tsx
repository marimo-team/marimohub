import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonOk, renderHookWithClient } from '@/test/render';
import { useProjectThumbnails, useSaveThumbnail, useThumbnail } from './thumbnails';

afterEach(() => vi.unstubAllGlobals());

describe('thumbnail mutations', () => {
	it.each([null, new Blob(['cropped PNG'], { type: 'image/png' })])(
		'refreshes the editor and gallery metadata after a mutation',
		async (image) => {
			const requests: string[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = input instanceof Request ? input.url : String(input);
					const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
					requests.push(`${method} ${url}`);
					return jsonOk({});
				}),
			);
			const { result } = renderHookWithClient(() => {
				const gallery = useProjectThumbnails('p', true);
				const editor = useThumbnail('p', 'n');
				return { gallery, editor, save: useSaveThumbnail('p', 'n') };
			});
			await waitFor(() =>
				expect(result.current.gallery.isSuccess && result.current.editor.isSuccess).toBe(true),
			);
			await act(() => result.current.save.mutateAsync(image));
			expect(
				requests.filter(
					(request) => request.startsWith('GET') && request.endsWith('/projects/p/thumbnails'),
				),
			).toHaveLength(2);
			expect(
				requests.filter(
					(request) => request.startsWith('GET') && request.endsWith('/notebooks/n/thumbnail'),
				),
			).toHaveLength(2);
		},
	);
});
