import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { ThemeProvider } from '@/context/ThemeContext';
import { setupUser } from '@/test/render';
import { deepLinkKeys, prefetchAppLink } from '@/api/deepLinks';
import { deferred } from '@/test/deferred';
import { AppLinkPage } from './AppLinkPage';
import { makeFetch, runningSession, PID, NID, sessionPosts } from './NotebookPage.testWorld';

const notebookFrame = (title: string, element: Element | null) =>
	title === 'Forecast' && element?.tagName === 'IFRAME';

function LocationProbe() {
	const location = useLocation();
	return (
		<output data-testid="location">
			{location.pathname}
			{location.search}
			{location.hash}
		</output>
	);
}

function renderLink(
	initialEntry = '/app/sales?filter=2026#chart',
	basename = '/',
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	controls?: ReactNode,
	reactStrictMode = false,
) {
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter basename={basename} initialEntries={[initialEntry]}>
				<ThemeProvider>
					{controls}
					<Suspense fallback={<p>Loading…</p>}>
						<Routes>
							<Route path="/app/*" element={<AppLinkPage />} />
						</Routes>
						<LocationProbe />
					</Suspense>
				</ThemeProvider>
			</MemoryRouter>
		</QueryClientProvider>,
		{ reactStrictMode },
	);
}

function linkFetch(
	options: {
		missing?: boolean;
		forbiddenSession?: boolean;
		resolve?: () => Promise<Response>;
	} = {},
) {
	const existing = makeFetch({
		role: 'viewer',
		viewerMode: 'applications',
		session: runningSession({ mode: 'app' }),
		...(options.forbiddenSession
			? { createError: { code: 'FORBIDDEN', message: 'App access denied', status: 403 } }
			: {}),
	});
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes('/api/v1/deep-links/')) {
			if (options.resolve) return options.resolve();
			return new Response(
				JSON.stringify(
					options.missing
						? { success: false, error: { code: 'NOT_FOUND', message: 'App link not found' } }
						: {
								success: true,
								data: {
									target: { kind: 'app', project_id: PID, notebook_id: NID },
									app: {
										project_id: PID,
										project_name: 'Sales',
										notebook_id: NID,
										title: 'Forecast',
										url: `/projects/${PID}/notebooks/${NID}/app`,
										your_role: 'viewer',
										can: { run: true },
									},
								},
							},
				),
				{ status: options.missing ? 404 : 200, headers: { 'content-type': 'application/json' } },
			);
		}
		return existing(input, init);
	});
	vi.stubGlobal('fetch', fetch);
	return { existing, fetch };
}

