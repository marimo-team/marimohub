import { z } from 'zod';
import { UnavailableError, ValidationError } from '../../../errors';
import type { BrowsePageRequest, IntegrationProbe } from '../../../ports/integrations';
import { basicAuthHeader, defineIntegration, envSegment, probeEndpoint } from '../sdk';
import { zSecret } from '../secretFields';
import {
	connectionUrl,
	hostField,
	portField,
	renderSqlConnection,
	SQL_CONNECTION_HINTS,
} from './common';

const clickhouseConfig = z.strictObject({
	host: hostField('Server hostname, e.g. abc123.us-east-1.aws.clickhouse.cloud'),
	port: portField(8443).describe('HTTP interface port'),
	secure: z.boolean().default(true).describe('Use HTTPS for the HTTP interface'),
	verify: z
		.boolean()
		.default(true)
		.describe('Verify the server certificate (clickhouse-connect `verify`)'),
	database: z.string().min(1).default('default'),
	username: z.string().min(1).default('default'),
	password: zSecret().optional().describe('Omit for a user with no password'),
});

export const clickhouse = defineIntegration({
	kind: 'clickhouse',
	title: 'ClickHouse',
	description: 'ClickHouse HTTP interface for clickhouse-connect and SQLAlchemy.',
	category: 'database',
	brand: { icon: 'clickhouse', color: '#FFCC01' },
	schemaVersion: 1,
	configSchema: clickhouseConfig,
	requirements: ['clickhouse-connect>=0.8'],
	uiHints: {
		...SQL_CONNECTION_HINTS,
		secure: { group: 'Connection', order: 3, widget: 'toggle' },
		database: { group: 'Connection', order: 4 },
		verify: { group: 'Connection', order: 5, widget: 'toggle', advanced: true },
	},

	render({ config, instanceName }) {
		const url = connectionUrl({
			scheme: 'clickhouse+http',
			host: config.host,
			port: config.port,
			segments: [config.database],
			username: config.username,
			password: config.password,
			query: { protocol: config.secure ? 'https' : 'http' },
		});
		return renderSqlConnection({
			tool: 'CLICKHOUSE',
			dir: 'clickhouse',
			instanceName,
			url,
			config,
			fields: { SECURE: config.secure },
			descriptor: { verify: config.verify },
		});
	},

	testConnection(config, probe) {
		const scheme = config.secure ? 'https' : 'http';
		const query = new URLSearchParams({
			query: 'SELECT version() AS version FORMAT JSON',
			database: config.database,
		});
		return probeEndpoint({
			probe,
			url: `${scheme}://${config.host}:${config.port}/?${query}`,
			init: {
				headers: { Authorization: basicAuthHeader(config.username, config.password ?? '') },
			},
			carriesSecrets: config.password !== undefined,
			describe(body) {
				const version = (body as { data?: { version?: string }[] } | undefined)?.data?.[0]?.version;
				return version ? `ClickHouse ${version}` : 'reachable';
			},
		});
	},

	browse: {
		available(config) {
			if (!config.verify && config.secure) {
				return {
					ok: false,
					reason: 'disabled TLS verification can only be exercised inside the sandbox',
				};
			}
			if (!config.secure && config.password !== undefined) {
				return { ok: false, reason: 'password authentication requires HTTPS for hub browsing' };
			}
			return { ok: true };
		},
		async listNamespaces(config, probe, request) {
			if (request.parent) return { items: [], next_cursor: null };
			const result = await clickhouseQuery(config, probe, 'SHOW DATABASES');
			return page(
				result.rows.map((row) => [String(row[0])]),
				request,
			);
		},
		async listTables(config, probe, namespace, request) {
			if (namespace.length !== 1) return { items: [], next_cursor: null };
			const result = await clickhouseQuery(
				config,
				probe,
				`SHOW TABLES FROM ${quoteIdentifier(namespace[0])}`,
			);
			return page(
				result.rows.map((row) => String(row[0])),
				request,
			);
		},
		async getTableSchema(config, probe, namespace, table, _request) {
			if (namespace.length !== 1) throw new ValidationError('ClickHouse tables need one database.');
			const result = await clickhouseQuery(
				config,
				probe,
				`DESCRIBE TABLE ${qualifiedName([...namespace, table])}`,
			);
			const name = result.columns.indexOf('name');
			const type = result.columns.indexOf('type');
			const comment = result.columns.indexOf('comment');
			if (name === -1 || type === -1)
				throw new UnavailableError('ClickHouse returned an invalid schema.');
			return {
				columns: result.rows.map((row) => {
					if (typeof row[name] !== 'string' || typeof row[type] !== 'string') {
						throw new UnavailableError('ClickHouse returned an invalid schema.');
					}
					const renderedType = row[type];
					const renderedComment =
						comment === -1 || typeof row[comment] !== 'string' ? '' : row[comment];
					return {
						name: row[name],
						type: renderedType,
						nullable: renderedType.startsWith('Nullable('),
						...(renderedComment ? { comment: renderedComment } : {}),
					};
				}),
			};
		},
		snippet(instanceName, namespace, table) {
			const env = `MARIMOHUB_CLICKHOUSE_${envSegment(instanceName)}_URL`;
			const sql = `SELECT * FROM ${qualifiedName([...namespace, table])} LIMIT 100`;
			return [
				'import os',
				'from sqlalchemy import create_engine',
				'',
				`engine = create_engine(os.environ[${JSON.stringify(env)}])`,
				`df = mo.sql(${JSON.stringify(sql)}, engine=engine)`,
				'df',
			].join('\n');
		},
		async previewRows(config, probe, namespace, table, request) {
			if (namespace.length !== 1) throw new ValidationError('ClickHouse tables need one database.');
			const result = await clickhouseQuery(
				config,
				probe,
				`SELECT * FROM ${qualifiedName([...namespace, table])} LIMIT ${request.limit}`,
			);
			return { columns: result.columns, rows: result.rows };
		},
	},
});

