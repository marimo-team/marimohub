import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { AppsPage } from '@/components/Apps/AppsPage';
import { ProjectSourceGate } from '@/components/Workspace/ProjectSourceGate';
import { Project } from './Project';
import { ErrorBoundary } from '@/components/ui';
import { notebookKeys, projectKeys } from '@/api/queryKeys';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { makeFetch, notebook, PID, project } from './Project.testWorld';

function setup(respond?: (url: URL) => Response | Promise<Response> | undefined) {
	makeFetch();
	const originalFetch = globalThis.fetch;
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), 'http://localhost');
		const response = respond?.(url);
		if (response) return response;
		if (url.pathname === '/api/v1/apps') {
			return jsonOk({ items: [], next_cursor: null, project: project() });
		}
		return originalFetch(input, init);
	});
	vi.stubGlobal('fetch', fetch);
	const result = renderWithClient(
		<QueryErrorResetBoundary>
			{({ reset }) => (
				<ErrorBoundary onRetry={reset}>
					<Routes>
						<Route path="/projects/:pid" element={<ProjectSourceGate />}>
							<Route index element={<Project />} />
						</Route>
						<Route path="/apps" element={<AppsPage />} />
					</Routes>
				</ErrorBoundary>
			)}
		</QueryErrorResetBoundary>,
		{ route: `/projects/${PID}`, suspenseFallback: <p>Loading page</p> },
	);
	return { ...result, fetch };
}

describe('project loading', () => {
	it.each([false, true])(
		'shows a session placeholder until the first response in compact=%s layout',
		async (compact) => {
			installMatchMedia(compact);
			const sessions = deferred<Response>();
			setup((url) =>
				url.pathname === `/api/v1/projects/${PID}/sessions` ? sessions.promise : undefined,
			);
			await screen.findByRole('heading', { name: 'Sales' });
			const row = screen.getByTestId('notebook-row');
			expect(row.querySelectorAll('.animate-pulse.size-2')).toHaveLength(1);
			if (!compact)
				expect(screen.getByRole('columnheader', { name: 'Sessions' })).toBeInTheDocument();
			await act(async () => sessions.resolve(jsonOk({ items: [], next_cursor: null })));
			await waitFor(() => expect(row.querySelector('.animate-pulse.size-2')).toBeNull());
			expect(screen.queryByRole('columnheader', { name: 'Sessions' })).not.toBeInTheDocument();
		},
	);

	it('waits for project metadata and notebooks without an apps access request', async () => {
		const details = deferred<Response>();
		const notebooks = deferred<Response>();
		const { fetch } = setup((url) => {
			if (url.pathname === `/api/v1/projects/${PID}`) return details.promise;
			if (url.pathname === `/api/v1/projects/${PID}/notebooks`) return notebooks.promise;
		});
		expect(screen.getByText('Checking project access…')).toBeVisible();
		expect(screen.queryByRole('heading', { name: 'Sales' })).not.toBeInTheDocument();
		await act(async () => details.resolve(jsonOk(project())));
		await waitFor(() => {
			const paths = fetch.mock.calls.map(
				([input]) => new URL(String(input), 'http://localhost').pathname,
			);
			expect(paths).toContain(`/api/v1/projects/${PID}/notebooks`);
			expect(paths).toContain(`/api/v1/projects/${PID}/sessions`);
			expect(paths).not.toContain('/api/v1/apps');
		});
		expect(screen.getByText('Loading page')).toBeVisible();
		expect(screen.queryByRole('heading', { name: 'Sales' })).not.toBeInTheDocument();
		await act(async () => notebooks.resolve(jsonOk({ items: [notebook()] })));
		expect(await screen.findByRole('heading', { name: 'Sales' })).toBeVisible();
		expect(screen.getByText('Forecast')).toBeVisible();
		expect(screen.queryByText('Loading page')).not.toBeInTheDocument();
	});

	it('preserves dialog state across background refreshes, including an access refresh failure', async () => {
		let failAccess = false;
		const refresh = deferred<Response>();
		const { client } = setup((url) => {
			if (failAccess && url.pathname === `/api/v1/projects/${PID}`) return refresh.promise;
		});
		await screen.findByRole('heading', { name: 'Sales' });
		fireEvent.click(screen.getByRole('button', { name: 'Edit project' }));
		const name = screen.getByLabelText('Project Name');
		fireEvent.change(name, { target: { value: 'Unsaved title' } });
		failAccess = true;
		act(() => {
			void client.invalidateQueries({ queryKey: projectKeys.detail(PID) });
		});
		await waitFor(() => expect(client.isFetching({ queryKey: projectKeys.detail(PID) })).toBe(1));
		expect(screen.getByLabelText('Project Name')).toBe(name);
		await act(async () => {
			refresh.resolve(jsonError('UNAVAILABLE', 'Temporarily unavailable', 503));
		});
		await waitFor(() => expect(client.isFetching({ queryKey: projectKeys.detail(PID) })).toBe(0));
		failAccess = false;
		await act(async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: projectKeys.detail(PID) }),
				client.invalidateQueries({ queryKey: notebookKeys.list(PID) }),
			]);
		});
		expect(screen.getByLabelText('Project Name')).toBe(name);
		expect(name).toHaveValue('Unsaved title');
		expect(screen.queryByText('Loading page')).not.toBeInTheDocument();
	});

	it('keeps the project and existing results visible while filters load', async () => {
		const filtered = deferred<Response>();
		const { fetch } = setup((url) => {
			if (url.pathname.endsWith('/notebooks') && url.searchParams.has('q')) return filtered.promise;
		});
		const heading = await screen.findByRole('heading', { name: 'Sales' });
		fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
		fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
			target: { value: 'missing' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() =>
			expect(fetch.mock.calls.some(([input]) => String(input).includes('q=missing'))).toBe(true),
		);
		expect(screen.getByRole('heading', { name: 'Sales' })).toBe(heading);
		expect(screen.getByText('Forecast')).toBeVisible();
		expect(screen.getByRole('status')).toHaveTextContent('Updating notebooks');
		expect(screen.queryByText('Loading page')).not.toBeInTheDocument();
		await act(async () => {
			filtered.resolve(jsonOk({ items: [] }));
		});
		expect(await screen.findByText('No notebooks match these filters')).toBeVisible();
		expect(screen.getByRole('heading', { name: 'Sales' })).toBe(heading);
	});

	it('redirects app users after hidden metadata without fetching notebooks', async () => {
		const { fetch } = setup((url) => {
			if (url.pathname === `/api/v1/projects/${PID}`)
				return jsonError('NOT_FOUND', 'Not found', 404);
			if (url.pathname === '/api/v1/apps') {
				return jsonOk({
					items: [],
					next_cursor: null,
					project: { ...project(), your_role: 'app-user' },
				});
			}
		});
		expect(await screen.findByRole('heading', { name: 'Apps' })).toBeVisible();
		expect(screen.getByText('No apps available.')).toBeVisible();
		const paths = fetch.mock.calls.map(
			([input]) => new URL(String(input), 'http://localhost').pathname,
		);
		expect(paths).toContain(`/api/v1/projects/${PID}`);
		expect(paths).not.toContain(`/api/v1/projects/${PID}/notebooks`);
	});

	it('retries an initial access failure through the page error boundary', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let failed = false;
		setup((url) => {
			if (url.pathname === `/api/v1/projects/${PID}` && !failed) {
				failed = true;
				return jsonError('UNAVAILABLE', 'Try again later', 503);
			}
		});
		expect(await screen.findByText('Try again later')).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('heading', { name: 'Sales' })).toBeVisible();
	});
});

