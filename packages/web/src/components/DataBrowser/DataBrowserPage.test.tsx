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
	browse_surfaces: ['tables'],
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

const objectKind: IntegrationKind = {
	...icebergKind,
	kind: 's3',
	title: 'S3',
	supports_browse: true,
	browse_surfaces: ['objects'],
};

const SNIPPET = 'from pyiceberg.catalog import load_catalog\n\ncatalog = load_catalog("lake")';

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function failed(message: string) {
	return new Response(
		JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message } }),
		{ status: 503, headers: { 'Content-Type': 'application/json' } },
	);
}

type ObjectFailure = 'buckets' | 'objects' | 'search' | 'detail' | 'versions' | 'preview';

function makeFetch({
	available = true,
	pagedTables = false,
	tables = ['orders'],
	capability = { metadata: true, preview: false },
	namespacesDown = false,
	kind = icebergKind,
	entry = lakeEntry,
	objectSearch = 'bounded-key-name',
	objectBuckets = [{ name: 'lake', configured: true }],
	objectEntries = [
		{ kind: 'prefix', name: 'daily/', key: 'daily/' },
		{ kind: 'object', name: 'events.jsonl', key: 'events.jsonl', size: 12 },
	],
	objectEntriesSecond = [],
	objectNextCursor = null,
	objectDetail = {},
	objectVersions = [],
	notebookFailure,
	objectPreview = {
		kind: 'text',
		format: 'text',
		text: 'hello object',
		truncated: false,
		bytes_read: 12,
		total_bytes: 12,
		warnings: [],
	},
	objectFailures = {},
}: {
	available?: boolean;
	pagedTables?: boolean;
	tables?: string[];
	capability?: { metadata: boolean; preview: boolean; reason?: string };
	namespacesDown?: boolean;
	kind?: IntegrationKind;
	entry?: IntegrationEntry;
	objectSearch?: 'none' | 'bounded-key-name';
	objectBuckets?: { name: string; configured: boolean }[];
	objectEntries?: unknown[];
	objectEntriesSecond?: unknown[];
	objectNextCursor?: string | null;
	objectDetail?: Record<string, unknown>;
	objectVersions?: unknown[];
	notebookFailure?: string;
	objectPreview?: unknown;
	objectFailures?: Partial<Record<ObjectFailure, string>>;
} = {}) {
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (method === 'POST' && url.includes(`/api/v1/projects/${PID}/notebooks`)) {
			if (notebookFailure) return failed(notebookFailure);
			const body = JSON.parse(String(init?.body)) as { title: string };
			return ok({ id: 'nb_1', project_id: PID, title: body.title });
		}
		if (method === 'POST' && url.endsWith('/browse/objects/preview')) {
			if (objectFailures.preview) return failed(objectFailures.preview);
			return ok(objectPreview);
		}
		if (method === 'POST' && url.endsWith('/browse/preview')) {
			return ok({ columns: ['id', 'status'], rows: [[1, 'paid']] });
		}
		if (method !== 'GET') throw new Error(`unexpected ${method} ${url}`);
		const target = new URL(url, 'http://test');
		if (url.includes('/api/v1/capabilities')) {
			return ok({ data_browser: { available, preview: false } });
		}
		if (url.includes('/api/v1/integrations/kinds')) {
			return ok([kind]);
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/objects/buckets`)) {
			if (objectFailures.buckets) return failed(objectFailures.buckets);
			return ok({ items: objectBuckets, next_cursor: null });
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/objects/head`)) {
			if (objectFailures.detail) return failed(objectFailures.detail);
			return ok({
				bucket: 'lake',
				key: target.searchParams.get('key'),
				size: 12,
				etag: '"etag"',
				content_type: 'text/plain',
				checksums: [],
				metadata: {},
				tags_available: false,
				snippet: 'import polars as pl',
				...objectDetail,
			});
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/objects/versions`)) {
			if (objectFailures.versions) return failed(objectFailures.versions);
			return ok({ items: objectVersions, next_cursor: null });
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/objects/search`)) {
			if (objectFailures.search) return failed(objectFailures.search);
			const continuing = target.searchParams.has('cursor');
			return ok({
				items: [
					{
						kind: 'object',
						name: continuing ? 'needle-second.jsonl' : 'needle.jsonl',
						key: continuing ? 'needle-second.jsonl' : 'needle.jsonl',
						size: 12,
					},
				],
				next_cursor: continuing ? null : 'continue',
				scanned: 5000,
				complete: continuing,
			});
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/objects`)) {
			if (objectFailures.objects) return failed(objectFailures.objects);
			return target.searchParams.has('cursor')
				? ok({ items: objectEntriesSecond, next_cursor: null })
				: ok({ items: objectEntries, next_cursor: objectNextCursor });
		}
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
			if (kind.browse_surfaces.includes('objects')) {
				return ok({
					metadata: false,
					preview: false,
					surfaces: {
						objects: {
							available: true,
							preview: true,
							download: true,
							search: objectSearch,
							versions: true,
							preview_formats: ['text'],
						},
					},
				});
			}
			return ok({
				...capability,
				surfaces: {
					tables: {
						available: capability.metadata,
						preview: capability.preview,
						...(capability.reason ? { reason: capability.reason } : {}),
					},
				},
			});
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations`)) {
			return ok({ items: [entry], next_cursor: null });
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

		const namespace = await screen.findByTestId('browse-namespace', undefined, { timeout: 5000 });
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

	it('loads a row preview only after the explicit button is pressed', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			capability: { metadata: true, preview: true },
		});

		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/browse/preview'))).toBe(
			false,
		);

		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(await screen.findByText('paid')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reload preview' })).toBeInTheDocument();
	});

	it('supports keyboard navigation and associates tabs with their panels', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			capability: { metadata: true, preview: true },
		});

		const schemaTab = await screen.findByRole('tab', { name: 'Schema' });
		const previewTab = screen.getByRole('tab', { name: 'Preview' });
		schemaTab.focus();
		await user.keyboard('{ArrowRight}');

		expect(previewTab).toHaveFocus();
		expect(previewTab).toHaveAttribute('aria-selected', 'true');
		const previewPanel = screen.getByRole('tabpanel');
		expect(previewTab).toHaveAttribute('aria-controls', previewPanel.id);
		expect(previewPanel).toHaveAttribute('aria-labelledby', previewTab.id);

		await user.keyboard('{ArrowLeft}');
		expect(schemaTab).toHaveFocus();
		expect(schemaTab).toHaveAttribute('aria-selected', 'true');
	});

	it('returns to schema when refreshed capabilities disable previews', async () => {
		const user = userEvent.setup();
		const capability = { metadata: true, preview: true };
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			capability,
		});
		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();

		capability.preview = false;
		await user.click(screen.getByRole('button', { name: 'Refresh' }));

		await waitFor(() =>
			expect(screen.queryByRole('tab', { name: 'Preview' })).not.toBeInTheDocument(),
		);
		expect(screen.getByPlaceholderText('Filter columns...')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Load preview' })).not.toBeInTheDocument();

		capability.preview = true;
		await user.click(screen.getByRole('button', { name: 'Refresh' }));
		await waitFor(() =>
			expect(screen.getByRole('tab', { name: 'Schema' })).toHaveAttribute('aria-selected', 'true'),
		);
		expect(screen.queryByRole('button', { name: 'Load preview' })).not.toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/browse/preview'))).toBe(
			false,
		);
	});

	it('reports when browsing is unavailable', async () => {
		setup(`/projects/${PID}/data`, { available: false });
		expect(await screen.findByText('Data browsing is not available')).toBeInTheDocument();
	});

	it('dispatches object-only integrations to the object browser', async () => {
		const fetchImpl = setup(`/projects/${PID}/data/${IID}`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		expect(await screen.findByText('events.jsonl')).toBeInTheDocument();
		expect(screen.getByText('daily/')).toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/browse/namespaces'))).toBe(
			false,
		);
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/browse/objects'))).toBe(
			true,
		);
	});

	it('selects among discovered buckets and reports empty or failed discovery', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [
				{ name: 'lake', configured: false },
				{ name: 'archive', configured: false },
			],
		});
		await user.click(await screen.findByRole('button', { name: 'archive' }));
		await waitFor(() => {
			const listCall = fetchImpl.mock.calls.find(([url]) => {
				const target = new URL(String(url), 'http://test');
				return target.pathname.endsWith('/browse/objects') && target.searchParams.has('bucket');
			});
			expect(new URL(String(listCall?.[0]), 'http://test').searchParams.get('bucket')).toBe(
				'archive',
			);
		});
	});

	it('explains when credentials discover no buckets', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [],
		});
		expect(await screen.findByText('No buckets available')).toBeInTheDocument();
		expect(
			screen.getByText('The integration credentials did not return an accessible bucket.'),
		).toBeInTheDocument();
	});

	it('shows actionable bucket and object-list failures', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { buckets: 'Bucket discovery failed. Check S3 permissions.' },
		});
		expect(
			await screen.findByText('Bucket discovery failed. Check S3 permissions.'),
		).toBeInTheDocument();

		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { objects: 'Object listing failed. Check ListBucket access.' },
		});
		expect(
			await screen.findByText('Object listing failed. Check ListBucket access.'),
		).toBeInTheDocument();
	});

	it('round-trips object selection in the URL and loads previews only on request', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`,
			{ kind: objectKind, entry: { ...lakeEntry, kind: 's3' } },
		);
		expect(await screen.findByText('s3://lake/events.jsonl')).toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/objects/preview'))).toBe(
			false,
		);
		await user.click(screen.getByRole('tab', { name: 'Preview' }));
		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(await screen.findByText('hello object')).toBeInTheDocument();
	});

	it('preserves URL-sensitive Unicode keys in detail and download links', async () => {
		const key = 'reports/日本語 ?#%/events.jsonl';
		setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=${encodeURIComponent(key)}`,
			{ kind: objectKind, entry: { ...lakeEntry, kind: 's3' } },
		);

		expect(await screen.findByText(`s3://lake/${key}`)).toBeInTheDocument();
		const download = screen.getByRole('link', { name: 'Download' });
		const target = new URL(download.getAttribute('href')!, 'http://test');
		expect(target.searchParams.get('bucket')).toBe('lake');
		expect(target.searchParams.get('key')).toBe(key);
	});

	it('renders checksums and tags and selects only concrete object versions', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectDetail: {
				checksums: [{ algorithm: 'SHA256', value: 'abc123' }],
				metadata: { owner: 'analytics' },
				tags_available: true,
				tags: [{ key: 'environment', value: 'production' }],
				last_modified: '2026-08-12T12:00:00Z',
			},
			objectVersions: [
				{
					bucket: 'lake',
					key: 'events.jsonl',
					version_id: 'v1',
					kind: 'version',
					is_latest: false,
					last_modified: '2026-08-11T12:00:00Z',
				},
				{
					bucket: 'lake',
					key: 'events.jsonl',
					version_id: 'deleted',
					kind: 'delete-marker',
					is_latest: true,
				},
			],
		});

		expect(await screen.findByText('abc123')).toBeInTheDocument();
		expect(screen.getByText('analytics')).toBeInTheDocument();
		expect(screen.getByText('production')).toBeInTheDocument();
		await user.click(screen.getByRole('tab', { name: 'Versions' }));
		expect(screen.getByRole('button', { name: /Delete marker/ })).toBeDisabled();
		await user.click(screen.getByRole('button', { name: /v1/ }));
		await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('version=v1'));
	});

	it.each([
		[
			'tabular',
			{
				kind: 'tabular',
				format: 'csv',
				columns: [{ name: 'name' }],
				rows: [['first'], ['first']],
				truncated: true,
				warnings: ['A malformed final row was omitted.'],
			},
			'A malformed final row was omitted.',
		],
		[
			'image',
			{
				kind: 'image',
				format: 'png',
				content_url: '/api/v1/image-content',
				width: 32,
				height: 16,
				total_bytes: 100,
				warnings: [],
			},
			'Object preview',
		],
		[
			'unsupported',
			{
				kind: 'unsupported',
				reason: 'Archives cannot be previewed safely.',
				total_bytes: 100,
			},
			'Archives cannot be previewed safely.',
		],
	] as const)(
		'renders an explicit %s preview and offers reload',
		async (_kind, preview, expected) => {
			const user = userEvent.setup();
			setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
				kind: objectKind,
				entry: { ...lakeEntry, kind: 's3' },
				objectPreview: preview,
			});
			await user.click(await screen.findByRole('tab', { name: 'Preview' }));
			await user.click(screen.getByRole('button', { name: 'Load preview' }));
			if (_kind === 'image')
				expect(await screen.findByRole('img', { name: expected })).toBeInTheDocument();
			else expect(await screen.findByText(expected)).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Reload preview' })).toBeInTheDocument();
		},
	);

	it('hides server search when the adapter does not provide it', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&q=ignored`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectSearch: 'none',
		});

		expect(await screen.findByText('events.jsonl')).toBeInTheDocument();
		expect(screen.queryByRole('textbox', { name: 'Search object keys' })).not.toBeInTheDocument();
	});

	it('submits bounded object search explicitly and reports partial progress', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		await screen.findByText('events.jsonl');
		const input = screen.getByRole('textbox', { name: 'Search object keys' });
		await user.type(input, 'needle');
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/objects/search'))).toBe(
			false,
		);
		await user.click(screen.getByRole('button', { name: 'Search object keys' }));
		expect(await screen.findByText('needle.jsonl')).toBeInTheDocument();
		expect(screen.getByText(/matches after scanning/)).toHaveTextContent(
			'1 matches after scanning 5000 keys; more may exist.',
		);
		await user.click(screen.getByRole('button', { name: 'Continue search' }));
		await waitFor(() =>
			expect(
				fetchImpl.mock.calls.some(
					([url]) =>
						String(url).includes('/objects/search') && String(url).includes('cursor=continue'),
				),
			).toBe(true),
		);
	});

	it('pages object listings through the reachable fallback button', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectNextCursor: 'p2',
			objectEntriesSecond: [{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 }],
		});

		await user.click(await screen.findByRole('button', { name: 'Load more' }));
		expect(await screen.findByText('second.csv')).toBeInTheDocument();
	});

	it('multi-selects object URIs and clears selection while navigating prefixes', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'prefix', name: 'daily/', key: 'daily/' },
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await user.click((await screen.findByText('first.csv')).closest('button')!);
		await user.keyboard('{Control>}');
		await user.click(screen.getByText('second.csv').closest('button')!);
		await user.keyboard('{/Control}');
		const copy = screen.getByRole('button', { name: 'Copy 2 selected URIs' });
		await user.click(copy);
		expect(await navigator.clipboard.readText()).toBe('s3://lake/first.csv\ns3://lake/second.csv');

		await user.click(screen.getByText('daily/').closest('button')!);
		expect(screen.queryByRole('button', { name: /Copy .* selected/ })).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByTestId('location')).toHaveTextContent('prefix=daily%2F'),
		);
		const row = await screen.findByText('first.csv');
		row.closest('button')!.focus();
		await user.keyboard('{Backspace}');
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('prefix='));
	});

	it('applies loaded type, size, date, and sort controls without searching', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{
					kind: 'object',
					name: 'old.csv',
					key: 'old.csv',
					size: 100,
					last_modified: '2026-08-10T12:00:00Z',
				},
				{
					kind: 'object',
					name: 'new.py',
					key: 'new.py',
					size: 2 * 1024 * 1024,
					last_modified: '2026-08-12T12:00:00Z',
				},
				{ kind: 'object', name: 'large.png', key: 'large.png', size: 200 * 1024 * 1024 },
			],
		});
		await screen.findByText('new.py');

		await user.selectOptions(screen.getByLabelText('Type'), 'text');
		expect(screen.getByText('new.py')).toBeInTheDocument();
		expect(screen.queryByText('old.csv')).not.toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText('Type'), 'all');
		await user.selectOptions(screen.getByLabelText('Size'), 'large');
		expect(screen.getByText('large.png')).toBeInTheDocument();
		expect(screen.queryByText('new.py')).not.toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText('Size'), 'all');
		await user.type(screen.getByLabelText('Modified after'), '2026-08-11');
		expect(screen.getByText('new.py')).toBeInTheDocument();
		expect(screen.queryByText('old.csv')).not.toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText('Sort loaded results'), 'name-desc');
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/objects/search'))).toBe(
			false,
		);
	});

	it('creates a notebook from the object-specific load snippet', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`,
			{ kind: objectKind, entry: { ...lakeEntry, kind: 's3' } },
		);
		await user.click(await screen.findByRole('button', { name: 'Open in notebook' }));
		await waitFor(() =>
			expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${PID}/notebooks/nb_1`),
		);
		const post = fetchImpl.mock.calls.find(
			([url, init]) => String(url).includes('/notebooks') && init?.method === 'POST',
		);
		const body = JSON.parse(String(post?.[1]?.body)) as { code: string };
		expect(body.code).toContain('# s3://lake/events.jsonl');
		expect(body.code).toContain('    import polars as pl');
	});

	it('preserves object selection when shared notebook creation fails', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			notebookFailure: 'Notebook creation failed.',
		});
		await user.click(await screen.findByRole('button', { name: 'Open in notebook' }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Open in notebook' })).toBeEnabled(),
		);
		expect(screen.getByTestId('location')).toHaveTextContent('key=events.jsonl');
		expect(screen.getByText('s3://lake/events.jsonl')).toBeInTheDocument();
	});

	it('keeps an explicit preview failure inline with a retry action', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { preview: 'Preview failed. Try a smaller object.' },
		});
		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(
			await screen.findByText('Preview failed. Try a smaller object.', { selector: 'p' }),
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();
	});

	it('keeps an object metadata failure inside the detail pane', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { detail: 'Object metadata is unavailable.' },
		});
		expect(await screen.findByText('Object metadata is unavailable.')).toBeInTheDocument();
	});

	it('keeps an object search failure inside the listing pane', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&q=needle`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { search: 'Object search reached its scan limit.' },
		});
		expect(await screen.findByText('Object search reached its scan limit.')).toBeInTheDocument();
	});

	it('keeps an object version failure inside the versions panel', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { versions: 'Object versions are unavailable.' },
		});
		await user.click(await screen.findByRole('tab', { name: 'Versions' }));
		expect(await screen.findByText('Object versions are unavailable.')).toBeInTheDocument();
	});

	it('filters and keyboard-navigates loaded object rows without a server request', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		const object = await screen.findByText('events.jsonl');
		const objectButton = object.closest('button')!;
		objectButton.focus();
		await user.keyboard('{ArrowUp}');
		expect(screen.getByText('daily/').closest('button')).toHaveFocus();

		await user.selectOptions(screen.getByLabelText('Type'), 'text');
		expect(screen.queryByText('events.jsonl')).not.toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/objects/search'))).toBe(
			false,
		);
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
