import { z } from 'zod';
import { defineIntegration, probeEndpoint } from '../sdk';
import { zSecret } from '../secretFields';
import { connectionUrl, hostField, renderConnection } from './common';

const HTTP_PATH_REGEX = /^\/[A-Za-z0-9._\-/]+$/;

const authSchema = z.discriminatedUnion('method', [
	z.object({ method: z.literal('personal_access_token'), token: zSecret() }),
	z.object({
		method: z.literal('oauth_m2m'),
		client_id: z.string().min(1),
		client_secret: zSecret(),
	}),
]);

const databricksConfig = z.object({
	host: hostField('Workspace hostname, e.g. dbc-1234abcd-5678.cloud.databricks.com'),
	http_path: z
		.string()
		.regex(HTTP_PATH_REGEX, 'Absolute warehouse path, e.g. /sql/1.0/warehouses/abc123')
		.describe('SQL warehouse or cluster HTTP path'),
	auth: authSchema,
	catalog: z.string().min(1).optional().describe('Unity Catalog name for unqualified tables'),
	schema: z.string().min(1).optional().describe('Session default schema'),
});

export const databricks = defineIntegration({
	kind: 'databricks',
	title: 'Databricks SQL',
	description: 'Databricks SQL warehouse connection for SQL cells and SQLAlchemy.',
	category: 'engine',
	brand: { icon: 'databricks', color: '#FF3621' },
	schemaVersion: 1,
	configSchema: databricksConfig,
	requirements: ['databricks-sql-connector>=3.4', 'databricks-sqlalchemy>=1.0'],
	uiHints: {
		host: { group: 'Connection', order: 1 },
		http_path: { group: 'Connection', order: 2 },
		auth: { group: 'Authentication', order: 10 },
		'auth.token': { widget: 'password' },
		'auth.client_secret': { widget: 'password' },
		catalog: { group: 'Defaults', order: 20 },
		schema: { group: 'Defaults', order: 21 },
	},

	render({ config, instanceName }) {
		// The SQLAlchemy dialect only spells token auth in a URL; an OAuth
		// service principal is passed to `sql.connect()` from the env vars.
		const url =
			config.auth.method === 'personal_access_token'
				? connectionUrl({
						scheme: 'databricks',
						host: config.host,
						port: 443,
						username: 'token',
						password: config.auth.token,
						segments: [config.schema],
						query: { http_path: config.http_path, catalog: config.catalog },
					})
				: undefined;
		return renderConnection({
			tool: 'DATABRICKS',
			dir: 'databricks',
			instanceName,
			fields: {
				URL: url,
				HOST: config.host,
				HTTP_PATH: config.http_path,
				TOKEN: config.auth.method === 'personal_access_token' ? config.auth.token : undefined,
				CLIENT_ID: config.auth.method === 'oauth_m2m' ? config.auth.client_id : undefined,
				CLIENT_SECRET: config.auth.method === 'oauth_m2m' ? config.auth.client_secret : undefined,
				CATALOG: config.catalog,
				SCHEMA: config.schema,
			},
			secretFields: ['URL', 'TOKEN', 'CLIENT_SECRET'],
			descriptor: { auth_method: config.auth.method, server_hostname: config.host },
			manifestExtra: { host: config.host, auth_method: config.auth.method },
		});
	},

	testConnection(config, probe) {
		if (config.auth.method === 'oauth_m2m') {
			return Promise.resolve({
				ok: false,
				latency_ms: 0,
				details: 'OAuth service principals can only be exercised inside the sandbox',
			});
		}
		return probeEndpoint({
			probe,
			url: `https://${config.host}/api/2.0/preview/scim/v2/Me`,
			init: { headers: { Authorization: `Bearer ${config.auth.token}` } },
			carriesSecrets: true,
			describe(body) {
				const user = (body as { userName?: string } | undefined)?.userName;
				return user ? `authenticated as ${user}` : 'authenticated';
			},
		});
	},
});
