import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { makeUser, stubApi } from '@/test/apiStub';
import { createTestQueryClient, jsonError, renderWithClient } from '@/test/render';
import type { ProjectRole } from '@/types';
import { userKeys } from '@/api/queryKeys';
import { lastProjectKey } from './lastProject';
import { ProjectSourceGate } from './ProjectSourceGate';

function Destination() {
	const location = useLocation();
	return <output aria-label="Destination">{location.pathname + location.search}</output>;
}

function setup(route: string, role: ProjectRole) {
	stubApi({
		'/api/v1/apps': {
			items: [],
			next_cursor: null,
			project: { id: 'p', name: 'Analysis', your_role: role },
		},
	});
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route path="data" element={<p>Data page</p>} />
				<Route path="notebooks/:nid/jobs" element={<p>Notebook jobs page</p>} />
			</Route>
			<Route path="*" element={<Destination />} />
		</Routes>,
		{ route, toaster: false },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
});

describe('ProjectSourceGate', () => {
	it.each(['/projects/p/data', '/projects/p/notebooks/n/jobs'])(
		'sends app users from %s to the project apps',
		async (route) => {
			setup(route, 'app-user');
			expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
				'/apps?project_id=p',
			);
		},
	);

	it.each([
		['/projects/p/data', 'Data page'],
		['/projects/p/notebooks/n/jobs', 'Notebook jobs page'],
	])('renders %s for source readers', async (route, page) => {
		setup(route, 'viewer');
		expect(await screen.findByText(page)).toBeVisible();
	});
});

it.each([
	{ remembered: 'missing', blocked: false },
	{ remembered: 'newer', blocked: false },
	{ remembered: 'missing', blocked: true },
])(
	'clears only the failed remembered project ($remembered, blocked=$blocked)',
	async ({ remembered, blocked }) => {
		const client = createTestQueryClient();
		client.setQueryData(userKeys.me(), makeUser());
		localStorage.setItem(lastProjectKey('u'), remembered);
		localStorage.setItem(lastProjectKey('other'), 'missing');
		if (blocked)
			vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
				throw new Error('Blocked');
			});
		stubApi({ '/api/v1/apps': jsonError('NOT_FOUND', 'Project not found', 404) });
		renderWithClient(
			<Routes>
				<Route path="/projects/:pid" element={<ProjectSourceGate />}>
					<Route index element={<p>Project source</p>} />
				</Route>
				<Route path="*" element={<Destination />} />
			</Routes>,
			{ route: '/projects/missing', toaster: false, client },
		);
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			/^\/projects$/,
		);
		expect(localStorage.getItem(lastProjectKey('u'))).toBe(
			!blocked && remembered === 'missing' ? null : remembered,
		);
		expect(localStorage.getItem(lastProjectKey('other'))).toBe('missing');
		expect(screen.queryByText('Project source')).not.toBeInTheDocument();
	},
);

it.each([false, true])(
	'rechecks access after returning to a formerly missing project (StrictMode=%s)',
	async (reactStrictMode) => {
		let missing = true;
		const { requests } = stubApi({
			'/api/v1/apps': () =>
				missing
					? jsonError('NOT_FOUND', 'Not found', 404)
					: {
							items: [],
							next_cursor: null,
							project: { id: 'p', name: 'Project', your_role: 'editor' },
						},
		});
		renderWithClient(
			<Routes>
				<Route path="/projects/:pid" element={<ProjectSourceGate />}>
					<Route index element={<p>Project source</p>} />
				</Route>
				<Route path="/projects" element={<Link to="/projects/p">Open project</Link>} />
			</Routes>,
			{ route: '/projects/p', toaster: false, reactStrictMode },
		);
		const reopen = await screen.findByRole('link', { name: 'Open project' });
		expect(requests).toHaveLength(1);
		missing = false;
		fireEvent.click(reopen);
		expect(await screen.findByText('Project source')).toBeVisible();
		expect(requests).toHaveLength(2);
	},
);
