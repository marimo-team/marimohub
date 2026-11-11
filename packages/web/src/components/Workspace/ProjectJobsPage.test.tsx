import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { stubApi } from '@/test/apiStub';
import { jsonError, renderWithClient, setupUser } from '@/test/render';
import type { ProjectRole } from '@/types';
import { ProjectJobsPage } from './ProjectJobsPage';
import { ProjectSourceGate } from './ProjectSourceGate';

function setup({
	available = true,
	role = 'editor',
	denied = false,
	failNext = false,
}: { available?: boolean; role?: ProjectRole; denied?: boolean; failNext?: boolean } = {}) {
	let failed = false;
	const { requests } = stubApi(
		{
			'/api/v1/apps': ({ url }) =>
				url.searchParams.get('project_id') !== 'p' || denied
					? jsonError('NOT_FOUND', 'Not found', 404)
					: {
							items: [],
							next_cursor: null,
							project: { id: 'p', name: 'Analysis', your_role: role },
						},
			'/api/v1/projects/p': () =>
				denied || role === 'app-user'
					? jsonError('NOT_FOUND', 'Not found', 404)
					: { id: 'p', name: 'Analysis', your_role: role },
			'/api/v1/projects/p/notebooks': ({ url }) => {
				if (!url.searchParams.has('cursor'))
					return { items: [{ id: 'first', title: 'First notebook' }], next_cursor: 'next' };
				if (failNext && !failed) {
					failed = true;
					return jsonError('UNAVAILABLE', 'Unavailable', 503);
				}
				return { items: [{ id: 'second', title: 'Second notebook' }], next_cursor: null };
			},
		},
		{ capabilities: { jobs: { available } } },
	);
	const user = setupUser();
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route path="jobs" element={<ProjectJobsPage />} />
			</Route>
			<Route path="/apps" element={<h1>Apps</h1>} />
			<Route path="/projects" element={<p>Projects destination</p>} />
		</Routes>,
		{ route: '/projects/p/jobs', errorBoundary: true },
	);
	return { user, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe('Project jobs navigation', () => {
	it('paginates notebooks and links to existing job routes without fetching individual jobs', async () => {
		const { user, requests } = setup();
		expect(await screen.findByRole('link', { name: /First notebook/ })).toHaveAttribute(
			'href',
			'/projects/p/notebooks/first/jobs',
		);
		await user.click(screen.getByRole('button', { name: 'Load more notebooks' }));
		expect(await screen.findByRole('link', { name: /Second notebook/ })).toHaveAttribute(
			'href',
			'/projects/p/notebooks/second/jobs',
		);
		expect(requests.some((url) => url.includes('/notebooks/') && url.endsWith('/jobs'))).toBe(
			false,
		);
		expect(screen.queryByRole('button', { name: 'Load more notebooks' })).not.toBeInTheDocument();
	});

	it('keeps loaded notebooks visible when the next page fails and allows retry', async () => {
		const { user } = setup({ failNext: true });
		await screen.findByRole('link', { name: /First notebook/ });
		await user.click(screen.getByRole('button', { name: 'Load more notebooks' }));
		await screen.findByText('Could not load more notebooks.');
		expect(screen.getByRole('link', { name: /First notebook/ })).toBeVisible();
		await user.click(screen.getByRole('button', { name: 'Retry loading notebooks' }));
		expect(await screen.findByRole('link', { name: /Second notebook/ })).toBeVisible();
	});

	it('does not load notebooks when jobs are unavailable', async () => {
		const { requests } = setup({ available: false });
		await screen.findByText('Jobs are not enabled');
		expect(requests.some((url) => url.includes('/notebooks'))).toBe(false);
	});

	it('redirects app users without fetching notebooks', async () => {
		const { requests } = setup({ role: 'app-user' });
		await screen.findByRole('heading', { name: 'Apps' });
		expect(requests).toContain('/api/v1/apps?project_id=p');
		expect(requests.filter((url) => url === '/api/v1/projects/p')).toHaveLength(1);
		expect(requests.some((url) => url.includes('/notebooks'))).toBe(false);
	});

	it('does not load notebooks when project access is denied', async () => {
		const { requests } = setup({ denied: true });
		await waitFor(() => expect(screen.getByText('Projects destination')).toBeVisible());
		expect(requests.some((url) => url.includes('/notebooks'))).toBe(false);
	});
});
