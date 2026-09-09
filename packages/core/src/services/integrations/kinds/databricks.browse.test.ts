import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationProbe } from '../../../ports/integrations';
import { browseContract } from '../../../testing/browseContract';
import { databricks } from './databricks';

const config = databricks.configSchema.parse({
	host: 'workspace.example.test',
	http_path: '/sql/1.0/warehouses/test',
	auth: { method: 'personal_access_token', token: 'test-personal-token' },
});
const browse = databricks.browse!;
const columns = [{ name: 'id', type_text: 'BIGINT', nullable: false }];

function probeWith(body: (url: URL) => unknown = () => ({}), status = 200) {
	const fetch = vi.fn<IntegrationProbe['fetch']>(async (url) => ({
		ok: status < 300,
		status,
		json: async () => body(new URL(url)),
	}));
	return { probe: { fetch, connect: vi.fn() } satisfies IntegrationProbe, fetch };
}

afterEach(() => vi.useRealTimers());

browseContract('Databricks fixtures', () => ({
	config,
	browse,
	probe: probeWith((url) => {
		if (url.pathname.endsWith('/catalogs')) return { catalogs: [{ name: 'main' }] };
		if (url.pathname.endsWith('/schemas'))
			return { schemas: [{ name: 'sales' }, { name: 'other' }] };
		if (url.pathname.endsWith('/tables')) return { tables: [{ name: 'orders' }] };
		return { columns };
	}).probe,
	pageLimit: 10,
	setup: async () => ({
		hierarchy: 'two-level',
		root: 'main',
		children: ['sales', 'other'],
		grandchild: '',
		table: 'orders',
		expectedColumns: [{ name: 'id', type: 'BIGINT', nullable: false }],
	}),
}));

