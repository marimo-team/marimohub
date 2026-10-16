import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { QueryClient } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import type { Theme } from '@/context/ThemeContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { projectKeys, userKeys } from '@/api/queryKeys';
import { projectQueryOptions } from '@/api/hooks';
import { deferred } from '@/test/deferred';
import { createTestQueryClient, renderWithClient } from '@/test/render';
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

function setup(
	entry = '/apps',
	items = [app],
	options: Partial<Parameters<typeof makeFetch>[0]> & {
		colorMode?: Theme;
		appStatus?: number;
		appReady?: Promise<void>;
		client?: QueryClient;
		projectStatus?: number;
		projectReady?: Promise<void>;
		projectReload?: Promise<void>;
		projectReloadStatus?: number;
		projectReloadRole?: string;
		userReloadStatus?: number;
		appsResponse?: (url: URL) => Response;
	} = {},
) {
	const existing = makeFetch({
		role: 'app-user',
		session: runningSession({ mode: 'app', can: { attach: true, stop: false } }),
		...options,
	});
	let projectReads = 0;
	let userReads = 0;
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
		if (url.pathname === '/api/v1/me' && ++userReads > 1 && options.userReloadStatus)
			return Response.json(
				{ success: false, error: { code: 'UNAVAILABLE', message: 'Unavailable' } },
				{ status: options.userReloadStatus },
			);
		if (url.pathname.endsWith(`/notebooks/${NID}/app`)) await options.appReady;
		const isProject = url.pathname === `/api/v1/projects/${PID}`;
		const isReload = isProject && ++projectReads > 1;
		if (isProject) {
			await options.projectReady;
			if (isReload) await options.projectReload;
		}
		const status = url.pathname.endsWith(`/notebooks/${NID}/app`)
			? options.appStatus
			: isReload && options.projectReloadStatus
				? options.projectReloadStatus
				: isProject
					? options.projectStatus
					: undefined;
		if (status)
			return new Response(
				JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Unavailable' } }),
				{ status, headers: { 'content-type': 'application/json' } },
			);
		if (url.pathname === '/api/v1/apps') {
			if (options.appsResponse) return options.appsResponse(url);
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
		if (isReload && options.projectReloadRole) {
			const body = (await (await existing(input, init)).json()) as {
				data: Record<string, unknown>;
			};
			return Response.json({
				success: true,
				data: { ...body.data, your_role: options.projectReloadRole },
			});
		}
		return existing(input, init);
	});
	vi.stubGlobal('fetch', fetch);
	const client = options.client ?? createTestQueryClient();
	const result = renderWithClient(
		<ThemeProvider>
			<Suspense fallback={<p>Loading…</p>}>
				<Routes>
					<Route path="/apps" element={<AppsPage />} />
					<Route path="/projects/:pid" element={<ProjectEntryPage />} />
					<Route path="/projects/:pid/notebooks/:nid" element={<AppEntryPage variant="edit" />} />
					<Route path="/projects/:pid/notebooks/:nid/app" element={<AppEntryPage />} />
				</Routes>
			</Suspense>
		</ThemeProvider>,
		{
			client,
			route: entry,
			toaster: false,
			branding: { color_mode: options.colorMode ?? 'user' },
		},
	);
	return { ...result, fetch, existing };
}

