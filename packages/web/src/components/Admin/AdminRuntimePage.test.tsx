import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonError, jsonOk, renderHookWithClient, renderWithClient } from '@/test/render';
import { useAdminRuntimeQuery } from '@/api/hooks';
import type { RuntimeDashboard } from '@/types';
import AdminRuntimePage from './AdminRuntimePage';

const at = '2026-09-16T12:00:00.000Z';
const sandbox: RuntimeDashboard['apps'][number]['sandboxes'][number] = {
	session_id: 'session-a',
	sandbox_id: 'sandbox-a',
	user_id: 'ada',
	status: 'running',
	started_at: at,
	last_heartbeat: at,
	source_version_id: 'version-two',
	compute_profile: 'small',
	active_connections: 3,
	connections_checked_at: at,
	pool_state: 'ready',
	version_status: 'current',
	legacy: false,
	users: 2,
	idle_since: null,
	incomplete: false,
	assignments: [
		{ user_id: 'ada', visits: 2, state: 'active', expires_at: '2026-09-16T12:02:00.000Z' },
		{ user_id: 'grace', visits: 0, state: 'grace', expires_at: '2026-09-16T12:00:15.000Z' },
	],
};
const fixture: RuntimeDashboard = {
	observed_at: at,
	incomplete: false,
	limits: { max_users_per_session: 4, max_sessions_per_version: 3 },
	apps: [
		{
			project_id: 'analytics',
			project_name: 'Analytics',
			notebook_id: 'sales',
			notebook_title: 'Sales dashboard',
			current_version_id: 'version-two',
			current_version_members: 1,
			incomplete: false,
			sandboxes: [
				sandbox,
				{
					...sandbox,
					session_id: 'session-old',
					sandbox_id: 'sandbox-old',
					source_version_id: 'version-one',
					version_status: 'old',
					pool_state: 'draining',
					users: 1,
				},
			],
		},
		{
			project_id: 'finance',
			project_name: 'Finance',
			notebook_id: 'budget',
			notebook_title: 'Budget',
			current_version_id: 'budget-version',
			current_version_members: 1,
			incomplete: false,
			sandboxes: [
				{
					...sandbox,
					session_id: 'budget-session',
					sandbox_id: 'budget-sandbox',
					source_version_id: 'budget-version',
				},
			],
		},
	],
	editors: [
		{
			...sandbox,
			project_id: 'analytics',
			project_name: 'Analytics',
			notebook_id: 'analysis',
			notebook_title: 'Exploration',
			session_id: 'editor-one',
			sandbox_id: 'editor-sandbox',
		},
	],
};

function setup(data = structuredClone(fixture)) {
	const fetcher = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === '/api/v1/admin/runtime') return jsonOk(data);
		if (url.startsWith('/api/v1/users?'))
			return jsonOk({
				ada: { id: 'ada', name: 'Ada', email: 'ada@example.com', picture_url: null },
				grace: { id: 'grace', name: 'Grace', email: 'grace@example.com', picture_url: null },
			});
		throw new Error(`Unexpected request ${url}`);
	});
	vi.stubGlobal('fetch', fetcher);
	const rendered = renderWithClient(<AdminRuntimePage />, { route: '/admin/runtime' });
	return { ...rendered, fetcher, user: userEvent.setup() };
}

