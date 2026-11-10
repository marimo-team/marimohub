import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { makeUser, stubApi } from '@/test/apiStub';
import { createTestQueryClient, jsonError, renderWithClient } from '@/test/render';
import type { ProjectRole } from '@/types';
import { appKeys, projectKeys, userKeys } from '@/api/queryKeys';
import { lastProjectKey } from './lastProject';
import { ProjectSourceGate } from './ProjectSourceGate';

const projectPreloads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/Project/projectRoute', () => ({
	ProjectRoute: { preload: () => projectPreloads.count++ },
}));

function Destination() {
	const location = useLocation();
	return <output aria-label="Destination">{location.pathname + location.search}</output>;
}

function setup(route: string, role: ProjectRole, client = createTestQueryClient()) {
	const api = stubApi({
		'/api/v1/projects/p':
			role === 'app-user'
				? jsonError('NOT_FOUND', 'Project not found', 404)
				: { id: 'p', name: 'Analysis', your_role: role },
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
		{ route, toaster: false, client },
	);
	return api;
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

	it('reuses fresh project metadata without another access request', async () => {
		const client = createTestQueryClient();
		client.setQueryData(projectKeys.detail('p'), {
			id: 'p',
			name: 'Analysis',
			your_role: 'editor',
		});
		const { requests } = setup('/projects/p/data', 'editor', client);
		expect(await screen.findByText('Data page')).toBeVisible();
		expect(requests).toEqual([]);
	});

	it('skips project metadata for a known app-only user', async () => {
		const client = createTestQueryClient();
		client.setQueryData(userKeys.me(), { ...makeUser(), app_only: true });
		const { requests } = setup('/projects/p/data', 'app-user', client);
		expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
			'/apps?project_id=p',
		);
		expect(requests).toEqual(['/api/v1/apps?project_id=p']);
	});

	it.each([
		['/projects/p/data', 'Data page'],
		['/projects/p/notebooks/n/jobs', 'Notebook jobs page'],
	])('renders %s for source readers', async (route, page) => {
		const { requests } = setup(route, 'viewer');
		expect(await screen.findByText(page)).toBeVisible();
		expect(requests).toEqual(['/api/v1/projects/p']);
	});

	it.each([
		['/projects/p', true],
		['/projects/p/data', false],
	])(
		'preloads the index page chunk before access resolves only on the index (%s)',
		async (route, preloads) => {
			const fetch = vi.fn(() => new Promise<Response>(() => {}));
			vi.stubGlobal('fetch', fetch);
			projectPreloads.count = 0;
			renderWithClient(
				<Routes>
					<Route path="/projects/:pid" element={<ProjectSourceGate />}>
						<Route index element={<p>Project page</p>} />
						<Route path="data" element={<p>Data page</p>} />
					</Route>
				</Routes>,
				{ route, toaster: false },
			);
			await waitFor(() => expect(fetch).toHaveBeenCalled());
			expect(projectPreloads.count > 0).toBe(preloads);
			expect(screen.queryByText(/page$/)).not.toBeInTheDocument();
		},
	);
});

it('falls back to app access after source access is revoked', async () => {
	let canRead = true;
	const { requests } = stubApi({
		'/api/v1/projects/p': () =>
			canRead
				? { id: 'p', name: 'Project', your_role: 'editor' }
				: jsonError('NOT_FOUND', 'Project not found', 404),
		'/api/v1/apps': {
			items: [],
			next_cursor: null,
			project: { id: 'p', name: 'Project', your_role: 'app-user' },
		},
	});
	const { client } = renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route index element={<p>Project source</p>} />
			</Route>
			<Route path="*" element={<Destination />} />
		</Routes>,
		{ route: '/projects/p', toaster: false },
	);
	expect(await screen.findByText('Project source')).toBeVisible();
	expect(requests).toEqual(['/api/v1/projects/p']);
	canRead = false;
	await act(() => client.invalidateQueries({ queryKey: projectKeys.detail('p') }));
	expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
		'/apps?project_id=p',
	);
	expect(screen.queryByText('Project source')).not.toBeInTheDocument();
});

