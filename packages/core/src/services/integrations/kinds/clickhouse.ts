import { z } from 'zod';
import { basicAuthHeader, defineIntegration, probeEndpoint } from '../sdk';
import { zSecret } from '../secretFields';
import {
	connectionUrl,
	hostField,
	portField,
	renderSqlConnection,
	SQL_CONNECTION_HINTS,
} from './common';

const clickhouseConfig = z.object({
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
});
