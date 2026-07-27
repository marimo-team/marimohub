import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { installMatchMedia, jsonOk, renderWithClient } from '@/test/render';
import { Header } from './Header';

const USER = { id: 'usr-123', email: 'ada@example.com' };

/**
 * `userEvent.setup()` installs its own `navigator.clipboard`, so the app's must
 * be stubbed afterwards or the copy silently succeeds against user-event's stub.
 */
function setup(writeText: () => Promise<void> = () => Promise.resolve()) {
	installMatchMedia(false);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/me') return jsonOk(USER);
			if (url === '/api/v1/me/tokens') return jsonOk([]);
			throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
		}),
	);
	const user = userEvent.setup();
	const clipboard = vi.fn(writeText);
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText: clipboard },
		configurable: true,
	});
	renderWithClient(
		<ThemeProvider>
			<AuthProvider>
				<Header />
			</AuthProvider>
		</ThemeProvider>,
		{ route: '/' },
	);
	return { user, clipboard };
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
});
