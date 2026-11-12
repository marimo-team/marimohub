import { act, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import {
	jsonError,
	jsonOk,
	renderWithClient,
	renderHookWithClient,
	setupUser,
} from '@/test/render';
import { useAdminMigrationsQuery } from '@/api/hooks';
import type { MigrationDashboard } from '@/types';
import AdminMigrationsPage from './AdminMigrationsPage';

const fixture: MigrationDashboard = {
	observed_at: '2026-11-12T12:00:00.000Z',
	incomplete: false,
	actions_available: true,
	action: 'ready',
	poll: true,
	counts: { waiting: 1, running: 0, completed: 0, needs_attention: 0 },
	rows: [
		{
			id: 'fixture-v1',
			title: 'Index widgets',
			description: 'Visits widgets.',
			impact: 'The app stays available.',
			progress_unit: 'widgets',
			status: 'waiting',
			retired: false,
			dependencies: [],
			progress: { processed: 3, partial: true },
		},
	],
};
afterEach(() => {
	vi.useRealTimers();
	focusManager.setFocused(undefined);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('shows partial progress, accessible details, and refreshes after a request', async () => {
	const fetcher = vi.fn(async () => jsonOk(fixture));
	vi.stubGlobal('fetch', fetcher);
	renderWithClient(<AdminMigrationsPage />);
	const user = setupUser();
	await user.click(await screen.findByText('Index widgets'));
	expect(screen.getByText('The app stays available.')).toBeVisible();
	expect(screen.getByText('3 widgets visited since tracking began')).toBeInTheDocument();
	fetcher.mockImplementationOnce(async () => jsonOk({ status: 'requested' }));
	await user.click(screen.getByRole('button', { name: 'Request attempt' }));
	await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
	expect(fetcher).toHaveBeenCalledWith(
		'/api/v1/admin/migrations/run',
		expect.objectContaining({ method: 'POST', body: '{}' }),
	);
});

it.each([409, 503])('refreshes after a stale or unavailable action (%s)', async (status) => {
	const fetcher = vi.fn(async () => jsonOk(fixture));
	vi.stubGlobal('fetch', fetcher);
	renderWithClient(<AdminMigrationsPage />);
	await screen.findByText('Index widgets');
	fetcher.mockImplementationOnce(async () => jsonError('UNAVAILABLE', 'Unavailable', status));
	await setupUser().click(screen.getByRole('button', { name: 'Request attempt' }));
	await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
});

it('shows incomplete counts and retired history without enabling unavailable actions', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			jsonOk({
				...fixture,
				incomplete: true,
				actions_available: false,
				rows: [{ ...fixture.rows[0], retired: true, status: 'not_recorded', progress: undefined }],
			}),
		),
	);
	renderWithClient(<AdminMigrationsPage />);
	expect(await screen.findByRole('alert')).toHaveTextContent('Counts are incomplete');
	expect(screen.getByText('Retired migrations')).toBeInTheDocument();
	expect(screen.getByText('Not recorded')).toBeInTheDocument();
	expect(screen.getByRole('button', { name: 'Request attempt' })).toBeDisabled();
});

it('stops polling while hidden, after completion, and after unmount', async () => {
	vi.useFakeTimers();
	const data = structuredClone(fixture);
	const fetcher = vi.fn(async () => jsonOk(data));
	vi.stubGlobal('fetch', fetcher);
	const { result, unmount } = renderHookWithClient(() => useAdminMigrationsQuery());
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(result.current.data).toBeDefined();
	focusManager.setFocused(false);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10_000);
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
	focusManager.setFocused(true);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	data.poll = false;
	data.action = 'already_complete';
	await act(async () => {
		await result.current.refetch();
	});
	const calls = fetcher.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10_000);
	});
	expect(fetcher).toHaveBeenCalledTimes(calls);
	unmount();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(fetcher).toHaveBeenCalledTimes(calls);
});

it('disables duplicate requests until registration resolves', async () => {
	let resolve!: (value: Response) => void;
	const pending = new Promise<Response>((done) => {
		resolve = done;
	});
	const fetcher = vi.fn(async () => jsonOk(fixture));
	vi.stubGlobal('fetch', fetcher);
	renderWithClient(<AdminMigrationsPage />);
	await screen.findByText('Index widgets');
	fetcher.mockImplementationOnce(() => pending);
	await setupUser().click(screen.getByRole('button', { name: 'Request attempt' }));
	expect(screen.getByRole('button', { name: 'Request attempt' })).toBeDisabled();
	resolve(jsonOk({ status: 'requested' }));
	await waitFor(() =>
		expect(screen.getByRole('button', { name: 'Request attempt' })).not.toBeDisabled(),
	);
});

it('shows a forbidden response without enabling actions', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonError('FORBIDDEN', 'Forbidden', 403)),
	);
	renderWithClient(<AdminMigrationsPage />);
	expect(await screen.findByRole('alert')).toHaveTextContent('super-admin access');
	expect(screen.getByRole('button', { name: 'Request attempt' })).toBeDisabled();
});