describe('stakeholder apps', () => {
	it.each([false, true])(
		'shows the preview link only with the integration: %s',
		async (enabled) => {
			const { container } = setup(app.url, [app], { previewProviders: enabled ? ['github'] : [] });
			await screen.findByText('Forecast');
			await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
			if (enabled)
				expect(await screen.findByRole('link', { name: 'Previews' })).toBeInTheDocument();
			else expect(screen.queryByRole('link', { name: 'Previews' })).not.toBeInTheDocument();
		},
	);

	it('shares the app URL without exposing notebook actions', async () => {
		const user = userEvent.setup();
		const writeText = vi.spyOn(navigator.clipboard, 'writeText');
		const success = vi.spyOn(toast, 'success');
		setup(`${app.url}?id=123&access_token=evil&session_id=evil`);
		await user.click(await screen.findByRole('button', { name: 'Share app' }));
		expect(screen.getAllByRole('menuitem')).toHaveLength(1);
		await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }));
		expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${app.url}?id=123`);
		expect(success).toHaveBeenCalledWith('App URL copied');
	});

	it('retries an initial gallery failure without navigating away', async () => {
		const appsResponse = vi
			.fn()
			.mockReturnValueOnce(
				Response.json(
					{ success: false, error: { code: 'UNAVAILABLE', message: 'Try again later' } },
					{ status: 503 },
				),
			)
			.mockReturnValueOnce(
				Response.json({ success: true, data: { items: [app], next_cursor: null } }),
			);
		setup('/apps', [app], { appsResponse });
		expect(await screen.findByRole('alert')).toHaveTextContent('Try again later');
		expect(screen.queryByRole('link', { name: 'Back to apps' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByRole('link', { name: /Forecast/ })).toBeVisible();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(appsResponse).toHaveBeenCalledTimes(2);
	});

	it('keeps loaded apps when pagination fails and retries the failed page', async () => {
		const nextApp = { ...app, notebook_id: 'second', title: 'Revenue', url: '/second/app' };
		const appsResponse = vi
			.fn()
			.mockReturnValueOnce(
				Response.json({ success: true, data: { items: [app], next_cursor: 'page-two' } }),
			)
			.mockReturnValueOnce(
				Response.json(
					{ success: false, error: { code: 'UNAVAILABLE', message: 'Unable to load more apps' } },
					{ status: 503 },
				),
			)
			.mockReturnValueOnce(
				Response.json({ success: true, data: { items: [nextApp], next_cursor: null } }),
			);
		setup('/apps', [app], { appsResponse });
		expect(await screen.findByRole('link', { name: /Forecast/ })).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load more apps');
		expect(screen.getByRole('link', { name: /Forecast/ })).toBeVisible();
		expect(screen.getByRole('searchbox', { name: 'Search apps' })).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByRole('link', { name: /Revenue/ })).toBeVisible();
		expect(screen.getByRole('link', { name: /Forecast/ })).toBeVisible();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
		expect(appsResponse.mock.calls.map(([url]) => url.searchParams.get('cursor'))).toEqual([
			null,
			'page-two',
			'page-two',
		]);
	});

	it('retains apps after a failed refresh and retries the first page', async () => {
		const appsResponse = vi
			.fn()
			.mockReturnValueOnce(
				Response.json({ success: true, data: { items: [app], next_cursor: 'page-two' } }),
			)
			.mockReturnValueOnce(
				Response.json(
					{ success: false, error: { code: 'UNAVAILABLE', message: 'Unable to refresh apps' } },
					{ status: 503 },
				),
			)
			.mockReturnValueOnce(
				Response.json({ success: true, data: { items: [app], next_cursor: 'page-two' } }),
			);
		const { client } = setup('/apps', [app], { appsResponse });
		expect(await screen.findByRole('link', { name: /Forecast/ })).toBeVisible();
		await act(() => client.invalidateQueries({ queryKey: ['apps', 'list'] }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Unable to refresh apps');
		expect(screen.getByRole('link', { name: /Forecast/ })).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByRole('button', { name: 'Load more' })).toBeVisible();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(appsResponse.mock.calls.map(([url]) => url.searchParams.get('cursor'))).toEqual([
			null,
			null,
			null,
		]);
	});

	it('labels apps by project and debounces searches while preserving the gallery', async () => {
		const { fetch } = setup();
		expect(await screen.findByText('Analytics')).toBeVisible();
		expect(screen.getByRole('link', { name: /Forecast/ })).toHaveAttribute('href', app.url);
		const queries = () =>
			fetch.mock.calls
				.map(([input]) => new URL(String(input), 'http://localhost'))
				.filter((url) => url.pathname === '/api/v1/apps')
				.map((url) => url.searchParams.get('q'));
		vi.useFakeTimers();
		try {
			const input = screen.getByRole('searchbox', { name: 'Search apps' });
			fireEvent.change(input, { target: { value: 'miss' } });
			await act(() => vi.advanceTimersByTimeAsync(100));
			fireEvent.change(input, { target: { value: 'missing' } });
			expect(input).toHaveValue('missing');
			expect(screen.getByRole('link', { name: /Forecast/ })).toBeVisible();
			expect(queries()).toEqual([null]);
			await act(() => vi.advanceTimersByTimeAsync(200));
			expect(queries()).toEqual([null, 'missing']);
			await act(() => vi.advanceTimersByTimeAsync(1));
		} finally {
			vi.useRealTimers();
		}
		expect(await screen.findByText('No apps available matching your search.')).toBeVisible();
	});

	it.each(['static', 'applications', 'ephemeral-sandbox'] as const)(
		'does not start a denied app under %s viewer mode',
		async (viewerMode) => {
			const { container, existing } = setup(app.url, [app], { canRun: false, viewerMode });
			expect(await screen.findByText('You cannot run this app.')).toBeVisible();
			expect(screen.getByRole('heading', { name: 'Forecast' })).toBeVisible();
			expect(container.querySelector('iframe')).toBeNull();
			expect(sessionPosts(existing)).toHaveLength(0);
			expect(screen.queryByRole('button', { name: 'Open app' })).toBeNull();
		},
	);

	it.each([
		{ role: 'viewer', suffix: '' },
		{ role: 'editor', suffix: '' },
		{ role: 'viewer', suffix: '/app' },
		{ role: 'editor', suffix: '/app' },
	] as const)(
		'preserves $role access to the notebook$suffix route when app details fail',
		async ({ role, suffix }) => {
			const { container, existing } = setup(`/projects/${PID}/notebooks/${NID}${suffix}`, [app], {
				role,
				viewerMode: 'ephemeral-sandbox',
				appStatus: 503,
			});
			await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
			expect(sessionPosts(existing)).toHaveLength(1);
			expect(screen.queryByText('Unable to open apps')).toBeNull();
		},
	);

	it('prefetches project and capabilities while app details are still pending', async () => {
		const appGate = deferred();
		const { fetch, existing, container } = setup(app.url, [app], {
			role: 'editor',
			appReady: appGate.promise,
		});
		try {
			await waitFor(() =>
				expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(
					expect.arrayContaining([`/api/v1/projects/${PID}`, '/api/v1/capabilities']),
				),
			);
			expect(screen.getByText('Opening app…')).toBeVisible();
			expect(sessionPosts(existing)).toHaveLength(0);
		} finally {
			await act(async () => appGate.resolve());
		}
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(sessionPosts(existing)).toHaveLength(1);
	});

	it('opens an authorized app when project prefetch is forbidden without an error toast', async () => {
		const errorToast = vi.spyOn(toast, 'error');
		const appGate = deferred();
		const { client, container, existing } = setup(app.url, [app], {
			appOnly: false,
			projectStatus: 403,
			appReady: appGate.promise,
		});
		try {
			await waitFor(() =>
				expect(client.getQueryState(projectKeys.detail(PID))?.status).toBe('error'),
			);
			expect(screen.getByText('Opening app…')).toBeVisible();
			expect(errorToast).not.toHaveBeenCalled();
		} finally {
			await act(async () => appGate.resolve());
		}
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(sessionPosts(existing)).toHaveLength(1);
		expect(errorToast).not.toHaveBeenCalled();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it.each([
		{ role: 'editor', projectStatus: 403 },
		{ role: 'editor', projectStatus: 404 },
		{ role: 'editor', projectStatus: 503 },
		{ role: 'app-user', projectStatus: undefined },
		{ role: 'editor', projectStatus: undefined },
	] as const)(
		'waits for cached project access to refresh: $role, $projectStatus',
		async ({ role, projectStatus }) => {
			const client = createTestQueryClient();
			makeFetch({ role: 'editor' });
			await client.fetchQuery(projectQueryOptions(PID));
			await client.invalidateQueries({ queryKey: projectKeys.detail(PID) });
			const projectGate = deferred();
			const { container, existing } = setup(app.url, [app], {
				client,
				role,
				appOnly: false,
				appStatus: 503,
				projectStatus,
				projectReady: projectGate.promise,
			});
			try {
				expect(await screen.findByText('Opening notebook…')).toBeVisible();
				expect(container.querySelector('iframe')).toBeNull();
				expect(sessionPosts(existing)).toHaveLength(0);
			} finally {
				await act(async () => projectGate.resolve());
			}
			if (role === 'editor' && !projectStatus) {
				await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
				expect(sessionPosts(existing)).toHaveLength(1);
			} else {
				expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
				expect(container.querySelector('iframe')).toBeNull();
				expect(sessionPosts(existing)).toHaveLength(0);
			}
		},
	);

	async function refreshOpenFallback(options: Parameters<typeof setup>[2] = {}) {
		const reload = deferred();
		const result = setup(app.url, [app], {
			role: 'editor',
			appStatus: 503,
			projectReload: reload.promise,
			...options,
		});
		const { container, fetch, client } = result;
		try {
			await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
			act(() => {
				void client.invalidateQueries({ queryKey: projectKeys.detail(PID) });
			});
			await waitFor(() =>
				expect(
					fetch.mock.calls.filter(([input]) => String(input).endsWith(`/projects/${PID}`)),
				).toHaveLength(2),
			);
			await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
			expect(screen.queryByText('Opening notebook…')).toBeNull();
		} finally {
			await act(async () => reload.resolve());
		}
		await waitFor(() =>
			expect(client.getQueryState(projectKeys.detail(PID))?.fetchStatus).toBe('idle'),
		);
		return result;
	}

	it('keeps the authoring fallback mounted during a background project refresh', async () => {
		const { container } = await refreshOpenFallback();
		expect(container.querySelector('iframe')).not.toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('keeps the authoring fallback open when a background project refresh fails', async () => {
		const { container, client } = await refreshOpenFallback({ projectReloadStatus: 503 });
		expect(client.getQueryState(projectKeys.detail(PID))?.status).toBe('error');
		expect(container.querySelector('iframe')).not.toBeNull();
		expect(screen.queryByText('Unavailable')).toBeNull();
	});

	it.each([
		{ projectReloadStatus: 403 },
		{ projectReloadStatus: 404 },
		{ projectReloadRole: 'app-user' },
	])(
		'closes the authoring fallback when a background refresh revokes access: %o',
		async (reload) => {
			const { container } = await refreshOpenFallback(reload);
			expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
			expect(container.querySelector('iframe')).toBeNull();
		},
	);

	async function refreshUserOnOpenFallback(userReloadStatus: number) {
		const result = setup(app.url, [app], { role: 'editor', appStatus: 503, userReloadStatus });
		const { container, client } = result;
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		act(() => {
			void client.invalidateQueries({ queryKey: userKeys.me() });
		});
		await waitFor(() => expect(client.getQueryState(userKeys.me())?.status).toBe('error'));
		return result;
	}

	it('keeps the authoring fallback open when a background user refresh fails', async () => {
		const { container } = await refreshUserOnOpenFallback(503);
		expect(container.querySelector('iframe')).not.toBeNull();
		expect(screen.queryByText('Unavailable')).toBeNull();
	});

	it('closes the authoring fallback when a background user refresh is forbidden', async () => {
		const { container } = await refreshUserOnOpenFallback(403);
		expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
		expect(container.querySelector('iframe')).toBeNull();
	});

	it('shows app capacity rejection with an explicit retry', async () => {
		const { existing } = setup(app.url, [app], {
			createError: { code: 'RESOURCE_EXHAUSTED', message: 'App is busy', status: 429 },
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('App is busy. Try again shortly.');
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(sessionPosts(existing)).toHaveLength(2));
	});

	it('fails closed when account classification is unavailable', async () => {
		const { fetch, existing, container } = setup(app.url, [app], {
			role: 'editor',
			appStatus: 503,
			meFailures: 1,
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
		expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain(
			`/api/v1/projects/${PID}`,
		);
		expect(container.querySelector('iframe')).toBeNull();
		expect(sessionPosts(existing)).toHaveLength(0);
	});

	it('keeps app-only failures away from authoring APIs', async () => {
		const { fetch, existing, container } = setup(app.url, [app], { appStatus: 404 });
		expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
		expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain(
			`/api/v1/projects/${PID}`,
		);
		expect(container.querySelector('iframe')).toBeNull();
		expect(sessionPosts(existing)).toHaveLength(0);
	});

	it.each([404, 503])(
		'fails closed for a mixed account when project access returns %s',
		async (projectStatus) => {
			const { existing, container } = setup(app.url, [app], {
				appOnly: false,
				appStatus: 503,
				projectStatus,
			});
			expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
			expect(container.querySelector('iframe')).toBeNull();
			expect(sessionPosts(existing)).toHaveLength(0);
			expect(existing.mock.calls.map(([input]) => String(input))).not.toContain(
				`/api/v1/projects/${PID}/notebooks/${NID}`,
			);
		},
	);

	it('does not use a mixed account to open authoring UI for an app-user project', async () => {
		const { existing, container } = setup(app.url, [app], { appOnly: false, appStatus: 503 });
		expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
		expect(container.querySelector('iframe')).toBeNull();
		expect(sessionPosts(existing)).toHaveLength(0);
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

	it.each(['light', 'dark'] as const)(
		'forces %s mode in embedded apps despite saved and URL preferences',
		async (mode) => {
			const preferred = mode === 'light' ? 'dark' : 'light';
			localStorage.setItem('marimohub-theme', preferred);
			try {
				const { container } = setup(`${app.url}?theme=${preferred}`, [app], { colorMode: mode });
				await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
				const src = container.querySelector('iframe')!.getAttribute('src')!;
				expect(new URL(src).searchParams.get('theme')).toBe(mode);
				expect(localStorage.getItem('marimohub-theme')).toBe(preferred);
			} finally {
				localStorage.removeItem('marimohub-theme');
			}
		},
	);

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
