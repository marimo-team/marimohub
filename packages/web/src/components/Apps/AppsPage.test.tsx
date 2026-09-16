import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@/context/ThemeContext';
import { AppsPage, ProjectEntryPage } from './AppsPage';
import { AppEntryPage } from './AppEntryPage';
import {
	makeFetch,
	NID,
	PID,
	runningSession,
	sessionPosts,
} from '../NotebookPage/NotebookPage.testWorld';

const app = {
	project_id: PID,
	project_name: 'Analytics',
	notebook_id: NID,
	title: 'Forecast',
	url: `/projects/${PID}/notebooks/${NID}/app`,
	your_role: 'app-user',
	can: { run: true },
};

function setup(entry = '/apps', items = [app]) {
	const existing = makeFetch({
		role: 'app-user',
		session: runningSession({ mode: 'app', can: { attach: true, stop: false } }),
	});
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
		if (url.pathname === '/api/v1/apps') {
			const q = url.searchParams.get('q') ?? '';
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						items: items.filter((item) => item.title.includes(q)),
						next_cursor: null,
						...(url.searchParams.has('project_id')
							? { project: { id: PID, name: 'Analytics', your_role: 'app-user' } }
							: {}),
					},
				}),
				{ headers: { 'content-type': 'application/json' } },
			);
		}
		return existing(input, init);
	});
	vi.stubGlobal('fetch', fetch);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const result = render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[entry]}>
				<ThemeProvider>
					<Suspense fallback={<p>Loading…</p>}>
						<Routes>
							<Route path="/apps" element={<AppsPage />} />
							<Route path="/projects/:pid" element={<ProjectEntryPage />} />
							<Route
								path="/projects/:pid/notebooks/:nid"
								element={<AppEntryPage variant="edit" />}
							/>
							<Route path="/projects/:pid/notebooks/:nid/app" element={<AppEntryPage />} />
						</Routes>
					</Suspense>
				</ThemeProvider>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { ...result, fetch, existing };
}

describe('stakeholder apps', () => {
	it('groups apps by project and searches without management controls', async () => {
		setup();
		expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeVisible();
		expect(screen.getByRole('link', { name: /Forecast/ })).toHaveAttribute('href', app.url);
		expect(screen.queryByText('New notebook')).toBeNull();
		await userEvent.type(screen.getByRole('textbox', { name: 'Search apps' }), 'missing');
		expect(await screen.findByText('No apps available matching your search.')).toBeVisible();
	});

	it('shows an empty gallery', async () => {
		setup('/apps', []);
		expect(await screen.findByText('No apps available.')).toBeVisible();
	});

	it('redirects an empty app-user project to its gallery', async () => {
		setup(`/projects/${PID}`, []);
		expect(await screen.findByRole('heading', { name: 'Apps' })).toBeVisible();
		expect(await screen.findByText('No apps available.')).toBeVisible();
	});

	it('redirects editor URLs and uses only the app API and session endpoints', async () => {
		const { container, fetch, existing } = setup(
			`/projects/${PID}/notebooks/${NID}?region=west&include-code=true`,
		);
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(container.querySelector('iframe')).toHaveAttribute(
			'src',
			'https://sandbox.example/kernel?region=west&theme=light&show-code=false',
		);
		expect(screen.getByRole('link', { name: 'Back to apps' })).toBeVisible();
		for (const label of ['Back to project', 'Stop', 'Restart', 'Versions', 'Jobs & schedules'])
			expect(screen.queryByText(label)).toBeNull();
		expect(sessionPosts(existing)).toHaveLength(1);
		const urls = fetch.mock.calls.map(
			([input]) =>
				new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname,
		);
		expect(urls).not.toContain(`/api/v1/projects/${PID}`);
		expect(urls).not.toContain(`/api/v1/projects/${PID}/notebooks/${NID}`);
		expect(urls).not.toContain(`/api/v1/projects/${PID}/sessions`);
		expect(urls).not.toContain('/api/v1/users');
	});
});
