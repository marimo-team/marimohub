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
		const requests = setup({ projects: () => new Promise(() => {}) });
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/projects/beta',
		);
		expect(requests.some((url) => url.startsWith('/api/v1/projects'))).toBe(false);
	});
	it('lets the project route validate a remembered project', async () => {
		localStorage.setItem(lastProjectKey('u'), 'deleted');
		setup();
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/projects/deleted',
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
	it.each([
		{ state: 'empty', projects: { items: [], next_cursor: null } },
		{ state: 'unavailable', projects: jsonError('UNAVAILABLE', 'Unavailable', 503) },
	])('opens the project index when the first-visit roster is $state', async ({ projects }) => {
		setup({ projects });
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			/^\/projects$/,
		);
	});
});
