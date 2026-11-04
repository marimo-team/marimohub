import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWorkspace, stubApi } from '@/test/apiStub';
import { jsonError } from '@/test/render';
import type { ProjectRole } from '@/types';
import { ProjectAlertsPage } from './ProjectAlertsPage';
import { ProjectSettingsPage } from './ProjectSettingsPage';
import { ProjectSourceGate } from './ProjectSourceGate';

function setup(
	section: 'members' | 'integrations' | 'alerts',
	role: ProjectRole | null = 'manager',
	denied = false,
	alerts = true,
) {
	const { requests } = stubApi(
		{
			'/api/v1/apps': ({ url }) =>
				url.searchParams.get('project_id') !== 'alpha' || denied
					? jsonError('NOT_FOUND', 'Not found', 404)
					: {
							items: [],
							next_cursor: null,
							project: { id: 'alpha', name: 'Alpha', your_role: role },
						},
			'/api/v1/projects/alpha': () =>
				denied || role === 'app-user'
					? jsonError('NOT_FOUND', 'Not found', 404)
					: {
							id: 'alpha',
							name: 'Alpha',
							owner: 'owner',
							members: [],
							default_role: 'inherit',
							your_role: role,
						},
			'/api/v1/users': {},
			'/api/v1/projects/alpha/members': [],
			'/api/v1/integrations/kinds': [],
			'/api/v1/projects/alpha/integrations': { items: [] },
			'/api/v1/projects/alpha/alert-destinations': { items: [] },
		},
		{ capabilities: { project_alerts: { available: alerts } } },
	);
	renderWorkspace(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route path="alerts" element={<ProjectAlertsPage />} />
				<Route path="members" element={<ProjectSettingsPage section="members" />} />
				<Route path="integrations" element={<ProjectSettingsPage section="integrations" />} />
			</Route>
			<Route path="/apps" element={<p>Apps destination</p>} />
		</Routes>,
		{ route: `/projects/alpha/${section}`, errorBoundary: true },
	);
	return requests;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Project settings pages', () => {
	it('renders alert destinations directly without a modal', async () => {
		setup('alerts');
		expect(await screen.findByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
		expect(await screen.findByText('No alert destinations')).toBeVisible();
		expect(screen.getByRole('button', { name: 'Add destination' })).toBeVisible();
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
	it.each(['viewer', 'editor'] as const)(
		'does not fetch alert destinations for %s direct links',
		async (role) => {
			const requests = setup('alerts', role);
			await screen.findByText('Alert management is not available');
			expect(requests.some((path) => path.endsWith('/alert-destinations'))).toBe(false);
			expect(screen.queryByRole('button', { name: 'Add destination' })).not.toBeInTheDocument();
		},
	);
	it('does not fetch alert destinations when alerts are disabled', async () => {
		const requests = setup('alerts', 'manager', false, false);
		await screen.findByText('Alerts are not enabled');
		expect(requests.some((path) => path.endsWith('/alert-destinations'))).toBe(false);
	});

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
	it.each(['members', 'integrations', 'alerts'] as const)(
		'redirects app-only project access from %s without fetching settings',
		async (section) => {
			const requests = setup(section, 'app-user');
			await screen.findByText('Apps destination');
			expect(requests).toContain('/api/v1/apps?project_id=alpha');
			expect(requests).not.toContain('/api/v1/projects/alpha');
			expect(
				requests.some((path) => /\/(members|integrations|alert-destinations)(\?|$)/.test(path)),
			).toBe(false);
		},
	);
	it.each(['members', 'integrations', 'alerts'] as const)(
		'respects denied direct links to %s',
		async (section) => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const requests = setup(section, null, true);
			await screen.findByText('Request failed');
			expect(
				requests.some((path) => /\/(members|integrations|alert-destinations)(\?|$)/.test(path)),
			).toBe(false);
		},
	);
});
