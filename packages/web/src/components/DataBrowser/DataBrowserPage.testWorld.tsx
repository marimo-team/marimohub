import { afterEach, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import DataBrowserPage from './DataBrowserPage';
import type { IntegrationEntry, IntegrationKind } from '@/types';
import { ThemeProvider } from '@/context/ThemeContext';
import { installMatchMedia, renderWithClient } from '@/test/render';
import { TestWorldControls } from './DataBrowserPage.testWorldControls';

export const PID = 'p_1';
export const IID = 'intg_lake';

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

export const lakeEntry: IntegrationEntry = {
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

export const objectKind: IntegrationKind = {
	...icebergKind,
	kind: 's3',
	title: 'S3',
	supports_browse: true,
	browse_surfaces: ['objects'],
};

export const azureObjectKind: IntegrationKind = {
	...objectKind,
	kind: 'azure_blob',
	title: 'Azure Blob',
};

export const pysparkKind: IntegrationKind = {
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

export const sparkEntry: IntegrationEntry = {
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

export type ObjectFailure =
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
		if (url.includes('/api/v1/me')) {
			return ok({ id: 'user_1', email: 'u@example.test', name: 'U', role: 'member' });
		}
		if (url.includes(`/api/v1/projects/${PID}/integrations/${IID}/browse/query/schema`)) {
			return ok({
				tables: [
					{
						namespace: ['sales'],
						name: 'orders',
						columns: [{ name: 'id', type: 'long', nullable: false }],
					},
				],
				truncated: { tables: false, columns: false, bytes: false },
				counts: { tables: 1, discovered_tables: 1, columns: 1, discovery_complete: true },
			});
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

export function setup(route: string | string[], fetchOpts?: Parameters<typeof makeFetch>[0]) {
	installMatchMedia();
	const fetchImpl = makeFetch(fetchOpts);
	renderWithClient(
		<ThemeProvider>
			<Routes>
				<Route path="/projects/:pid/data" element={<DataBrowserPage />} />
				<Route path="/projects/:pid/data/:iid" element={<DataBrowserPage />} />
			</Routes>
			<TestWorldControls deepLink={`/projects/${PID}/data/${IID}?ns=sales&table=orders`} />
		</ThemeProvider>,
		{ route },
	);
	return fetchImpl;
}

afterEach(() => {
	vi.unstubAllGlobals();
});
