import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadInitialRoute } from './initialRoute';
import { createTestQueryClient, jsonError, jsonOk } from '@/test/render';
import { appKeys, notebookKeys, projectKeys, sessionKeys } from '@/api/queryKeys';
import { rememberProject, lastProjectKey } from '@/components/Workspace/lastProject';
import { deferred } from '@/test/deferred';

vi.mock('@/components/Workspace/WorkspaceLayout', () => ({ WorkspaceLayout: () => null }));
vi.mock('@/components/Project/Project', () => ({ Project: () => null }));
vi.mock('@/components/Workspace/WorkspaceHome', () => ({ WorkspaceHome: () => null }));
vi.mock('@/components/ProjectList/ProjectList', () => ({ ProjectList: () => null }));

afterEach(() => {
	vi.unstubAllGlobals();
	window.history.replaceState({}, '', '/');
	document.querySelector('base')?.remove();
});

describe('initial route prefetch', () => {
	it.each(['app-only', 'remembered'] as const)(
		'does not block a %s home route on the speculative first-project lookup',
		async (route) => {
			const lookup = deferred<Response>();
			const userId = `prefetch-${route}`;
			if (route === 'remembered') rememberProject(userId, 'remembered');
			const fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), window.location.href);
				if (url.pathname === '/api/v1/projects') return lookup.promise;
				if (url.pathname.endsWith('/me'))
					return jsonOk({ id: userId, app_only: route === 'app-only' });
				return jsonOk(
					url.pathname.endsWith('/projects/remembered')
						? { id: 'remembered' }
						: { items: [], next_cursor: null },
				);
			});
			vi.stubGlobal('fetch', fetch);
			try {
				const routes = await preloadInitialRoute(createTestQueryClient());
				expect(routes.Home).toBeTypeOf('function');
				const rememberedRequested = fetch.mock.calls.some(([url]) =>
					String(url).endsWith('/projects/remembered'),
				);
				expect(rememberedRequested).toBe(route === 'remembered');
			} finally {
				lookup.resolve(jsonOk({ items: [], next_cursor: null }));
				localStorage.removeItem(lastProjectKey(userId));
			}
		},
	);

	it('starts the first-project lookup alongside the account request without fetching a roster', async () => {
		const requested: URL[] = [];
		let resolveUser!: (response: Response) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) => {
				const url = new URL(String(input), window.location.href);
				requested.push(url);
				if (url.pathname.endsWith('/me'))
					return new Promise<Response>((resolve) => {
						resolveUser = resolve;
					});
				if (url.pathname === '/api/v1/projects')
					return Promise.resolve(jsonOk({ items: [{ id: 'p' }], next_cursor: 'more' }));
				return Promise.resolve(
					jsonOk(
						url.pathname.endsWith('/projects/p') ? { id: 'p' } : { items: [], next_cursor: null },
					),
				);
			}),
		);
		const pending = preloadInitialRoute(createTestQueryClient());
		await vi.waitFor(() => expect(requested).toHaveLength(2));
		expect(
			requested.find((url) => url.pathname === '/api/v1/projects')?.searchParams.get('limit'),
		).toBe('1');
		resolveUser(jsonOk({ id: 'u', app_only: false }));
		await pending;
		expect(requested.some((url) => url.pathname === '/api/v1/projects/p/notebooks')).toBe(true);
		expect(requested.filter((url) => url.pathname === '/api/v1/projects')).toHaveLength(1);
	});

	it('does not hold the project page behind a stalled sessions request', async () => {
		window.history.replaceState({}, '', '/projects/p');
		const client = createTestQueryClient();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes('/sessions')) return new Promise<Response>(() => {});
				return jsonOk(
					String(input).endsWith('/projects/p')
						? { id: 'p', your_role: 'editor' }
						: { items: [], next_cursor: null },
				);
			}),
		);
		expect((await preloadInitialRoute(client)).Project).toBeTypeOf('function');
		expect(client.getQueryState(sessionKeys.listByProject('p'))?.fetchStatus).toBe('fetching');
		await client.cancelQueries();
	});

	it.each([401, 404, 503])(
		'allows rendering the access/error UI after a %s prefetch failure',
		async (status) => {
			window.history.replaceState({}, '', '/projects/p');
			const client = createTestQueryClient();
			const fetch = vi.fn(async () =>
				jsonError(
					status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
					'Unavailable',
					status,
				),
			);
			vi.stubGlobal('fetch', fetch);
			expect((await preloadInitialRoute(client)).Project).toBeTypeOf('function');
			expect(client.getQueryState(projectKeys.detail('p'))?.status).toBe('error');
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(client.getQueryData(appKeys.projectAccess('p'))).toBeUndefined();
		},
	);

	it('starts project, filtered notebooks and sessions together without an apps access request', async () => {
		const base = document.createElement('base');
		base.href = '/hub/';
		document.head.append(base);
		window.history.replaceState({}, '', '/hub/projects/p?q=forecast&status=draft&tag=team');
		const responses = new Map<string, (response: Response) => void>();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(input: RequestInfo | URL) =>
					new Promise<Response>((resolve) => {
						responses.set(String(input), resolve);
					}),
			),
		);
		const client = createTestQueryClient();
		const ready = preloadInitialRoute(client);
		await vi.waitFor(() => expect(responses.size).toBe(3));
		for (const [url, resolve] of responses) {
			const path = new URL(url, 'http://localhost').pathname;
			resolve(
				jsonOk(
					path.endsWith('/projects/p')
						? { id: 'p', your_role: 'editor' }
						: { items: [], next_cursor: null },
				),
			);
		}
		const routes = await ready;
		expect(routes.Layout).toBeTypeOf('function');
		expect(routes.Project).toBeTypeOf('function');
		expect(client.getQueryData(appKeys.list('p'))).toBeUndefined();
		expect([...responses.keys()].some((url) => url.includes('/apps'))).toBe(false);
		expect(client.getQueryData(projectKeys.detail('p'))).toMatchObject({ id: 'p' });
		await vi.waitFor(() => expect(client.getQueryData(sessionKeys.listByProject('p'))).toEqual([]));
		expect(
			client.getQueryData(
				notebookKeys.filteredList('p', { q: 'forecast', status: 'draft', tag: 'team' }),
			),
		).toMatchObject({ pages: [{ items: [] }] });
		expect([...responses.keys()].find((url) => url.includes('/notebooks?'))).toContain('limit=100');
	});

	it('starts project and app details without waiting for the user or theme', async () => {
		window.history.replaceState({}, '', '/projects/p/notebooks/n');
		const requested: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) => {
				requested.push(String(input));
				return new Promise<Response>(() => {});
			}),
		);
		await preloadInitialRoute(createTestQueryClient());
		await vi.waitFor(() => expect(requested).toHaveLength(2));
		expect(requested).toContain('/api/v1/projects/p');
		expect(requested).toContain('/api/v1/projects/p/notebooks/n/app');
	});
});
