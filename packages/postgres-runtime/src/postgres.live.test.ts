import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type {
	DataQueryExecution,
	IntegrationProbe,
	PostgresConnectionCapability,
} from '@marimo-hub/core';
import { browseContract } from '@marimo-hub/core/testing/browse-contract';
import type { BrowseContractOptions } from '@marimo-hub/core/testing/browse-contract';
import { createPostgresDataQueryExecutorFactory, PostgresDatabaseBrowser } from './node';

const port = Number(process.env.MARIMOHUB_TEST_POSTGRES_PORT);
const live = Number.isInteger(port) && port > 0 ? describe : describe.skip;
const plainPort = Number(process.env.MARIMOHUB_TEST_POSTGRES_PLAIN_PORT);
const caPath = process.env.MARIMOHUB_TEST_POSTGRES_CA_PATH;
const wrongCaPath = process.env.MARIMOHUB_TEST_POSTGRES_WRONG_CA_PATH;
const caBundle = caPath ? readFileSync(caPath, 'utf8') : undefined;
const wrongCaBundle = wrongCaPath ? readFileSync(wrongCaPath, 'utf8') : undefined;
const tlsIt = caBundle && wrongCaBundle ? it : it.skip;

live('PostgreSQL live conformance', () => {
	const { Client } = pg;
	const connection: PostgresConnectionCapability = {
		provider: 'postgres',
		host: 'postgres.test',
		port,
		database: 'hubtest',
		username: 'hub_reader',
		password: 'readerpass',
		tls: { mode: 'disable' },
	};
	const resolveHost = async () => [{ address: '127.0.0.1', family: 4 }];
	const cancellationConnection: PostgresConnectionCapability = caBundle
		? {
				...connection,
				tls: { mode: 'verify-full', ca: { kind: 'bundle', pem: caBundle } },
			}
		: connection;
	const browser = new PostgresDatabaseBrowser({
		resolveHost,
		mode: 'full',
		metadataTimeoutMs: 5_000,
		previewTimeoutMs: 5_000,
		previewMaxBytes: 64 * 1024,
	});
	const contractBrowse: BrowseContractOptions<PostgresConnectionCapability>['browse'] = {
		available: () => ({ ok: true }),
		listNamespaces: (source, _probe, request) => browser.listNamespaces(source, request),
		listTables: (source, _probe, namespace, request) =>
			browser.listTables(source, namespace, request),
		getTableSchema: (source, _probe, namespace, table, request) =>
			browser.getTableSchema(source, namespace, table, request),
		previewRows: (source, _probe, namespace, table, request) =>
			browser.previewRows(source, namespace, table, request),
		snippet: () => '',
	};
	const contractProbe: IntegrationProbe = {
		fetch: () => Promise.reject(new Error('unused')),
		connect: () => Promise.reject(new Error('unused')),
	};

	browseContract('postgres (live)', () => ({
		browse: contractBrowse,
		config: connection,
		probe: contractProbe,
		pageLimit: 2,
		setup: async () => ({
			hierarchy: 'flat',
			root: 'sales',
			children: [],
			grandchild: '',
			table: 'orders',
			tableNamespace: ['sales'],
			expectedColumns: [
				{ name: 'id', type: 'bigint', nullable: false },
				{ name: 'amount', type: 'numeric(20,4)', nullable: true, comment: 'Exact total' },
				{ name: 'created_at', type: 'timestamp with time zone', nullable: true },
				{ name: 'payload', type: 'bytea', nullable: true },
				{ name: 'meta', type: 'jsonb', nullable: true },
				{ name: 'tags', type: 'text[]', nullable: true },
				{ name: 'special', type: 'double precision', nullable: true },
			],
			expectedPreview: {
				columns: ['id', 'amount', 'created_at', 'payload', 'meta', 'tags', 'special'],
				rows: [
					[
						'1',
						'1234567890123456.7890',
						'2026-01-02T03:04:05.000Z',
						'AP8=',
						{ ok: true },
						['one', 'two'],
						null,
					],
				],
			},
		}),
	}));

	it('browses schemas, relations, columns, and normalized rows', async () => {
		await expect(browser.listNamespaces(connection, { limit: 20 })).resolves.toMatchObject({
			items: expect.arrayContaining([['sales']]),
		});
		await expect(browser.listTables(connection, ['sales'], { limit: 20 })).resolves.toMatchObject({
			items: expect.arrayContaining([
				'foreign_orders',
				'order_materialized',
				'order_view',
				'orders',
				'orders_partitioned',
			]),
		});
		await expect(browser.getTableSchema(connection, ['sales'], 'orders')).resolves.toMatchObject({
			columns: expect.arrayContaining([
				expect.objectContaining({ name: 'amount', type: 'numeric(20,4)', comment: 'Exact total' }),
			]),
		});
		await expect(
			browser.previewRows(connection, ['sales'], 'orders', { limit: 10 }),
		).resolves.toEqual({
			columns: ['id', 'amount', 'created_at', 'payload', 'meta', 'tags', 'special'],
			rows: [
				[
					'1',
					'1234567890123456.7890',
					'2026-01-02T03:04:05.000Z',
					'AP8=',
					{ ok: true },
					['one', 'two'],
					null,
				],
			],
		});
		await expect(
			browser.previewRows(connection, ['sales'], 'Odd " Table', { limit: 10 }),
		).resolves.toMatchObject({ columns: ['Odd " Column'], rows: [['quoted']] });
	});

	it('uses opaque keyset cursors', async () => {
		const first = await browser.listTables(connection, ['sales'], { limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.next_cursor).toMatch(/^name:/);
		const second = await browser.listTables(connection, ['sales'], {
			limit: 1,
			cursor: first.next_cursor ?? undefined,
		});
		expect(second.items).toHaveLength(1);
		expect(second.items[0] > first.items[0]).toBe(true);
	});

	tlsIt('preserves the original hostname for verified TLS', async () => {
		const verified = {
			...connection,
			tls: { mode: 'verify-full', ca: { kind: 'bundle', pem: caBundle! } } as const,
		};
		await expect(browser.listNamespaces(verified, { limit: 20 })).resolves.toMatchObject({
			items: expect.arrayContaining([['sales']]),
		});
	});

	tlsIt('implements every TLS verification mode and sanitized failures', async () => {
		for (const mode of ['prefer', 'require'] as const) {
			await expect(
				browser.listNamespaces({ ...connection, tls: { mode } }, { limit: 20 }),
			).resolves.toBeDefined();
		}
		await expect(
			browser.listNamespaces(
				{
					...connection,
					host: 'certificate-mismatch.test',
					tls: { mode: 'verify-ca', ca: { kind: 'bundle', pem: caBundle! } },
				},
				{ limit: 20 },
			),
		).resolves.toBeDefined();
		await expect(
			browser.listNamespaces(
				{
					...connection,
					host: 'certificate-mismatch.test',
					tls: { mode: 'verify-full', ca: { kind: 'bundle', pem: caBundle! } },
				},
				{ limit: 20 },
			),
		).rejects.toMatchObject({ message: 'The PostgreSQL TLS connection failed.' });
		await expect(
			browser.listNamespaces(
				{
					...connection,
					tls: { mode: 'verify-full', ca: { kind: 'bundle', pem: wrongCaBundle! } },
				},
				{ limit: 20 },
			),
		).rejects.toMatchObject({ message: 'The PostgreSQL TLS connection failed.' });
		await expect(
			browser.listNamespaces({ ...connection, password: 'not-the-password' }, { limit: 20 }),
		).rejects.toMatchObject({ message: 'PostgreSQL authentication failed.' });
	});

	tlsIt('falls back from prefer only when TLS is unavailable', async () => {
		expect(Number.isInteger(plainPort) && plainPort > 0).toBe(true);
		await expect(
			browser.listNamespaces(
				{ ...connection, port: plainPort, tls: { mode: 'prefer' } },
				{ limit: 20 },
			),
		).resolves.toBeDefined();
	});

	it('runs bounded PostgreSQL SQL in a read-only transaction', async () => {
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request: DataQueryExecution = {
			sql: 'SELECT id, amount FROM sales.orders',
			connection: {
				files: [],
				vars: {},
				integration: { id: 'test' as never, name: 'test', kind: 'postgres', version: 1 },
				plan: { engine: 'postgres', connection },
			},
			accessMode: 'read-only',
			limits: { maxRows: 10, maxBytes: 64 * 1024, deadlineMs: 5_000 },
		};

		await expect(executor.execute(request, new AbortController().signal)).resolves.toMatchObject({
			columns: ['id', 'amount'],
			rows: [['1', '1234567890123456.7890']],
			truncated: false,
		});
		executor.terminate();
	});

	it('runs semicolon-terminated PostgreSQL SQL', async () => {
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);

		await expect(
			executor.execute(queryRequest(connection, 'SELECT 1;'), new AbortController().signal),
		).resolves.toMatchObject({ columns: ['?column?'], rows: [[1]], truncated: false });
		executor.terminate();
	});

	it('preserves duplicate columns and enforces row and byte bounds', async () => {
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request = queryRequest(
			connection,
			'SELECT value AS duplicate, value + 1 AS duplicate FROM generate_series(1, 3) AS value',
		);

		await expect(
			executor.execute(
				{ ...request, limits: { ...request.limits, maxRows: 1 } },
				new AbortController().signal,
			),
		).resolves.toEqual({ columns: ['duplicate', 'duplicate'], rows: [[1, 2]], truncated: true });
		await expect(
			executor.execute(
				{ ...request, limits: { ...request.limits, maxBytes: 55 } },
				new AbortController().signal,
			),
		).resolves.toMatchObject({ rows: [], truncated: true });
		executor.terminate();
	});

	it('stops buffering wide rows when the byte budget is reached', async () => {
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request = queryRequest(
			connection,
			"SELECT repeat('x', 1024 * 1024) AS value FROM generate_series(1, 100)",
		);

		await expect(
			executor.execute(
				{ ...request, limits: { ...request.limits, maxRows: 100, maxBytes: 2_200_000 } },
				new AbortController().signal,
			),
		).resolves.toMatchObject({ rows: [expect.any(Array), expect.any(Array)], truncated: true });
		executor.terminate();
	});

	it('returns SQLSTATE and adjusted character position without provider text', async () => {
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request = queryRequest(connection, 'SELECT 1 + FROM sales.orders');

		await expect(executor.execute(request, new AbortController().signal)).rejects.toThrow(
			/PostgreSQL rejected this read-only query \(SQLSTATE 42601 at character [0-9]+\)\./,
		);
		executor.terminate();
	});

	it('blocks data-modifying CTEs for a role that otherwise has write access', async () => {
		const writer = {
			...connection,
			username: 'hub_writer',
			password: 'writerpass',
		};
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request: DataQueryExecution = {
			sql: 'WITH removed AS (DELETE FROM sales.orders RETURNING *) SELECT * FROM removed',
			connection: {
				files: [],
				vars: {},
				integration: { id: 'test' as never, name: 'test', kind: 'postgres', version: 1 },
				plan: { engine: 'postgres', connection: writer },
			},
			accessMode: 'read-only',
			limits: { maxRows: 10, maxBytes: 64 * 1024, deadlineMs: 5_000 },
		};

		await expect(executor.execute(request, new AbortController().signal)).rejects.toThrow(
			'read-only query',
		);
		const observer = new Client({
			host: '127.0.0.1',
			port,
			database: 'hubtest',
			user: 'postgres',
			password: 'adminpass',
		});
		await observer.connect();
		const result = await observer.query('SELECT count(*)::int AS count FROM sales.orders');
		await observer.end();
		expect(result.rows[0].count).toBe(1);
	});

	it('terminates a sleeping backend within two seconds', async () => {
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request: DataQueryExecution = {
			sql: 'SELECT pg_sleep(30)',
			connection: {
				files: [],
				vars: {},
				integration: { id: 'test' as never, name: 'test', kind: 'postgres', version: 1 },
				plan: { engine: 'postgres', connection: cancellationConnection },
			},
			accessMode: 'read-only',
			limits: { maxRows: 10, maxBytes: 64 * 1024, deadlineMs: 35_000 },
		};
		const running = executor.execute(request, new AbortController().signal);
		const observer = new Client({
			host: '127.0.0.1',
			port,
			database: 'hubtest',
			user: 'postgres',
			password: 'adminpass',
		});
		await observer.connect();
		await waitForBackend(observer, true);

		executor.terminate();
		await expect(running).rejects.toThrow();
		await waitForBackend(observer, false);
		await observer.end();
	});
});

async function waitForBackend(client: InstanceType<typeof pg.Client>, present: boolean) {
	const deadline = Date.now() + 2_000;
	do {
		const result = await client.query(
			"SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'marimohub-data-browser'",
		);
		if (result.rows[0].count > 0 === present) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	} while (Date.now() < deadline);
	throw new Error(
		`PostgreSQL backend presence did not become ${String(present)} within two seconds.`,
	);
}

function queryRequest(connection: PostgresConnectionCapability, sql: string): DataQueryExecution {
	return {
		sql,
		connection: {
			files: [],
			vars: {},
			integration: { id: 'test' as never, name: 'test', kind: 'postgres', version: 1 },
			plan: { engine: 'postgres', connection },
		},
		accessMode: 'read-only',
		limits: { maxRows: 10, maxBytes: 64 * 1024, deadlineMs: 5_000 },
	};
}
