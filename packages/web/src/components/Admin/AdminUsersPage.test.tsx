import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { ErrorBoundary } from '@/components/ui';
import type { AdminUser } from '@/types';
import AdminUsersPage from './AdminUsersPage';

const USERS: AdminUser[] = [
	{
		id: 'user-ada',
		email: 'ada@example.com',
		name: 'Ada Lovelace',
		updated_at: '2026-08-01T12:00:00.000Z',
		is_super_admin: true,
	},
	{
		id: 'user-grace',
		email: 'grace@example.com',
		name: 'Grace Hopper',
		updated_at: '2026-08-02T09:30:00.000Z',
		is_super_admin: false,
	},
];

function setup(items: AdminUser[] = USERS) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === '/api/v1/admin/users') return jsonOk({ items, next_cursor: null });
			throw new Error(`unexpected fetch: ${url}`);
		}),
	);
	renderWithClient(<AdminUsersPage />);
	return userEvent.setup();
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AdminUsersPage', () => {
	it('renders the directory with a super-admin badge only where deserved', async () => {
		setup();

		expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
		expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
		expect(screen.getByText('grace@example.com')).toBeInTheDocument();
		expect(screen.getByText('user-grace')).toBeInTheDocument();

		const rows = screen.getAllByTestId('admin-user-row');
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent('Super admin');
		expect(rows[1]).not.toHaveTextContent('Super admin');
	});

	it('filters by name, email, or id from the search box', async () => {
		const user = setup();
		await screen.findByText('Ada Lovelace');

		await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'grace');
		expect(screen.getAllByTestId('admin-user-row')).toHaveLength(1);
		expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
		expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();

		await user.clear(screen.getByRole('searchbox', { name: 'Search users' }));
		await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'zzz-nope');
		expect(screen.getByText('No users matching "zzz-nope"')).toBeInTheDocument();
	});

	it('shows the empty state for an empty directory, even with a whitespace query', async () => {
		const user = setup([]);
		expect(await screen.findByText('No users yet')).toBeInTheDocument();

		await user.type(screen.getByRole('searchbox', { name: 'Search users' }), '   ');
		expect(screen.getByText('No users yet')).toBeInTheDocument();
		expect(screen.queryByText(/No users matching/)).not.toBeInTheDocument();
	});

	// The race where a super admin was removed from MARIMOHUB_SUPER_ADMINS while
	// their tab was open: /me still says super admin, but the API now refuses.
	it('surfaces a 403 to the error boundary instead of rendering an empty page', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => jsonError('FORBIDDEN', 'Requires super admin', 403)),
			);
			renderWithClient(
				<ErrorBoundary>
					<AdminUsersPage />
				</ErrorBoundary>,
			);
			expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
			expect(screen.getByText('Requires super admin')).toBeInTheDocument();
		} finally {
			log.mockRestore();
		}
	});
});
