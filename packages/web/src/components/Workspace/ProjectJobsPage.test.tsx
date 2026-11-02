import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { ProjectJobsPage } from './ProjectJobsPage';

function setup({
	available = true,
	role = 'editor',
	denied = false,
	failNext = false,
}: { available?: boolean; role?: string; denied?: boolean; failNext?: boolean } = {}) {
	const requests: string[] = [];
	let failed = false;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), 'http://localhost');
			requests.push(url.pathname + url.search);
			if (url.pathname === '/api/v1/projects/p')
				return denied
					? jsonError('FORBIDDEN', 'Forbidden', 403)
					: jsonOk({ id: 'p', name: 'Analysis', your_role: role });
			if (url.pathname === '/api/v1/capabilities') return jsonOk({ jobs: { available } });
			if (url.pathname === '/api/v1/projects/p/notebooks') {
				if (!url.searchParams.has('cursor'))
					return jsonOk({ items: [{ id: 'first', title: 'First notebook' }], next_cursor: 'next' });
				if (failNext && !failed) {
					failed = true;
					return jsonError('UNAVAILABLE', 'Unavailable', 503);
				}
				return jsonOk({ items: [{ id: 'second', title: 'Second notebook' }], next_cursor: null });
			}
			throw new Error(`Unexpected request ${url}`);
		}),
	);
	const user = userEvent.setup();
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid/jobs" element={<ProjectJobsPage />} />
			<Route path="/apps" element={<h1>Apps</h1>} />
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
		expect(requests.some((url) => url.includes('/notebooks'))).toBe(false);
	});

	it('does not load notebooks when project access is denied', async () => {
		const { requests } = setup({ denied: true });
		await waitFor(() => expect(screen.getByText('Request failed')).toBeVisible());
		expect(requests.some((url) => url.includes('/notebooks'))).toBe(false);
	});
});
