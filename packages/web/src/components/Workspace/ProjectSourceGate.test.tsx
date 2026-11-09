import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { stubApi } from '@/test/apiStub';
import { jsonError, renderWithClient } from '@/test/render';
import type { ProjectRole } from '@/types';
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

afterEach(() => vi.unstubAllGlobals());

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

it('returns a missing remembered project to the project index', async () => {
	stubApi({ '/api/v1/apps': jsonError('NOT_FOUND', 'Project not found', 404) });
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route index element={<p>Project source</p>} />
			</Route>
			<Route path="*" element={<Destination />} />
		</Routes>,
		{ route: '/projects/missing', toaster: false },
	);
	expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent('/projects');
	expect(screen.queryByText('Project source')).not.toBeInTheDocument();
});
