import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { userKeys } from '@/api/queryKeys';
import { makeUser, stubApi } from '@/test/apiStub';
import type { RouteHandler } from '@/test/apiStub';
import { createTestQueryClient, jsonError, renderWithClient } from '@/test/render';
import { WorkspaceHome } from './WorkspaceHome';
import { lastProjectKey } from './lastProject';

function Destination() {
	const location = useLocation();
	return (
		<output aria-label="Destination">
			{location.pathname}
			{location.search}
		</output>
	);
}

const PROJECTS = {
	items: [
		{ id: 'alpha', name: 'Alpha', tags: [] },
		{ id: 'beta', name: 'Beta', tags: [] },
	],
	next_cursor: null,
};

function setup({
	userId = 'u',
	appOnly = false,
	route = '/',
	projects = PROJECTS as RouteHandler,
} = {}) {
	const user = makeUser({ id: userId, app_only: appOnly });
	const client = createTestQueryClient();
	client.setQueryData(userKeys.me(), user);
	const { requests } = stubApi({ '/api/v1/projects': projects }, { me: user });
	renderWithClient(
		<AuthProvider>
			<Routes>
				<Route path="/" element={<WorkspaceHome />} />
				<Route path="*" element={<Destination />} />
			</Routes>
		</AuthProvider>,
		{ route, toaster: false, client, errorBoundary: true },
	);
	return requests;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
});

describe('Workspace home', () => {
	it('restores the previous accessible project', async () => {
		localStorage.setItem(lastProjectKey('u'), 'beta');
		setup();
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/projects/beta',
		);
	});
	it('falls back to an accessible project when the remembered one is gone', async () => {
		localStorage.setItem(lastProjectKey('u'), 'deleted');
		setup();
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/projects/alpha',
		);
	});
	it('does not reuse another account’s preference', async () => {
		localStorage.setItem(lastProjectKey('other'), 'beta');
		setup();
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/projects/alpha',
		);
	});
	it('works when local storage is blocked', async () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('Blocked');
		});
		setup();
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/projects/alpha',
		);
	});
	it('keeps app-only users on Apps', async () => {
		localStorage.setItem(lastProjectKey('u'), 'beta');
		setup({ appOnly: true });
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent('/apps');
	});
	it('preserves project-index filter links', async () => {
		const requests = setup({ route: '/?q=analysis' });
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/projects?q=analysis',
		);
		expect(requests.some((url) => url.startsWith('/api/v1/projects'))).toBe(false);
	});
	it('shows the project index when there are no projects', async () => {
		localStorage.setItem(lastProjectKey('u'), 'beta');
		setup({ projects: { items: [], next_cursor: null } });
		expect(await screen.findByText('No projects yet')).toBeVisible();
		expect(screen.queryByRole('status', { name: 'Destination' })).not.toBeInTheDocument();
	});
	it('does not redirect when the project list fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		localStorage.setItem(lastProjectKey('u'), 'beta');
		setup({ projects: jsonError('UNAVAILABLE', 'Unavailable', 503) });
		expect(await screen.findByText('Request failed')).toBeVisible();
		expect(screen.queryByRole('status', { name: 'Destination' })).not.toBeInTheDocument();
	});
});