interface ClickHouseResult {
	columns: string[];
	rows: unknown[][];
}

async function clickhouseQuery(
	config: z.infer<typeof clickhouseConfig>,
	probe: IntegrationProbe,
	query: string,
): Promise<ClickHouseResult> {
	const url = new URL(`${config.secure ? 'https' : 'http'}://${config.host}:${config.port}/`);
	url.searchParams.set('database', config.database);
	url.searchParams.set('wait_end_of_query', '1');
	url.searchParams.set('query', `${query} FORMAT JSONCompact`);
	const response = await probe.fetch(url.toString(), {
		method: 'GET',
		headers: { Authorization: basicAuthHeader(config.username, config.password ?? '') },
	});
	if (!response.ok) throw new UnavailableError(`ClickHouse answered HTTP ${response.status}.`);
	const body = await response.json();
	if (!isRecord(body) || !Array.isArray(body.meta) || !Array.isArray(body.data)) {
		throw new UnavailableError('ClickHouse returned an invalid result.');
	}
	const columns = body.meta.map((column) =>
		isRecord(column) && typeof column.name === 'string' ? column.name : undefined,
	);
	if (columns.some((column) => column === undefined)) {
		throw new UnavailableError('ClickHouse returned an invalid result.');
	}
	if (!body.data.every((row) => Array.isArray(row) && row.length === columns.length)) {
		throw new UnavailableError('ClickHouse returned an invalid result.');
	}
	return { columns: columns as string[], rows: body.data as unknown[][] };
}

function page<T>(items: T[], request: BrowsePageRequest) {
	const offset = request.cursor === undefined ? 0 : Number(request.cursor);
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new ValidationError('Invalid browse cursor.');
	const selected = items.slice(offset, offset + request.limit);
	const next = offset + selected.length;
	return { items: selected, next_cursor: next < items.length ? String(next) : null };
}

function qualifiedName(parts: string[]): string {
	return parts.map(quoteIdentifier).join('.');
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
