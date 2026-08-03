import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/context/AuthContext';
import { jsonOk, renderWithClient } from '@/test/render';
import { Footer } from './Footer';

const USER = { id: 'usr-123', email: 'ada@example.com' };

const VERSION = {
	version: '0.2.0',
	image: 'ghcr.io/marimo-team/marimohub:0.2.0',
	sandbox_image: null,
	started_at: null,
	replica: null,
	node: null,
	backends: { storage: 's3', compute: 'coreweave', auth: 'oidc' },
};

const CAPABILITIES = {
	federation: { available: true },
	integrations: { available: false },
	viewer_mode: 'interactive',
	viewer_session_modes: ['edit', 'run'],
	editor_sandbox_sharing: 'shared',
	default_role: null,
	limits: {
		max_concurrent_sessions_per_user: 5,
		max_apps_per_project: null,
		max_request_bytes: 1,
		max_versions_per_notebook: 100,
		default_page_size: 50,
		max_page_size: 200,
	},
	sandbox_images: ['ghcr.io/marimo-team/marimo-sandbox:1.2.3'],
	compute_profiles: [{ name: 'small', cpu: '1', memory: '2Gi' }],
	compute_profile_override: 'editors',
};

function setup({
	version = VERSION,
	me = USER as Record<string, unknown>,
}: { version?: typeof VERSION; me?: Record<string, unknown> } = {}) {
	const capabilitiesFetch = vi.fn(() => jsonOk(CAPABILITIES));
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/me') return jsonOk(me);
			if (url === '/api/v1/version') return jsonOk(version);
			if (url === '/api/v1/capabilities') return capabilitiesFetch();
			throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
		}),
	);
	const user = userEvent.setup();
	renderWithClient(
		<AuthProvider>
			<Footer />
		</AuthProvider>,
		{ route: '/' },
	);
	return { user, capabilitiesFetch };
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole('button', { name: 'Version info' }));
	await waitFor(() => expect(screen.getByText('marimohub')).toBeInTheDocument());
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Footer', () => {
	it('links a release version to its GitHub release page', async () => {
		const { user } = setup();
		await openPopover(user);

		const link = await screen.findByRole('link', { name: /0\.2\.0/ });
		expect(link).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub/releases/tag/v0.2.0',
		);
	});

	it('links a git SHA version to its commit', async () => {
		const { user } = setup({ version: { ...VERSION, version: 'a1b2c3d' } });
		await openPopover(user);

		const link = await screen.findByRole('link', { name: /a1b2c3d/ });
		expect(link).toHaveAttribute('href', 'https://github.com/marimo-team/marimohub/commit/a1b2c3d');
	});

	it('renders dev builds as plain text', async () => {
		const { user } = setup({ version: { ...VERSION, version: 'dev' } });
		await openPopover(user);

		expect(await screen.findByText('dev')).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /dev/ })).not.toBeInTheDocument();
	});

	it('hides the policy section (and skips the fetch) for regular users', async () => {
		const { user, capabilitiesFetch } = setup();
		await openPopover(user);

		expect(screen.queryByText('Policy')).not.toBeInTheDocument();
		expect(capabilitiesFetch).not.toHaveBeenCalled();
	});

	it('shows deployment policy to super admins', async () => {
		const { user } = setup({ me: { ...USER, is_super_admin: true } });
		await openPopover(user);

		expect(await screen.findByText('Policy')).toBeInTheDocument();
		expect(screen.getByText('interactive')).toBeInTheDocument();
		expect(screen.getByText('members only')).toBeInTheDocument();
		// integrations unavailable → only federation listed
		expect(screen.getByText('federation')).toBeInTheDocument();
		expect(
			screen.getByText(/5 sessions\/user · ∞ apps\/project · 100 versions/),
		).toBeInTheDocument();
		expect(screen.getByText('ghcr.io/marimo-team/marimo-sandbox:1.2.3')).toBeInTheDocument();
		expect(screen.getByText('small (override: editors)')).toBeInTheDocument();
	});
});