it('keeps the source page open when a background access refresh fails', async () => {
	let unavailable = false;
	stubApi({
		'/api/v1/projects/p': () =>
			unavailable
				? jsonError('INTERNAL_ERROR', 'Temporarily unavailable', 503)
				: { id: 'p', name: 'Project', your_role: 'editor' },
	});
	const { client } = renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route index element={<p>Project source</p>} />
			</Route>
		</Routes>,
		{ route: '/projects/p', toaster: false, errorBoundary: true },
	);
	expect(await screen.findByText('Project source')).toBeVisible();
	unavailable = true;
	await act(() => client.invalidateQueries({ queryKey: projectKeys.detail('p') }));
	expect(screen.getByText('Project source')).toBeVisible();
	expect(screen.queryByText('Request failed')).not.toBeInTheDocument();
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
		stubApi({
			'/api/v1/projects/missing': jsonError('NOT_FOUND', 'Project not found', 404),
			'/api/v1/apps': jsonError('NOT_FOUND', 'Project not found', 404),
		});
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
			'/api/v1/projects/p': () =>
				missing
					? jsonError('NOT_FOUND', 'Not found', 404)
					: { id: 'p', name: 'Project', your_role: 'editor' },
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
		expect(requests.filter((url) => url.startsWith('/api/v1/apps'))).toHaveLength(1);
		missing = false;
		fireEvent.click(reopen);
		expect(await screen.findByText('Project source')).toBeVisible();
		expect(requests.filter((url) => url === '/api/v1/projects/p')).toHaveLength(2);
		expect(requests.filter((url) => url.startsWith('/api/v1/apps'))).toHaveLength(1);
	},
);

it.each([
	{ code: 'UNAUTHORIZED', status: 401 },
	{ code: 'FORBIDDEN', status: 403 },
])('hides cached source after a $status access denial', async ({ code, status }) => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	let denied = false;
	const { requests } = stubApi({
		'/api/v1/projects/p': () =>
			denied
				? jsonError(code, 'Access denied', status)
				: { id: 'p', name: 'Project', your_role: 'editor' },
	});
	const { client } = renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route index element={<p>Project source</p>} />
			</Route>
		</Routes>,
		{ route: '/projects/p', toaster: false, errorBoundary: true },
	);
	expect(await screen.findByText('Project source')).toBeVisible();
	denied = true;
	await act(() => client.invalidateQueries({ queryKey: projectKeys.detail('p') }));
	expect(await screen.findByText('Request failed')).toBeVisible();
	expect(screen.queryByText('Project source')).not.toBeInTheDocument();
	expect(requests).toEqual(['/api/v1/projects/p', '/api/v1/projects/p']);
});

it('rechecks a cached apps grant before revealing source after a project denial', async () => {
	const client = createTestQueryClient();
	client.setQueryData(appKeys.projectAccess('p'), {
		pages: [
			{ items: [], next_cursor: null, missing: false, project: { id: 'p', your_role: 'editor' } },
		],
		pageParams: [undefined],
	});
	let resolveAccess!: (value: Response) => void;
	const { requests } = stubApi({
		'/api/v1/projects/p': jsonError('NOT_FOUND', 'Not found', 404),
		'/api/v1/apps': () =>
			new Promise<Response>((resolve) => {
				resolveAccess = resolve;
			}),
	});
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<ProjectSourceGate />}>
				<Route index element={<p>Project source</p>} />
			</Route>
			<Route path="*" element={<Destination />} />
		</Routes>,
		{ route: '/projects/p', toaster: false, client, reactStrictMode: true },
	);
	await waitFor(() => expect(requests).toContain('/api/v1/apps?project_id=p'));
	expect(screen.queryByText('Project source')).not.toBeInTheDocument();
	await act(async () => resolveAccess(jsonError('NOT_FOUND', 'Not found', 404)));
	expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
		/^\/projects$/,
	);
	expect(requests).toEqual(['/api/v1/projects/p', '/api/v1/apps?project_id=p']);
});

