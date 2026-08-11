import { describe, expect, it } from 'vitest';
import { NotFoundError, UnavailableError } from '../../../errors';
import type { IntegrationProbe } from '../../../ports/integrations';
import { icebergRest } from './icebergRest';

const browse = icebergRest.browse!;

const BASE_CONFIG = {
	uri: 'https://catalog.internal/api/catalog',
	warehouse: 'wh',
	auth: { method: 'bearer_token', token: 'tok-123' },
	storage: { scheme: 's3', region: 'us-east-1' },
};

const config = (over: Record<string, unknown> = {}) =>
	icebergRest.configSchema.parse({ ...BASE_CONFIG, ...over });

const CONFIG_RESPONSE = { overrides: { prefix: 'demo' }, defaults: {} };

/** Serves canned JSON per pathname and records every requested URL. */
function fakeCatalog(routes: Record<string, unknown>, requested: string[] = []): IntegrationProbe {
	const respond = (ok: boolean, status: number, body: unknown) =>
		Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
	return {
		fetch: (url, init) => {
			requested.push(url);
			const target = new URL(url);
			if (init?.headers?.Authorization !== 'Bearer tok-123') return respond(false, 401, null);
			const body = routes[target.pathname];
			if (body === undefined) return respond(false, 404, null);
			return respond(true, 200, body);
		},
	};
}

describe('iceberg_rest browse availability', () => {
	it('allows the auth methods the probe can exercise', () => {
		expect(browse.available(config())).toEqual({ ok: true });
		expect(
			browse.available(config({ auth: { method: 'basic', username: 'u', password: 'p' } })),
		).toEqual({ ok: true });
		expect(browse.available(config({ auth: { method: 'none' } }))).toEqual({ ok: true });
	});

	it('defers sandbox-only auth methods and custom TLS to the sandbox', () => {
		const sigv4 = browse.available(config({ auth: { method: 'sigv4', region: 'us-east-1' } }));
		expect(sigv4).toMatchObject({ ok: false, reason: expect.stringContaining('sigv4') });
		const tls = browse.available(config({ tls: { ca_bundle: 'PEM' } }));
		expect(tls).toMatchObject({ ok: false, reason: expect.stringContaining('certificate') });
	});
});