describe('notebook pagination', () => {
	it.each(['http', 'network'])(
		'preserves rows after a %s page failure and retries only that page',
		async (failure) => {
			let fail = true;
			const { fetch } = setup((url) => {
				if (!url.pathname.endsWith('/notebooks')) return;
				if (!url.searchParams.has('cursor'))
					return jsonOk({ items: [notebook()], next_cursor: 'next' });
				if (fail) {
					if (failure === 'network') return Promise.reject(new TypeError('Failed to fetch'));
					return jsonError('UNAVAILABLE', 'Page unavailable', 503);
				}
				return jsonOk({
					items: [notebook(), { ...notebook(), id: 'older', title: 'Older notebook' }],
					next_cursor: null,
				});
			});
			await screen.findByText('Forecast');
			fireEvent.click(screen.getByRole('button', { name: 'Load more notebooks' }));
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Load more notebooks' })).toBeEnabled(),
			);
			expect(screen.getByText('Forecast')).toBeVisible();
			expect(screen.getAllByTestId('notebook-row')).toHaveLength(1);
			fail = false;
			fireEvent.click(screen.getByRole('button', { name: 'Load more notebooks' }));
			await screen.findByText('Older notebook');
			expect(screen.getAllByTestId('notebook-row')).toHaveLength(2);
			expect(
				fetch.mock.calls
					.filter(([url]) => String(url).includes('/notebooks?'))
					.map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('cursor')),
			).toEqual([null, 'next', 'next']);
			expect(screen.queryByRole('button', { name: 'Load more notebooks' })).not.toBeInTheDocument();
		},
	);

	it('loads notebooks beyond the first 100 only on request', async () => {
		const entries = Array.from({ length: 150 }, (_, i) => ({
			...notebook(),
			id: `notebook-${i}`,
			title: `Notebook ${i}`,
		}));
		const { fetch } = setup((url) => {
			if (!url.pathname.endsWith('/notebooks')) return;
			return jsonOk(
				url.searchParams.has('cursor')
					? { items: entries.slice(100), next_cursor: null }
					: { items: entries.slice(0, 100), next_cursor: 'next' },
			);
		});
		await screen.findByText('Notebook 99', {}, { timeout: 10_000 });
		expect(screen.getAllByTestId('notebook-row')).toHaveLength(100);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes('cursor='))).toHaveLength(0);
		await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('100+ notebooks'));
		fireEvent.click(screen.getByRole('button', { name: 'Load more notebooks' }));
		await screen.findByText('Notebook 149', {}, { timeout: 10_000 });
		expect(screen.getAllByTestId('notebook-row')).toHaveLength(150);
		await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('150 notebooks'));
		expect(screen.queryByRole('button', { name: 'Load more notebooks' })).not.toBeInTheDocument();
	});
});
