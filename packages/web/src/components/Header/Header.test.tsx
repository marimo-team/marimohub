import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { installMatchMedia, jsonOk, renderWithClient } from '@/test/render';
import { Header } from './Header';

const USER = { id: 'usr-123', email: 'ada@example.com' };

function LocationProbe() {
	return <output data-testid="location">{useLocation().pathname}</output>;
}

/**
 * `userEvent.setup()` installs its own `navigator.clipboard`, so the app's must
 * be stubbed afterwards or the copy silently succeeds against user-event's stub.
 */
function setup(
	writeText: () => Promise<void> = () => Promise.resolve(),
	me: Record<string, unknown> = USER,
) {
	installMatchMedia(false);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/me') return jsonOk(me);
			if (url === '/api/v1/me/tokens') return jsonOk([]);
			if (url === '/api/v1/integrations/kinds') return jsonOk([]);
			if (url.startsWith('/api/v1/org/integrations?')) {
				return jsonOk({
					items: [
						{
							id: 'intg-1',
							kind: 'postgres',
							name: 'warehouse',
							enabled: true,
							current_version: 1,
							created_by: 'u',
							created_at: '',
							updated_at: '',
							scope: 'org',
						},
					],
					next_cursor: null,
				});
			}
			throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
		}),
	);
	const user = userEvent.setup();
	const clipboard = vi.fn(writeText);
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText: clipboard },
		configurable: true,
	});
	const rendered = renderWithClient(
		<ThemeProvider>
			<AuthProvider>
				<>
					<Header />
					<LocationProbe />
				</>
			</AuthProvider>
		</ThemeProvider>,
		{ route: '/' },
	);
	return { user, clipboard, ...rendered };
}

async function openUserMenu(user: ReturnType<typeof userEvent.setup>) {
	await waitFor(() =>
		expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument(),
	);
	await user.click(screen.getByRole('button', { name: 'User menu' }));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	// Neither of the above reverts a property descriptor, so the stub would stay
	// installed over the real Clipboard API for the rest of the run.
	Reflect.deleteProperty(navigator, 'clipboard');
	localStorage.clear();
	document.documentElement.classList.remove('dark');
});

describe('Header', () => {
	it('shows the signed-in user and their id in the menu', async () => {
		const { user } = setup();
		await openUserMenu(user);

		expect(screen.getByText(USER.email)).toBeInTheDocument();
		expect(screen.getByText(USER.id)).toBeInTheDocument();
	});

	it('renders the validated profile picture without sending a referrer', async () => {
		const picture = 'https://images.example.com/ada.png';
		const { container } = setup(undefined, { ...USER, name: 'Ada', picture_url: picture });
		await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument());
		const image = container.querySelector('img');
		expect(image).toHaveAttribute('src', picture);
		expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
	});

	it('falls back to the user initial when the profile picture fails', async () => {
		const { container } = setup(undefined, {
			...USER,
			name: 'Ada',
			picture_url: 'https://images.example.com/missing.png',
		});
		const image = await waitFor(() => {
			const element = container.querySelector('img');
			if (!element) throw new Error('Expected profile image to render');
			return element;
		});
		fireEvent.error(image);

		expect(container.querySelector('img')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'User menu' })).toHaveTextContent('A');
	});

	it('copies the user id — invites are addressed by id, not email', async () => {
		const { user, clipboard } = setup();
		await openUserMenu(user);

		await user.click(screen.getByRole('menuitem', { name: /Copy user id/ }));

		expect(clipboard).toHaveBeenCalledWith(USER.id);
	});

	it('opens the API tokens dialog from the menu', async () => {
		const { user } = setup();
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		await openUserMenu(user);

		await user.click(screen.getByRole('menuitem', { name: /API tokens/ }));

		await waitFor(() =>
			expect(screen.getByRole('heading', { name: 'API tokens' })).toBeInTheDocument(),
		);
	});

	it('toggles the theme', async () => {
		const { user } = setup();
		expect(document.documentElement).not.toHaveClass('dark');

		await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
		expect(document.documentElement).toHaveClass('dark');

		await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
		expect(document.documentElement).not.toHaveClass('dark');
	});

	it('hides the user menu until the identity resolves', () => {
		setup();
		expect(screen.queryByRole('button', { name: 'User menu' })).not.toBeInTheDocument();
	});

	it('offers Org integrations to super admins only', async () => {
		const { user } = setup();
		await openUserMenu(user);
		expect(screen.queryByRole('menuitem', { name: /Org integrations/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('menuitem', { name: /Admin/ })).not.toBeInTheDocument();
	});

	it('navigates super admins to the admin section', async () => {
		const { user } = setup(undefined, { ...USER, is_super_admin: true });
		await openUserMenu(user);
		await user.click(screen.getByRole('menuitem', { name: /Admin/ }));
		expect(screen.getByTestId('location')).toHaveTextContent('/admin/users');
	});

	it('opens the org integrations dialog for a super admin and lists the org entries', async () => {
		const { user } = setup(undefined, { ...USER, is_super_admin: true });
		await openUserMenu(user);

		await user.click(screen.getByRole('menuitem', { name: /Org integrations/ }));

		await waitFor(() =>
			expect(screen.getByRole('heading', { name: 'Org integrations' })).toBeInTheDocument(),
		);
		// The list must come from GET /org/integrations, not the project routes.
		expect(await screen.findByText('warehouse')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Edit warehouse' })).toBeInTheDocument();
	});
});
