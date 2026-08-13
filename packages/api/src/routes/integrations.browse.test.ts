import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from '@hono/zod-openapi';
import {
	AesGcmSecretCodec,
	DataQueryService,
	DataPreviewService,
	defaultRegistry,
	defineIntegration,
	IntegrationRegistry,
	Millis,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
	UnavailableError,
	zSecret,
} from '@marimo-hub/core';
import type {
	DataQueryExecution,
	IntegrationProbe,
	ObjectBrowser,
	PythonPreviewProgram,
	TablePreview,
} from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { clearObjectCredentialCacheForTests } from './objectBrowse';
import { clearIntegrationBrowseStateForTests } from './integrations';

const codec = new AesGcmSecretCodec({ kek: '/ECMzY/eM7nlHPPNu+OM2wv0lWiFuHUScSJxNmh64N8=' });

afterEach(() => vi.restoreAllMocks());

/** U+001F, the separator multi-part namespaces use in query params. */
const SEP = String.fromCharCode(0x1f);

/** Browsable test kind; ops are network-free, so no probe traffic in tests. */
const browsyKind = defineIntegration({
	kind: 'browsy',
	title: 'Browsy',
	description: 'test kind',
	category: 'catalog',
	brand: { color: '#000000' },
	schemaVersion: 1,
	configSchema: z.object({
		mode: z.enum(['open', 'sandbox_only']).default('open'),
		token: zSecret(),
	}),
	render: () => ({}),
	query: {
		available: () => ({ ok: true }),
		plan: () => ({ setup: [] }),
	},
	browse: {
		available: (config) =>
			config.mode === 'open' ? { ok: true } : { ok: false, reason: 'sandbox only' },
		// Echo the inputs so route tests can assert round-trips.
		listNamespaces: async (config, _probe, request) => {
			if (config.token === 'many-namespaces') {
				return {
					items: request.parent
						? []
						: Array.from({ length: 300 }, (_, index) => [
								`ns-${index.toString().padStart(3, '0')}`,
							]),
					next_cursor: null,
				};
			}
			if (config.token === 'schema-work-limit') {
				const current = request.parent
					? Number.parseInt(request.parent[0]?.slice(3) ?? '', 10)
					: -1;
				return {
					items: current < 255 ? [[`ns-${String(current + 1).padStart(3, '0')}`]] : [],
					next_cursor: null,
				};
			}
			if (config.token === 'repeated-table-cursor') {
				return { items: request.parent ? [] : [['sales']], next_cursor: null };
			}
			return {
				items: [['sales', 'eu.central'], ...(request.parent ? [request.parent] : [])],
				next_cursor: request.cursor ?? 'next-token',
			};
		},
		listTables: async (config, _probe, namespace, request) => {
			// Simulated outage, so route tests can exercise the failure path.
			if (namespace[0] === 'boom') throw new UnavailableError('The catalog answered HTTP 503.');
			if (config.token === 'schema-work-limit' && namespace[0]?.startsWith('ns-')) {
				const index = Number.parseInt(namespace[0].slice(3), 10);
				return {
					items: index >= 128 ? [`table-${index}`] : [],
					next_cursor: null,
				};
			}
			if (config.token === 'repeated-table-cursor') {
				const start = request.cursor ? 100 : 0;
				const count = request.cursor ? 28 : 100;
				return {
					items: Array.from({ length: count }, (_, index) => `table-${start + index}`),
					next_cursor: 'repeat',
				};
			}
			if (namespace[0]?.startsWith('ns-')) return { items: [], next_cursor: null };
			return { items: [namespace.join('|')], next_cursor: null };
		},
		getTableSchema: async (_config, _probe, _namespace, table) => ({
			columns: [{ name: `${table}_id`, type: 'long', nullable: false }],
		}),
		previewRows: async (_config, _probe, namespace, table, request) => ({
			columns: ['qualified', 'limit'],
			rows: [[`${namespace.join('.')}.${table}`, request.limit]],
		}),
		snippet: (name, namespace, table) => `load ${name}:${namespace.join('.')}.${table}`,
	},
});

const sandboxBrowsyKind = defineIntegration({
	kind: 'sandbox_browsy',
	title: 'Sandbox browsy',
	description: 'test kind with sandbox preview',
	category: 'catalog',
	brand: { color: '#000000' },
	schemaVersion: 1,
	configSchema: z.object({}),
	render: () => ({ env: { SANDBOX_BROWSY: 'enabled' } }),
	preview: {
		available: () => ({ ok: true, programs: { python: true } }),
		programs: (input) => ({
			python: {
				script: 'preview',
				maxRows: input.limit,
				input: {
					integration_name: input.integration.name,
					user_id: input.principal.userId,
				},
				render: { env: { SANDBOX_BROWSY: 'enabled' } },
				integration: input.integration,
				sessionId: input.sessionId,
				credentialVars: input.credentialVars,
			},
		}),
	},
	browse: {
		available: () => ({ ok: true }),
		listNamespaces: async () => ({ items: [['sales']], next_cursor: null }),
		listTables: async () => ({ items: ['orders'], next_cursor: null }),
		getTableSchema: async () => ({ columns: [] }),
		snippet: () => 'load',
	},
});

const objectBrowser: ObjectBrowser<'s3'> = {
	provider: 's3',
	capability: (source, context) => {
		const available =
			source.auth.method === 'static' ||
			context.federation?.provider === 's3' ||
			context.allow_server_ambient.s3 === true;
		return {
			provider: 's3',
			root_kind: 'bucket',
			uri_scheme: 's3',
			available,
			preview: available,
			download: available,
			search: 'bounded-key-name',
			versions: available,
			preview_formats: available ? ['csv', 'text', 'png'] : [],
			...(available ? {} : { reason: 'No object-store credentials are available.' }),
		};
	},
	listBuckets: async () => ({
		items: [{ name: 'lake', configured: true }],
		next_cursor: null,
	}),
	listObjects: async (_source, _context, request) => ({
		items: [
			{ kind: 'prefix', name: 'daily/', key: `${request.prefix ?? ''}daily/` },
			{
				kind: 'object',
				name: 'events.jsonl',
				key: `${request.prefix ?? ''}events.jsonl`,
				size: 12,
				etag: '"etag"',
			},
		],
		next_cursor: request.cursor ?? null,
	}),
	searchObjects: async (_source, _context, request) => ({
		items: [
			{ kind: 'object', name: request.query, key: `${request.prefix ?? ''}${request.query}` },
		],
		next_cursor: request.cursor ?? null,
		scanned: 37,
		complete: request.cursor !== undefined,
	}),
	headObject: async (_source, _context, request) => ({
		...request,
		size: 12,
		etag: '"etag"',
		content_type: 'text/plain',
		checksums: [],
		metadata: {},
		tags_available: false,
	}),
	listVersions: async (_source, _context, request) => ({
		items: [
			{
				bucket: request.bucket,
				key: request.key,
				version_id: 'v1',
				kind: 'version',
				is_latest: true,
				size: 12,
			},
		],
		next_cursor: null,
	}),
	previewObject: async () => ({
		kind: 'text',
		format: 'text',
		text: 'hello object',
		truncated: false,
		bytes_read: 12,
		total_bytes: 12,
		warnings: [],
	}),
	openObject: async (_source, _context, request) => ({
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('hello object'));
				controller.close();
			},
		}),
		status: request.range ? 206 : 200,
		content_type: 'text/plain',
		content_length: 12,
		total_size: 12,
		...(request.range ? { content_range: 'bytes 0-4/12' } : {}),
		etag: '"etag"',
		close: () => {},
	}),
};

