import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { userKeys } from '@/api/queryKeys';
import { createTestQueryClient, jsonOk, renderWithClient } from '@/test/render';
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

function setup({ userId = 'u', appOnly = false, route = '/' } = {}) {
	const requests: string[] = [];
	const user = { id: userId, email: 'user@example.com', app_only: appOnly };
	const client = createTestQueryClient();
	client.setQueryData(userKeys.me(), user);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), 'http://localhost');
			requests.push(url.pathname);
			if (url.pathname === '/api/v1/me') return jsonOk(user);
			if (url.pathname === '/api/v1/projects')
				return jsonOk({
					items: [
						{ id: 'alpha', name: 'Alpha' },
						{ id: 'beta', name: 'Beta' },
					],
					next_cursor: null,
				});
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	renderWithClient(
		<AuthProvider>
			<Routes>
				<Route path="/" element={<WorkspaceHome />} />
				<Route path="*" element={<Destination />} />
			</Routes>
		</AuthProvider>,
		{ route, toaster: false, client },
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
		expect(requests).not.toContain('/api/v1/projects');
	});
});