afterEach(() => {
	vi.useRealTimers();
	focusManager.setFocused(undefined);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AdminRuntimePage', () => {
	it('shows version groups, occupancy, and lazy account details', async () => {
		const { fetcher, user } = setup();
		await screen.findByRole('region', { name: 'Sales dashboard pool' });
		expect(screen.getByText('Old version')).toBeInTheDocument();
		expect(screen.getAllByText('2 / 4 occupied slots')).toHaveLength(2);
		expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/v1/users?'))).toBe(
			false,
		);
		await user.click(screen.getByRole('button', { name: 'Inspect sandbox sandbox-a' }));
		const dialog = await screen.findByRole('dialog', { name: 'Sandbox details' });
		expect(await within(dialog).findByText('ada@example.com')).toBeInTheDocument();
		expect(within(dialog).getByText('Active visit · 2 visits')).toBeInTheDocument();
		expect(within(dialog).getByText('Reconnect grace · 0 visits')).toBeInTheDocument();
		expect(within(dialog).getByRole('textbox', { name: 'Session ID' })).toHaveValue('session-a');
		expect(within(dialog).getByRole('button', { name: 'Copy source version' })).toBeInTheDocument();
		expect(within(dialog).getByText('~3')).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Inspect sandbox sandbox-a' })).toHaveFocus(),
		);
	});

	it('filters apps and summary counts locally and includes basic editors', async () => {
		const { user, fetcher } = setup();
		await screen.findByText('Sales dashboard');
		await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'analytics');
		expect(screen.queryByText('Budget')).not.toBeInTheDocument();
		expect(screen.getByText('Active apps').parentElement?.parentElement).toHaveTextContent('1');
		await user.type(screen.getByRole('searchbox'), 'version-one');
		expect(screen.getByText('Sales dashboard')).toBeInTheDocument();
		expect(
			fetcher.mock.calls.filter(([url]) => String(url) === '/api/v1/admin/runtime'),
		).toHaveLength(1);
		await user.clear(screen.getByRole('searchbox'));
		await user.click(screen.getByRole('tab', { name: 'Editors' }));
		expect(await screen.findByText('Exploration')).toBeInTheDocument();
		expect(screen.getByText('Initial source version')).toBeInTheDocument();
		expect(await screen.findByText('Ada')).toBeInTheDocument();
	});

	it('shows unknown legacy occupancy and unlimited limits without a percentage', async () => {
		const data = structuredClone(fixture);
		data.limits = { max_users_per_session: null, max_sessions_per_version: null };
		data.apps = [
			{
				...data.apps[0],
				sandboxes: [
					{
						...sandbox,
						legacy: true,
						users: null,
						assignments: [],
						source_version_id: null,
						version_status: 'unknown',
					},
				],
			},
		];
		setup(data);
		await screen.findByText('Occupancy unknown');
		expect(screen.getByText('Unknown version')).toBeInTheDocument();
		expect(screen.getByText('≥ 0')).toBeInTheDocument();
		expect(screen.getByText(/Unlimited accounts per sandbox/)).toBeInTheDocument();
		expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
	});

	it('uses a bounded meter for large capacities and labels reservations', async () => {
		const data = structuredClone(fixture);
		data.limits.max_users_per_session = 100;
		data.apps = [
			{ ...data.apps[0], sandboxes: [{ ...sandbox, pool_state: 'starting', status: null }] },
		];
		setup(data);
		const meter = await screen.findByRole('progressbar', { name: 'Occupied slots' });
		expect(meter).toHaveAttribute('max', '100');
		expect(meter).toHaveAttribute('value', '2');
		expect(screen.getByText(/^Reserved /)).toBeInTheDocument();
	});

	it('preserves the last successful snapshot on refresh errors and allows manual refresh while paused', async () => {
		const { fetcher, user } = setup();
		await screen.findByText('Sales dashboard');
		await user.click(screen.getByRole('button', { name: 'Pause' }));
		expect(screen.getByText(/Auto-refresh paused/)).toBeInTheDocument();
		fetcher.mockImplementation(async () => jsonError('INTERNAL_ERROR', 'Unavailable'));
		await user.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Showing the last successful snapshot',
		);
		expect(screen.getByText('Sales dashboard')).toBeInTheDocument();
	});

	it('shows incomplete data, empty results, and a selected sandbox removed by refresh', async () => {
		const { fetcher, user, client } = setup();
		await user.click(await screen.findByRole('button', { name: 'Inspect sandbox sandbox-a' }));
		fetcher.mockImplementation(async () => jsonOk({ ...fixture, apps: [], incomplete: true }));
		await act(async () => {
			await client.invalidateQueries({ queryKey: ['admin', 'runtime'] });
		});
		expect(
			await screen.findByText('This sandbox is no longer in the runtime snapshot.'),
		).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(await screen.findByText('No active apps match these filters.')).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('Some runtime records are unavailable');
	});

	it('polls only while visible and unpaused', async () => {
		vi.useFakeTimers();
		focusManager.setFocused(true);
		const fetcher = vi.fn(async () => jsonOk(fixture));
		vi.stubGlobal('fetch', fetcher);
		const { result, rerender, unmount } = renderHookWithClient(
			({ paused }) => useAdminRuntimeQuery(paused),
			{ initialProps: { paused: false } },
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(result.current.data).toBeDefined();
		expect(fetcher).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		focusManager.setFocused(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		rerender({ paused: true });
		focusManager.setFocused(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		await act(async () => {
			await result.current.refetch();
		});
		expect(fetcher).toHaveBeenCalledTimes(3);
		rerender({ paused: false });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(fetcher).toHaveBeenCalledTimes(4);
		unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it('reports an initial fetch failure without presenting an empty deployment', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonError('INTERNAL_ERROR', 'Unavailable')),
		);
		renderWithClient(<AdminRuntimePage />, { route: '/admin/runtime' });
		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Could not load runtime data'),
		);
		expect(screen.queryByText('No active apps match these filters.')).not.toBeInTheDocument();
	});
	it('keeps account IDs and occupancy visible when identity lookup fails', async () => {
		const { fetcher, user } = setup();
		await screen.findByText('Sales dashboard');
		fetcher.mockImplementation(async (input) =>
			String(input).startsWith('/api/v1/users?')
				? jsonError('INTERNAL_ERROR', 'Directory unavailable')
				: jsonOk(fixture),
		);
		await user.click(screen.getByRole('button', { name: 'Inspect sandbox sandbox-a' }));
		const dialog = await screen.findByRole('dialog', { name: 'Sandbox details' });
		expect(
			await within(dialog).findByText('Names unavailable; showing account IDs.'),
		).toBeInTheDocument();
		expect(within(dialog).getAllByText('ada').length).toBeGreaterThan(0);
		expect(within(dialog).getByText('Accounts · 2')).toBeInTheDocument();
		expect(within(dialog).getByText('Reconnect grace · 0 visits')).toBeInTheDocument();
	});

	it('recovers from a failed refresh and updates an open detail panel', async () => {
		const { fetcher, user, client } = setup();
		await user.click(await screen.findByRole('button', { name: 'Inspect sandbox sandbox-a' }));
		await screen.findByText('ada@example.com');
		fetcher.mockImplementation(async () => jsonError('INTERNAL_ERROR', 'Unavailable'));
		await act(async () => {
			await client.invalidateQueries({ queryKey: ['admin', 'runtime'] });
		});
		expect(within(screen.getByRole('dialog')).getByText('Accounts · 2')).toBeInTheDocument();
		const refreshed = structuredClone(fixture);
		refreshed.observed_at = '2026-09-16T12:01:00.000Z';
		refreshed.apps[0].sandboxes[0] = {
			...sandbox,
			users: 0,
			assignments: [],
			pool_state: 'draining',
			version_status: 'old',
		};
		fetcher.mockImplementation(async () => jsonOk(refreshed));
		await act(async () => {
			await client.invalidateQueries({ queryKey: ['admin', 'runtime'] });
		});
		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText('Accounts · 0')).toBeInTheDocument();
		expect(within(dialog).getByText('No occupied account slots.')).toBeInTheDocument();
		expect(within(dialog).getByText('Old version')).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('preserves an unavailable project filter until the admin clears it', async () => {
		const { fetcher, user } = setup();
		await screen.findByText('Budget');
		await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'finance');
		fetcher.mockImplementation(async () => jsonOk({ ...fixture, apps: [fixture.apps[0]] }));
		await user.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(
			await screen.findByRole('option', { name: 'finance (no active sessions)' }),
		).toBeInTheDocument();
		expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('finance');
		expect(screen.getByText('No active apps match these filters.')).toBeInTheDocument();
		await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), '');
		expect(screen.getByText('Sales dashboard')).toBeInTheDocument();
	});

	it('shows unknown current-version capacity instead of zero when the head cannot be read', async () => {
		const data = structuredClone(fixture);
		data.apps = [
			{
				...data.apps[0],
				current_version_id: null,
				current_version_members: null,
				incomplete: true,
				sandboxes: [{ ...sandbox, version_status: 'unknown' }],
			},
		];
		data.incomplete = true;
		setup(data);
		expect(await screen.findByText(/Current-version pool: Unknown/)).toBeInTheDocument();
		expect(screen.getByText('Unknown version')).toBeInTheDocument();
		expect(screen.queryByText(/No sandbox for the current version/)).not.toBeInTheDocument();
	});

	it('preserves actual over-capacity counts while bounding the meter', async () => {
		const data = structuredClone(fixture);
		data.limits.max_users_per_session = 20;
		data.apps = [{ ...data.apps[0], sandboxes: [{ ...sandbox, users: 25 }] }];
		setup(data);
		expect(await screen.findByText('25 / 20 occupied slots')).toBeInTheDocument();
		expect(screen.getByRole('progressbar')).toHaveAttribute('value', '20');
		expect(screen.getByRole('progressbar')).toHaveAttribute(
			'aria-valuetext',
			'25 / 20 occupied slots',
		);
	});

	it('uses the same connection display for zero and unknown counts in both views', async () => {
		const data = structuredClone(fixture);
		data.apps[0].sandboxes[0].active_connections = 0;
		data.editors[0].active_connections = null;
		data.editors[0].connections_checked_at = null;
		const { user } = setup(data);
		await user.click(await screen.findByRole('button', { name: 'Inspect sandbox sandbox-a' }));
		expect(within(screen.getByRole('dialog')).getByText('~0')).toBeInTheDocument();
		await user.keyboard('{Escape}');
		await user.click(screen.getByRole('tab', { name: 'Editors' }));
		expect(await screen.findByText('Unknown')).toBeInTheDocument();
		expect(screen.getByText('Checked —')).toBeInTheDocument();
	});
});
