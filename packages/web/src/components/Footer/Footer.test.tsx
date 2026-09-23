import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { BrandingContext } from '@/context/BrandingContext';
import { jsonOk, renderWithClient } from '@/test/render';
import { Footer } from './Footer';

const USER = { id: 'usr-123', email: 'ada@example.com' };

function LocationProbe() {
	return <span data-testid="location">{useLocation().pathname}</span>;
}

function setup({
	version = '0.2.0',
	me = USER as Record<string, unknown>,
	name = 'marimohub',
}: { version?: string; me?: Record<string, unknown>; name?: string } = {}) {
	const capabilitiesFetch = vi.fn(() => jsonOk({}));
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/me') return jsonOk(me);
			if (url === '/api/v1/version') return jsonOk({ version });
			if (url === '/api/v1/capabilities') return capabilitiesFetch();
			throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
		}),
	);
	const user = userEvent.setup();
	renderWithClient(
		<AuthProvider>
			<BrandingContext value={{ ...DEFAULT_THEME_CONFIG, name }}>
				<Footer />
			</BrandingContext>
			<LocationProbe />
		</AuthProvider>,
		{ route: '/' },
	);
	return { user, capabilitiesFetch };
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole('button', { name: 'About marimohub' }));
	await waitFor(() => expect(screen.getByText('marimohub')).toBeInTheDocument());
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Footer', () => {
	it('uses the deployment name in About while preserving product attribution and source links', async () => {
		const name = 'Research <Hub>';
		const { user } = setup({ name });
		expect(screen.getByText(name)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: `About ${name}` }));

		const popover = within(screen.getByRole('dialog'));
		expect(popover.getByText(name)).toBeInTheDocument();
		expect(popover.getByText('Powered by marimohub')).toBeInTheDocument();
		expect(popover.getByRole('link', { name: /Source/ })).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub',
		);
	});

	it('links a release version to its GitHub release page', async () => {
		const { user } = setup();
		await openPopover(user);
		expect(screen.queryByText('Powered by marimohub')).not.toBeInTheDocument();

		const link = await screen.findByRole('link', { name: /0\.2\.0/ });
		expect(link).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub/releases/tag/v0.2.0',
		);
	});

	it('links a git SHA version to its commit', async () => {
		const { user } = setup({ version: 'a1b2c3d' });
		await openPopover(user);

		const link = await screen.findByRole('link', { name: /a1b2c3d/ });
		expect(link).toHaveAttribute('href', 'https://github.com/marimo-team/marimohub/commit/a1b2c3d');
	});

	it('renders git-describe versions as plain text — no such release tag exists', async () => {
		const { user } = setup({ version: '0.2.0-5-gdeadbeef' });
		await openPopover(user);

		expect(await screen.findByText('0.2.0-5-gdeadbeef')).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /0\.2\.0/ })).not.toBeInTheDocument();
	});

	it('renders dev builds as plain text', async () => {
		const { user } = setup({ version: 'dev' });
		await openPopover(user);

		expect(await screen.findByText('dev')).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /dev/ })).not.toBeInTheDocument();
	});

	it('shows source and issue links to everyone', async () => {
		const { user } = setup();
		await openPopover(user);

		expect(screen.getByRole('link', { name: /Source/ })).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub',
		);
		expect(screen.getByRole('link', { name: /Report an issue/ })).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub/issues',
		);
	});

	it('hides the settings shortcut (and never fetches capabilities) for regular users', async () => {
		const { user, capabilitiesFetch } = setup();
		await openPopover(user);

		expect(screen.queryByRole('button', { name: /Deployment settings/ })).not.toBeInTheDocument();
		expect(capabilitiesFetch).not.toHaveBeenCalled();
	});

	it('navigates super admins to the admin settings page', async () => {
		const { user, capabilitiesFetch } = setup({ me: { ...USER, is_super_admin: true } });
		await openPopover(user);

		await user.click(screen.getByRole('button', { name: /Deployment settings/ }));

		expect(screen.getByTestId('location')).toHaveTextContent('/admin/settings');
		// The popover closed itself on navigation.
		expect(screen.queryByRole('link', { name: /Source/ })).not.toBeInTheDocument();
		// Deployment detail now lives on the settings page — no capabilities fetch here.
		expect(capabilitiesFetch).not.toHaveBeenCalled();
	});
});
