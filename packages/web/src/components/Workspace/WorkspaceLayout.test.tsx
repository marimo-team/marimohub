import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import { lastProjectKey } from './lastProject';
import { WorkspaceLayout } from './WorkspaceLayout';
import type { WorkspaceNavigationSlots } from './navigation';

function Page() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<div>
			<output aria-label="Location">{location.pathname}</output>
			<button onClick={() => void navigate(-1)}>Back</button>
		</div>
	);
}

function setup({
	route = '/projects/alpha',
	role = 'editor',
	appOnly = false,
	mobile = false,
	jobs = true,
	data = true,
	alerts = true,
	projectError = false,
	listError = false,
	slots,
	branding,
}: {
	route?: string | string[];
	role?: string | null;
	appOnly?: boolean;
	mobile?: boolean;
	jobs?: boolean;
	data?: boolean;
	alerts?: boolean;
	projectError?: boolean;
	listError?: boolean;
	slots?: WorkspaceNavigationSlots;
	branding?: Partial<ThemeConfig>;
} = {}) {
	installMatchMedia(mobile);
	const requests: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), 'http://localhost');
			requests.push(url.pathname + url.search);
			if (url.pathname === '/api/v1/me')
				return jsonOk({
					id: 'u',
					email: 'user@example.com',
					app_only: appOnly,
					can_create_projects: false,
					is_super_admin: false,
					groups: [],
				});
			if (url.pathname === '/api/v1/capabilities')
				return jsonOk({
					jobs: { available: jobs },
					data_browser: { available: data },
					federation: { available: false, default_enabled: false },
					project_groups: { available: false },
					project_alerts: { available: alerts, selectable_kinds: [], max_destinations: 5 },
				});
			if (url.pathname === '/api/v1/version') return jsonOk({ version: 'test' });
			if (url.pathname.endsWith('/members')) return jsonOk([]);
			if (url.pathname.endsWith('/alert-destinations')) return jsonOk({ items: [] });
			if (url.pathname === '/api/v1/users') return jsonOk({});
			if (url.pathname === '/api/v1/projects') {
				if (listError) return jsonError('UNAVAILABLE', 'Unavailable', 503);
				return jsonOk(
					url.searchParams.has('cursor')
						? { items: [{ id: 'beta', name: 'Beta' }], next_cursor: null }
						: { items: [{ id: 'alpha', name: 'Alpha' }], next_cursor: 'next' },
				);
			}
			if (url.pathname.startsWith('/api/v1/projects/')) {
				if (projectError) return jsonError('FORBIDDEN', 'Forbidden', 403);
				const id = url.pathname.split('/').at(-1);
				return jsonOk({
					id,
					name: id === 'alpha' ? 'Alpha' : id === 'beta' ? 'Beta' : 'Archived project',
					owner: 'u',
					members: [],
					default_role: 'inherit',
					your_role: role,
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	const user = userEvent.setup();
	const rendered = renderWithClient(
		<ThemeProvider>
			<AuthProvider>
				<WorkspaceLayout slots={slots}>
					<Page />
				</WorkspaceLayout>
			</AuthProvider>
		</ThemeProvider>,
		{ route, toaster: false, branding },
	);
	return { user, requests, ...rendered };
}

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
	document.documentElement.classList.remove('dark');
});

