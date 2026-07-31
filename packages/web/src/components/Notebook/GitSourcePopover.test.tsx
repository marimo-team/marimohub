import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GitSourcePopover } from './GitSourcePopover';

const PID = 'proj-1';
const NID = 'nb-1';

function renderPopover(source: Record<string, unknown>) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						data: { meta: { id: NID, title: 'NB', author: 'u-1' }, source },
					}),
					{ headers: { 'content-type': 'application/json' } },
				),
		),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<GitSourcePopover projectId={PID} notebookId={NID} trigger={<span>git</span>} />, {
		wrapper,
	});
}

const GIT_SOURCE = {
	type: 'git',
	provider: 'github',
	repo: 'acme/analytics',
	branch: 'main',
	root_path: 'apps',
	entry_notebook: 'dashboard.py',
	commit: 'abc123def456',
	current_version_id: 'v1',
	last_synced_at: '2026-07-01T10:00:00Z',
};

beforeEach(() => {
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('GitSourcePopover', () => {
	it('links repo, commit, and source for a GitHub owner/repo source', async () => {
		renderPopover(GIT_SOURCE);
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByRole('link', { name: 'acme/analytics' })).toHaveAttribute(
			'href',
			'https://github.com/acme/analytics',
		);
		expect(screen.getByRole('link', { name: 'abc123d' })).toHaveAttribute(
			'href',
			'https://github.com/acme/analytics/commit/abc123def456',
		);
		expect(screen.getByRole('link', { name: /View source on GitHub/ })).toHaveAttribute(
			'href',
			'https://github.com/acme/analytics/blob/abc123def456/apps/dashboard.py',
		);
	});

	it('renders metadata without links when the repo is not plain owner/repo', async () => {
		renderPopover({ ...GIT_SOURCE, repo: 'git@github.com:acme/analytics.git' });
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('git@github.com:acme/analytics.git')).toBeInTheDocument();
		expect(screen.getByText('abc123d')).toBeInTheDocument();
		expect(screen.getByText('apps/dashboard.py')).toBeInTheDocument();
		expect(screen.queryByRole('link')).toBeNull();
	});
});
