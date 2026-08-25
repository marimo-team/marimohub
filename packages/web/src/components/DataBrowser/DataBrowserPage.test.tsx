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

const azureObjectKind: IntegrationKind = {
	...objectKind,
	kind: 'azure_blob',
	title: 'Azure Blob',
};

const pysparkKind: IntegrationKind = {
	...icebergKind,
	kind: 'pyspark',
	title: 'PySpark (Spark Connect)',
	description: 'Remote PySpark DataFrame sessions over Spark Connect.',
	category: 'engine',
	brand: { icon: 'apachespark', color: '#E25A1C' },
	supports_test: false,
	supports_browse: false,
	browse_surfaces: [],
	requirements: ['pyspark[connect]>=4.2'],
};

const sparkEntry: IntegrationEntry = {
	...lakeEntry,
	id: 'intg_spark',
	kind: 'pyspark',
	name: 'analytics-prod',
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

type ObjectFailure =
	| 'capability'
	| 'buckets'
	| 'objects'
	| 'search'
	| 'detail'
	| 'versions'
	| 'preview';

function makeFetch({
	available = true,
	pagedTables = false,
	tables = ['orders'],
	capability = { metadata: true, preview: false },
	querySurface,
	queryEnabled = querySurface !== undefined,
	role = 'editor',
	namespacesDown = false,
	kind = icebergKind,
	entry = lakeEntry,
	objectSearch = 'bounded-key-name',
	objectProvider = 's3',
	objectRootKind = 'bucket',
	objectUriScheme = 's3',
	objectBuckets = [{ name: 'lake', configured: true }],
	objectBucketsSecond = [],
	objectBucketNextCursor = null,
	objectBucketNextFailure,
	objectEntries = [
		{ kind: 'prefix', name: 'daily/', key: 'daily/' },
		{ kind: 'object', name: 'events.jsonl', key: 'events.jsonl', size: 12 },
	],
	objectEntriesSecond = [],
	objectNextCursor = null,
	objectDetail = {},
	objectVersions = [],
	notebookFailure,
	notebookGate,
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
	querySurface?: { available: boolean; reason?: string };
	queryEnabled?: boolean;
	role?: 'editor' | 'manager';
	namespacesDown?: boolean;
	kind?: IntegrationKind;
	entry?: IntegrationEntry;
	objectSearch?: 'none' | 'bounded-key-name' | 'unknown';
	objectProvider?: 's3' | 'gcs' | 'azure_blob' | 'unknown';
	objectRootKind?: 'bucket' | 'container' | 'unknown';
	objectUriScheme?: 's3' | 'gs' | 'az' | 'unknown';
	objectBuckets?: { name: string; configured: boolean }[];
	objectBucketsSecond?: { name: string; configured: boolean }[];
	objectBucketNextCursor?: string | null;
	objectBucketNextFailure?: string;
	objectEntries?: unknown[];
	objectEntriesSecond?: unknown[];
	objectNextCursor?: string | null;
	objectDetail?: Record<string, unknown>;
	objectVersions?: unknown[];
	notebookFailure?: string;
	notebookGate?: Promise<void>;
	objectPreview?: unknown;
	objectFailures?: Partial<Record<ObjectFailure, string>>;
} = {}) {
	let nextBucketFailure = objectBucketNextFailure;
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (method === 'POST' && url.includes(`/api/v1/projects/${PID}/notebooks`)) {
			await notebookGate;
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
			return ok({
				data_browser: { available, preview: false, query: queryEnabled },
			});
		}
		if (url.includes('/api/v1/integrations/kinds')) {
			return ok([kind]);
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/objects/buckets`)) {
			if (objectFailures.buckets) return failed(objectFailures.buckets);
			if (target.searchParams.has('cursor') && nextBucketFailure) {
				const message = nextBucketFailure;
				nextBucketFailure = undefined;
				return failed(message);
			}
			return target.searchParams.has('cursor')
				? ok({ items: objectBucketsSecond, next_cursor: null })
				: ok({ items: objectBuckets, next_cursor: objectBucketNextCursor });
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
						error: {
							code: 'SERVICE_UNAVAILABLE',
							message: 'The catalog answered HTTP 503.',
							request_id: 'browse-req-123',
						},
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
		if (url.includes(`/api/v1/projects/${PID}/integrations/${entry.id}/browse`)) {
			if (objectFailures.capability) return failed(objectFailures.capability);
			if (kind.browse_surfaces.includes('objects')) {
				return ok({
					surfaces: {
						objects: {
							provider: objectProvider,
							root_kind: objectRootKind,
							uri_scheme: objectUriScheme,
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
				surfaces: {
					tables: {
						available: capability.metadata,
						preview: capability.preview,
						...(capability.reason ? { reason: capability.reason } : {}),
					},
					...(querySurface ? { query: querySurface } : {}),
				},
			});
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations`)) {
			return ok({ items: [entry], next_cursor: null });
		}
		if (url.includes(`/api/v1/projects/${PID}`)) {
			return ok({ id: PID, name: 'Demo', description: 'd', your_role: role });
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

function HistoryControls() {
	const navigate = useNavigate();
	return (
		<>
			<button type="button" data-testid="history-back" onClick={() => void navigate(-1)}>
				back
			</button>
			<button type="button" data-testid="history-forward" onClick={() => void navigate(1)}>
				forward
			</button>
		</>
	);
}

function setup(route: string | string[], fetchOpts?: Parameters<typeof makeFetch>[0]) {
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
			<HistoryControls />
		</>,
		{ route },
	);
	return fetchImpl;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('DataBrowserPage', () => {
	it('shows PySpark connection info and opens its session snippet in a notebook', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${sparkEntry.id}`, {
			kind: pysparkKind,
			entry: sparkEntry,
		});

		expect(await screen.findByTestId('browse-integration')).toHaveTextContent('analytics-prod');
		expect(
			screen.getByText(/cannot inspect its catalogs without opening a Spark session/),
		).toBeInTheDocument();
		expect(screen.getByText('pyspark[connect]>=4.2')).toBeInTheDocument();
		expect(screen.getByText(/SparkSession\.builder\.remote/)).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Create PySpark Notebook' }));

		await waitFor(() => {
			expect(screen.getByTestId('location').textContent).toContain(
				`/projects/${PID}/notebooks/nb_1`,
			);
		});
		const post = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
		const body = JSON.parse(String(post?.[1]?.body)) as { title: string; code: string };
		expect(body.title).toBe('connect_analytics_prod');
		expect(body.code).toContain('.joinpath("pyspark", "analytics-prod.json")');
		expect(body.code).toContain('builder.getOrCreate()');
	});

	it('shows a disabled Query control with the server blocker reason', async () => {
		setup(`/projects/${PID}/data/${IID}`, {
			role: 'manager',
			querySurface: { available: false, reason: 'Broker unavailable.' },
		});

		await screen.findByTestId('browse-namespace', undefined, { timeout: 5000 });
		expect(screen.getByRole('button', { name: 'Tables' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
		expect(screen.queryByRole('button', { name: 'Objects' })).not.toBeInTheDocument();
		expect(screen.getByText('Run SQL unavailable.')).toBeInTheDocument();
		expect(screen.getByText('Broker unavailable.')).toBeInTheDocument();
	});

	it('shows the deployment blocker when the global Run SQL capability is off', async () => {
		setup(`/projects/${PID}/data/${IID}`, {
			role: 'manager',
			queryEnabled: false,
			querySurface: {
				available: false,
				reason: 'Run SQL is not enabled on this deployment.',
			},
		});

		await screen.findByTestId('browse-namespace', undefined, { timeout: 5000 });
		expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
		expect(screen.getByText('Run SQL is not enabled on this deployment.')).toBeInTheDocument();
	});

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

		await user.click(await screen.findByRole('button', { name: /Open in Notebook/ }));

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
		expect(screen.getByRole('group', { name: 'Object filters' })).toHaveClass('flex', 'flex-wrap');
	});

	it('opens the detail sheet and closes it from the header button or Escape', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});

		expect(
			await screen.findByRole('complementary', { name: 'Object details' }),
		).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Close details' }));
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('key='));
		expect(screen.queryByRole('complementary', { name: 'Object details' })).not.toBeInTheDocument();

		await user.click(screen.getByText('events.jsonl').closest('button')!);
		expect(
			await screen.findByRole('complementary', { name: 'Object details' }),
		).toBeInTheDocument();
		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('key='));
	});

	it('copies and downloads through row quick actions without opening the object', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});

		await screen.findByText('events.jsonl');
		await user.click(screen.getByRole('button', { name: 'Copy URI for events.jsonl' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/events.jsonl');
		await user.click(screen.getByRole('button', { name: 'Copy key for events.jsonl' }));
		expect(await navigator.clipboard.readText()).toBe('events.jsonl');
		const download = screen.getByRole('link', { name: 'Download events.jsonl' });
		const target = new URL(download.getAttribute('href')!, 'http://test');
		expect(target.searchParams.get('key')).toBe('events.jsonl');
		expect(screen.getByTestId('location')).not.toHaveTextContent('key=');
		expect(screen.queryByRole('complementary', { name: 'Object details' })).not.toBeInTheDocument();
	});

	it('navigates upward with the breadcrumb trail from a nested prefix', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&prefix=daily%2Freports%2F`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});

		await screen.findByText('events.jsonl');
		await user.click(screen.getByRole('button', { name: 'daily' }));
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('reports'));
		expect(screen.getByTestId('location')).toHaveTextContent('prefix=daily%2F');
		await user.click(screen.getByRole('button', { name: 'lake' }));
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('prefix='));
		// A lone auto-selected bucket makes the root crumb inert.
		expect(screen.getByText('Buckets')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Buckets' })).not.toBeInTheDocument();
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

	it('pages bucket discovery before choosing a bucket', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [{ name: 'first', configured: false }],
			objectBucketsSecond: [{ name: 'second', configured: false }],
			objectBucketNextCursor: 'bucket-page-2',
		});

		expect(await screen.findByText('first')).toBeInTheDocument();
		expect(screen.queryByText('second')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Load more buckets' }));
		expect(await screen.findByText('second')).toBeInTheDocument();
		expect(
			fetchImpl.mock.calls.some(
				([url]) =>
					String(url).includes('/objects/buckets') && String(url).includes('cursor=bucket-page-2'),
			),
		).toBe(true);
	});

	it('keeps loaded buckets visible and retries a failed next page', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [{ name: 'first', configured: false }],
			objectBucketsSecond: [{ name: 'second', configured: false }],
			objectBucketNextCursor: 'bucket-page-2',
			objectBucketNextFailure: 'The next bucket page failed.',
		});

		await user.click(await screen.findByRole('button', { name: 'Load more buckets' }));
		expect(await screen.findByText('The next bucket page failed.')).toBeInTheDocument();
		expect(screen.getByText('first')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry loading buckets' }));
		expect(await screen.findByText('second')).toBeInTheDocument();
		expect(screen.queryByText('The next bucket page failed.')).not.toBeInTheDocument();
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

	it('uses provider capability metadata for Azure containers and URIs', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: azureObjectKind,
			entry: { ...lakeEntry, kind: 'azure_blob' },
			objectProvider: 'azure_blob',
			objectRootKind: 'container',
			objectUriScheme: 'az',
			objectBuckets: [],
		});
		expect(await screen.findByText('No containers available')).toBeInTheDocument();
		expect(
			screen.getByText('The integration credentials did not return an accessible container.'),
		).toBeInTheDocument();
	});

	it('handles unknown object capability vocabulary without fabricating a URI', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectProvider: 'unknown',
			objectRootKind: 'unknown',
			objectUriScheme: 'unknown',
		});

		await user.click(await screen.findByRole('button', { name: /^events\.jsonl/i }));
		expect(await screen.findByText('lake/events.jsonl')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Copy URI' })).not.toBeInTheDocument();
	});

	it('shows a refetch failure instead of a cached empty bucket state', async () => {
		const user = userEvent.setup();
		const objectFailures: Partial<Record<ObjectFailure, string>> = {};
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [],
			objectFailures,
		});
		expect(await screen.findByText('No buckets available')).toBeInTheDocument();

		objectFailures.buckets = 'Bucket refresh failed.';
		await user.click(screen.getByRole('button', { name: 'Refresh' }));

		expect(await screen.findByText('Bucket refresh failed.')).toBeInTheDocument();
		expect(screen.queryByText('No buckets available')).not.toBeInTheDocument();
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
		expect(screen.queryByLabelText('Filter loaded objects')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry loading objects' })).toBeInTheDocument();
	});

	it('keeps parent-prefix navigation available when the initial listing fails', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&prefix=daily%2F`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { objects: 'Object listing failed. Check ListBucket access.' },
		});

		const parentPrefix = await screen.findByRole('button', { name: 'Parent prefix' });
		expect(
			await screen.findByRole('button', { name: 'Retry loading objects' }),
		).toBeInTheDocument();
		await user.click(parentPrefix);

		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('prefix='));
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

	it('resets selection to the URL object after back and forward navigation', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=first.csv`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await user.click((await screen.findByText('second.csv')).closest('button')!);
		await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('key=second.csv'));
		await user.click(screen.getByTestId('history-back'));
		expect(await screen.findByText('s3://lake/first.csv')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Copy 1 selected URI' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/first.csv');

		await user.click(screen.getByTestId('history-forward'));
		expect(await screen.findByText('s3://lake/second.csv')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Copy 1 selected URI' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/second.csv');
	});

	it('resets a multi-selection when revisiting its URL through history', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=first.csv`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await screen.findByRole('button', { name: /^first\.csv/ });
		const second = screen.getByRole('button', { name: /^second\.csv/ });
		await user.keyboard('{Control>}');
		await user.click(second);
		await user.keyboard('{/Control}');
		expect(screen.getByRole('button', { name: 'Copy 2 selected URIs' })).toBeInTheDocument();
		await user.click(screen.getByTestId('history-back'));
		expect(await screen.findByText('s3://lake/first.csv')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^first\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		expect(screen.getByRole('button', { name: /^second\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		await user.click(screen.getByTestId('history-forward'));
		expect(await screen.findByText('s3://lake/second.csv')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^first\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		expect(screen.getByRole('button', { name: /^second\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await user.click(screen.getByRole('button', { name: 'Copy 1 selected URI' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/second.csv');
	});

	it('does not carry a loaded preview into another object detail', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=first.csv`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(await screen.findByText('hello object')).toBeInTheDocument();
		await user.click(screen.getByText('second.csv').closest('button')!);
		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();
		expect(screen.queryByText('hello object')).not.toBeInTheDocument();
	});

	it('reports rejected key and snippet clipboard writes', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		await screen.findByText('s3://lake/events.jsonl');
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

		await user.click(screen.getByRole('button', { name: 'Copy key' }));
		expect(await screen.findByText('Could not copy to clipboard')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Copy snippet' }));
		expect(write).toHaveBeenCalledTimes(2);
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
		const write = vi.spyOn(navigator.clipboard, 'writeText');
		await user.click(copy);
		await waitFor(() =>
			expect(write).toHaveBeenCalledWith('s3://lake/first.csv\ns3://lake/second.csv'),
		);

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
		await user.click(await screen.findByRole('button', { name: 'Open in Notebook' }));
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

	it('disables object notebook creation while the request is pending', async () => {
		const user = userEvent.setup();
		let releaseNotebook!: () => void;
		const notebookGate = new Promise<void>((resolve) => {
			releaseNotebook = resolve;
		});
		const fetchImpl = setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`,
			{
				kind: objectKind,
				entry: { ...lakeEntry, kind: 's3' },
				notebookGate,
			},
		);

		await user.click(await screen.findByRole('button', { name: 'Open in Notebook' }));
		const pending = await screen.findByRole('button', { name: 'Creating Notebook…' });
		expect(pending).toBeDisabled();
		await user.click(pending);
		expect(
			fetchImpl.mock.calls.filter(
				([url, init]) => String(url).includes('/notebooks') && init?.method === 'POST',
			),
		).toHaveLength(1);
		releaseNotebook();
		await waitFor(() =>
			expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${PID}/notebooks/nb_1`),
		);
	});

	it('preserves object selection when shared notebook creation fails', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			notebookFailure: 'Notebook creation failed.',
		});
		await user.click(await screen.findByRole('button', { name: 'Open in Notebook' }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Open in Notebook' })).toBeEnabled(),
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

	it('shows an object capability request failure instead of a perpetual loading message', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { capability: 'S3 capability check failed.' },
		});

		expect(await screen.findByText('S3 capability check failed.')).toBeInTheDocument();
		expect(screen.queryByText('Checking object-store access…')).not.toBeInTheDocument();
	});

	it('shows the upstream error inline when a listing fails', async () => {
		setup(`/projects/${PID}/data/${IID}`, { namespacesDown: true });

		expect(await screen.findByText('The catalog answered HTTP 503.')).toBeInTheDocument();
		expect(screen.getByText('Reference: browse-req-123')).toBeInTheDocument();
	});

	it('an unknown integration id in the URL falls back to the empty detail pane', async () => {
		setup(`/projects/${PID}/data/intg_ghost?ns=sales&table=orders`);

		expect(await screen.findByTestId('browse-integration')).toBeInTheDocument();
		expect(await screen.findByText('Select an Integration')).toBeInTheDocument();
	});
});
