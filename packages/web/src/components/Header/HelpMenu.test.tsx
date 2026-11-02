import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/context/AuthContext';
import { jsonOk, renderWithClient } from '@/test/render';
import { HelpMenu } from './HelpMenu';

const USER = { id: 'usr-123', email: 'ada@example.com' };

function setup({
	version = '0.2.0',
	name = 'marimohub',
}: { version?: string; name?: string } = {}) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/me') return jsonOk(USER);
			if (url === '/api/v1/version') return jsonOk({ version });
			if (url === '/api/v1/capabilities') return jsonOk({});
			throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
		}),
	);
	const user = userEvent.setup();
	renderWithClient(
		<AuthProvider>
			<HelpMenu />
		</AuthProvider>,
		{ route: '/', branding: { name } },
	);
	return { user };
}

async function openAbout(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole('button', { name: 'Help' }));
	await user.click(screen.getByRole('menuitem', { name: 'About marimohub' }));
	await waitFor(() => expect(screen.getByText('marimohub')).toBeInTheDocument());
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('HelpMenu About', () => {
	it('uses the deployment name in About while preserving product attribution and source links', async () => {
		const name = 'Research <Hub>';
		const { user } = setup({ name });
		await user.click(screen.getByRole('button', { name: 'Help' }));
		await user.click(screen.getByRole('menuitem', { name: `About ${name}` }));

		const dialog = within(screen.getByRole('dialog'));
		expect(dialog.getByText(name)).toBeInTheDocument();
		expect(dialog.getByText('Powered by marimohub')).toBeInTheDocument();
		expect(dialog.getByRole('link', { name: /Source/ })).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub',
		);
	});

	it('links a release version to its GitHub release page', async () => {
		const { user } = setup();
		await openAbout(user);
		expect(screen.queryByText('Powered by marimohub')).not.toBeInTheDocument();

		const link = await screen.findByRole('link', { name: /0\.2\.0/ });
		expect(link).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub/releases/tag/v0.2.0',
		);
	});

	it('links a git SHA version to its commit', async () => {
		const { user } = setup({ version: 'a1b2c3d' });
		await openAbout(user);

		const link = await screen.findByRole('link', { name: /a1b2c3d/ });
		expect(link).toHaveAttribute('href', 'https://github.com/marimo-team/marimohub/commit/a1b2c3d');
	});

	it('renders git-describe versions as plain text — no such release tag exists', async () => {
		const { user } = setup({ version: '0.2.0-5-gdeadbeef' });
		await openAbout(user);

		expect(await screen.findByText('0.2.0-5-gdeadbeef')).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /0\.2\.0/ })).not.toBeInTheDocument();
	});

	it('renders dev builds as plain text', async () => {
		const { user } = setup({ version: 'dev' });
		await openAbout(user);

		expect(await screen.findByText('dev')).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /dev/ })).not.toBeInTheDocument();
	});

	it('shows source and issue links to everyone', async () => {
		const { user } = setup();
		await openAbout(user);

		expect(screen.getByRole('link', { name: /Source/ })).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub',
		);
		expect(screen.getByRole('link', { name: /Report an issue/ })).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub/issues',
		);
	});

	it.each(['close button', 'Escape'])('dismisses About with %s', async (action) => {
		const { user } = setup();
		await openAbout(user);

		if (action === 'Escape') await user.keyboard('{Escape}');
		else await user.click(screen.getByRole('button', { name: 'Close' }));

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		await openAbout(user);
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});
});