describe('iceberg_rest browse operations', () => {
	it('resolves the server prefix from /v1/config and pages namespaces', async () => {
		const requested: string[] = [];
		const probe = fakeCatalog(
			{
				'/api/catalog/v1/config': CONFIG_RESPONSE,
				'/api/catalog/v1/demo/namespaces': {
					namespaces: [['sales'], ['sales', 'eu']],
					'next-page-token': 'page-2',
				},
			},
			requested,
		);

		const page = await browse.listNamespaces(config(), probe, { limit: 25, cursor: 'page-1' });

		// The nested entry is not a DIRECT child of the root; it stays reachable
		// by expanding `sales`, so a flat listing cannot distort the tree.
		expect(page).toEqual({ items: [['sales']], next_cursor: 'page-2' });
		const listUrl = new URL(requested.at(-1)!);
		expect(listUrl.searchParams.get('pageSize')).toBe('25');
		expect(listUrl.searchParams.get('pageToken')).toBe('page-1');
		expect(new URL(requested[0]).searchParams.get('warehouse')).toBe('wh');
	});

	it('passes a multi-part parent through the configured separator', async () => {
		const requested: string[] = [];
		const probe = fakeCatalog(
			{
				'/api/catalog/v1/config': CONFIG_RESPONSE,
				'/api/catalog/v1/demo/namespaces': { namespaces: [] },
			},
			requested,
		);

		await browse.listNamespaces(config(), probe, { limit: 10, parent: ['a.b', 'c'] });

		expect(new URL(requested.at(-1)!).searchParams.get('parent')).toBe('a.b\u001fc');
	});

	it('keeps only direct children of the parent when a server ignores the param', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces': {
				namespaces: [
					['sales'],
					['hr'],
					['sales', 'eu'],
					['sales', 'eu'],
					['sales', 'eu', 'north'],
					['sales', ''],
					'not-a-namespace',
				],
			},
		});

		const page = await browse.listNamespaces(config(), probe, { limit: 10, parent: ['sales'] });

		expect(page.items).toEqual([['sales', 'eu']]);
	});

	it('stops paging when a server echoes the request token back', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces': {
				namespaces: [['sales']],
				'next-page-token': 'stuck',
			},
		});

		const first = await browse.listNamespaces(config(), probe, { limit: 10 });
		expect(first.next_cursor).toBe('stuck');
		const second = await browse.listNamespaces(config(), probe, { limit: 10, cursor: 'stuck' });
		expect(second.next_cursor).toBeNull();
	});

	it('dedupes table names', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces/sales/tables': {
				identifiers: [
					{ namespace: ['sales'], name: 'orders' },
					{ namespace: ['sales'], name: 'orders' },
					{ namespace: ['sales'], name: '' },
				],
			},
		});

		const page = await browse.listTables(config(), probe, ['sales'], { limit: 10 });

		expect(page.items).toEqual(['orders']);
	});

	it('lists table names for a namespace addressed with the encoded separator', async () => {
		const requested: string[] = [];
		const probe = fakeCatalog(
			{
				'/api/catalog/v1/config': CONFIG_RESPONSE,
				'/api/catalog/v1/demo/namespaces/sales%1Feu/tables': {
					identifiers: [
						{ namespace: ['sales', 'eu'], name: 'orders' },
						{ namespace: ['sales', 'eu'], name: 'refunds' },
					],
				},
			},
			requested,
		);

		const page = await browse.listTables(config(), probe, ['sales', 'eu'], { limit: 100 });

		expect(page).toEqual({ items: ['orders', 'refunds'], next_cursor: null });
	});

	it('honors a server-declared namespace-separator override', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': {
				overrides: { prefix: 'demo', 'namespace-separator': '%2E' },
				defaults: {},
			},
			// With the override, the nested namespace is joined by %2E (a real
			// server percent-decodes it to `sales.eu`; the live suite covers that).
			'/api/catalog/v1/demo/namespaces/sales%2Eeu/tables': {
				identifiers: [{ namespace: ['sales', 'eu'], name: 'orders' }],
			},
		});

		const page = await browse.listTables(config(), probe, ['sales', 'eu'], { limit: 10 });

		expect(page.items).toEqual(['orders']);
	});

	it('refuses an unsafe CONFIGURED separator, falling back to %1F', async () => {
		const requested: string[] = [];
		const probe = fakeCatalog(
			{
				'/api/catalog/v1/config': CONFIG_RESPONSE,
				'/api/catalog/v1/demo/namespaces/sales%1Feu/tables': { identifiers: [] },
			},
			requested,
		);

		// `/` would restructure the catalog path (`…/namespaces/sales/eu/tables`).
		await browse.listTables(
			config({ rest: { namespace_separator: '/' } }),
			probe,
			['sales', 'eu'],
			{ limit: 10 },
		);

		expect(new URL(requested.at(-1)!).pathname).toBe(
			'/api/catalog/v1/demo/namespaces/sales%1Feu/tables',
		);
	});

	it('renders the current schema, nested types, and partitioning', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces/sales/tables/orders': {
				metadata: {
					location: 's3://warehouse/sales/orders',
					'format-version': 2,
					'current-snapshot-id': 77,
					snapshots: [
						{ 'snapshot-id': 1, 'timestamp-ms': 1_700_000_000_000 },
						{
							'snapshot-id': 77,
							'timestamp-ms': 1_750_000_000_000,
							summary: { 'total-records': '123456', 'total-files-size': '789000' },
						},
					],
					'current-schema-id': 1,
					schemas: [
						{ 'schema-id': 0, fields: [] },
						{
							'schema-id': 1,
							fields: [
								{ id: 1, name: 'id', required: true, type: 'long' },
								{ id: 2, name: 'ts', required: false, type: 'timestamptz', doc: 'event time' },
								{
									id: 3,
									name: 'address',
									required: false,
									type: {
										type: 'struct',
										fields: [{ id: 4, name: 'city', type: 'string' }],
									},
								},
								{
									id: 5,
									name: 'tags',
									required: false,
									type: { type: 'list', element: 'string' },
								},
							],
						},
					],
					'default-spec-id': 0,
					'partition-specs': [
						{
							'spec-id': 0,
							fields: [
								{ 'source-id': 2, name: 'ts_day', transform: 'day' },
								{ 'source-id': 1, name: 'id', transform: 'identity' },
							],
						},
					],
				},
			},
		});

		const schema = await browse.getTableSchema(config(), probe, ['sales'], 'orders');

		expect(schema.columns).toEqual([
			{ name: 'id', type: 'long', nullable: false },
			{ name: 'ts', type: 'timestamptz', nullable: true, comment: 'event time' },
			{ name: 'address', type: 'struct<city: string>', nullable: true },
			{ name: 'tags', type: 'list<string>', nullable: true },
		]);
		expect(schema.partitioning).toEqual(['day(ts)', 'id']);
		expect(schema.location).toBe('s3://warehouse/sales/orders');
		expect(schema.format_version).toBe(2);
		expect(schema.current_snapshot).toEqual({
			committed_at: new Date(1_750_000_000_000).toISOString(),
			total_records: 123_456,
			total_data_size_bytes: 789_000,
		});
	});

	it('maps an upstream 404 to NotFound and other failures to Unavailable', async () => {
		const probe = fakeCatalog({ '/api/catalog/v1/config': CONFIG_RESPONSE });
		await expect(browse.listTables(config(), probe, ['nope'], { limit: 10 })).rejects.toThrow(
			NotFoundError,
		);

		const denied = fakeCatalog({});
		await expect(browse.listNamespaces(config(), denied, { limit: 10 })).rejects.toThrow(
			UnavailableError,
		);
	});

	it('replaces a transport throw with a generic failure', async () => {
		const probe: IntegrationProbe = {
			fetch: () => Promise.reject(new Error('socket hang up for Bearer tok-123')),
		};
		await expect(browse.listNamespaces(config(), probe, { limit: 10 })).rejects.toThrow(
			'The catalog request failed.',
		);
	});
});

