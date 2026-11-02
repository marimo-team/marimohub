import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import type { ProjectRole } from '@/types';
import { ProjectSettingsPage } from './ProjectSettingsPage';

function setup(
	section: 'members' | 'integrations',
	role: ProjectRole | null = 'manager',
	denied = false,
) {
	installMatchMedia();
	const requests: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const { pathname, searchParams } = new URL(String(input), 'http://localhost');
			requests.push(pathname);
			if (pathname === '/api/v1/me')
				return jsonOk({ id: 'user', email: 'user@example.com', groups: [] });
			if (pathname === '/api/v1/apps' && searchParams.get('project_id') === 'alpha')
				return denied
					? jsonError('NOT_FOUND', 'Not found', 404)
					: jsonOk({
							items: [],
							next_cursor: null,
							project: { id: 'alpha', name: 'Alpha', your_role: role },
						});
			if (pathname === '/api/v1/projects/alpha')
				return denied || role === 'app-user'
					? jsonError('NOT_FOUND', 'Not found', 404)
					: jsonOk({
							id: 'alpha',
							name: 'Alpha',
							owner: 'owner',
							members: [],
							default_role: 'inherit',
							your_role: role,
						});
			if (pathname === '/api/v1/capabilities')
				return jsonOk({
					project_groups: { available: false },
					federation: { available: false, default_enabled: false },
				});
			if (pathname === '/api/v1/users') return jsonOk({});
			if (pathname.endsWith('/members')) return jsonOk([]);
			if (pathname === '/api/v1/integrations/kinds') return jsonOk([]);
			if (pathname.endsWith('/integrations')) return jsonOk({ items: [] });
			throw new Error(`Unexpected request: ${pathname}`);
		}),
	);
	renderWithClient(
		<AuthProvider>
			<Routes>
				<Route path="/projects/:pid/members" element={<ProjectSettingsPage section="members" />} />
				<Route
					path="/projects/:pid/integrations"
					element={<ProjectSettingsPage section="integrations" />}
				/>
				<Route path="/apps" element={<p>Apps destination</p>} />
			</Routes>
		</AuthProvider>,
		{ route: `/projects/alpha/${section}`, errorBoundary: true },
	);
	return requests;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Project settings pages', () => {
	it('renders member management directly without a modal', async () => {
		setup('members');
		expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
		expect(await screen.findByText('No explicit project members')).toBeVisible();
		expect(screen.getByRole('combobox', { name: 'Search users' })).toBeVisible();
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
	it('keeps member management read-only for viewers', async () => {
		setup('members', 'viewer');
		await screen.findByText('No explicit project members');
		expect(screen.queryByRole('combobox', { name: 'Search users' })).not.toBeInTheDocument();
	});
	it('renders integrations with an Add action and a small cloud access control', async () => {
		setup('integrations');
		expect(await screen.findByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
		expect(await screen.findByRole('button', { name: 'Add integration' })).toBeVisible();
		expect(screen.getByRole('button', { name: 'Cloud access' })).toBeVisible();
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
	it.each(['members', 'integrations'] as const)(
		'redirects app-only project access from %s without fetching settings',
		async (section) => {
			const requests = setup(section, 'app-user');
			await screen.findByText('Apps destination');
			expect(requests).toContain('/api/v1/apps');
			expect(requests).not.toContain('/api/v1/projects/alpha');
			expect(
				requests.some((path) => path.endsWith('/members') || path.endsWith('/integrations')),
			).toBe(false);
		},
	);
	it.each(['members', 'integrations'] as const)(
		'respects denied direct links to %s',
		async (section) => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const requests = setup(section, null, true);
			await screen.findByText('Request failed');
			expect(
				requests.some((path) => path.endsWith('/members') || path.endsWith('/integrations')),
			).toBe(false);
		},
	);
});
