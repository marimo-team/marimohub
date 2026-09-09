import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import type { BigQueryConnectionCapability, IntegrationProbe } from '@marimo-hub/core';
import { browseContract } from '@marimo-hub/core/testing/browse-contract';
import { BigQueryDatabaseBrowser } from './index';

let source: BigQueryConnectionCapability;
let publicKey: CryptoKey;
const fields = [
	{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
	{ name: 'amount', type: 'NUMERIC' },
	{ name: 'tags', type: 'STRING', mode: 'REPEATED' },
	{ name: 'record', type: 'RECORD', fields: [{ name: 'active', type: 'BOOLEAN' }] },
];
const metadata = { type: 'TABLE', schema: { fields } };
const data = {
	rows: [
		{
			f: [
				{ v: '9223372036854775807' },
				{ v: '123456789.012345678' },
				{ v: [{ v: 'one' }, { v: 'two' }] },
				{ v: { f: [{ v: 'true' }] } },
			],
		},
	],
};

beforeAll(async () => {
	const keys = await generateKeyPair('RS256', { extractable: true });
	publicKey = keys.publicKey;
	source = {
		provider: 'bigquery',
		project_id: 'example-project',
		credentials_json: JSON.stringify({
			type: 'service_account',
			client_email: 'reader@example.iam.gserviceaccount.com',
			private_key: await exportPKCS8(keys.privateKey),
			token_uri: 'https://oauth2.googleapis.com/token',
		}),
	};
});
afterEach(() => vi.useRealTimers());

function world(body: (url: URL) => unknown = () => ({}), status = 200) {
	const fetch = vi.fn<IntegrationProbe['fetch']>(async (url) => ({
		ok: status < 300,
		status,
		json: async () =>
			url === 'https://oauth2.googleapis.com/token'
				? { access_token: 'minted-token', expires_in: 3600 }
				: body(new URL(url)),
	}));
	const probe = { fetch, connect: vi.fn() } satisfies IntegrationProbe;
	return { fetch, probe, browser: new BigQueryDatabaseBrowser({ probe, mode: 'full' }) };
}

browseContract('BigQuery fixtures', () => {
	const { browser, probe } = world((url) => {
		if (url.pathname.endsWith('/datasets'))
			return { datasets: [{ datasetReference: { datasetId: 'sales' } }] };
		if (url.pathname.endsWith('/tables'))
			return { tables: [{ tableReference: { tableId: 'orders' } }] };
		if (url.pathname.endsWith('/data')) return data;
		return metadata;
	});
	return {
		config: source,
		probe,
		browse: {
			available: () => ({ ok: true }),
			snippet: () => '',
			listNamespaces: (config, _probe, request) => browser.listNamespaces(config, request),
			listTables: (config, _probe, namespace, request) =>
				browser.listTables(config, namespace, request),
			getTableSchema: (config, _probe, namespace, table, request) =>
				browser.getTableSchema(config, namespace, table, request),
			previewRows: (config, _probe, namespace, table, request) =>
				browser.previewRows(config, namespace, table, request),
		},
		setup: async () => ({
			hierarchy: 'flat',
			root: 'sales',
			children: [],
			grandchild: '',
			table: 'orders',
			expectedColumns: [
				{ name: 'id', type: 'INTEGER', nullable: false },
				{ name: 'amount', type: 'NUMERIC', nullable: true },
				{ name: 'tags', type: 'ARRAY<STRING>', nullable: false },
				{ name: 'record', type: 'STRUCT<active BOOLEAN>', nullable: true },
			],
			expectedPreview: {
				columns: ['id', 'amount', 'tags', 'record'],
				rows: [['9223372036854775807', '123456789.012345678', ['one', 'two'], { active: true }]],
			},
		}),
	};
});

describe('BigQuery browser', () => {
	it('signs a read-only JWT for the fixed token endpoint and tests an empty project', async () => {
		const { browser, fetch } = world(() => ({ datasets: [] }));
		expect(await browser.testConnection(source)).toMatchObject({ ok: true });
		const params = new URLSearchParams(fetch.mock.calls[0][1]?.body);
		const { payload } = await jwtVerify(params.get('assertion')!, publicKey, {
			audience: 'https://oauth2.googleapis.com/token',
		});
		expect(payload.scope).toBe('https://www.googleapis.com/auth/bigquery.readonly');
		expect(payload.iss).toBe('reader@example.iam.gserviceaccount.com');
		expect(fetch.mock.calls[1][1]?.headers?.Authorization).toBe('Bearer minted-token');
		expect(new URL(fetch.mock.calls[1][0]).searchParams.get('maxResults')).toBe('1');
	});

	it('checks the default dataset without restricting discovery to it', async () => {
		const { browser, fetch } = world((url) =>
			url.pathname.endsWith('/datasets')
				? { datasets: [{ datasetReference: { datasetId: 'other' } }] }
				: { datasetReference: { datasetId: 'sales' } },
		);
		const configured = { ...source, dataset: 'sales' };
		expect(await browser.testConnection(configured)).toMatchObject({ ok: true });
		expect(await browser.listNamespaces(configured, { limit: 10 })).toEqual({
			items: [['other']],
			next_cursor: null,
		});
		expect(fetch.mock.calls[1][0]).toContain('/datasets/sales');
	});

	it('preserves empty pages, forwards opaque tokens, and rejects repeated tokens', async () => {
		const { browser, fetch } = world(() => ({ tables: [], nextPageToken: 'continue' }));
		expect(await browser.listTables(source, ['sales'], { limit: 1 })).toEqual({
			items: [],
			next_cursor: 'continue',
		});
		await expect(
			browser.listTables(source, ['sales'], { limit: 1, cursor: 'continue' }),
		).rejects.toThrow('non-advancing');
		expect(new URL(fetch.mock.calls[2][0]).searchParams.get('pageToken')).toBe('continue');
	});

	it('preserves exact numbers, nested records, and repeated values', async () => {
		const { browser, fetch } = world((url) => (url.pathname.endsWith('/data') ? data : metadata));
		const preview = await browser.previewRows(source, ['sales'], 'orders', { limit: 1 });
		expect(preview.rows).toEqual([
			['9223372036854775807', '123456789.012345678', ['one', 'two'], { active: true }],
		]);
		expect(new URL(fetch.mock.calls[2][0]).searchParams.get('maxResults')).toBe('1');
		expect(
			fetch.mock.calls.some(([url]) => url.includes('/queries') || url.includes('/jobs')),
		).toBe(false);
	});

	it('maps comments and partition metadata', async () => {
		const { browser } = world(() => ({
			...metadata,
			rangePartitioning: { field: 'id' },
			schema: {
				fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED', description: 'Identifier' }],
			},
		}));
		expect(await browser.getTableSchema(source, ['sales'], 'orders')).toEqual({
			columns: [{ name: 'id', type: 'INTEGER', nullable: false, comment: 'Identifier' }],
			partitioning: ['id'],
		});
	});

	it.each(['VIEW', 'EXTERNAL', 'MATERIALIZED_VIEW'])(
		'does not execute queries for %s previews',
		async (type) => {
			const { browser, fetch } = world(() => ({ type }));
			await expect(browser.previewRows(source, ['sales'], 'view', { limit: 20 })).rejects.toThrow(
				'notebook',
			);
			expect(fetch).toHaveBeenCalledTimes(2);
		},
	);

	it('disallows previews in metadata mode before resolving credentials', async () => {
		const { probe, fetch } = world();
		const browser = new BigQueryDatabaseBrowser({ probe, mode: 'metadata' });
		await expect(browser.previewRows(source, ['sales'], 'orders', { limit: 20 })).rejects.toThrow(
			'full',
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(['invalid JSON', JSON.stringify({ type: 'authorized_user' })])(
		'rejects malformed credentials',
		async (credentials_json) => {
			const { browser, fetch } = world();
			expect(await browser.testConnection({ ...source, credentials_json })).toMatchObject({
				ok: false,
				details: expect.stringContaining('credential is invalid'),
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it('refuses credential-supplied token endpoints', async () => {
		const { browser, fetch } = world();
		const credentials_json = JSON.stringify({
			...(JSON.parse(source.credentials_json) as Record<string, unknown>),
			token_uri: 'https://elsewhere.example/token',
		});
		expect(await browser.testConnection({ ...source, credentials_json })).toMatchObject({
			ok: false,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([401, 403, 404, 500])(
		'does not expose provider response bodies for HTTP %s',
		async (status) => {
			const { browser, fetch } = world(() => ({ message: 'minted-token secret-material' }));
			fetch.mockImplementation(async (url) => ({
				ok: url.endsWith('/token'),
				status: url.endsWith('/token') ? 200 : status,
				json: async () =>
					url.endsWith('/token')
						? { access_token: 'minted-token', expires_in: 3600 }
						: { message: 'minted-token secret-material' },
			}));
			const result = await browser.testConnection(source);
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toMatch(/minted-token|secret-material/);
		},
	);

	it('bounds a stalled authentication request and rejects pre-canceled requests', async () => {
		const { probe, fetch } = world();
		fetch.mockImplementation(() => new Promise(() => {}));
		const browser = new BigQueryDatabaseBrowser({ probe, mode: 'full', metadataTimeoutMs: 20 });
		await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow('timed out');
		const controller = new AbortController();
		controller.abort();
		await expect(
			browser.listNamespaces(source, { limit: 1, signal: controller.signal }),
		).rejects.toThrow('canceled');
	});

	it('uses a separate probe budget for connection tests', async () => {
		const testWorld = world(() => ({ datasets: [] }));
		const browseWorld = world(() => ({ datasets: [] }));
		const browser = new BigQueryDatabaseBrowser({
			probe: browseWorld.probe,
			testProbe: testWorld.probe,
			mode: 'metadata',
		});
		await browser.testConnection(source);
		expect(testWorld.fetch).toHaveBeenCalledTimes(2);
		expect(browseWorld.fetch).not.toHaveBeenCalled();
	});
});

describe('BigQuery failure boundaries', () => {
	it.each([{}, { access_token: '' }, { access_token: 'secret\r\nheader' }])(
		'rejects malformed token responses before accessing metadata: %j',
		async (response) => {
			const { browser, fetch } = world();
			fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => response });
			await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow(
				'BigQuery authentication failed. Check the service-account credentials.',
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it('rejects an invalid private key without making a network request', async () => {
		const { browser, fetch } = world();
		const credentials_json = JSON.stringify({
			...(JSON.parse(source.credentials_json) as Record<string, unknown>),
			private_key: 'sensitive-invalid-key',
		});
		await expect(
			browser.listNamespaces({ ...source, credentials_json }, { limit: 1 }),
		).rejects.toThrow('BigQuery authentication failed. Check the service-account credentials.');
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([401, 403])('stops after an OAuth HTTP %s rejection', async (status) => {
		const { browser, fetch } = world(() => ({ message: 'sensitive-token' }), status);
		await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow(
			'BigQuery authentication failed. Check the service-account credentials.',
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('reports revoked row access even when metadata access succeeds', async () => {
		const { browser, fetch } = world(() => metadata);
		fetch.mockImplementation(async (url) => ({
			ok: !url.endsWith('/data?maxResults=1'),
			status: url.endsWith('/data?maxResults=1') ? 403 : 200,
			json: async () =>
				url.endsWith('/token') ? { access_token: 'minted-token', expires_in: 3600 } : metadata,
		}));
		await expect(browser.previewRows(source, ['sales'], 'orders', { limit: 1 })).rejects.toThrow(
			'BigQuery access was denied.',
		);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it.each([
		{ datasets: [{ datasetReference: {} }] },
		{ datasets: 'sensitive-provider-value' },
		{ nextPageToken: 123 },
	])('rejects malformed dataset pages: %j', async (response) => {
		const { browser } = world(() => response);
		await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow(
			'BigQuery returned invalid metadata or row data.',
		);
	});

	it('rejects a provider page that exceeds the requested limit', async () => {
		const { browser } = world(() => ({
			datasets: ['first', 'second'].map((datasetId) => ({ datasetReference: { datasetId } })),
		}));
		await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow('page limit');
	});

	it('forwards opaque dataset cursors without turning them into query parameters', async () => {
		const cursor = 'next+/=&maxResults=999#fragment';
		const { browser, fetch } = world(() => ({ datasets: [], nextPageToken: cursor }));
		expect(await browser.listNamespaces(source, { limit: 1 })).toEqual({
			items: [],
			next_cursor: cursor,
		});
		await expect(browser.listNamespaces(source, { limit: 1, cursor })).rejects.toThrow(
			'non-advancing',
		);
		const url = new URL(fetch.mock.calls[2][0]);
		expect(url.searchParams.get('pageToken')).toBe(cursor);
		expect(url.searchParams.get('maxResults')).toBe('1');
		expect(url.hash).toBe('');
	});

	it.each([0, -1, 1.5, 1001, Number.NaN])(
		'rejects invalid preview limit %s before authentication',
		async (limit) => {
			const { browser, fetch } = world();
			await expect(browser.previewRows(source, ['sales'], 'orders', { limit })).rejects.toThrow(
				'row limit',
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it('bounds returned rows even when the provider ignores maxResults', async () => {
		const { browser } = world((url) =>
			url.pathname.endsWith('/data')
				? { rows: [data.rows[0], data.rows[0]], pageToken: 'more' }
				: metadata,
		);
		expect(
			(await browser.previewRows(source, ['sales'], 'orders', { limit: 1 })).rows,
		).toHaveLength(1);
	});

	it('enforces the sample limit in UTF-8 bytes', async () => {
		const result = { columns: ['text'], rows: [['雪']] };
		const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
		const { probe } = world((url) =>
			url.pathname.endsWith('/data')
				? { rows: [{ f: [{ v: '雪' }] }] }
				: { type: 'TABLE', schema: { fields: [{ name: 'text', type: 'STRING' }] } },
		);
		const exact = new BigQueryDatabaseBrowser({ probe, mode: 'full', previewMaxBytes: bytes });
		expect(await exact.previewRows(source, ['sales'], 'orders', { limit: 1 })).toEqual(result);
		const smaller = new BigQueryDatabaseBrowser({
			probe,
			mode: 'full',
			previewMaxBytes: bytes - 1,
		});
		await expect(smaller.previewRows(source, ['sales'], 'orders', { limit: 1 })).rejects.toThrow(
			'byte limit',
		);
	});

	it('returns column names for an empty base table', async () => {
		const { browser } = world((url) => (url.pathname.endsWith('/data') ? {} : metadata));
		expect(await browser.previewRows(source, ['sales'], 'orders', { limit: 1 })).toEqual({
			columns: fields.map((field) => field.name),
			rows: [],
		});
	});

	it('sanitizes transport and JSON decoding exceptions', async () => {
		const { browser, fetch } = world();
		fetch.mockRejectedValueOnce(new Error('sensitive transport details'));
		await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow(
			'BigQuery authentication failed.',
		);
		fetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ access_token: 'minted-token', expires_in: 3600 }),
		});
		fetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error('sensitive response body');
			},
		});
		await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow(
			'The BigQuery request failed.',
		);
	});

	it('cancels the metadata fetch after authentication and forwards its abort signal', async () => {
		const { browser, fetch } = world();
		const controller = new AbortController();
		const started = Promise.withResolvers<AbortSignal>();
		fetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ access_token: 'minted-token', expires_in: 3600 }),
		});
		fetch.mockImplementationOnce(async (_url, options) => {
			started.resolve(options!.signal!);
			return new Promise(() => {});
		});
		const pending = browser.listNamespaces(source, { limit: 1, signal: controller.signal });
		const assertion = expect(pending).rejects.toThrow('canceled');
		const signal = await started.promise;
		controller.abort(new Error('sensitive abort reason'));
		await assertion;
		expect(signal.aborted).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe('BigQuery token reuse and deadlines', () => {
	it('reuses a token across browsing and testing and refreshes one minute before expiry', async () => {
		vi.useFakeTimers();
		const { browser, fetch } = world(() => ({ datasets: [] }));
		await browser.listNamespaces(source, { limit: 1 });
		await browser.testConnection(source);
		await vi.advanceTimersByTimeAsync(3_539_999);
		await browser.listNamespaces(source, { limit: 1 });
		expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await browser.listNamespaces(source, { limit: 1 });
		expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(2);
	});

	it('isolates tokens by credential and browser instance', async () => {
		const { browser, probe, fetch } = world(() => ({ datasets: [] }));
		const rotated = {
			...source,
			credentials_json: JSON.stringify({
				...(JSON.parse(source.credentials_json) as Record<string, unknown>),
				private_key_id: 'rotated-key',
			}),
		};
		await browser.listNamespaces(source, { limit: 1 });
		await browser.listNamespaces(rotated, { limit: 1 });
		await browser.listNamespaces(source, { limit: 1 });
		await new BigQueryDatabaseBrowser({ probe, mode: 'full' }).listNamespaces(source, { limit: 1 });
		expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(3);
	});

	it('discards a rejected token and authenticates on the next request', async () => {
		const { browser, fetch } = world(() => ({ datasets: [] }));
		await browser.listNamespaces(source, { limit: 1 });
		fetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
		await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow('access was denied');
		await browser.listNamespaces(source, { limit: 1 });
		expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(2);
	});

	it('does not reuse tokens whose remaining lifetime is too short', async () => {
		const { browser, fetch } = world(() => ({ datasets: [] }));
		fetch.mockImplementation(async (url) => ({
			ok: true,
			status: 200,
			json: async () =>
				url.endsWith('/token') ? { access_token: 'short-token', expires_in: 60 } : { datasets: [] },
		}));
		await browser.listNamespaces(source, { limit: 1 });
		await browser.listNamespaces(source, { limit: 1 });
		expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(2);
	});

	it.each([undefined, 0, -1, '3600', 86_401])(
		'rejects an invalid token lifetime %s without caching it',
		async (expires_in) => {
			const { browser, fetch } = world(() => ({ datasets: [] }));
			fetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ access_token: 'bad-lifetime', expires_in }),
			});
			await expect(browser.listNamespaces(source, { limit: 1 })).rejects.toThrow(
				'authentication failed',
			);
			await browser.listNamespaces(source, { limit: 1 });
			expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(2);
		},
	);

	it.each(['metadata', 'preview'])(
		'aborts the pending %s request at the shared deadline after authentication',
		async (operation) => {
			vi.useFakeTimers();
			const { browser, fetch } = world();
			const authStarted = Promise.withResolvers<AbortSignal>();
			const releaseToken = Promise.withResolvers<void>();
			const resourceStarted = Promise.withResolvers<AbortSignal>();
			fetch.mockImplementation(async (url, options) => {
				if (url.endsWith('/token')) {
					authStarted.resolve(options!.signal!);
					await releaseToken.promise;
					return {
						ok: true,
						status: 200,
						json: async () => ({ access_token: 'minted-token', expires_in: 3600 }),
					};
				}
				if (operation === 'preview' && !new URL(url).pathname.endsWith('/data')) {
					return { ok: true, status: 200, json: async () => metadata };
				}
				resourceStarted.resolve(options!.signal!);
				return new Promise(() => {});
			});
			const pending =
				operation === 'metadata'
					? browser.listNamespaces(source, { limit: 1 })
					: browser.previewRows(source, ['sales'], 'orders', { limit: 1 });
			const assertion = expect(pending).rejects.toThrow('timed out');
			const authSignal = await authStarted.promise;
			await vi.advanceTimersByTimeAsync(25_000);
			releaseToken.resolve();
			const resourceSignal = await resourceStarted.promise;
			expect(resourceSignal).toBe(authSignal);
			expect(resourceSignal.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(4_999);
			expect(resourceSignal.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await assertion;
			expect(resourceSignal.aborted).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(operation === 'metadata' ? 2 : 3);
		},
	);
});