describe('iceberg_rest browse snippet', () => {
	it('uses a dotted identifier when no part contains a dot', () => {
		expect(browse.snippet('lake', ['sales', 'eu'], 'orders')).toBe(
			[
				'from pyiceberg.catalog import load_catalog',
				'',
				'catalog = load_catalog("lake")',
				'table = catalog.load_table("sales.eu.orders")',
				'df = table.scan(limit=100).to_arrow()',
				'df',
			].join('\n'),
		);
	});

	it('falls back to a tuple identifier when a part contains a dot', () => {
		expect(browse.snippet('lake', ['a.b'], 'orders')).toContain(
			'catalog.load_table(("a.b", "orders"))',
		);
	});
});

describe('iceberg_rest browse unhappy paths', () => {
	const respond = (ok: boolean, status: number, body: unknown) =>
		Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

	it('oauth2: exchanges the client secret for a token and sends it as the bearer', async () => {
		const requested: { url: string; auth?: string; body?: string }[] = [];
		const probe: IntegrationProbe = {
			fetch: (url, init) => {
				requested.push({ url, auth: init?.headers?.Authorization, body: init?.body });
				if (url.includes('idp.internal/token')) {
					return respond(true, 200, { access_token: 'oauth-tok' });
				}
				if (init?.headers?.Authorization !== 'Bearer oauth-tok') return respond(false, 401, null);
				if (url.includes('/v1/config')) return respond(true, 200, CONFIG_RESPONSE);
				return respond(true, 200, { namespaces: [['sales']] });
			},
		};

		const page = await browse.listNamespaces(oauthConfig(), probe, { limit: 10 });

		expect(page.items).toEqual([['sales']]);
		const tokenRequest = requested.find((r) => r.url.includes('idp.internal/token'));
		expect(tokenRequest?.auth).toMatch(/^Basic /);
		expect(tokenRequest?.body).toContain('grant_type=client_credentials');
		// The client secret never rides anywhere except the token exchange.
		for (const r of requested) {
			if (!r.url.includes('idp.internal/token')) expect(r.auth).not.toContain('csec');
		}
	});

	it('oauth2: a failing token endpoint surfaces as unavailable, without the secret', async () => {
		const probe: IntegrationProbe = {
			fetch: (url) =>
				url.includes('idp.internal/token')
					? respond(false, 500, null)
					: respond(true, 200, CONFIG_RESPONSE),
		};

		const rejection = expect(browse.listNamespaces(oauthConfig(), probe, { limit: 10 })).rejects;
		await rejection.toThrow(UnavailableError);
		await rejection.toThrow(/token endpoint: HTTP 500/);
	});

	it('a truncated or non-JSON listing response is refused, not misread as empty', async () => {
		const probe: IntegrationProbe = {
			fetch: (url) =>
				url.includes('/v1/config')
					? respond(true, 200, CONFIG_RESPONSE)
					: respond(true, 200, undefined),
		};

		await expect(browse.listNamespaces(config(), probe, { limit: 10 })).rejects.toThrow(
			/not JSON or exceeded the size limit/,
		);
	});

	it('malformed listing shapes degrade to empty pages instead of crashing', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces': { namespaces: 'nope' },
			'/api/catalog/v1/demo/namespaces/sales/tables': { identifiers: { name: 'orders' } },
		});

		expect(await browse.listNamespaces(config(), probe, { limit: 10 })).toEqual({
			items: [],
			next_cursor: null,
		});
		expect(await browse.listTables(config(), probe, ['sales'], { limit: 10 })).toEqual({
			items: [],
			next_cursor: null,
		});
	});

	it('renders a format-v1 table (single `schema`, no `schemas` list)', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces/sales/tables/legacy': {
				metadata: {
					'format-version': 1,
					schema: { fields: [{ id: 1, name: 'id', required: true, type: 'long' }] },
				},
			},
		});

		const schema = await browse.getTableSchema(config(), probe, ['sales'], 'legacy');

		expect(schema.columns).toEqual([{ name: 'id', type: 'long', nullable: false }]);
		expect(schema.format_version).toBe(1);
	});

	it('falls back to the last schema when current-schema-id matches nothing', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces/sales/tables/orders': {
				metadata: {
					'current-schema-id': 99,
					schemas: [
						{ 'schema-id': 0, fields: [] },
						{ 'schema-id': 1, fields: [{ id: 1, name: 'id', required: true, type: 'long' }] },
					],
				},
			},
		});

		const schema = await browse.getTableSchema(config(), probe, ['sales'], 'orders');

		expect(schema.columns).toEqual([{ name: 'id', type: 'long', nullable: false }]);
	});

	it('tolerates a table response with no readable metadata or garbage stats', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces/sales/tables/empty': { metadata: null },
			'/api/catalog/v1/demo/namespaces/sales/tables/junkstats': {
				metadata: {
					schemas: [{ 'schema-id': 0, fields: [{ id: 1, name: 'id', type: 'long' }] }],
					'current-schema-id': 0,
					'current-snapshot-id': 7,
					snapshots: [{ 'snapshot-id': 7, summary: { 'total-records': 'not-a-number' } }],
				},
			},
		});

		expect(await browse.getTableSchema(config(), probe, ['sales'], 'empty')).toEqual({
			columns: [],
		});
		const junk = await browse.getTableSchema(config(), probe, ['sales'], 'junkstats');
		expect(junk.current_snapshot).toBeUndefined();
	});
});