function browserDeps(
	bucket: MemoryBucket,
	dataPreview?: DataPreviewService,
	dataQuery?: DataQueryService,
	options: { probe?: IntegrationProbe; testClickhouse?: boolean } = {},
) {
	const registry = new IntegrationRegistry();
	registry.register(browsyKind);
	registry.register(sandboxBrowsyKind);
	if (options.testClickhouse) registry.register({ ...browsyKind, kind: 'clickhouse' });
	for (const def of defaultRegistry().list()) {
		if (!options.testClickhouse || def.kind !== 'clickhouse') registry.register(def);
	}
	const probe = options.probe ?? {
		fetch: () => Promise.reject(new Error('no network in tests')),
	};
	const storeOptions = {
		bucket,
		registry,
		codec,
		probe,
		browseProbe: probe,
		objectBrowsers: { s3: objectBrowser },
		dataPreview,
		dataQuery,
	};
	return {
		integrations: new ProjectIntegrationsStore(storeOptions),
		orgIntegrations: new OrgIntegrationsStore(storeOptions),
		dataBrowser: {
			preview: false,
			query: false,
			objectBrowser: {
				allowServerAmbientCredentials: false,
				maxConcurrentDownloads: 16,
				maxConcurrentDownloadsPerUser: 2,
				downloadTimeoutMs: Millis.of(60_000),
			},
		},
	};
}

function queryService(
	executions: DataQueryExecution[],
	execute: () => Promise<{
		columns: string[];
		rows: unknown[][];
		truncated: boolean;
	}> = async () => ({
		columns: ['value'],
		rows: [[1]],
		truncated: false,
	}),
): DataQueryService {
	return new DataQueryService({
		executorFactory: {
			create: async () => ({
				runtime: 'worker',
				execute: async (execution) => {
					executions.push(execution);
					return execute();
				},
				terminate: () => {},
			}),
		},
		maxConcurrent: 1,
		maxConcurrentPerUser: 1,
		maxRows: 10,
		maxBytes: 4096,
		executionTimeoutMs: 1000,
	});
}

function previewService(
	preview: (program: PythonPreviewProgram) => Promise<TablePreview>,
	available: () => boolean = () => true,
): DataPreviewService {
	return new DataPreviewService({
		maxConcurrent: 4,
		maxConcurrentPerUser: 1,
		sandbox: {
			available,
			check: async () => {},
			preview,
			close: async () => {},
		},
	});
}