describe('Databricks metadata', () => {
	it('checks metadata with a PAT and accepts an empty catalog', async () => {
		const { probe, fetch } = probeWith(() => ({ catalogs: [] }));
		expect(await databricks.testConnection!(config, probe)).toMatchObject({
			ok: true,
			details: expect.stringContaining('metadata access verified'),
		});
		expect(fetch).toHaveBeenCalledWith(
			'https://workspace.example.test/api/2.1/unity-catalog/catalogs?max_results=1',
			expect.objectContaining({
				headers: { Authorization: 'Bearer test-personal-token' },
			}),
		);
	});

	it('exchanges M2M credentials and checks both configured defaults', async () => {
		const { probe, fetch } = probeWith((url) =>
			url.pathname === '/oidc/v1/token'
				? { access_token: 'minted-secret' }
				: { name: 'configured' },
		);
		const oauth = {
			...config,
			catalog: 'main',
			schema: 'sales',
			auth: { method: 'oauth_m2m' as const, client_id: 'client', client_secret: 'secret' },
		};
		expect(await databricks.testConnection!(oauth, probe)).toMatchObject({ ok: true });
		expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
			'/oidc/v1/token',
			'/api/2.1/unity-catalog/catalogs/main',
			'/api/2.1/unity-catalog/schemas/main.sales',
		]);
		expect(fetch.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			body: 'grant_type=client_credentials&scope=all-apis',
		});
		expect(fetch.mock.calls[1][1]?.headers?.Authorization).toBe('Bearer minted-secret');
	});

	it('keeps empty pages with continuation tokens and passes cursors upstream', async () => {
		const { probe, fetch } = probeWith((url) =>
			url.searchParams.has('page_token')
				? { tables: [{ name: 'later' }] }
				: { tables: [], next_page_token: 'second' },
		);
		expect(await browse.listTables(config, probe, ['main', 'sales'], { limit: 1 })).toEqual({
			items: [],
			next_cursor: 'second',
		});
		expect(
			await browse.listTables(config, probe, ['main', 'sales'], { limit: 1, cursor: 'second' }),
		).toEqual({ items: ['later'], next_cursor: null });
		expect(new URL(fetch.mock.calls[1][0]).searchParams.get('page_token')).toBe('second');
	});

	it.each([1, 50, 100, 1000])(
		'caps table requests at the provider limit and omits unused metadata for limit %s',
		async (limit) => {
			const names = Array.from({ length: Math.min(limit, 50) }, (_, index) => `table_${index}`);
			const { probe, fetch } = probeWith((url) => {
				expect(url.searchParams.get('max_results')).toBe(String(Math.min(limit, 50)));
				expect(url.searchParams.get('omit_columns')).toBe('true');
				expect(url.searchParams.get('omit_properties')).toBe('true');
				return url.searchParams.has('page_token')
					? { tables: [{ name: 'last' }] }
					: { tables: names.map((name) => ({ name })), next_page_token: 'next+/=' };
			});
			const first = await browse.listTables(config, probe, ['main', 'sales'], { limit });
			expect(first).toEqual({ items: names, next_cursor: 'next+/=' });
			expect(
				await browse.listTables(config, probe, ['main', 'sales'], {
					limit,
					cursor: first.next_cursor!,
				}),
			).toEqual({ items: ['last'], next_cursor: null });
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(new URL(fetch.mock.calls[1][0]).searchParams.get('page_token')).toBe('next+/=');
		},
	);

	it.each([{ parent: [] }, { parent: ['main'] }])(
		'retains the namespace page size for $parent',
		async ({ parent }) => {
			const { probe, fetch } = probeWith(() => ({}));
			await browse.listNamespaces(config, probe, { parent, limit: 100 });
			const url = new URL(fetch.mock.calls[0][0]);
			expect(url.searchParams.get('max_results')).toBe('100');
			expect(url.searchParams.has('omit_columns')).toBe(false);
			expect(url.searchParams.has('omit_properties')).toBe(false);
		},
	);

	it('rejects a repeated page token', async () => {
		const { probe } = probeWith(() => ({ tables: [], next_page_token: 'same' }));
		await expect(
			browse.listTables(config, probe, ['main', 'sales'], { limit: 1, cursor: 'same' }),
		).rejects.toThrow('non-advancing');
	});

	it('maps columns and partition ordering, and encodes identifiers', async () => {
		const { probe, fetch } = probeWith(() => ({
			columns: [
				{ name: 'day', type_text: 'DATE', nullable: true, partition_index: 1 },
				{
					name: 'region',
					type_text: 'STRING',
					nullable: false,
					partition_index: 0,
					comment: 'Region',
				},
			],
		}));
		expect(await browse.getTableSchema(config, probe, ['main', 'sales'], 'Odd / table')).toEqual({
			columns: [
				{ name: 'day', type: 'DATE', nullable: true },
				{ name: 'region', type: 'STRING', nullable: false, comment: 'Region' },
			],
			partitioning: ['region', 'day'],
		});
		expect(fetch.mock.calls[0][0]).toContain('main.sales.Odd%20%2F%20table');
	});

	it.each([401, 403, 404, 500])('sanitizes HTTP %s errors', async (status) => {
		const { probe } = probeWith(() => ({ message: 'test-personal-token minted-secret' }), status);
		const result = await databricks.testConnection!(config, probe);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toMatch(/test-personal-token|minted-secret/);
		await expect(browse.listNamespaces(config, probe, { limit: 1 })).rejects.toThrow(/Databricks/);
	});

	it('rejects malformed OAuth responses without leaking response values', async () => {
		const { probe } = probeWith(() => ({ access_token: 'bad\r\nsecret' }));
		const result = await databricks.testConnection!(
			{ ...config, auth: { method: 'oauth_m2m', client_id: 'client', client_secret: 'secret' } },
			probe,
		);
		expect(result.ok).toBe(false);
		expect(result.details).not.toContain('bad');
	});

	it('cancels an in-flight metadata request', async () => {
		const controller = new AbortController();
		const probe: IntegrationProbe = {
			connect: vi.fn(),
			fetch: vi.fn(() => new Promise<never>(() => {})),
		};
		const pending = browse.listNamespaces(config, probe, { limit: 1, signal: controller.signal });
		const assertion = expect(pending).rejects.toThrow('canceled');
		controller.abort();
		await assertion;
	});

	it('bounds the whole metadata operation by one deadline', async () => {
		vi.useFakeTimers();
		const probe: IntegrationProbe = {
			connect: vi.fn(),
			fetch: vi.fn(() => new Promise<never>(() => {})),
		};
		const assertion = expect(browse.listNamespaces(config, probe, { limit: 1 })).rejects.toThrow(
			'timed out',
		);
		await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
	});

	it('generates notebook code for both auth methods without plaintext secrets', () => {
		const snippet = browse.snippet('warehouse', ['main', 'sales'], 'odd`table');
		expect(snippet).toContain('warehouse.json');
		expect(snippet).toContain('token_env');
		expect(snippet).toContain('oauth_service_principal');
		expect(snippet).toContain('odd``table');
		expect(snippet).not.toContain(
			config.auth.method === 'personal_access_token' ? config.auth.token : 'unused',
		);
		expect(browse.previewRows).toBeUndefined();
	});
});

