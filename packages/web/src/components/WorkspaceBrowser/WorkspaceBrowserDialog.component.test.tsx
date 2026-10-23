import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import WorkspaceBrowserDialog from './WorkspaceBrowserDialog';

afterEach(() => vi.unstubAllGlobals());

it('keeps read-only browsing available when capabilities fail', async () => {
	installMatchMedia();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | Request) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/capabilities')) return jsonError('INTERNAL_ERROR', 'Unavailable', 500);
			if (url.includes('/workspace/access'))
				return jsonOk({ writable: false, read_only_reason: 'viewer', protected_paths: [] });
			if (url.includes('/workspace/entries'))
				return jsonOk({ items: [{ path: '/data.csv', name: 'data.csv', kind: 'file', size: 3 }] });
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	renderWithClient(
		<WorkspaceBrowserDialog
			projectId="project"
			notebookId="notebook"
			notebookTitle="Notebook"
			isOpen
			onClose={vi.fn()}
		/>,
		{ toaster: false },
	);
	expect((await screen.findAllByText('data.csv')).length).toBeGreaterThan(0);
	expect(
		screen.getByText('Your project role allows browsing, but not workspace changes.'),
	).toBeInTheDocument();
	expect(screen.getByRole('button', { name: 'New Folder' })).toBeDisabled();
	expect(screen.getByRole('button', { name: 'New File' })).toBeDisabled();
});
