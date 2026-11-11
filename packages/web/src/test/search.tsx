import { vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { jsonError, jsonOk, renderWithClient, setupUser } from './render';
import type { SearchHit } from '@/api/search';
import SearchPage from '@/components/Search/SearchPage';
import { useWorkspaceSearchShortcut } from '@/hooks/useWorkspaceSearchShortcut';
import { useSearchAccess } from '@/hooks/useSearchAccess';
import { SEARCH_ROUTE, PROJECT_SEARCH_ROUTE } from '@/lib/workspaceSearch';

export const hit: SearchHit = {
	id: 'one',
	kind: 'code',
	resource: { type: 'notebook', notebook_id: 'n' },
	title: 'Revenue model',
	project_id: 'alpha',
	project_name: 'Alpha',
	href: '/projects/alpha/notebooks/n',
	indexed_at: '2026-11-02T00:00:00Z',
	snippet: { text: 'annual revenue = 42', highlights: [{ start: 7, end: 14 }] },
};
export const response = (items = [hit], partial = false) =>
	jsonOk({ items, partial, coverage: [] });
function Location() {
	const { available } = useSearchAccess();
	useWorkspaceSearchShortcut(available);
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<output aria-label="Location">
				{location.pathname}
				{location.search}
			</output>
			<button onClick={() => void navigate(-1)}>Back</button>
		</>
	);
}
export function setup({
	route = '/search?q=revenue',
	appOnly = false,
	enabled = true,
	semantic = false,
	search = () => Promise.resolve(response()),
	projectsFail = false,
	capabilities,
}: {
	route?: string;
	appOnly?: boolean;
	enabled?: boolean;
	semantic?: boolean;
	search?: (url: URL, signal?: AbortSignal | null) => Promise<Response>;
	projectsFail?: boolean;
	capabilities?: () => Promise<Response>;
} = {}) {
	const searches: URL[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
			if (url.pathname === '/api/v1/me') return jsonOk({ id: 'u', app_only: appOnly });
			if (url.pathname === '/api/v1/capabilities')
				return capabilities
					? capabilities()
					: jsonOk({
							search: {
								available: enabled,
								semantic,
								kinds: ['notebook', 'code', 'output', 'datasource', 'namespace', 'table', 'column'],
							},
						});
			if (url.pathname === '/api/v1/projects')
				return projectsFail
					? jsonError('SERVICE_UNAVAILABLE', 'Unavailable', 503)
					: jsonOk({
							items: [
								{ id: 'alpha', name: 'Alpha' },
								{ id: 'beta', name: 'Beta' },
							],
							next_cursor: null,
						});
			if (url.pathname.startsWith('/api/v1/projects/'))
				return jsonOk({ id: url.pathname.split('/').at(-1), name: 'Alpha', your_role: 'editor' });
			if (url.pathname === '/api/v1/search') {
				searches.push(url);
				return search(url, init?.signal);
			}
			throw new Error(`Unexpected request ${url}`);
		}),
	);
	const rendered = renderWithClient(
		<AuthProvider>
			<Location />
			<Routes>
				<Route path={SEARCH_ROUTE} element={<SearchPage />} />
				<Route path={PROJECT_SEARCH_ROUTE} element={<SearchPage />} />
				<Route path="/projects/:pid/notebooks/:nid" element={<p>Opened notebook</p>} />
			</Routes>
		</AuthProvider>,
		{ route, toaster: false },
	);
	return { ...rendered, searches, user: setupUser() };
}

export async function selectSearchFilter(
	user: ReturnType<typeof setupUser>,
	label: 'Scope' | 'Type',
	option: string,
) {
	await user.click(screen.getByRole('button', { name: new RegExp(`${label}$`) }));
	await user.click(await screen.findByRole('option', { name: option }));
}
