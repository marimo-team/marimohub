import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonOk, renderWithClient } from '@/test/render';
import { SyncSettingsDialog } from './SyncSettingsDialog';

const PID = 'proj-x';
const NID = 'nb-9';
const SYNC_URL = `https://host/api/sync/git/v1/projects/${PID}/notebooks/${NID}`;

const activeSource = {
	type: 'git' as const,
	provider: 'github' as const,
	repo: 'acme/analytics',
	branch: 'main',
	root_path: 'apps',
	entry_notebook: 'dashboard.py',
	sync_mode: 'push' as const,
	current_version_id: 'ver-1',
	commit: 'abcdef1234567890',
	last_synced_at: '2025-03-05T14:00:00Z',
};

function setup(options: { canEdit?: boolean; initialToken?: string; pending?: boolean }) {
	const calls: { method: string; url: string; body?: unknown }[] = [];
	const source = options.pending
		? {
				...activeSource,
				pending_config: {
					repo: 'acme/new-analytics',
					branch: 'release',
					root_path: 'notebooks',
					entry_notebook: 'new_dashboard.py',
				},
			}
		: activeSource;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = init?.body ? JSON.parse(init.body as string) : undefined;
			calls.push({ method, url, body });
			if (method === 'GET') {
				return jsonOk({
					meta: { id: NID, title: 'Dash' },
					readme: null,
					source,
				});
			}
			if (method === 'PATCH') {
				return jsonOk({
					source: { ...source, pending_config: body },
				});
			}
			if (method === 'POST' && url.endsWith('/sync-token/rotate')) {
				return jsonOk({ sync_url: SYNC_URL, sync_token: 'mhsync_rotated' });
			}
			throw new Error(`unexpected fetch: ${method} ${url}`);
		}),
	);
	const onClose = vi.fn();
	renderWithClient(
		<SyncSettingsDialog
			isOpen
			onClose={onClose}
			projectId={PID}
			notebookId={NID}
			title="Dash"
			syncUrl={SYNC_URL}
			canEdit={options.canEdit ?? true}
			initialToken={options.initialToken}
		/>,
	);
	return { calls, onClose };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('SyncSettingsDialog', () => {
	it('shows the source configuration, sync URL, and last-sync metadata', async () => {
		setup({});

		await waitFor(() => expect(screen.getByLabelText('Repository')).toHaveValue('acme/analytics'));
		expect(screen.getByLabelText('Branch')).toHaveValue('main');
		expect(screen.getByLabelText('Folder in repo (optional)')).toHaveValue('apps');
		expect(screen.getByLabelText('Notebook file')).toHaveValue('dashboard.py');
		expect(screen.getByLabelText('Sync URL')).toHaveValue(SYNC_URL);
		expect(screen.getByText(/last synced/i)).toBeInTheDocument();
	});

	it('shows desired settings while explaining which active source remains served', async () => {
		setup({ pending: true });

		await waitFor(() =>
			expect(screen.getByLabelText('Repository')).toHaveValue('acme/new-analytics'),
		);
		expect(screen.getByLabelText('Branch')).toHaveValue('release');
		expect(screen.getByText(/changes are pending/i)).toBeInTheDocument();
		expect(screen.getByText(/acme\/analytics · main · apps\/dashboard.py/i)).toBeInTheDocument();
	});

	it('PATCHes all four edited source fields', async () => {
		const user = userEvent.setup();
		const { calls, onClose } = setup({});

		await waitFor(() => expect(screen.getByLabelText('Repository')).toHaveValue('acme/analytics'));
		const repo = screen.getByLabelText('Repository');
		await user.clear(repo);
		await user.type(repo, 'acme/new-repo');
		const branch = screen.getByLabelText('Branch');
		await user.clear(branch);
		await user.type(branch, 'release');
		const folder = screen.getByLabelText('Folder in repo (optional)');
		await user.clear(folder);
		await user.type(folder, 'notebooks');
		const file = screen.getByLabelText('Notebook file');
		await user.clear(file);
		await user.type(file, 'new.py');
		await user.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
				repo: 'acme/new-repo',
				branch: 'release',
				root_path: 'notebooks',
				entry_notebook: 'new.py',
			}),
		);
		expect(onClose).toHaveBeenCalled();
	});

	it('renders read-only settings for a viewer without rotation controls', async () => {
		setup({ canEdit: false });

		const repo = await screen.findByLabelText('Repository');
		expect(repo).toHaveAttribute('readonly');
		expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Rotate token' })).not.toBeInTheDocument();
	});

	it('rotates the token after confirmation and displays it once', async () => {
		const user = userEvent.setup();
		const { calls } = setup({});
		await screen.findByLabelText('Repository');

		await user.click(screen.getByRole('button', { name: 'Rotate token' }));
		await user.click(screen.getByRole('button', { name: 'Rotate' }));

		expect(await screen.findByLabelText('Sync token')).toHaveValue('mhsync_rotated');
		expect(screen.getByText(/shown once/i)).toBeInTheDocument();
		expect(calls.some((call) => call.method === 'POST')).toBe(true);
	});

	it('shows the write-once token handed off by notebook creation', async () => {
		setup({ initialToken: 'mhsync_created' });
		expect(await screen.findByLabelText('Sync token')).toHaveValue('mhsync_created');
	});
});
