import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import DataBrowserPage from './DataBrowserPage';
import type { IntegrationEntry, IntegrationKind } from '@/types';
import { installMatchMedia, renderWithClient } from '@/test/render';

const PID = 'p_1';
const IID = 'intg_lake';

const icebergKind: IntegrationKind = {
	kind: 'iceberg_rest',
	title: 'Iceberg REST Catalog',
	description: 'REST catalog',
	category: 'catalog',
	brand: { color: '#1E90FF' },
	schema_version: 2,
	json_schema: { type: 'object', properties: {} },
	ui_hints: {},
	supports_test: true,
	supports_browse: true,
	requirements: [],
	secret_sources: { inline: false, references: [] },
};

const lakeEntry: IntegrationEntry = {
	id: IID,
	kind: 'iceberg_rest',
	name: 'lake',
	enabled: true,
	current_version: 1,
	created_by: 'u',
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z',
	scope: 'project',
};

const SNIPPET = 'from pyiceberg.catalog import load_catalog\n\ncatalog = load_catalog("lake")';

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function makeFetch({
	available = true,
	pagedTables = false,
	tables = ['orders'],
	capability = { metadata: true, preview: false },
	namespacesDown = false,
}: {
	available?: boolean;
	pagedTables?: boolean;
	tables?: string[];
	capability?: { metadata: boolean; preview: boolean; reason?: string };
	namespacesDown?: boolean;
} = {}) {
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (method === 'POST' && url.includes(`/api/v1/projects/${PID}/notebooks`)) {
			const body = JSON.parse(String(init?.body)) as { title: string };
			return ok({ id: 'nb_1', project_id: PID, title: body.title });
		}
		if (method !== 'GET') throw new Error(`unexpected ${method} ${url}`);
		const target = new URL(url, 'http://test');
		if (url.includes('/api/v1/capabilities')) {
			return ok({ data_browser: { available, preview: false } });
		}
		if (url.includes('/api/v1/integrations/kinds')) return ok([icebergKind]);
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/namespaces`)) {
			if (namespacesDown) {
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'SERVICE_UNAVAILABLE', message: 'The catalog answered HTTP 503.' },
					}),
					{ status: 503, headers: { 'Content-Type': 'application/json' } },
				);
			}
			const parent = target.searchParams.get('parent');
			return parent === null
				? ok({ items: [['sales']], next_cursor: null })
				: ok({ items: [], next_cursor: null });
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/tables`)) {
			if (!pagedTables) return ok({ items: tables, next_cursor: null });
			return target.searchParams.get('cursor') === 'p2'
				? ok({ items: ['refunds'], next_cursor: null })
				: ok({ items: ['orders'], next_cursor: 'p2' });
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/schema`)) {
			return ok({
				columns: [
					{ name: 'id', type: 'long', nullable: false },
					{ name: 'ts', type: 'timestamptz', nullable: true, comment: 'event time' },
				],
				partitioning: ['day(ts)'],
				snippet: SNIPPET,
				location: 's3://warehouse/sales/orders',
				format_version: 2,
				current_snapshot: {
					committed_at: '2026-08-01T00:00:00Z',
					total_records: 123456,
					total_data_size_bytes: 789000,
				},
			});
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse`)) {
			return ok(capability);
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations`)) {
			return ok({ items: [lakeEntry], next_cursor: null });
		}
		if (url.includes(`/api/v1/projects/${PID}`)) {
			return ok({ id: PID, name: 'Demo', description: 'd', your_role: 'editor' });
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return impl;
}

function LocationProbe() {
	const location = useLocation();
	return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

/** Simulates an in-app deep link arriving while the page is already mounted. */
function DeepLink({ to }: { to: string }) {
	const navigate = useNavigate();
	return (
		<button type="button" data-testid="deeplink" onClick={() => void navigate(to)}>
			deeplink
		</button>
	);
}

function setup(route: string, fetchOpts?: Parameters<typeof makeFetch>[0]) {
	installMatchMedia();
	const fetchImpl = makeFetch(fetchOpts);
	renderWithClient(
		<>
			<Routes>
				<Route path="/projects/:pid/data" element={<DataBrowserPage />} />
				<Route path="/projects/:pid/data/:iid" element={<DataBrowserPage />} />
			</Routes>
			<LocationProbe />
			<DeepLink to={`/projects/${PID}/data/${IID}?ns=sales&table=orders`} />
		</>,
		{ route },
	);
	return fetchImpl;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('DataBrowserPage', () => {
	it('restores a deep link: tree expanded to the namespace, table selected, schema shown', async () => {
		setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`);

		const namespace = await screen.findByTestId('browse-namespace');
		expect(namespace).toHaveAttribute('aria-expanded', 'true');
		const table = await screen.findByTestId('browse-table');
		expect(table).toHaveAttribute('aria-current', 'true');

		expect(await screen.findByText(/123[,.\s]456 rows/)).toBeInTheDocument();
		expect(screen.getByText('771 KiB')).toBeInTheDocument();
		expect(screen.getByText('format v2')).toBeInTheDocument();
		expect(screen.getByText('s3://warehouse/sales/orders')).toBeInTheDocument();
		expect(screen.getByText('day(ts)')).toBeInTheDocument();
		expect(screen.getByText(/load_catalog/)).toBeInTheDocument();
	});

	it('expands the ancestry when a deep link arrives while already mounted', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}`);

		const namespace = await screen.findByTestId('browse-namespace');
		expect(namespace).toHaveAttribute('aria-expanded', 'false');

		await user.click(screen.getByTestId('deeplink'));

		await waitFor(() => {
			expect(screen.getByTestId('browse-namespace')).toHaveAttribute('aria-expanded', 'true');
		});
		expect(await screen.findByTestId('browse-table')).toHaveAttribute('aria-current', 'true');
	});

	it('writes the selection into the URL when a table is clicked', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}`);

		await user.click(await screen.findByTestId('browse-namespace'));
		await user.click(await screen.findByTestId('browse-table'));

		await waitFor(() => {
			const location = screen.getByTestId('location').textContent ?? '';
			expect(location).toContain(`/projects/${PID}/data/${IID}`);
			expect(decodeURIComponent(location)).toContain(`ns=sales`);
			expect(location).toContain('table=orders');
		});
	});

	it('pages tables with Load more', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}`, { pagedTables: true });

		await user.click(await screen.findByTestId('browse-namespace'));
		expect(await screen.findByText('orders')).toBeInTheDocument();
		expect(screen.queryByText('refunds')).not.toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Load more' }));
		expect(await screen.findByText('refunds')).toBeInTheDocument();
	});

	it('finds a table under a collapsed namespace while a filter is active', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?q=orders`);

		// The namespace stays visible (its tables are not loaded yet), so the
		// filtered table remains reachable by expanding it.
		const namespace = await screen.findByTestId('browse-namespace');
		expect(screen.getByLabelText('Filter tables')).toHaveValue('orders');
		await user.click(namespace);
		expect(await screen.findByTestId('browse-table')).toHaveTextContent('orders');
	});

	it('filters loaded tables and says so when nothing matches', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?q=zzz`);

		await user.click(await screen.findByTestId('browse-namespace'));
		expect(await screen.findByText('No tables here match "zzz".')).toBeInTheDocument();
		expect(screen.queryByTestId('browse-table')).not.toBeInTheDocument();
	});

	it('resets the column filter when another table is selected', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			tables: ['orders', 'refunds'],
		});

		const filter = await screen.findByPlaceholderText('Filter columns...');
		await user.type(filter, 'zzz');
		expect(await screen.findByText('No columns match "zzz".')).toBeInTheDocument();

		await user.click(screen.getByText('refunds'));

		expect(await screen.findByPlaceholderText('Filter columns...')).toHaveValue('');
		expect(screen.queryByText('No columns match "zzz".')).not.toBeInTheDocument();
	});

	it('creates a notebook seeded with the load snippet and navigates to it', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`);

		await user.click(await screen.findByRole('button', { name: /Open in notebook/ }));

		await waitFor(() => {
			expect(screen.getByTestId('location').textContent).toContain(
				`/projects/${PID}/notebooks/nb_1`,
			);
		});
		const post = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
		const body = JSON.parse(String(post?.[1]?.body)) as { title: string; code: string };
		expect(body.title).toBe('explore_orders');
		expect(body.code).toContain('# sales.orders');
		expect(body.code).toContain('    catalog = load_catalog("lake")');
	});

	it('reports when browsing is unavailable', async () => {
		setup(`/projects/${PID}/data`, { available: false });
		expect(await screen.findByText('Data browsing is not available')).toBeInTheDocument();
	});

	it('shows the capability reason under an instance the hub cannot browse', async () => {
		setup(`/projects/${PID}/data/${IID}`, {
			capability: { metadata: false, preview: false, reason: 'sandbox only' },
		});

		expect(await screen.findByText('sandbox only')).toBeInTheDocument();
		expect(screen.queryByTestId('browse-namespace')).not.toBeInTheDocument();
	});

	it('shows the upstream error inline when a listing fails', async () => {
		setup(`/projects/${PID}/data/${IID}`, { namespacesDown: true });

		expect(await screen.findByText('The catalog answered HTTP 503.')).toBeInTheDocument();
	});

	it('an unknown integration id in the URL falls back to the empty detail pane', async () => {
		setup(`/projects/${PID}/data/intg_ghost?ns=sales&table=orders`);

		expect(await screen.findByTestId('browse-integration')).toBeInTheDocument();
		expect(await screen.findByText('Select a table')).toBeInTheDocument();
	});
});