describe('AppLinkPage', () => {
	it('keeps the boot-resolved alias mounted while project metadata loads in StrictMode', async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { fetch, existing } = linkFetch();
		const project = deferred<Response>();
		const projectPath = `/api/v1/projects/${PID}`;
		const requests = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
			String(input).endsWith(projectPath) ? project.promise : fetch(input, init),
		);
		vi.stubGlobal('fetch', requests);
		await prefetchAppLink(client, 'sales');
		renderLink('/app/sales', '/', client, undefined, true);
		await waitFor(() =>
			expect(requests.mock.calls.some(([input]) => String(input).endsWith(projectPath))).toBe(true),
		);
		expect(screen.getByText('Opening app…')).toBeVisible();
		expect(sessionPosts(existing)).toHaveLength(0);
		await act(async () => project.resolve(await existing(projectPath)));
		await waitFor(() => expect(sessionPosts(existing)).toHaveLength(1));
		expect(
			fetch.mock.calls.filter(([input]) => String(input).includes('/deep-links/')),
		).toHaveLength(1);
	});

	it('does not reuse a boot-resolved app after its alias is removed', async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const options = { missing: false };
		const { fetch, existing } = linkFetch(options);
		await prefetchAppLink(client, 'sales');
		const first = renderLink('/app/sales', '/', client);
		await waitFor(() => expect(sessionPosts(existing)).toHaveLength(1));
		first.unmount();
		options.missing = true;
		renderLink('/app/sales', '/', client);
		expect(await screen.findByRole('alert')).toHaveTextContent('App link not found');
		expect(sessionPosts(existing)).toHaveLength(1);
		expect(screen.queryByTitle(notebookFrame)).not.toBeInTheDocument();
		expect(
			fetch.mock.calls.filter(([input]) => String(input).includes('/deep-links/')),
		).toHaveLength(2);
	});

	it('consumes the boot lookup without repeating it after mount', async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { fetch, existing } = linkFetch();
		await prefetchAppLink(client, 'sales');
		const first = renderLink('/app/sales', '/', client, undefined, true);
		await waitFor(() => expect(sessionPosts(existing)).toHaveLength(1));
		const lookups = () =>
			fetch.mock.calls.filter(([input]) => String(input).includes('/deep-links/'));
		expect(lookups()).toHaveLength(1);
		first.unmount();
		renderLink('/app/sales', '/', client);
		await waitFor(() => expect(lookups()).toHaveLength(2));
	});

	it('starts from the resolved summary without requesting app details', async () => {
		const { fetch, existing } = linkFetch();
		renderLink();
		await waitFor(() => expect(sessionPosts(existing)).toHaveLength(1), { timeout: 5_000 });
		expect(
			fetch.mock.calls.some(([input]) => String(input).endsWith(`/notebooks/${NID}/app`)),
		).toBe(false);
	});

	it('does not start a session when a nested alias is missing', async () => {
		const { existing, fetch } = linkFetch({ missing: true });
		renderLink('/app/team/missing');
		expect(await screen.findByRole('alert')).toHaveTextContent('App link not found');
		expect(sessionPosts(existing)).toHaveLength(0);
		expect(
			fetch.mock.calls.some(([input]) => String(input) === '/api/v1/deep-links/team%2Fmissing'),
		).toBe(true);
	});

	it.each(['sales', 'team/overview', 'team/overview/details'])(
		'forwards parameters and copies %s under a deployment prefix',
		async (slug) => {
			const user = setupUser();
			const writeText = vi.spyOn(navigator.clipboard, 'writeText');
			const { existing, fetch } = linkFetch();
			const base = document.createElement('base');
			base.href = `${window.location.origin}/hub/`;
			document.head.append(base);
			try {
				renderLink(
					`/hub/app/${slug}?id=123&tag=one&tag=two&empty=&%61ccess_token=evil&session_id=evil&file=other.py`,
					'/hub',
				);
				const frame = await screen.findByTitle(notebookFrame);
				expect(frame).toHaveAttribute(
					'src',
					'https://sandbox.example/kernel?id=123&tag=one&tag=two&empty=&theme=light&show-code=false',
				);
				await user.click(screen.getByRole('button', { name: 'Share app' }));
				await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }));
				expect(writeText).toHaveBeenCalledWith(
					`${window.location.origin}/hub/app/${slug}?id=123&tag=one&tag=two&empty=`,
				);
				expect(
					fetch.mock.calls
						.filter(([input]) => String(input).includes('/api/v1/deep-links/'))
						.map(([input]) => String(input)),
				).toEqual([`/api/v1/deep-links/${encodeURIComponent(slug)}`]);
				expect(sessionPosts(existing)).toHaveLength(1);
			} finally {
				base.remove();
			}
		},
	);

	it('reloads only the notebook frame when a slug query changes', async () => {
		function Controls() {
			const navigate = useNavigate();
			return <button onClick={() => void navigate('?id=456')}>Change query</button>;
		}
		const { existing, fetch } = linkFetch();
		renderLink('/app/sales?id=123', '/', undefined, <Controls />);
		const initial = await screen.findByTitle(notebookFrame);
		const resolves = fetch.mock.calls.filter(([input]) =>
			String(input).includes('/deep-links/'),
		).length;
		fireEvent.click(screen.getByText('Change query'));
		const frame = screen.getByTitle(notebookFrame);
		expect(frame).not.toBe(initial);
		expect(new URL(frame.getAttribute('src')!).searchParams.get('id')).toBe('456');
		expect(screen.getByTestId('location')).toHaveTextContent('/app/sales?id=456');
		expect(sessionPosts(existing)).toHaveLength(1);
		expect(
			fetch.mock.calls.filter(([input]) => String(input).includes('/deep-links/')),
		).toHaveLength(resolves);
	});

	it.each([
		'/app/sales?filter=2026#chart',
		'/app/revenue?filter=2026#chart',
		'/app/team/overview?filter=2026#chart',
	])('opens the shared app and preserves %s', async (path) => {
		const { existing } = linkFetch();
		renderLink(path);
		const frame = await screen.findByTitle(notebookFrame);
		expect(new URL(frame.getAttribute('src')!).searchParams.get('filter')).toBe('2026');
		expect(screen.getByTestId('location')).toHaveTextContent(path);
		expect(sessionPosts(existing)).toHaveLength(1);
	});

	it('supports deployment base paths and resolves again on remount', async () => {
		const { fetch } = linkFetch();
		const view = renderLink('/hub/app/sales', '/hub');
		expect(await screen.findByTitle(notebookFrame)).toBeInTheDocument();
		view.unmount();
		renderLink('/hub/app/sales', '/hub');
		expect(await screen.findByTitle(notebookFrame)).toBeInTheDocument();
		expect(
			fetch.mock.calls.filter(([input]) => String(input).includes('/deep-links/')),
		).toHaveLength(2);
	});

	it('does not start a session for an unavailable link', async () => {
		const { existing } = linkFetch({ missing: true });
		renderLink();
		expect(await screen.findByRole('heading', { name: 'App link not found' })).toBeInTheDocument();
		expect(screen.queryByTitle(notebookFrame)).toBeNull();
		expect(sessionPosts(existing)).toHaveLength(0);
	});

	it('shows existing app admission errors without redirecting', async () => {
		const { existing } = linkFetch({ forbiddenSession: true });
		renderLink();
		expect(await screen.findByText('App access denied')).toBeInTheDocument();
		expect(screen.queryByTitle(notebookFrame)).toBeNull();
		expect(sessionPosts(existing)).toHaveLength(1);
		expect(screen.getByTestId('location')).toHaveTextContent('/app/sales');
	});
	it('does not use a cached target while revalidation is pending or returns 404', async () => {
		let resolveResponse!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
		const { existing } = linkFetch({ resolve: () => response });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(deepLinkKeys.resolve('sales'), {
			target: { kind: 'app', project_id: PID, notebook_id: NID },
		});
		renderLink('/app/sales', '/', client);
		expect(screen.getByText('Opening app…')).toBeInTheDocument();
		expect(existing).not.toHaveBeenCalled();
		await act(async () =>
			resolveResponse(
				new Response(
					JSON.stringify({
						success: false,
						error: { code: 'NOT_FOUND', message: 'App link not found' },
					}),
					{ status: 404, headers: { 'content-type': 'application/json' } },
				),
			),
		);
		expect(await screen.findByRole('heading', { name: 'App link not found' })).toBeInTheDocument();
		expect(sessionPosts(existing)).toHaveLength(0);
	});

	it('waits for revalidation while offline and opens the app after reconnecting', async () => {
		const { existing } = linkFetch();
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(deepLinkKeys.resolve('sales'), {
			target: { kind: 'app', project_id: PID, notebook_id: NID },
		});
		onlineManager.setOnline(false);
		const view = renderLink('/app/sales', '/', client);
		try {
			expect(screen.getByText('Opening app…')).toBeInTheDocument();
			expect(existing).not.toHaveBeenCalled();
			await act(async () => onlineManager.setOnline(true));
			expect(await screen.findByTitle(notebookFrame)).toBeInTheDocument();
			expect(sessionPosts(existing)).toHaveLength(1);
		} finally {
			view.unmount();
			onlineManager.setOnline(true);
		}
	});

	it.each([false, true])(
		'recovers from a resolver outage without starting an app early (boot=%s)',
		async (boot) => {
			const user = setupUser();
			const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			let unavailable = true;
			const { existing, fetch } = linkFetch({
				resolve: async () =>
					new Response(
						JSON.stringify(
							unavailable
								? {
										success: false,
										error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable' },
									}
								: {
										success: true,
										data: { target: { kind: 'app', project_id: PID, notebook_id: NID } },
									},
						),
						{ status: unavailable ? 503 : 200, headers: { 'content-type': 'application/json' } },
					),
			});
			if (boot)
				await expect(prefetchAppLink(client, 'sales')).rejects.toThrow('Temporarily unavailable');
			renderLink('/app/sales?filter=2026#chart', '/', client);
			expect(
				await screen.findByRole('heading', { name: 'Unable to open app' }),
			).toBeInTheDocument();
			expect(sessionPosts(existing)).toHaveLength(0);
			expect(
				fetch.mock.calls.filter(([input]) => String(input).includes('/deep-links/')),
			).toHaveLength(1);
			unavailable = false;
			await user.click(screen.getByRole('button', { name: 'Try again' }));
			expect(await screen.findByTitle(notebookFrame)).toBeInTheDocument();
			expect(screen.getByTestId('location')).toHaveTextContent('/app/sales?filter=2026#chart');
			expect(
				new URL(screen.getByTitle(notebookFrame).getAttribute('src')!).searchParams.get('filter'),
			).toBe('2026');
			expect(sessionPosts(existing)).toHaveLength(1);
			expect(
				fetch.mock.calls.filter(([input]) => String(input).includes('/deep-links/')),
			).toHaveLength(2);
		},
	);
});