describe('Databricks failure boundaries', () => {
	const oauth = {
		...config,
		auth: { method: 'oauth_m2m' as const, client_id: 'client', client_secret: 'sensitive-secret' },
	};

	it.each([401, 403])(
		'stops before metadata when M2M authentication returns HTTP %s',
		async (status) => {
			const { probe, fetch } = probeWith(() => ({ message: 'sensitive-secret' }), status);
			await expect(browse.listNamespaces(oauth, probe, { limit: 1 })).rejects.toThrow(
				'Databricks authentication failed.',
			);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/oidc/v1/token');
		},
	);

	it.each([{}, { access_token: '' }, { access_token: 123 }])(
		'rejects invalid M2M token payloads: %j',
		async (body) => {
			const { probe, fetch } = probeWith(() => body);
			await expect(browse.listNamespaces(oauth, probe, { limit: 1 })).rejects.toThrow(
				'invalid metadata',
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it('fails when the configured schema is inaccessible even if its catalog is accessible', async () => {
		const { probe, fetch } = probeWith();
		fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: 'main' }) });
		fetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			json: async () => ({ message: 'test-personal-token' }),
		});
		expect(
			await databricks.testConnection!({ ...config, catalog: 'main', schema: 'private' }, probe),
		).toMatchObject({
			ok: false,
			details: expect.stringContaining('metadata access was denied'),
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each([config, oauth])(
		'rejects a schema default without a catalog before authentication with $auth.method',
		async (config) => {
			const { probe, fetch } = probeWith();
			expect(await databricks.testConnection!({ ...config, schema: 'sales' }, probe)).toMatchObject(
				{
					ok: false,
					details: 'Configure a catalog to verify the default Databricks schema.',
				},
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ config, expected: ['databricks-sql-connector>=3.4', 'databricks-sqlalchemy>=1.0'] },
		{
			config: oauth,
			expected: [
				'databricks-sql-connector>=3.4',
				'databricks-sqlalchemy>=1.0',
				'databricks-sdk>=0.18',
			],
		},
	])('resolves notebook requirements for $config.auth.method', ({ config, expected }) => {
		expect(databricks.resolveRequirements!(config)).toEqual(expected);
	});

	it.each([
		{ catalogs: [{ name: '' }] },
		{ catalogs: 'secret-response' },
		{ next_page_token: 123 },
	])('rejects malformed catalog pages: %j', async (body) => {
		const { probe } = probeWith(() => body);
		await expect(browse.listNamespaces(config, probe, { limit: 1 })).rejects.toThrow(
			'invalid metadata',
		);
	});

	it('rejects oversized catalog pages', async () => {
		const { probe } = probeWith(() => ({ catalogs: [{ name: 'first' }, { name: 'second' }] }));
		await expect(browse.listNamespaces(config, probe, { limit: 1 })).rejects.toThrow('page limit');
	});

	it.each([0, -1, 1.5, 1001])('rejects invalid metadata page size %s', async (limit) => {
		const { probe, fetch } = probeWith();
		await expect(browse.listNamespaces(config, probe, { limit })).rejects.toThrow('page limit');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('encodes schema listing parameters and opaque cursors independently', async () => {
		const { probe, fetch } = probeWith(() => ({ schemas: [] }));
		const catalog = 'main & catalog/雪';
		const cursor = '+/=&max_results=999#fragment';
		expect(
			await browse.listNamespaces(config, probe, { parent: [catalog], limit: 1, cursor }),
		).toEqual({
			items: [],
			next_cursor: null,
		});
		const url = new URL(fetch.mock.calls[0][0]);
		expect(url.searchParams.get('catalog_name')).toBe(catalog);
		expect(url.searchParams.get('page_token')).toBe(cursor);
		expect(url.searchParams.get('max_results')).toBe('1');
		expect(url.hash).toBe('');
	});

	it('rejects malformed table columns without exposing provider values', async () => {
		const { probe } = probeWith(() => ({
			columns: [{ name: 'secret-column', type_text: 'STRING', nullable: 'yes' }],
		}));
		await expect(browse.getTableSchema(config, probe, ['main', 'sales'], 'orders')).rejects.toThrow(
			'Databricks returned invalid metadata.',
		);
	});

	it('does not authenticate an already canceled request', async () => {
		const { probe, fetch } = probeWith();
		const controller = new AbortController();
		controller.abort(new Error('sensitive abort reason'));
		await expect(
			browse.listNamespaces(oauth, probe, { limit: 1, signal: controller.signal }),
		).rejects.toThrow('canceled');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('uses the remaining deadline after M2M authentication', async () => {
		vi.useFakeTimers();
		const { probe, fetch } = probeWith();
		fetch.mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25_000));
			return { ok: true, status: 200, json: async () => ({ access_token: 'minted-token' }) };
		});
		fetch.mockImplementationOnce(() => new Promise(() => {}));
		const assertion = expect(browse.listNamespaces(oauth, probe, { limit: 1 })).rejects.toThrow(
			'timed out',
		);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(fetch).toHaveBeenCalledTimes(2);
		const signal = fetch.mock.calls[1][1]?.signal;
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
		expect(signal?.aborted).toBe(true);
	});
});