function oauthConfig() {
	return config({
		auth: {
			method: 'oauth2_client_credentials',
			token_endpoint: 'https://idp.internal/token',
			client_id: 'cid',
			client_secret: 'csec',
		},
	});
}

describe('iceberg_rest browse URI and scoping', () => {
	it('preserves the configured query string (tenant routing) on catalog routes', async () => {
		const requested: string[] = [];
		const probe = fakeCatalog(
			{
				'/api/catalog/v1/config': CONFIG_RESPONSE,
				'/api/catalog/v1/demo/namespaces/sales/tables': { identifiers: [] },
			},
			requested,
		);

		await browse.listTables(
			config({ uri: 'https://catalog.internal/api/catalog?tenant=acme' }),
			probe,
			['sales'],
			{ limit: 10 },
		);

		for (const url of requested) {
			expect(new URL(url).searchParams.get('tenant')).toBe('acme');
		}
	});

	it('drops identifiers scoped to a different namespace, keeps ones without any', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces/sales/tables': {
				identifiers: [
					{ namespace: ['sales'], name: 'orders' },
					{ namespace: ['hr'], name: 'salaries' },
					{ name: 'bare' },
				],
			},
		});

		const page = await browse.listTables(config(), probe, ['sales'], { limit: 10 });

		expect(page.items).toEqual(['orders', 'bare']);
	});

	it('renders format-v1 partitioning from the flat singular partition-spec', async () => {
		const probe = fakeCatalog({
			'/api/catalog/v1/config': CONFIG_RESPONSE,
			'/api/catalog/v1/demo/namespaces/sales/tables/v1part': {
				metadata: {
					'format-version': 1,
					schema: {
						fields: [
							{ id: 1, name: 'id', required: true, type: 'long' },
							{ id: 2, name: 'ts', required: false, type: 'timestamptz' },
						],
					},
					'partition-spec': [
						{ 'source-id': 2, 'field-id': 1000, name: 'ts_day', transform: 'day' },
					],
				},
			},
		});

		const schema = await browse.getTableSchema(config(), probe, ['sales'], 'v1part');

		expect(schema.partitioning).toEqual(['day(ts)']);
	});
});