describe('Data browser routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];
	let deps: ReturnType<typeof browserDeps>;

	beforeEach(async () => {
		clearObjectCredentialCacheForTests();
		clearIntegrationBrowseStateForTests();
		bucket = await createInitializedBucket();
		deps = browserDeps(bucket);
		request = createTestApi({ bucket, userId: ACTOR, deps }).request;
	});

	async function createProject() {
		const data = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'P', description: 'd' }),
			201,
		);
		return data.id;
	}

	async function createBrowsable(pid: string, name = 'lake') {
		return expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'browsy',
				name,
				config: { token: 'tok' },
			}),
			201,
		);
	}

	async function createObjectStore(pid: string, name = 'objects') {
		return expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 's3',
				name,
				config: {
					bucket: 'lake',
					auth: {
						method: 'static',
						access_key_id: 'access',
						secret_access_key: 'secret',
					},
				},
			}),
			201,
		);
	}

	it('404s when the data browser is not wired', async () => {
		const { dataBrowser: _unused, ...withoutBrowser } = deps;
		const bare = createTestApi({ bucket, userId: ACTOR, deps: withoutBrowser }).request;
		const pid = await createProject();
		const created = await createBrowsable(pid);
		await expectError(
			await bare('GET', `/projects/${pid}/integrations/${created.id}/browse`),
			404,
			'NOT_FOUND',
		);
	});

	it('reports the instance capability, with preview off', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/browse`),
		);
		expect(capability).toEqual({
			surfaces: {
				tables: { available: true, preview: false },
				query: {
					available: false,
					reason: 'Run SQL is not enabled on this deployment.',
				},
			},
		});

		const closed = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'browsy',
				name: 'closed',
				config: { mode: 'sandbox_only', token: 'tok' },
			}),
			201,
		);
		const closedCapability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${closed.id}/browse`),
		);
		expect(closedCapability).toEqual({
			surfaces: {
				tables: { available: false, preview: false, reason: 'sandbox only' },
				query: {
					available: false,
					reason: 'Run SQL is not enabled on this deployment.',
				},
			},
		});
	});

	it('advertises object-only instances with surface-specific capabilities', async () => {
		const pid = await createProject();
		const created = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 's3',
				name: 'objects',
				config: {
					bucket: 'lake',
					auth: {
						method: 'static',
						access_key_id: 'access',
						secret_access_key: 'secret',
					},
				},
			}),
			201,
		);
		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/browse`),
		);
		expect(capability).toEqual({
			surfaces: {
				objects: {
					provider: 's3',
					root_kind: 'bucket',
					uri_scheme: 's3',
					available: true,
					preview: true,
					download: true,
					search: 'bounded-key-name',
					versions: true,
					preview_formats: ['csv', 'text', 'png'],
				},
			},
		});
	});

	it('lists buckets and opaque Unicode object keys, then returns detail and versions', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse/objects`;

		expect(await expectOk(await request('GET', `${base}/buckets`))).toEqual({
			items: [{ name: 'lake', configured: true }],
			next_cursor: null,
		});
		const prefix = 'space and %/日本語/?#';
		const listed = await expectOk<{ items: { key: string }[] }>(
			await request('GET', `${base}?bucket=lake&prefix=${encodeURIComponent(prefix)}`),
		);
		expect(listed.items.map((item) => item.key)).toEqual([
			`${prefix}daily/`,
			`${prefix}events.jsonl`,
		]);

		const key = `${prefix}events.jsonl`;
		const detail = await expectOk<{ key: string; snippet?: string }>(
			await request('GET', `${base}/head?bucket=lake&key=${encodeURIComponent(key)}`),
		);
		expect(detail).toMatchObject({ key, snippet: expect.stringContaining('s3://lake/') });
		const versions = await expectOk<{ items: { version_id?: string }[] }>(
			await request('GET', `${base}/versions?bucket=lake&key=${encodeURIComponent(key)}`),
		);
		expect(versions.items).toEqual([expect.objectContaining({ version_id: 'v1' })]);
	});

	it('reports low-cardinality object metadata cache outcomes', async () => {
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		(deps as typeof deps & { metrics: typeof metrics }).metrics = metrics;
		request = createTestApi({ bucket, userId: ACTOR, deps }).request;
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/objects?bucket=lake`;

		await expectOk(await request('GET', url));
		await expectOk(await request('GET', url));
		await expectOk(await request('GET', `${url}&fresh=true`));

		expect(metrics.increment).toHaveBeenCalledWith('object_browser.cache.requests', 1, {
			operation: 'list_objects',
			outcome: 'miss',
		});
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.cache.requests', 1, {
			operation: 'list_objects',
			outcome: 'hit',
		});
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.cache.requests', 1, {
			operation: 'list_objects',
			outcome: 'refresh',
		});
		for (const call of metrics.increment.mock.calls) {
			expect(JSON.stringify(call[2])).not.toMatch(/lake|proj-|intg-|user-/);
		}
	});

	it('reports bounded search progress and rejects inconsistent filters', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse/objects/search`;
		const first = await expectOk<{
			items: { key: string }[];
			scanned: number;
			complete: boolean;
		}>(await request('GET', `${base}?bucket=lake&prefix=events%2F&query=needle`));
		expect(first).toMatchObject({
			items: [{ key: 'events/needle' }],
			scanned: 37,
			complete: false,
		});
		await expectError(await request('GET', `${base}?bucket=lake&query=x`), 422, 'VALIDATION_ERROR');
		await expectError(
			await request('GET', `${base}?bucket=lake&query=needle&min_size=10&max_size=1`),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request(
				'GET',
				`${base}?bucket=lake&query=needle&modified_after=2026-08-12T00%3A00%3A00Z&modified_before=2026-08-11T00%3A00%3A00Z`,
			),
			422,
			'VALIDATION_ERROR',
		);
		await expectOk(
			await request(
				'GET',
				`${base}?bucket=lake&query=needle&modified_after=2026-08-12T00%3A00%3A00.1Z&modified_before=2026-08-12T00%3A00%3A00.100Z`,
			),
		);
	});

	it('enforces object search and preview budgets independently', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const search = `/projects/${pid}/integrations/${created.id}/browse/objects/search?bucket=lake&query=needle`;
		for (let index = 0; index < 5; index += 1) await expectOk(await request('GET', search));
		await expectError(await request('GET', search), 429, 'RESOURCE_EXHAUSTED');

		const preview = `/projects/${pid}/integrations/${created.id}/browse/objects/preview`;
		for (let index = 0; index < 10; index += 1) {
			await expectOk(
				await request('POST', preview, { bucket: 'lake', key: 'events.jsonl', limit: 5 }),
			);
		}
		await expectError(
			await request('POST', preview, { bucket: 'lake', key: 'events.jsonl', limit: 5 }),
			429,
			'RESOURCE_EXHAUSTED',
		);
	});

	it('rejects operations disabled by the object capability before calling the adapter', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		vi.spyOn(objectBrowser, 'capability').mockReturnValue({
			provider: 's3',
			root_kind: 'bucket',
			uri_scheme: 's3',
			available: true,
			preview: false,
			download: false,
			search: 'none',
			versions: false,
			preview_formats: [],
		});
		const search = vi.spyOn(objectBrowser, 'searchObjects');
		const versions = vi.spyOn(objectBrowser, 'listVersions');
		const preview = vi.spyOn(objectBrowser, 'previewObject');
		const open = vi.spyOn(objectBrowser, 'openObject');
		const base = `/projects/${pid}/integrations/${created.id}/browse/objects`;
		await expectError(
			await request('GET', `${base}/search?bucket=lake&query=needle`),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request('GET', `${base}/versions?bucket=lake&key=events.jsonl`),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request('POST', `${base}/preview`, { bucket: 'lake', key: 'events.jsonl' }),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await request('GET', `${base}/content?bucket=lake&key=events.jsonl`),
			404,
			'NOT_FOUND',
		);
		expect(search).not.toHaveBeenCalled();
		expect(versions).not.toHaveBeenCalled();
		expect(preview).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});

	it('previews and streams object content with audits, range headers, and safe filenames', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse/objects`;
		const key = 'reports/evil\r\n";name.txt';
		const previewResponse = await request('POST', `${base}/preview`, {
			bucket: 'lake',
			key,
			limit: 5,
		});
		expect(previewResponse.headers.get('cache-control')).toBe('no-store');
		expect(await expectOk(previewResponse)).toMatchObject({
			kind: 'text',
			text: 'hello object',
		});

		const content = await request(
			'GET',
			`${base}/content?bucket=lake&key=${encodeURIComponent(key)}&etag=${encodeURIComponent('"etag"')}`,
			undefined,
			{ Range: 'bytes=0-4' },
		);
		expect(content.status).toBe(206);
		expect(content.headers.get('cache-control')).toBe('private, no-store');
		expect(content.headers.get('content-range')).toBe('bytes 0-4/12');
		expect(content.headers.get('content-type')).toBe('application/octet-stream');
		expect(content.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
		expect(await content.text()).toBe('hello object');

		const events = await expectOk<{ event: string; key?: string }[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: 'integration.object.preview', key }),
				expect.objectContaining({ event: 'integration.object.download', key }),
			]),
		);
	});

	it('does not cache object details that may contain tags', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/objects/head?bucket=lake&key=events.jsonl`;
		let detailCalls = 0;
		const original = deps.integrations.browseObjectDetail.bind(deps.integrations);
		deps.integrations.browseObjectDetail = (async (...args: Parameters<typeof original>) => {
			detailCalls += 1;
			return original(...args);
		}) as typeof original;

		await expectOk(await request('GET', url));
		await expectOk(await request('GET', url));
		expect(detailCalls).toBe(2);
	});

	it('does not run streaming downloads through response ETag middleware', async () => {
		vi.spyOn(objectBrowser, 'openObject').mockResolvedValueOnce({
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('stream'));
					controller.close();
				},
			}),
			status: 200,
			content_type: 'text/plain',
			content_length: 6,
			total_size: 6,
			close: () => {},
		});
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const response = await request(
			'GET',
			`/projects/${pid}/integrations/${created.id}/browse/objects/content?bucket=lake&key=stream.txt`,
		);

		expect(response.headers.get('etag')).toBeNull();
		expect(await response.text()).toBe('stream');
	});

	it('rejects excess concurrent downloads and releases the permit after cancellation', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		deps.dataBrowser.objectBrowser.maxConcurrentDownloads = 1;
		deps.dataBrowser.objectBrowser.maxConcurrentDownloadsPerUser = 1;
		const url = `/projects/${pid}/integrations/${created.id}/browse/objects/content?bucket=lake&key=events.jsonl`;

		const first = await request('GET', url);
		expect(first.status).toBe(200);
		await expectError(await request('GET', url), 429, 'RESOURCE_EXHAUSTED');
		await first.body?.cancel();

		const afterCancel = await request('GET', url);
		expect(afterCancel.status).toBe(200);
		expect(await afterCancel.text()).toBe('hello object');
	});

	it('reports download timeouts separately from downstream cancellations', async () => {
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		(deps as typeof deps & { metrics: typeof metrics }).metrics = metrics;
		request = createTestApi({ bucket, userId: ACTOR, deps }).request;
		const canceledWith = vi.fn();
		vi.spyOn(objectBrowser, 'openObject').mockResolvedValueOnce({
			body: new ReadableStream({ cancel: canceledWith }),
			status: 200,
			content_type: 'text/plain',
			content_length: 12,
			total_size: 12,
			close: () => {},
		});
		const pid = await createProject();
		const created = await createObjectStore(pid);
		deps.dataBrowser.objectBrowser.downloadTimeoutMs = Millis.of(5);
		const url = `/projects/${pid}/integrations/${created.id}/browse/objects/content?bucket=lake&key=events.jsonl`;

		const timedOut = await request('GET', url);
		await vi.waitFor(() =>
			expect(metrics.increment).toHaveBeenCalledWith('object_browser.download.timeouts', 1, {
				operation: 'download',
			}),
		);
		await vi.waitFor(() =>
			expect(canceledWith).toHaveBeenCalledWith(expect.objectContaining({ name: 'TimeoutError' })),
		);
		expect(metrics.increment).not.toHaveBeenCalledWith('object_browser.download.cancellations', 1, {
			operation: 'download',
		});
		await timedOut.body?.cancel().catch(() => {});

		deps.dataBrowser.objectBrowser.downloadTimeoutMs = Millis.of(60_000);
		const canceled = await request('GET', url);
		await canceled.body?.cancel();
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.download.cancellations', 1, {
			operation: 'download',
		});
	});

	it('rejects malformed ranges and overlong keys before opening content', async () => {
		const pid = await createProject();
		const created = await createObjectStore(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse/objects`;
		for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=-']) {
			await expectError(
				await request('GET', `${base}/content?bucket=lake&key=a.txt`, undefined, {
					Range: range,
				}),
				416,
				'BAD_REQUEST',
			);
		}
		const oversized = encodeURIComponent('😀'.repeat(300));
		await expectError(
			await request('GET', `${base}/head?bucket=lake&key=${oversized}`),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('previews rows on demand with no-store and appends an audit event', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		deps.dataBrowser.preview = true;

		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/browse`),
		);
		expect(capability).toEqual({
			surfaces: {
				tables: { available: true, preview: true },
				query: {
					available: false,
					reason: 'Run SQL is not enabled on this deployment.',
				},
			},
		});

		const response = await request(
			'POST',
			`/projects/${pid}/integrations/${created.id}/browse/preview`,
			{ namespace: ['sales'], table: 'orders', limit: 7 },
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await expectOk(response)).toEqual({
			columns: ['qualified', 'limit'],
			rows: [['sales.orders', 7]],
		});

		const events = await expectOk<{ event: string; table?: string }[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events).toContainEqual(expect.objectContaining({ event: 'integration.preview' }));
	});

	it('keeps the query route declared but returns 404 while its runtime gate is off', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);

		await expectError(
			await request('POST', `/projects/${pid}/integrations/${created.id}/browse/query`, {
				sql: 'select 1',
			}),
			404,
			'NOT_FOUND',
		);
	});

	it('runs bounded SQL through the isolated service and audits without SQL text', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const executions: DataQueryExecution[] = [];
		const queryDeps = browserDeps(bucket, undefined, queryService(executions));
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;
		const sql = "select 'audit-secret-must-not-leak'";

		const response = await query(
			'POST',
			`/projects/${pid}/integrations/${created.id}/browse/query`,
			{ sql },
		);

		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await expectOk(response)).toEqual({
			columns: ['value'],
			rows: [[1]],
			truncated: false,
			execution_ms: expect.any(Number),
		});
		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({
			sql,
			accessMode: 'read-only',
			connection: {
				integration: { id: created.id, name: 'lake', kind: 'browsy', version: 1 },
			},
		});
		const connection = executions[0]?.connection;
		expect(Object.isFrozen(connection)).toBe(true);
		expect(Object.isFrozen(connection?.files)).toBe(true);
		expect(Object.isFrozen(connection?.files[0])).toBe(true);
		expect(Object.isFrozen(connection?.vars)).toBe(true);
		expect(Object.isFrozen(connection?.integration)).toBe(true);

		const eventsResponse = await query('GET', `/projects/${pid}/events`);
		const eventsText = await eventsResponse.text();
		expect(eventsText).toContain('integration.query');
		expect(eventsText).not.toContain('audit-secret-must-not-leak');
	});

	it('keeps Run SQL unavailable unless its independent gate and executor are both present', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/query`;
		for (let index = 0; index < 6; index++) {
			await expectError(await request('POST', url, { sql: 'select 1' }), 404, 'NOT_FOUND');
		}

		deps.dataBrowser.query = true;
		await expectError(await request('POST', url, { sql: 'select 1' }), 404, 'NOT_FOUND');
	});

	it('rejects empty and oversized UTF-8 SQL before invoking the executor', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const executions: DataQueryExecution[] = [];
		const queryDeps = browserDeps(bucket, undefined, queryService(executions));
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;
		const url = `/projects/${pid}/integrations/${created.id}/browse/query`;

		await expectError(await query('POST', url, { sql: '   ' }), 422, 'VALIDATION_ERROR');
		await expectError(
			await query('POST', url, { sql: 'é'.repeat(20_000) }),
			422,
			'VALIDATION_ERROR',
		);
		expect(executions).toHaveLength(0);
	});

	it('caches and coalesces bounded query-schema traversal', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const queryDeps = browserDeps(bucket, undefined, queryService([]));
		queryDeps.dataBrowser.query = true;
		const browseNamespaces = vi.spyOn(queryDeps.integrations, 'browseNamespaces');
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;
		const url = `/projects/${pid}/integrations/${created.id}/browse/query/schema`;

		const [first, coalesced] = await Promise.all([query('GET', url), query('GET', url)]);
		await expectOk(first);
		await expectOk(coalesced);
		const callsAfterMiss = browseNamespaces.mock.calls.length;
		expect(callsAfterMiss).toBeGreaterThan(0);
		await expectOk(await query('GET', url));
		expect(browseNamespaces).toHaveBeenCalledTimes(callsAfterMiss);
	});

	it('reports table truncation when namespace traversal reaches its cap', async () => {
		const pid = await createProject();
		const created = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'browsy',
				name: 'many',
				config: { token: 'many-namespaces' },
			}),
			201,
		);
		const queryDeps = browserDeps(bucket, undefined, queryService([]));
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;

		const schema = await expectOk<{ truncated: { tables: boolean } }>(
			await query('GET', `/projects/${pid}/integrations/${created.id}/browse/query/schema`),
		);
		expect(schema.truncated.tables).toBe(true);
	});

	it('returns a truncated schema when traversal exhausts its work budget', async () => {
		const pid = await createProject();
		const created = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'browsy',
				name: 'deep',
				config: { token: 'schema-work-limit' },
			}),
			201,
		);
		const queryDeps = browserDeps(bucket, undefined, queryService([]));
		queryDeps.dataBrowser.query = true;
		const browseNamespaces = vi.spyOn(queryDeps.integrations, 'browseNamespaces');
		const browseTables = vi.spyOn(queryDeps.integrations, 'browseTables');
		const browseTableSchema = vi.spyOn(queryDeps.integrations, 'browseTableSchema');
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;

		const schema = await expectOk<{ tables: unknown[]; truncated: { tables: boolean } }>(
			await query('GET', `/projects/${pid}/integrations/${created.id}/browse/query/schema`),
		);

		expect(schema.tables).toEqual([]);
		expect(schema.truncated.tables).toBe(true);
		expect(browseNamespaces.mock.calls.length + browseTables.mock.calls.length).toBe(512);
		expect(browseTableSchema).not.toHaveBeenCalled();
	});

	it('preserves repeated-cursor truncation when the final table page reaches the cap', async () => {
		const pid = await createProject();
		const created = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'browsy',
				name: 'repeated-cursor',
				config: { token: 'repeated-table-cursor' },
			}),
			201,
		);
		const queryDeps = browserDeps(bucket, undefined, queryService([]));
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;

		const schema = await expectOk<{ tables: unknown[]; truncated: { tables: boolean } }>(
			await query('GET', `/projects/${pid}/integrations/${created.id}/browse/query/schema`),
		);

		expect(schema.tables).toHaveLength(128);
		expect(schema.truncated.tables).toBe(true);
	});

	it('rejects byte-oversized revise input before invoking managed AI', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const generateSql = vi.fn(async () => 'SELECT 1');
		const queryDeps = browserDeps(bucket, undefined, queryService([]));
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({
			bucket,
			userId: ACTOR,
			deps: { ...queryDeps, ai: { generateSql } as never },
		}).request;

		await expectError(
			await query('POST', `/projects/${pid}/integrations/${created.id}/browse/query/generate`, {
				mode: 'revise',
				instruction: 'Improve this',
				sql: 'é'.repeat(20_000),
			}),
			422,
			'VALIDATION_ERROR',
		);
		expect(generateSql).not.toHaveBeenCalled();
	});

	it('rejects multi-statement managed-AI output', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const generateSql = vi.fn(async () => 'SELECT 1; DELETE FROM orders');
		const queryDeps = browserDeps(bucket, undefined, queryService([]));
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({
			bucket,
			userId: ACTOR,
			deps: { ...queryDeps, ai: { generateSql } as never },
		}).request;

		await expectError(
			await query('POST', `/projects/${pid}/integrations/${created.id}/browse/query/generate`, {
				mode: 'generate',
				instruction: 'Show orders',
			}),
			422,
			'VALIDATION_ERROR',
		);
		expect(generateSql).toHaveBeenCalledOnce();
	});

	it('validates managed-AI output with the resolved integration SQL dialect', async () => {
		const pid = await createProject();
		const sql = "SELECT 'a\\';b'";
		const generateSql = vi.fn(async () => sql);
		const queryDeps = browserDeps(bucket, undefined, queryService([]), {
			testClickhouse: true,
		});
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({
			bucket,
			userId: ACTOR,
			deps: { ...queryDeps, ai: { generateSql } as never },
		}).request;
		const created = await expectOk<{ id: string }>(
			await query('POST', `/projects/${pid}/integrations`, {
				kind: 'clickhouse',
				name: 'warehouse',
				config: { token: 'tok' },
			}),
			201,
		);

		const generated = await expectOk<{ sql: string }>(
			await query('POST', `/projects/${pid}/integrations/${created.id}/browse/query/generate`, {
				mode: 'generate',
				instruction: 'Show a string literal',
			}),
		);
		expect(generated.sql).toBe(sql);
	});

	it('redacts executor failures and does not audit unsuccessful SQL', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const executions: DataQueryExecution[] = [];
		const queryDeps = browserDeps(
			bucket,
			undefined,
			queryService(executions, async () => {
				throw new Error('password=hunter2');
			}),
		);
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;

		const response = await query(
			'POST',
			`/projects/${pid}/integrations/${created.id}/browse/query`,
			{ sql: 'select secret' },
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.text();
		expect(response.status).toBe(503);
		expect(body).not.toContain('hunter2');
		expect(executions).toHaveLength(1);

		const eventsResponse = await query('GET', `/projects/${pid}/events`);
		expect(await eventsResponse.text()).not.toContain('integration.query');
	});

	it('does not execute or audit SQL for a disabled integration', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		await expectOk(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, { enabled: false }),
		);
		const executions: DataQueryExecution[] = [];
		const queryDeps = browserDeps(bucket, undefined, queryService(executions));
		queryDeps.dataBrowser.query = true;
		const query = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;

		await expectError(
			await query('POST', `/projects/${pid}/integrations/${created.id}/browse/query`, {
				sql: 'select 1',
			}),
			404,
			'NOT_FOUND',
		);
		expect(executions).toHaveLength(0);
		const eventsResponse = await query('GET', `/projects/${pid}/events`);
		expect(await eventsResponse.text()).not.toContain('integration.query');
	});

	it('uses manager authorization and a rate limit separate from browsing', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const editor = uid('query-editor');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: editor, role: 'editor' }),
			201,
		);
		const executions: DataQueryExecution[] = [];
		const queryDeps = browserDeps(bucket, undefined, queryService(executions));
		const asEditor = createTestApi({ bucket, userId: editor, deps: queryDeps }).request;
		const asManager = createTestApi({ bucket, userId: ACTOR, deps: queryDeps }).request;
		const url = `/projects/${pid}/integrations/${created.id}/browse/query`;

		queryDeps.dataBrowser.query = true;
		await expectError(await asEditor('POST', url, { sql: 'select 1' }), 403, 'FORBIDDEN');
		for (let index = 0; index < 5; index++) {
			await expectOk(await asManager('POST', url, { sql: `select ${index}` }));
		}
		await expectError(await asManager('POST', url, { sql: 'select 6' }), 429, 'RESOURCE_EXHAUSTED');
	});

	it('passes the authenticated email as the native browse identity', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		deps.dataBrowser.preview = true;
		const original = deps.integrations.browseTablePreview.bind(deps.integrations);
		const captured: Parameters<typeof original>[6][] = [];
		deps.integrations.browseTablePreview = (async (...args: Parameters<typeof original>) => {
			captured.push(args[6]);
			return original(...args);
		}) as typeof original;

		await expectOk(
			await request('POST', `/projects/${pid}/integrations/${created.id}/browse/preview`, {
				namespace: ['sales'],
				table: 'orders',
			}),
		);
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({ limit: 20, query_user: `${ACTOR}@example.com` });
		expect(captured[0].signal).toBeInstanceOf(AbortSignal);
	});

	it('renders only the selected integration for the sandbox preview fallback', async () => {
		const pid = await createProject();
		await createBrowsable(pid, 'other');
		const selected = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'sandbox_browsy',
				name: 'selected',
				config: {},
			}),
			201,
		);
		const calls: unknown[] = [];
		const dataPreview = previewService(async (program) => {
			calls.push(program);
			return { columns: ['id'], rows: [[1]] };
		});
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...browserDeps(bucket, dataPreview),
				dataBrowser: { preview: true },
			},
		}).request;

		const response = await full(
			'POST',
			`/projects/${pid}/integrations/${selected.id}/browse/preview`,
			{ namespace: ['sales'], table: 'orders', limit: 3 },
		);
		expect(await expectOk(response)).toEqual({ columns: ['id'], rows: [[1]] });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			input: { integration_name: 'selected', user_id: ACTOR },
			render: { env: { SANDBOX_BROWSY: 'enabled' } },
			integration: { name: 'selected', kind: 'sandbox_browsy' },
		});
	});

	it('advertises a sandbox preview only after the runtime is ready', async () => {
		const pid = await createProject();
		const selected = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'sandbox_browsy',
				name: 'preview-gated',
				config: {},
			}),
			201,
		);
		let ready = false;
		const dataPreview = previewService(
			async () => ({ columns: [], rows: [] }),
			() => ready,
		);
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...browserDeps(bucket, dataPreview),
				dataBrowser: { preview: true },
			},
		}).request;
		const url = `/projects/${pid}/integrations/${selected.id}/browse`;

		expect(await expectOk(await full('GET', url))).toEqual({
			surfaces: { tables: { available: true, preview: false } },
		});
		ready = true;
		expect(await expectOk(await full('GET', url))).toEqual({
			surfaces: { tables: { available: true, preview: true } },
		});
	});

	it('rechecks runtime preview support instead of rejecting a stale capability verdict', async () => {
		const pid = await createProject();
		const selected = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'sandbox_browsy',
				name: 'preview-recovered',
				config: {},
			}),
			201,
		);
		let availabilityChecks = 0;
		const dataPreview = previewService(
			async () => ({ columns: ['id'], rows: [[1]] }),
			() => ++availabilityChecks > 1,
		);
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...browserDeps(bucket, dataPreview),
				dataBrowser: { preview: true },
			},
		}).request;

		expect(
			await expectOk(
				await full('POST', `/projects/${pid}/integrations/${selected.id}/browse/preview`, {
					namespace: ['sales'],
					table: 'orders',
				}),
			),
		).toEqual({ columns: ['id'], rows: [[1]] });
		expect(availabilityChecks).toBeGreaterThanOrEqual(2);
	});

	it('injects project WIF credentials into sandbox previews', async () => {
		const pid = await createProject();
		await expectOk(await request('PATCH', `/projects/${pid}`, { federation: { enabled: true } }));
		const selected = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'sandbox_browsy',
				name: 'selected-wif',
				config: {},
			}),
			201,
		);
		const calls: PythonPreviewProgram[] = [];
		let credentialVars: Record<string, string> | undefined;
		const dataPreview = previewService(async (program) => {
			calls.push(program);
			credentialVars =
				typeof program.credentialVars === 'function'
					? await program.credentialVars()
					: program.credentialVars;
			return { columns: [], rows: [] };
		});
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...browserDeps(bucket, dataPreview),
				wif: {
					issuer: { mint: async () => 'jwt', jwks: async () => ({ keys: [] }) } as never,
					issuerUrl: 'https://hub.example.com',
					target: {
						broker: {
							exchange: async () => ({
								accessKeyId: 'temporary-key',
								secretAccessKey: 'temporary-secret',
								sessionToken: 'temporary-token',
							}),
						},
						storage: { region: 'us-east-1' },
						audience: 'storage',
					},
				},
				dataBrowser: { preview: true },
			},
		}).request;

		await expectOk(
			await full('POST', `/projects/${pid}/integrations/${selected.id}/browse/preview`, {
				namespace: ['sales'],
				table: 'orders',
			}),
		);
		expect(calls[0]?.credentialVars).toBeTypeOf('function');
		expect(credentialVars).toEqual({
			AWS_ACCESS_KEY_ID: 'temporary-key',
			AWS_SECRET_ACCESS_KEY: 'temporary-secret',
			AWS_SESSION_TOKEN: 'temporary-token',
			AWS_REGION: 'us-east-1',
		});
	});

	it('single-flights expiring WIF credentials for ambient object browsing', async () => {
		const pid = await createProject();
		await expectOk(await request('PATCH', `/projects/${pid}`, { federation: { enabled: true } }));
		const staticStore = await createObjectStore(pid, 'static-with-wif');
		const ambient = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 's3',
				name: 'ambient-objects',
				config: { bucket: 'lake', auth: { method: 'ambient' } },
			}),
			201,
		);
		let exchanges = 0;
		const wifApi = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...deps,
				wif: {
					issuer: { mint: async () => 'jwt', jwks: async () => ({ keys: [] }) } as never,
					issuerUrl: 'https://hub.example.com',
					target: {
						broker: {
							exchange: async () => {
								exchanges += 1;
								await new Promise((resolve) => setTimeout(resolve, 10));
								return {
									accessKeyId: 'temporary-key',
									secretAccessKey: 'temporary-secret',
									expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
								};
							},
						},
						storage: { region: 'us-east-1' },
						audience: 'storage',
					},
				},
			},
		}).request;
		await expectOk(await wifApi('GET', `/projects/${pid}/integrations/${staticStore.id}/browse`));
		expect(exchanges).toBe(0);
		const url = `/projects/${pid}/integrations/${ambient.id}/browse`;
		const responses = await Promise.all([wifApi('GET', url), wifApi('GET', url)]);
		const results = await Promise.all(
			responses.map((response) => expectOk<Record<string, unknown>>(response)),
		);
		expect(results).toHaveLength(2);
		expect(exchanges).toBe(1);
	});

	it('keeps ambient object browsing unavailable without WIF or explicit server opt-in', async () => {
		const pid = await createProject();
		const ambient = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 's3',
				name: 'ambient-denied',
				config: { bucket: 'lake', auth: { method: 'ambient' } },
			}),
			201,
		);
		const capability = await expectOk<{
			surfaces: { objects: { available: boolean; reason?: string } };
		}>(await request('GET', `/projects/${pid}/integrations/${ambient.id}/browse`));
		expect(capability.surfaces.objects).toMatchObject({
			available: false,
			reason: 'No object-store credentials are available.',
		});
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${ambient.id}/browse/objects/buckets`),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('does not fall through to ambient server credentials when WIF exchange fails', async () => {
		const pid = await createProject();
		await expectOk(await request('PATCH', `/projects/${pid}`, { federation: { enabled: true } }));
		const ambient = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 's3',
				name: 'federated-objects',
				config: { bucket: 'lake', auth: { method: 'ambient' } },
			}),
			201,
		);
		deps.dataBrowser.objectBrowser.allowServerAmbientCredentials = true;
		const federatedApi = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...deps,
				wif: {
					issuer: { mint: async () => 'jwt', jwks: async () => ({ keys: [] }) } as never,
					issuerUrl: 'https://hub.example.com',
					target: {
						broker: {
							exchange: async () => {
								throw new Error('broker unavailable');
							},
						},
						storage: { region: 'us-east-1' },
						audience: 'storage',
					},
				},
			},
		}).request;

		const capability = await expectOk<{
			surfaces: { objects: { available: boolean; reason?: string } };
		}>(await federatedApi('GET', `/projects/${pid}/integrations/${ambient.id}/browse`));
		expect(capability.surfaces.objects).toMatchObject({
			available: false,
			reason: 'No object-store credentials are available.',
		});
	});

	it('does not exchange project WIF credentials for native previews', async () => {
		const pid = await createProject();
		await expectOk(await request('PATCH', `/projects/${pid}`, { federation: { enabled: true } }));
		const selected = await createBrowsable(pid, 'native-wif');
		const mint = vi.fn(async () => 'jwt');
		const exchange = vi.fn(async () => ({
			accessKeyId: 'temporary-key',
			secretAccessKey: 'temporary-secret',
			sessionToken: 'temporary-token',
		}));
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...browserDeps(bucket),
				wif: {
					issuer: { mint, jwks: async () => ({ keys: [] }) } as never,
					issuerUrl: 'https://hub.example.com',
					target: {
						broker: { exchange },
						storage: { region: 'us-east-1' },
						audience: 'storage',
					},
				},
				dataBrowser: { preview: true },
			},
		}).request;

		expect(
			await expectOk(
				await full('POST', `/projects/${pid}/integrations/${selected.id}/browse/preview`, {
					namespace: ['sales'],
					table: 'orders',
				}),
			),
		).toEqual({ columns: ['qualified', 'limit'], rows: [['sales.orders', 20]] });
		expect(mint).not.toHaveBeenCalled();
		expect(exchange).not.toHaveBeenCalled();
	});
	it('editor can browse; viewer cannot', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const editor = uid('user_editor');
		const viewer = uid('user_viewer');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: editor, role: 'editor' }),
			201,
		);
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: viewer, role: 'viewer' }),
			201,
		);

		const asEditor = createTestApi({ bucket, userId: editor, deps }).request;
		const namespaces = await expectOk<{ items: string[][] }>(
			await asEditor('GET', `/projects/${pid}/integrations/${created.id}/browse/namespaces`),
		);
		expect(namespaces.items).toContainEqual(['sales', 'eu.central']);

		const asViewer = createTestApi({ bucket, userId: viewer, deps }).request;
		await expectError(
			await asViewer('GET', `/projects/${pid}/integrations/${created.id}/browse/namespaces`),
			403,
			'FORBIDDEN',
		);
		await expectError(
			await asViewer('GET', `/projects/${pid}/integrations/${created.id}/browse`),
			403,
			'FORBIDDEN',
		);
		const objectStore = await createObjectStore(pid, 'viewer-objects');
		await expectError(
			await asViewer(
				'GET',
				`/projects/${pid}/integrations/${objectStore.id}/browse/objects?bucket=lake`,
			),
			403,
			'FORBIDDEN',
		);
	});

	it('round-trips dotted namespace parts and cursors through the query params', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse`;

		const parent = encodeURIComponent(['a.b', 'c'].join(SEP));
		const namespaces = await expectOk<{ items: string[][]; next_cursor: string | null }>(
			await request('GET', `${base}/namespaces?parent=${parent}&cursor=page-2&limit=5`),
		);
		expect(namespaces.items).toContainEqual(['a.b', 'c']);
		expect(namespaces.next_cursor).toBe('page-2');

		const tables = await expectOk<{ items: string[] }>(
			await request('GET', `${base}/tables?namespace=${parent}`),
		);
		expect(tables.items).toEqual(['a.b|c']);

		const schema = await expectOk<Record<string, unknown>>(
			await request('GET', `${base}/schema?namespace=sales&table=orders`),
		);
		expect(schema).toEqual({
			columns: [{ name: 'orders_id', type: 'long', nullable: false }],
			snippet: 'load lake:sales.orders',
		});
	});

	it('422s an instance whose kind cannot browse, with the reason on the capability', async () => {
		const pid = await createProject();
		const pg = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'pg',
				config: { host: 'db.internal', database: 'analytics', username: 'svc', password: 'pw' },
			}),
			201,
		);
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${pg.id}/browse/tables?namespace=s`),
			422,
			'VALIDATION_ERROR',
		);
		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${pg.id}/browse`),
		);
		expect(capability).toEqual({ surfaces: {} });
	});

	it('serves repeat lookups from the cache and enforces the per-user budget', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const rateUser = uid('user_browse_rate');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: rateUser, role: 'editor' }),
			201,
		);
		const asRateUser = createTestApi({ bucket, userId: rateUser, deps }).request;
		const base = `/projects/${pid}/integrations/${created.id}/browse`;

		// The same lookup repeated is a cache hit and never exhausts the budget.
		for (let i = 0; i < 40; i++) {
			await expectOk(await asRateUser('GET', `${base}/tables?namespace=cached`));
		}

		// Distinct lookups are misses; the budget refuses within the minute.
		let limited = 0;
		for (let i = 0; i < 21; i++) {
			const res = await asRateUser('GET', `${base}/tables?namespace=ns-${i}`);
			if (res.status === 429) limited += 1;
		}
		expect(limited).toBeGreaterThan(0);
	});

	it('a warm cache entry stops serving once the instance is shadowed or disabled', async () => {
		const root = uid('user_cache_root');
		const rootApi = createTestApi({
			bucket,
			userId: root,
			deps: { ...deps, policy: { superAdmins: [root] } },
		});
		const orgInstance = await expectOk<{ id: string }>(
			await rootApi.request('POST', '/org/integrations', {
				kind: 'browsy',
				name: 'cached-lake',
				config: { token: 'org-tok' },
			}),
			201,
		);
		const pid = await createProject();
		const orgUrl = `/projects/${pid}/integrations/${orgInstance.id}/browse/tables?namespace=warm`;
		await expectOk(await request('GET', orgUrl));

		// Shadowing must take effect immediately, not after the TTL.
		await createBrowsable(pid, 'cached-lake');
		await expectError(await request('GET', orgUrl), 404, 'NOT_FOUND');

		const project = await createBrowsable(pid, 'own-lake');
		const projectUrl = `/projects/${pid}/integrations/${project.id}/browse/tables?namespace=warm`;
		await expectOk(await request('GET', projectUrl));
		await expectOk(
			await request('PATCH', `/projects/${pid}/integrations/${project.id}`, { enabled: false }),
		);
		await expectError(await request('GET', projectUrl), 422, 'VALIDATION_ERROR');
	});

	it('fresh=true bypasses the cache read but still refreshes the entry', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse`;

		// Wrap the store method to count how often the cache actually misses.
		let storeCalls = 0;
		const original = deps.integrations.browseTables.bind(deps.integrations);
		deps.integrations.browseTables = (async (...args: Parameters<typeof original>) => {
			storeCalls += 1;
			return original(...args);
		}) as typeof original;

		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check`));
		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check`));
		expect(storeCalls).toBe(1);

		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check&fresh=true`));
		expect(storeCalls).toBe(2);

		// The fresh result refreshed the cache: a plain lookup hits it again.
		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check`));
		expect(storeCalls).toBe(2);
	});

	// The schema response embeds the instance name in its snippet, and a rename
	// bumps only the head — never the config version.
	it('a rename invalidates warm schema responses', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/schema?namespace=sales&table=orders`;

		const before = await expectOk<{ snippet?: string }>(await request('GET', url));
		expect(before.snippet).toBe('load lake:sales.orders');

		await expectOk(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, { name: 'lagoon' }),
		);

		const after = await expectOk<{ snippet?: string }>(await request('GET', url));
		expect(after.snippet).toBe('load lagoon:sales.orders');
	});

	it('an unknown integration id answers 404 on every browse route', async () => {
		const pid = await createProject();
		const ghost = 'intg-7h2k9qm4xz7rp3w8';
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${ghost}/browse`),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${ghost}/browse/tables?namespace=s`),
			404,
			'NOT_FOUND',
		);
	});

	it('rejects malformed browse query params with 422', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse`;
		for (const bad of [
			`${base}/namespaces?limit=0`,
			`${base}/namespaces?limit=501`,
			`${base}/tables?namespace=`,
			`${base}/tables`,
			`${base}/tables?namespace=s&fresh=nah`,
			`${base}/schema?namespace=s`,
			// Empty identifier parts (bare/leading/trailing joiner) — no catalog
			// can hold them, so they must not spend an upstream request.
			`${base}/tables?namespace=%1F`,
			`${base}/tables?namespace=s%1F`,
			`${base}/namespaces?parent=%1Fs`,
		]) {
			await expectError(await request('GET', bad), 422, 'VALIDATION_ERROR');
		}
	});

	// Each caller still pays its own budget for the miss; only the upstream
	// probe traffic is shared.
	it('concurrent identical lookups share one upstream load', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/tables?namespace=fanin`;

		let storeCalls = 0;
		const original = deps.integrations.browseTables.bind(deps.integrations);
		deps.integrations.browseTables = (async (...args: Parameters<typeof original>) => {
			storeCalls += 1;
			// Hold the load open so the other requests arrive while it is in flight.
			await new Promise((resolve) => setTimeout(resolve, 20));
			return original(...args);
		}) as typeof original;

		const responses = await Promise.all([
			request('GET', url),
			request('GET', url),
			request('GET', url),
		]);
		for (const res of responses) expect(res.status).toBe(200);
		expect(storeCalls).toBe(1);
	});

	it('maps an upstream outage to 503 and never caches the failure', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/tables?namespace=boom`;

		let storeCalls = 0;
		const original = deps.integrations.browseTables.bind(deps.integrations);
		deps.integrations.browseTables = (async (...args: Parameters<typeof original>) => {
			storeCalls += 1;
			return original(...args);
		}) as typeof original;

		await expectError(await request('GET', url), 503, 'SERVICE_UNAVAILABLE');
		await expectError(await request('GET', url), 503, 'SERVICE_UNAVAILABLE');
		// Both requests reached the store: an outage is retried, not remembered.
		expect(storeCalls).toBe(2);
	});

	it('an org instance is browsable through the project until shadowed', async () => {
		const root = uid('user_browse_root');
		const rootApi = createTestApi({
			bucket,
			userId: root,
			deps: { ...deps, policy: { superAdmins: [root] } },
		});
		const orgInstance = await expectOk<{ id: string }>(
			await rootApi.request('POST', '/org/integrations', {
				kind: 'browsy',
				name: 'shared-lake',
				config: { token: 'org-tok' },
			}),
			201,
		);

		const pid = await createProject();
		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${orgInstance.id}/browse`),
		);
		expect(capability).toEqual({
			surfaces: {
				tables: { available: true, preview: false },
				query: {
					available: false,
					reason: 'Run SQL is not enabled on this deployment.',
				},
			},
		});

		await createBrowsable(pid, 'shared-lake');
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${orgInstance.id}/browse`),
			404,
			'NOT_FOUND',
		);
	});
});
