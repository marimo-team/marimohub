import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
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

function setup(options: {
	canEdit?: boolean;
	initialToken?: string;
	pending?: boolean;
	provider?: string;
	syncProviders?: string[];
	remoteCommit?: string;
	omitSourceControlCapability?: boolean;
	driftError?: boolean;
	driftNotConfigured?: boolean;
	syncError?: boolean;
}) {
	const calls: { method: string; url: string; body?: unknown }[] = [];
	const base = { ...activeSource, provider: options.provider ?? activeSource.provider };
	const source = options.pending
		? {
				...base,
				pending_config: {
					repo: 'acme/new-analytics',
					branch: 'release',
					root_path: 'notebooks',
					entry_notebook: 'new_dashboard.py',
				},
			}
		: base;
	const remoteCommit = options.remoteCommit ?? activeSource.commit;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = init?.body ? JSON.parse(init.body as string) : undefined;
			calls.push({ method, url, body });
			if (method === 'GET' && url.endsWith('/capabilities')) {
				// The omit variant mimics an older server without the field (deploy skew).
				return jsonOk(
					options.omitSourceControlCapability
						? {}
						: {
								source_control: {
									change_request_providers: [],
									sync_providers: options.syncProviders ?? [],
								},
							},
				);
			}
			if (method === 'GET' && url.endsWith('/source/drift')) {
				if (options.driftNotConfigured) {
					return jsonError('SYNC_NOT_CONFIGURED', 'Server-initiated sync is not configured', 409);
				}
				if (options.driftError) {
					return jsonError('SERVICE_UNAVAILABLE', 'GitHub is unavailable', 503);
				}
				return jsonOk({
					current_commit: source.commit,
					remote_commit: remoteCommit,
					in_sync: remoteCommit === source.commit && !options.pending,
					pending_config: options.pending ?? false,
					checked_at: '2025-03-05T15:00:00Z',
				});
			}
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
			if (method === 'POST' && url.endsWith('/source/sync')) {
				if (options.syncError) {
					return jsonError('SERVICE_UNAVAILABLE', 'GitHub is unavailable', 503);
				}
				return jsonOk({ synced: true, commit: remoteCommit, version_id: 'ver-2' });
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

	it('shows drift and syncs on demand when the provider supports server sync', async () => {
		const user = userEvent.setup();
		const { calls } = setup({ syncProviders: ['github'], remoteCommit: 'fedcba9876543210' });

		expect(await screen.findByText(/behind/i)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Sync now' }));

		await waitFor(() =>
			expect(
				calls.some((call) => call.method === 'POST' && call.url.endsWith('/source/sync')),
			).toBe(true),
		);
	});

	it('shows the in-sync drift line when the commits match', async () => {
		setup({ syncProviders: ['github'] });
		expect(await screen.findByText(/in sync at/i)).toBeInTheDocument();
	});

	it('hides server-sync chrome when the provider has no reader', async () => {
		setup({});
		await screen.findByLabelText('Repository');
		expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
		expect(callsToDrift()).toBe(false);

		function callsToDrift() {
			const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
			return fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/source/drift'));
		}
	});

	it('hides server-sync chrome for a viewer even when a reader exists', async () => {
		setup({ canEdit: false, syncProviders: ['github'] });
		await screen.findByLabelText('Repository');
		expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
	});

	it('shows server-sync chrome while pending settings move to a supported provider', async () => {
		// Active provider is gitlab (no reader); the pending settings may land on
		// GitHub, so the server — not the stored provider — decides.
		setup({ provider: 'gitlab', pending: true, syncProviders: ['github'] });
		expect(await screen.findByRole('button', { name: 'Sync now' })).toBeInTheDocument();
		expect(await screen.findByText(/pending settings awaiting sync/i)).toBeInTheDocument();
	});

	it('hides server-sync chrome for an unsupported provider with nothing pending', async () => {
		setup({ provider: 'gitlab', syncProviders: ['github'] });
		await screen.findByLabelText('Repository');
		expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
	});

	it('hides server-sync chrome when the server predates the capability field', async () => {
		setup({ syncProviders: ['github'], omitSourceControlCapability: true });
		await screen.findByLabelText('Repository');
		expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
	});

	it('hides server-sync chrome when the server reports the repository unsupported', async () => {
		// e.g. a GitHub Enterprise source: same `github` provider id in the
		// capability list, but the server answers SYNC_NOT_CONFIGURED.
		const { calls } = setup({ syncProviders: ['github'], driftNotConfigured: true });
		await screen.findByLabelText('Repository');
		await waitFor(() =>
			expect(calls.some((call) => call.url.endsWith('/source/drift'))).toBe(true),
		);
		// The row may flash while the drift probe is in flight; it must settle away.
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
			expect(screen.queryByText(/checking sync status/i)).not.toBeInTheDocument();
		});
	});

	it('keeps Sync now usable when the drift probe fails', async () => {
		setup({ syncProviders: ['github'], driftError: true });
		expect(await screen.findByRole('button', { name: 'Sync now' })).toBeEnabled();
		await waitFor(() =>
			expect(screen.queryByText(/checking sync status/i)).not.toBeInTheDocument(),
		);
		expect(screen.queryByText(/behind|in sync at/i)).not.toBeInTheDocument();
	});

	it('re-enables Sync now after a failed sync', async () => {
		const user = userEvent.setup();
		setup({ syncProviders: ['github'], remoteCommit: 'fedcba9876543210', syncError: true });

		await user.click(await screen.findByRole('button', { name: 'Sync now' }));

		await waitFor(() => expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled());
	});
});
