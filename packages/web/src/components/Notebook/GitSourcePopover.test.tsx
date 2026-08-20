import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GitSourcePopover } from './GitSourcePopover';

const PID = 'proj-1';
const NID = 'nb-1';

function renderPopover(
	source: Record<string, unknown>,
	options: { canSync?: boolean; syncProviders?: string[] } = {},
) {
	const json = (data: unknown) =>
		new Response(JSON.stringify({ success: true, data }), {
			headers: { 'content-type': 'application/json' },
		});
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/capabilities')) {
				return json({
					source_control: {
						change_request_providers: [],
						sync_providers: options.syncProviders ?? [],
					},
				});
			}
			if (url.endsWith('/source/drift')) {
				return json({
					current_commit: source.commit,
					remote_commit: source.commit,
					in_sync: true,
					pending_config: false,
					checked_at: '2026-07-01T11:00:00Z',
				});
			}
			return json({ meta: { id: NID, title: 'NB', author: 'u-1' }, source });
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<GitSourcePopover
			projectId={PID}
			notebookId={NID}
			trigger={<span>git</span>}
			canSync={options.canSync}
		/>,
		{ wrapper },
	);
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
		expect(screen.getByRole('link', { name: 'main' })).toHaveAttribute(
			'href',
			'https://github.com/acme/analytics/tree/main',
		);
		expect(screen.getByRole('link', { name: 'apps/dashboard.py' })).toHaveAttribute(
			'href',
			'https://github.com/acme/analytics/blob/abc123def456/apps/dashboard.py',
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

	it('links a self-hosted GitLab URL repo with GitLab deep-link paths', async () => {
		renderPopover({
			...GIT_SOURCE,
			provider: 'gitlab',
			repo: 'https://my-gitlab-url.my-company.org/group1/marimo/nb',
		});
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('Synced from GitLab')).toBeInTheDocument();
		expect(
			screen.getByRole('link', { name: 'https://my-gitlab-url.my-company.org/group1/marimo/nb' }),
		).toHaveAttribute('href', 'https://my-gitlab-url.my-company.org/group1/marimo/nb');
		expect(screen.getByRole('link', { name: 'main' })).toHaveAttribute(
			'href',
			'https://my-gitlab-url.my-company.org/group1/marimo/nb/-/tree/main',
		);
		expect(screen.getByRole('link', { name: 'apps/dashboard.py' })).toHaveAttribute(
			'href',
			'https://my-gitlab-url.my-company.org/group1/marimo/nb/-/blob/abc123def456/apps/dashboard.py',
		);
		expect(screen.getByRole('link', { name: 'abc123d' })).toHaveAttribute(
			'href',
			'https://my-gitlab-url.my-company.org/group1/marimo/nb/-/commit/abc123def456',
		);
		expect(screen.getByRole('link', { name: /View source on GitLab/ })).toBeInTheDocument();
	});

	it('renders metadata without links when the host is not recognized', async () => {
		renderPopover({
			...GIT_SOURCE,
			provider: null,
			repo: 'https://code.my-company.org/team/repo',
		});
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('Synced from a git repository')).toBeInTheDocument();
		expect(screen.getByText('https://code.my-company.org/team/repo')).toBeInTheDocument();
		expect(screen.getByText('abc123d')).toBeInTheDocument();
		expect(screen.getByText('apps/dashboard.py')).toBeInTheDocument();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('renders metadata without links when the repo is a legacy git@ remote', async () => {
		renderPopover({ ...GIT_SOURCE, repo: 'git@github.com:acme/analytics.git' });
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('git@github.com:acme/analytics.git')).toBeInTheDocument();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('shows drift and Sync now for an editor when the provider supports server sync', async () => {
		renderPopover(GIT_SOURCE, { canSync: true, syncProviders: ['github'] });
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText(/in sync at/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
	});

	it('hides server-sync chrome without editor access even when a reader exists', async () => {
		renderPopover(GIT_SOURCE, { syncProviders: ['github'] });
		await userEvent.click(screen.getByRole('button'));

		await screen.findByRole('link', { name: 'acme/analytics' });
		expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
	});

	it('hides server-sync chrome for an editor when no reader covers the provider', async () => {
		renderPopover(GIT_SOURCE, { canSync: true, syncProviders: [] });
		await userEvent.click(screen.getByRole('button'));

		await screen.findByRole('link', { name: 'acme/analytics' });
		expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
	});
});