describe('Workspace navigation', () => {
	it.each([false, true])(
		'preserves shell customization with workspace navigation (mobile=%s)',
		async (mobile) => {
			const { user } = setup({
				mobile,
				branding: {
					nav_links: [{ label: 'Platform', href: '/platform', roles: ['editor'] }],
					support_url: 'https://support.example.com',
					announcement: { id: 'maintenance', text: 'Planned maintenance' },
				},
			});
			const navigation = within(screen.getByRole('navigation', { name: 'Global' }));
			expect(await navigation.findByRole('link', { name: 'Platform' })).toHaveAttribute(
				'href',
				'/platform',
			);
			expect(navigation.getByRole('link', { name: 'Projects' })).toHaveAttribute(
				'href',
				'/projects',
			);
			expect(navigation.getByRole('link', { name: 'Apps' })).toHaveAttribute('href', '/apps');
			expect(screen.getAllByRole('complementary', { name: 'Announcement' })).toHaveLength(1);
			expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
			if (mobile) {
				await user.click(screen.getByRole('button', { name: 'Open navigation' }));
				expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeVisible();
				await user.click(screen.getByRole('button', { name: 'Close navigation' }));
			}
			await user.click(screen.getByRole('button', { name: 'Help' }));
			expect(screen.getByRole('menuitem', { name: 'Get help' })).toHaveAttribute(
				'href',
				'https://support.example.com',
			);
		},
	);

	it('shows global and project search with separate active states', async () => {
		setup({
			route: '/projects/alpha/search',
			slots: { search: { available: true, allowed: true, to: '/search' } },
		});
		expect(await screen.findByRole('link', { name: 'Search project' })).toHaveAttribute(
			'aria-current',
			'page',
		);
		expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/search');
		expect(screen.getByRole('link', { name: 'Search' })).not.toHaveAttribute('aria-current');
	});
	it.each([
		['/projects/alpha', 'Notebooks'],
		['/projects/alpha/data/integration?table=orders', 'Data'],
		['/projects/alpha/jobs', 'Jobs'],
		['/projects/alpha/notebooks/notebook/jobs?job=nightly&run=latest', 'Jobs'],
	])('selects the project and section for %s', async (route, section) => {
		setup({ route });
		expect(await screen.findByRole('link', { name: section })).toHaveAttribute(
			'aria-current',
			'page',
		);
		expect(screen.getByRole('button', { name: /Alpha/ })).toBeVisible();
		expect(
			within(screen.getByRole('navigation', { name: 'Project' }))
				.getAllByRole('link')
				.filter((link) => link.getAttribute('aria-current') === 'page'),
		).toHaveLength(1);
	});

	it.each(['/', '/projects'])('marks All projects active on %s', async (route) => {
		setup({ route });
		expect(await screen.findByRole('link', { name: 'All projects' })).toHaveAttribute(
			'aria-current',
			'page',
		);
	});

	it('switches projects from later roster pages and follows browser history', async () => {
		const { user } = setup({ route: '/projects/alpha/data/warehouse' });
		await user.click(await screen.findByRole('button', { name: /Alpha/ }));
		await user.click(await screen.findByRole('option', { name: 'Beta' }));
		expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent('/projects/beta');
		expect(await screen.findByRole('link', { name: 'Notebooks' })).toHaveAttribute(
			'aria-current',
			'page',
		);
		await user.click(screen.getByRole('button', { name: 'Back' }));
		expect(screen.getByRole('button', { name: /Alpha/ })).toBeVisible();
		expect(await screen.findByRole('link', { name: 'Data' })).toHaveAttribute(
			'aria-current',
			'page',
		);
	});

	it('keeps direct-linked projects selected when absent from the active roster', async () => {
		setup({ route: '/projects/archived/data' });
		expect(await screen.findByRole('button', { name: /Archived project/ })).toBeVisible();
	});

	it.each(['viewer', 'app-user', null])('gates project navigation for role %s', async (role) => {
		const { requests } = setup({ role });
		await waitFor(() => expect(requests).toContain('/api/v1/projects/alpha'));
		await screen.findByRole('button', { name: /Alpha/ });
		expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
		if (role === 'viewer') expect(await screen.findByRole('link', { name: 'Jobs' })).toBeVisible();
		else {
			expect(screen.queryByRole('navigation', { name: 'Project' })).not.toBeInTheDocument();
			expect(
				screen.queryByRole('navigation', { name: 'Project settings' }),
			).not.toBeInTheDocument();
		}
	});

	it('remembers validated direct links without opening the mobile drawer', async () => {
		setup({ route: '/projects/beta/data', mobile: true });
		await waitFor(() => expect(localStorage.getItem(lastProjectKey('u'))).toBe('beta'));
	});

	it('does not remember a project when access is denied', async () => {
		localStorage.setItem(lastProjectKey('u'), 'beta');
		setup({ projectError: true });
		await screen.findByRole('button', { name: /Alpha/ });
		expect(localStorage.getItem(lastProjectKey('u'))).toBe('beta');
	});

	it.each([false, true])(
		'clears project context on the projects page (mobile=%s)',
		async (mobile) => {
			const { user } = setup({ mobile });
			await waitFor(() => expect(localStorage.getItem(lastProjectKey('u'))).toBe('alpha'));
			await user.click(screen.getByRole('link', { name: 'Projects' }));
			if (mobile) await user.click(screen.getByRole('button', { name: 'Open navigation' }));
			const picker = await screen.findByRole('button', { name: /All projects/ });
			for (const name of ['Notebooks', 'Data', 'Jobs'])
				expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
			expect(
				screen.queryByRole('navigation', { name: 'Project settings' }),
			).not.toBeInTheDocument();
			expect(localStorage.getItem(lastProjectKey('u'))).toBe('alpha');
			await user.click(picker);
			await user.click(await screen.findByRole('option', { name: 'Beta' }));
			if (mobile) await user.click(screen.getByRole('button', { name: 'Open navigation' }));
			expect(await screen.findByRole('button', { name: /Beta/ })).toBeVisible();
			for (const name of ['Notebooks', 'Data', 'Jobs'])
				expect(await screen.findByRole('link', { name })).toBeVisible();
		},
	);

	it.each([false, true])(
		'hides workspace navigation on Apps and restores it on return (mobile=%s)',
		async (mobile) => {
			const { user } = setup({ mobile });
			await screen.findByRole('button', { name: 'User menu' });
			await user.click(screen.getByRole('link', { name: 'Apps' }));
			expect(screen.getByRole('link', { name: 'Apps' })).toHaveAttribute('aria-current', 'page');
			expect(screen.queryByRole('complementary', { name: 'Workspace' })).not.toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
			await user.click(screen.getByRole('button', { name: 'Back' }));
			if (mobile)
				expect(await screen.findByRole('button', { name: 'Open navigation' })).toBeVisible();
			else expect(await screen.findByRole('complementary', { name: 'Workspace' })).toBeVisible();
		},
	);

	it('hides unavailable capabilities and unregistered slots', async () => {
		setup({ jobs: false, data: false });
		await screen.findByRole('link', { name: 'Notebooks' });
		for (const name of ['Data', 'Jobs', 'Chat', 'Search'])
			expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
	});

	it.each([false, true])('opens project settings from the sidebar (mobile=%s)', async (mobile) => {
		const { user, requests } = setup({ mobile, role: 'manager' });
		if (mobile) await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
		const settings = await screen.findByRole('navigation', { name: 'Project settings' });
		expect(
			requests.some((url) => url.endsWith('/members') || url.endsWith('/alert-destinations')),
		).toBe(false);
		for (const [label, title] of [['Alerts', 'Project alerts']]) {
			const trigger = await within(settings).findByRole('button', { name: label });
			trigger.focus();
			await user.keyboard('{Enter}');
			expect(await screen.findByRole('dialog', { name: title })).toBeVisible();
			await user.keyboard('{Escape}');
			await waitFor(() =>
				expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument(),
			);
			await waitFor(() => expect(trigger).toHaveFocus());
		}
	});

	it.each([false, true])(
		'navigates to settings pages and follows history (mobile=%s)',
		async (mobile) => {
			const { user } = setup({ mobile });
			for (const [label, path] of [
				['Members', 'members'],
				['Integrations', 'integrations'],
			]) {
				if (mobile)
					await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
				const link = await screen.findByRole('link', { name: label });
				link.focus();
				await user.keyboard('{Enter}');
				expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(
					`/projects/alpha/${path}`,
				);
				if (mobile) {
					expect(screen.queryByRole('dialog', { name: 'Workspace' })).not.toBeInTheDocument();
					await user.click(screen.getByRole('button', { name: 'Open navigation' }));
				}
				expect(await screen.findByRole('link', { name: label })).toHaveAttribute(
					'aria-current',
					'page',
				);
				expect(screen.getByRole('link', { name: 'Notebooks' })).not.toHaveAttribute('aria-current');
				if (mobile) await user.keyboard('{Escape}');
			}
			await user.click(screen.getByRole('button', { name: 'Back' }));
			expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(
				'/projects/alpha/members',
			);
		},
	);

	it.each([
		['viewer', true, false],
		['editor', true, false],
		['manager', true, true],
		['admin', true, true],
		['manager', false, false],
	] as const)('gates Alerts for role=%s and capability=%s', async (role, alerts, visible) => {
		setup({ role, alerts });
		const settings = await screen.findByRole('navigation', { name: 'Project settings' });
		expect(within(settings).getByRole('link', { name: 'Members' })).toBeVisible();
		expect(within(settings).getByRole('link', { name: 'Integrations' })).toBeVisible();
		if (visible)
			expect(await within(settings).findByRole('button', { name: 'Alerts' })).toBeVisible();
		else expect(within(settings).queryByRole('button', { name: 'Alerts' })).not.toBeInTheDocument();
	});

	it.each([
		[false, true],
		[true, false],
		[true, true],
	])(
		'requires availability=%s and permission=%s for optional destinations',
		async (available, allowed) => {
			setup({
				slots: {
					search: { to: '/search', available, allowed },
					chat: { to: '/projects/alpha/chat', available, allowed },
				},
			});
			await screen.findByRole('link', { name: 'Notebooks' });
			for (const name of ['Search', 'Chat']) {
				if (available && allowed) expect(screen.getByRole('link', { name })).toBeVisible();
				else expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
			}
		},
	);

	it('leaves global links available when project requests fail', async () => {
		setup({ projectError: true, listError: true });
		await screen.findByText('Project list unavailable.');
		expect(screen.getByRole('link', { name: 'Apps' })).toBeVisible();
		expect(screen.queryByRole('navigation', { name: 'Project' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry projects' })).toBeVisible();
	});

	it('does not fetch authoring projects or show the sidebar for app-only users', async () => {
		const { requests } = setup({ appOnly: true, route: '/apps' });
		await screen.findByRole('button', { name: 'User menu' });
		expect(screen.queryByRole('complementary', { name: 'Workspace' })).not.toBeInTheDocument();
		expect(requests.some((url) => url.startsWith('/api/v1/projects'))).toBe(false);
	});

	it('supports keyboard opening, Escape, focus return, and navigation in the mobile drawer', async () => {
		const { user } = setup({ mobile: true });
		const trigger = await screen.findByRole('button', { name: 'Open navigation' });
		trigger.focus();
		await user.keyboard('{Enter}');
		const dialog = await screen.findByRole('dialog', { name: 'Workspace' });
		expect(dialog).toContainElement(document.activeElement as HTMLElement);
		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		await waitFor(() => expect(trigger).toHaveFocus());
		await user.keyboard('{Enter}');
		await user.click(await within(screen.getByRole('dialog')).findByRole('link', { name: 'Data' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(
			'/projects/alpha/data',
		);
	});
});
