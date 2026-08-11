import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { AuthProvider } from '@/context/AuthContext';
import { ErrorBoundary } from '@/components/ui';
import type { AdminUser } from '@/types';
import AdminUsersPage from './AdminUsersPage';

const USERS: AdminUser[] = [
	{
		id: 'user-ada',
		email: 'ada@example.com',
		name: 'Ada Lovelace',
		updated_at: '2026-08-01T12:00:00.000Z',
		suspended_at: null,
		is_super_admin: true,
	},
	{
		id: 'user-grace',
		email: 'grace@example.com',
		name: 'Grace Hopper',
		updated_at: '2026-08-02T09:30:00.000Z',
		suspended_at: null,
		is_super_admin: false,
	},
];

// Default to a signed-in user absent from the directory so existing assertions
// see no self-row; individual tests override to exercise self-suspension.
function setup(items: AdminUser[] = USERS, currentUserId = 'user-self') {
	let current = items.map((item) => ({ ...item }));
	const me = {
		id: currentUserId,
		email: `${currentUserId}@example.com`,
		name: 'Current User',
		logout_url: null,
		is_super_admin: true,
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/me') return jsonOk(me);
			if (url === '/api/v1/admin/users') return jsonOk({ items: current, next_cursor: null });
			const match = /^\/api\/v1\/users\/([^/]+)\/suspension$/.exec(url);
			if (match) {
				const userId = decodeURIComponent(match[1]);
				const suspended = init?.method === 'PUT';
				current = current.map((item) =>
					item.id === userId
						? {
								...item,
								suspended_at: suspended ? '2026-08-11T18:00:00.000Z' : null,
							}
						: item,
				);
				return jsonOk(current.find((item) => item.id === userId));
			}
			throw new Error(`unexpected fetch: ${url}`);
		}),
	);
	renderWithClient(
		<AuthProvider>
			<AdminUsersPage />
		</AuthProvider>,
	);
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

	it('confirms suspension and refreshes the row with a suspended badge', async () => {
		const user = setup();
		await screen.findByText('Grace Hopper');

		const rows = screen.getAllByTestId('admin-user-row');
		await user.click(rows[1].querySelector('button')!);
		expect(screen.getByRole('heading', { name: 'Suspend Grace Hopper' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Suspend' }));

		expect(await screen.findByText('Suspended')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
		expect(vi.mocked(fetch)).toHaveBeenCalledWith(
			'/api/v1/users/user-grace/suspension',
			expect.objectContaining({ method: 'PUT' }),
		);
	});

	it('reactivates a suspended user', async () => {
		const user = setup([USERS[0], { ...USERS[1], suspended_at: '2026-08-11T18:00:00.000Z' }]);
		await screen.findByText('Suspended');

		await user.click(screen.getByRole('button', { name: 'Reactivate' }));
		expect(screen.getByRole('heading', { name: 'Reactivate Grace Hopper' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Reactivate' }));

		expect(await screen.findAllByRole('button', { name: 'Suspend' })).toHaveLength(2);
		expect(screen.queryByText('Suspended')).not.toBeInTheDocument();
		expect(vi.mocked(fetch)).toHaveBeenCalledWith(
			'/api/v1/users/user-grace/suspension',
			expect.objectContaining({ method: 'DELETE' }),
		);
	});

	it('disables self-suspension for the signed-in super admin', async () => {
		setup(USERS, 'user-ada');
		await screen.findByText('Ada Lovelace');

		const rows = screen.getAllByTestId('admin-user-row');
		const selfButton = rows[0].querySelector('button')!;
		// The self row's Suspend action is disabled once /me resolves; the API would
		// reject a self-suspension, so the UI never offers the failing confirmation.
		await waitFor(() => expect(selfButton).toBeDisabled());
		expect(selfButton.closest('[title]')).toHaveAttribute(
			'title',
			'You cannot suspend your own account',
		);
		// Another user's row stays actionable.
		expect(rows[1].querySelector('button')!).toBeEnabled();
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
					<AuthProvider>
						<AdminUsersPage />
					</AuthProvider>
				</ErrorBoundary>,
			);
			expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
			expect(screen.getByText('Requires super admin')).toBeInTheDocument();
		} finally {
			log.mockRestore();
		}
	});
});
