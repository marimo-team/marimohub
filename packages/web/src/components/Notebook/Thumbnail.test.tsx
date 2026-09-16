import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { thumbnailKey } from '@/api/thumbnails';
import { jsonOk, renderWithClient } from '@/test/render';
import { Thumbnail } from './Thumbnail';

afterEach(() => vi.unstubAllGlobals());

describe('gallery thumbnails', () => {
	it('shows the notebook title as a placeholder when no image is selected', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					jsonOk({ source: null, revision: null, captured_at: null, has_custom: false }),
				),
		);
		const { container, client } = renderWithClient(
			<Thumbnail projectId="p" notebookId="n" title="Sales" />,
		);
		await waitFor(() =>
			expect(client.getQueryState(thumbnailKey('p', 'n'))?.status).toBe('success'),
		);
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(container.querySelector('img')).toBeNull();
	});
	it('falls back on an image error and tries again when the thumbnail changes', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					jsonOk({ source: 'custom', revision: 'first', captured_at: null, has_custom: true }),
				),
		);
		const { container, client } = renderWithClient(
			<Thumbnail projectId="p" notebookId="n" title="Sales" />,
		);
		await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
		const original = container.querySelector('img')!;
		expect(original).toHaveAttribute('loading', 'lazy');
		expect(original).toHaveAttribute('width', '960');
		expect(original).toHaveAttribute('height', '540');
		fireEvent.error(original);
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(container.querySelector('img')).toBeNull();
		await act(async () => {
			client.setQueryData(thumbnailKey('p', 'n'), {
				source: 'automatic',
				revision: 'second',
				captured_at: null,
				has_custom: false,
			});
		});
		await waitFor(() =>
			expect(container.querySelector('img')).toHaveAttribute(
				'src',
				expect.stringContaining('second'),
			),
		);
	});
});
