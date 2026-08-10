import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { SyncedNotebookDialog } from './SyncedNotebookDialog';

function renderDialog(fetchImpl = vi.fn()) {
	vi.stubGlobal('fetch', fetchImpl);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = vi.fn();
	const onCreated = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(
		<SyncedNotebookDialog isOpen onClose={onClose} projectId="proj-x" onCreated={onCreated} />,
		{ wrapper },
	);
	return { onClose, onCreated };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('SyncedNotebookDialog', () => {
	it('disables Create until the required fields are filled', async () => {
		const user = userEvent.setup();
		renderDialog();

		// Branch is pre-seeded with `main`; title/repo/file are still empty.
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

		await user.type(screen.getByLabelText('Notebook name'), 'Dash');
		await user.type(screen.getByLabelText('Repository'), 'acme/analytics');
		await user.type(screen.getByLabelText('Notebook file'), 'dashboard.py');

		expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
	});

	it('marks a required field invalid once it is touched and left empty', async () => {
		const user = userEvent.setup();
		renderDialog();

		const repo = screen.getByLabelText('Repository');
		expect(repo).not.toHaveAttribute('aria-invalid', 'true');

		await user.type(repo, 'x');
		await user.clear(repo);
		await user.tab();

		expect(repo).toHaveAttribute('aria-invalid', 'true');
		expect(screen.getByText('Repository is required')).toBeInTheDocument();
	});

	it('rejects a repository that is neither owner/repo nor a repository URL', async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.type(screen.getByLabelText('Repository'), 'just-a-name');
		await user.tab();

		expect(screen.getByText(/owner\/repo or a repository URL/i)).toBeInTheDocument();
	});

	it('POSTs to the git endpoint and hands the write-once token to onCreated', async () => {
		const user = userEvent.setup();
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						success: true,
						data: {
							notebook: { id: 'nb-9', title: 'Dash' },
							sync_url: 'https://host/api/sync/git/v1/projects/proj-x/notebooks/nb-9',
							sync_token: 'mhsync_secret',
						},
					}),
					{ headers: { 'content-type': 'application/json' } },
				),
		);
		const { onCreated } = renderDialog(fetchImpl);

		await user.type(screen.getByLabelText('Notebook name'), 'Dash');
		await user.type(screen.getByLabelText('Repository'), 'acme/analytics');
		await user.type(screen.getByLabelText('Folder in repo (optional)'), 'apps');
		await user.type(screen.getByLabelText('Notebook file'), 'dashboard.py');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(String(url)).toBe('/api/v1/projects/proj-x/notebooks/git');
		expect(init).toMatchObject({ method: 'POST' });
		expect(JSON.parse(init!.body as string)).toEqual({
			title: 'Dash',
			description: 'Dash',
			repo: 'acme/analytics',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
		});
		expect(onCreated).toHaveBeenCalledWith({
			notebookId: 'nb-9',
			title: 'Dash',
			syncUrl: 'https://host/api/sync/git/v1/projects/proj-x/notebooks/nb-9',
			token: 'mhsync_secret',
		});
	});
});
