import { deferred } from '@/test/deferred';
import { capabilitiesQueryOptions } from '@/api/hooks';
import { projectKeys, userKeys } from '@/api/queryKeys';
import { DOCS_BASE } from '@/lib/links';
import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ThemeLinkRole } from '@marimo-hub/core/theme';
import { HelpMenu } from '@/components/Header/HelpMenu';
import { AuthProvider } from '@/context/AuthContext';
import { createTestQueryClient, jsonOk, renderWithClient } from '@/test/render';
import { useShellLinks } from './useShellLinks';

function HeaderLinks() {
	return (
		<>
			{useShellLinks('header').map((link) => (
				<a key={link.label} href={link.href}>
					{link.label}
				</a>
			))}
		</>
	);
}
afterEach(() => vi.unstubAllGlobals());
it.each(['app-user', 'viewer', 'editor', 'manager', 'admin'] as const)(
	'filters links for %s and keeps help links out of the header',
	async (role: ThemeLinkRole) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				if (String(input).endsWith('/me'))
					return jsonOk({
						id: 'u',
						app_only: role === 'app-user',
						is_super_admin: role === 'admin',
					});
				return jsonOk({ default_role: role });
			}),
		);
		renderWithClient(
			<AuthProvider>
				<HeaderLinks />
				<HelpMenu />
			</AuthProvider>,
			{
				route: '/',
				branding: {
					docs_url: '/manual',
					support_url: 'https://support.example.com',
					nav_links: [
						{ label: 'Platform', href: '/platform' },
						{ label: 'Your link', href: '/role', roles: [role] },
						{ label: 'Hidden', href: '/hidden', roles: [] },
						{
							label: 'Support portal',
							href: 'https://example.com/help',
							placement: 'help',
							external: false,
							roles: [role],
						},
					],
				},
			},
		);
		expect(await screen.findByRole('link', { name: 'Your link' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Platform' })).toBeInTheDocument();
		expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
		expect(screen.queryByText('Support portal')).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
			'Documentation',
			'Get help',
			'Support portal',
			'About marimohub',
		]);
		expect(screen.getByRole('menuitem', { name: 'Documentation' })).toHaveAttribute(
			'href',
			'/manual',
		);
		expect(screen.getByRole('menuitem', { name: 'Get help' })).toHaveAttribute('target', '_blank');
		expect(screen.getByRole('menuitem', { name: 'Support portal' })).not.toHaveAttribute('target');
	},
);
it('uses the project role before the deployment default', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input) => {
			if (String(input).endsWith('/me')) return jsonOk({ id: 'u' });
			if (String(input).includes('/projects/')) return jsonOk({ id: 'p', your_role: 'manager' });
			return jsonOk({ default_role: 'viewer' });
		}),
	);
	renderWithClient(<HeaderLinks />, {
		route: '/projects/p',
		branding: { nav_links: [{ label: 'Managers', href: '/manager', roles: ['manager'] }] },
	});
	expect(await screen.findByRole('link', { name: 'Managers' })).toBeInTheDocument();
});

it.each([403, 503])(
	'keeps role-specific links hidden while project access loads or fails (%s)',
	async (status) => {
		const project = deferred<Response>();
		const client = createTestQueryClient();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				if (String(input).endsWith('/me')) return jsonOk({ id: 'u' });
				if (String(input).includes('/projects/')) return project.promise;
				return jsonOk({ default_role: 'editor' });
			}),
		);
		renderWithClient(<HeaderLinks />, {
			client,
			route: '/projects/p',
			branding: {
				nav_links: [
					{ label: 'Public', href: '/public' },
					{ label: 'Editors', href: '/editors', roles: ['editor'] },
				],
			},
		});
		await waitFor(() =>
			expect(client.getQueryData(capabilitiesQueryOptions().queryKey)).toEqual({
				default_role: 'editor',
			}),
		);
		expect(screen.getByRole('link', { name: 'Public' })).toBeInTheDocument();
		expect(screen.queryByText('Editors')).not.toBeInTheDocument();
		project.resolve(
			Response.json(
				{ success: false, error: { code: 'UNAVAILABLE', message: 'Cannot load project' } },
				{ status },
			),
		);
		await waitFor(() =>
			expect(client.getQueryState(projectKeys.detail('p'))?.status).toBe('error'),
		);
		expect(screen.queryByText('Editors')).not.toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Public' })).toBeInTheDocument();
	},
);

it('keeps public links and default documentation available when identity lookup fails', async () => {
	const client = createTestQueryClient();
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json(
				{ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in' } },
				{ status: 401 },
			),
		),
	);
	renderWithClient(
		<>
			<HeaderLinks />
			<HelpMenu />
		</>,
		{
			client,
			route: '/',
			branding: {
				nav_links: [
					{ label: 'Public', href: '/public' },
					{ label: 'Admins', href: '/admin', roles: ['admin'] },
				],
			},
		},
	);
	await waitFor(() => expect(client.getQueryState(userKeys.me())?.fetchStatus).toBe('idle'));
	expect(screen.getByRole('link', { name: 'Public' })).toBeInTheDocument();
	expect(screen.queryByText('Admins')).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole('button', { name: 'Help' }));
	expect(screen.getByRole('menuitem', { name: 'Documentation' })).toHaveAttribute(
		'href',
		DOCS_BASE,
	);
	expect(screen.queryByRole('menuitem', { name: 'Get help' })).not.toBeInTheDocument();
});
