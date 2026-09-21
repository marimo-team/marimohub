import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { ProjectEntryPage, AppsPage } from '@/components/Apps/AppsPage';
import { ErrorBoundary } from '@/components/ui';
import { notebookKeys, projectKeys } from '@/api/queryKeys';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { makeFetch, notebook, PID, project } from './Project.testWorld';

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

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
						<Route path="/projects/:pid" element={<ProjectEntryPage />} />
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
	it('shares one fallback until access, project details, and notebooks are ready', async () => {
		const access = deferredResponse();
		const details = deferredResponse();
		const notebooks = deferredResponse();
		const { fetch } = setup((url) => {
			if (url.pathname === '/api/v1/apps') return access.promise;
			if (url.pathname === `/api/v1/projects/${PID}`) return details.promise;
			if (url.pathname === `/api/v1/projects/${PID}/notebooks`) return notebooks.promise;
		});
		const fallback = screen.getByText('Loading page');
		expect(screen.queryByText('Loading project…')).not.toBeInTheDocument();
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		await act(async () => {
			access.resolve(jsonOk({ items: [], next_cursor: null, project: project() }));
		});
		await waitFor(() => {
			const paths = fetch.mock.calls.map(
				([input]) => new URL(String(input), 'http://localhost').pathname,
			);
			expect(paths).toContain(`/api/v1/projects/${PID}`);
			expect(paths).toContain(`/api/v1/projects/${PID}/notebooks`);
		});
		expect(screen.getByText('Loading page')).toBe(fallback);
		await act(async () => {
			details.resolve(jsonOk(project()));
		});
		expect(screen.getByText('Loading page')).toBe(fallback);
		expect(screen.queryByRole('heading', { name: 'Sales' })).not.toBeInTheDocument();
		await act(async () => {
			notebooks.resolve(jsonOk({ items: [notebook()] }));
		});
		expect(await screen.findByRole('heading', { name: 'Sales' })).toBeVisible();
		expect(screen.getByText('Forecast')).toBeVisible();
		expect(screen.queryByText('Loading page')).not.toBeInTheDocument();
	});

	it('preserves dialog state across background refreshes, including an access refresh failure', async () => {
		let failAccess = false;
		const refresh = deferredResponse();
		const { client } = setup((url) => {
			if (failAccess && url.pathname === '/api/v1/apps') return refresh.promise;
		});
		await screen.findByRole('heading', { name: 'Sales' });
		fireEvent.click(screen.getByRole('button', { name: 'Edit project' }));
		const name = screen.getByLabelText('Project Name');
		fireEvent.change(name, { target: { value: 'Unsaved title' } });
		failAccess = true;
		act(() => {
			void client.invalidateQueries({ queryKey: ['apps', 'list'] });
		});
		await waitFor(() => expect(client.isFetching({ queryKey: ['apps', 'list'] })).toBe(1));
		expect(screen.getByLabelText('Project Name')).toBe(name);
		await act(async () => {
			refresh.resolve(jsonError('UNAVAILABLE', 'Temporarily unavailable', 503));
		});
		await waitFor(() => expect(client.isFetching({ queryKey: ['apps', 'list'] })).toBe(0));
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
		const filtered = deferredResponse();
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

	it('redirects app users without fetching authoring data', async () => {
		const { fetch } = setup((url) => {
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
		expect(paths).not.toContain(`/api/v1/projects/${PID}`);
		expect(paths).not.toContain(`/api/v1/projects/${PID}/notebooks`);
	});

	it('retries an initial access failure through the page error boundary', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let failed = false;
		setup((url) => {
			if (url.pathname === '/api/v1/apps' && !failed) {
				failed = true;
				return jsonError('UNAVAILABLE', 'Try again later', 503);
			}
		});
		expect(await screen.findByText('Try again later')).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('heading', { name: 'Sales' })).toBeVisible();
	});
});
