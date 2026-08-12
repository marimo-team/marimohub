import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from '@hono/zod-openapi';
import {
	AesGcmSecretCodec,
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
import type { ObjectBrowser } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import type { PythonPreviewProgram, TablePreview } from '@marimo-hub/core';
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
	browse: {
		available: (config) =>
			config.mode === 'open' ? { ok: true } : { ok: false, reason: 'sandbox only' },
		// Echo the inputs so route tests can assert round-trips.
		listNamespaces: async (_config, _probe, request) => ({
			items: [['sales', 'eu.central'], ...(request.parent ? [request.parent] : [])],
			next_cursor: request.cursor ?? 'next-token',
		}),
		listTables: async (_config, _probe, namespace) => {
			// Simulated outage, so route tests can exercise the failure path.
			if (namespace[0] === 'boom') throw new UnavailableError('The catalog answered HTTP 503.');
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

const objectBrowser: ObjectBrowser = {
	capability: (source, context) => {
		const available =
			source.auth.method === 'static' ||
			context.temporary_s3_credentials !== undefined ||
			context.allow_server_ambient;
		return {
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

function browserDeps(bucket: MemoryBucket, dataPreview?: DataPreviewService) {
	const registry = new IntegrationRegistry();
	registry.register(browsyKind);
	registry.register(sandboxBrowsyKind);
	for (const def of defaultRegistry().list()) registry.register(def);
	const stubProbe = { fetch: () => Promise.reject(new Error('no network in tests')) };
	const options = {
		bucket,
		registry,
		codec,
		probe: stubProbe,
		browseProbe: stubProbe,
		objectBrowsers: { s3: objectBrowser },
		dataPreview,
	};
	return {
		integrations: new ProjectIntegrationsStore(options),
		orgIntegrations: new OrgIntegrationsStore(options),
		dataBrowser: {
			preview: false,
			objectBrowser: {
				allowServerAmbientCredentials: false,
				maxConcurrentDownloads: 16,
				maxConcurrentDownloadsPerUser: 2,
				downloadTimeoutMs: Millis.of(60_000),
			},
		},
	};
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
			metadata: true,
			preview: false,
			surfaces: { tables: { available: true, preview: false } },
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
			metadata: false,
			preview: false,
			reason: 'sandbox only',
			surfaces: { tables: { available: false, preview: false, reason: 'sandbox only' } },
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
			metadata: false,
			preview: false,
			surfaces: {
				objects: {
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
			metadata: true,
			preview: true,
			surfaces: { tables: { available: true, preview: true } },
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

	it('passes the authenticated email as the native browse identity', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		deps.dataBrowser.preview = true;
		const captured: unknown[] = [];
		const original = deps.integrations.browseTablePreview.bind(deps.integrations);
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
		expect(captured).toEqual([{ limit: 20, query_user: `${ACTOR}@example.com` }]);
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
			metadata: true,
			preview: false,
			surfaces: { tables: { available: true, preview: false } },
		});
		ready = true;
		expect(await expectOk(await full('GET', url))).toEqual({
			metadata: true,
			preview: true,
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
		const calls: unknown[] = [];
		const dataPreview = previewService(async (program) => {
			calls.push(program);
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
		expect(calls[0]).toMatchObject({
			credentialVars: {
				AWS_ACCESS_KEY_ID: 'temporary-key',
				AWS_SECRET_ACCESS_KEY: 'temporary-secret',
				AWS_SESSION_TOKEN: 'temporary-token',
				AWS_REGION: 'us-east-1',
			},
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
		expect(capability).toMatchObject({
			metadata: false,
			reason: expect.stringContaining('does not support browsing'),
		});
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
			metadata: true,
			preview: false,
			surfaces: { tables: { available: true, preview: false } },
		});

		await createBrowsable(pid, 'shared-lake');
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${orgInstance.id}/browse`),
			404,
			'NOT_FOUND',
		);
	});
});
