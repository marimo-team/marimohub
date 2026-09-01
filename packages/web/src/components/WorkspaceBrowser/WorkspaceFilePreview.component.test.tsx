import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import { WorkspaceFilePreview } from './WorkspaceFilePreview';

const finderMocks = vi.hoisted(() => ({
	preview: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock('@marimo-team/react-finder', () => ({
	Finder: {
		Preview: ({ children }: { children: (preview: unknown) => ReactNode }) =>
			children(finderMocks.preview()),
	},
	formatFileSize: (size: number) => `${size} bytes`,
	useFinderStore: () => ({
		getState: () => ({ writeFile: finderMocks.writeFile }),
	}),
}));

vi.mock('codemirror', () => {
	throw new Error('chunk unavailable');
});

beforeEach(() => {
	const bytes = new TextEncoder().encode('SELECT 1;');
	finderMocks.preview.mockReturnValue({
		item: {
			path: 'query.sql',
			name: 'query.sql',
			kind: 'file',
			size: bytes.byteLength,
			mimeType: 'text/plain',
		},
		content: {
			status: 'success',
			blob: {
				size: bytes.byteLength,
				arrayBuffer: () => Promise.resolve(bytes.buffer),
			},
		},
	});
});

describe('WorkspaceFilePreview', () => {
	it('shows a fallback when the text editor runtime fails to load', async () => {
		renderWithClient(
			<WorkspaceFilePreview
				path="query.sql"
				access={{ writable: true, read_only_reason: null, protected_paths: [] }}
				onDirtyChange={vi.fn()}
			/>,
			{ toaster: false },
		);

		expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the text editor:');
		expect(screen.getByText('query.sql')).toBeInTheDocument();
	});
});