it.each([
	{ endpoint: 'project', cached: false },
	{ endpoint: 'apps', cached: false },
	{ endpoint: 'apps', cached: true },
])(
	'retries a failed $endpoint access check without treating the project as missing (cached=$cached)',
	async ({ endpoint, cached }) => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = createTestQueryClient();
		client.setQueryData(userKeys.me(), makeUser());
		localStorage.setItem(lastProjectKey('u'), 'p');
		let unavailable = true;
		const project = { id: 'p', name: 'Project', your_role: 'editor' };
		if (cached)
			client.setQueryData(appKeys.projectAccess('p'), {
				pages: [{ items: [], next_cursor: null, missing: false, project }],
				pageParams: [undefined],
			});
		const { requests } = stubApi({
			'/api/v1/projects/p': () =>
				endpoint === 'apps'
					? jsonError('NOT_FOUND', 'Not found', 404)
					: unavailable
						? jsonError('INTERNAL_ERROR', 'Temporarily unavailable', 503)
						: project,
			'/api/v1/apps': () =>
				unavailable
					? jsonError('INTERNAL_ERROR', 'Temporarily unavailable', 503)
					: { items: [], next_cursor: null, project },
		});
		renderWithClient(
			<QueryErrorResetBoundary>
				{({ reset }) => (
					<ErrorBoundary onRetry={reset}>
						<Routes>
							<Route path="/projects/:pid" element={<ProjectSourceGate />}>
								<Route index element={<p>Project source</p>} />
							</Route>
							<Route path="*" element={<Destination />} />
						</Routes>
					</ErrorBoundary>
				)}
			</QueryErrorResetBoundary>,
			{ route: '/projects/p', toaster: false, client },
		);
		expect(await screen.findByText('Something went wrong')).toBeVisible();
		expect(screen.queryByText('Project source')).not.toBeInTheDocument();
		expect(screen.queryByRole('status', { name: 'Destination' })).not.toBeInTheDocument();
		expect(localStorage.getItem(lastProjectKey('u'))).toBe('p');
		unavailable = false;
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Project source')).toBeVisible();
		expect(requests.filter((url) => url.startsWith('/api/v1/apps'))).toHaveLength(
			endpoint === 'apps' ? 2 : 0,
		);
	},
);

it('does not carry a failed app access check into another project', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const client = createTestQueryClient();
	client.setQueryData(userKeys.me(), makeUser({ app_only: true }));
	const { requests } = stubApi({
		'/api/v1/apps': ({ url }) =>
			url.searchParams.get('project_id') === 'p'
				? jsonError('INTERNAL_ERROR', 'Temporarily unavailable', 503)
				: { items: [], next_cursor: null, project: { id: 'other', your_role: 'app-user' } },
	});
	renderWithClient(
		<>
			<Link to="/projects/other/data">Open another project</Link>
			<Routes>
				<Route path="/projects/:pid" element={<ProjectSourceGate />}>
					<Route path="data" element={<p>Project source</p>} />
				</Route>
				<Route path="*" element={<Destination />} />
			</Routes>
		</>,
		{ route: '/projects/p/data', toaster: false, client },
	);
	expect(await screen.findByText('Something went wrong')).toBeVisible();
	fireEvent.click(screen.getByRole('link', { name: 'Open another project' }));
	expect(await screen.findByRole('status', { name: 'Destination' })).toHaveTextContent(
		'/apps?project_id=other',
	);
	expect(screen.queryByText('Project source')).not.toBeInTheDocument();
	expect(requests.filter((url) => url.startsWith('/api/v1/apps'))).toEqual([
		'/api/v1/apps?project_id=p',
		'/api/v1/apps?project_id=other',
	]);
});
