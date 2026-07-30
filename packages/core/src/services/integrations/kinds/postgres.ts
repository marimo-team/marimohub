import { z } from 'zod';
import { defineIntegration, envSegment, HOSTNAME_REGEX } from '../sdk';
import { zSecret } from '../secretFields';

const pgConfig = z.object({
	host: z
		.string()
		.regex(HOSTNAME_REGEX, 'Hostname only — no scheme, port, path, or credentials')
		.describe('Server hostname, e.g. db.internal'),
	port: z.number().int().min(1).max(65535).default(5432),
	database: z.string().min(1),
	username: z.string().min(1),
	password: zSecret().describe('Password for the database user'),
	ssl: z.boolean().default(true).describe('Require TLS (sslmode=require)'),
});

export const postgres = defineIntegration({
	kind: 'postgres',
	title: 'PostgreSQL',
	description: 'Direct Postgres connection for SQL cells and SQLAlchemy.',
	category: 'database',
	schemaVersion: 1,
	configSchema: pgConfig,
	// The rendered URL uses the plain `postgresql://` scheme, which SQLAlchemy
	// resolves via psycopg2.
	requirements: ['sqlalchemy>=2', 'psycopg2-binary>=2.9'],
	uiHints: {
		host: { group: 'Connection', order: 1 },
		port: { group: 'Connection', order: 2, widget: 'number' },
		database: { group: 'Connection', order: 3 },
		username: { group: 'Authentication', order: 10 },
		password: { group: 'Authentication', order: 11, widget: 'password' },
		ssl: { group: 'Connection', order: 4, widget: 'toggle' },
	},

	render({ config, instanceName }) {
		const seg = envSegment(instanceName);
		const auth = `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}`;
		const query = config.ssl ? '?sslmode=require' : '';
		const url =
			`postgresql://${auth}@${config.host}:${config.port}` +
			`/${encodeURIComponent(config.database)}${query}`;
		return {
			env: {
				[`MARIMOHUB_PG_${seg}_URL`]: url,
				[`MARIMOHUB_PG_${seg}_HOST`]: config.host,
				[`MARIMOHUB_PG_${seg}_PORT`]: String(config.port),
				[`MARIMOHUB_PG_${seg}_DATABASE`]: config.database,
				[`MARIMOHUB_PG_${seg}_USER`]: config.username,
				[`MARIMOHUB_PG_${seg}_PASSWORD`]: config.password,
			},
			files: [
				{
					// Secret-free descriptor: points at the env vars rather than
					// embedding the password, so notebook code can introspect safely.
					path: `postgres/${instanceName}.json`,
					content: `${JSON.stringify(
						{
							host: config.host,
							port: config.port,
							database: config.database,
							username: config.username,
							password_env: `MARIMOHUB_PG_${seg}_PASSWORD`,
							url_env: `MARIMOHUB_PG_${seg}_URL`,
							ssl: config.ssl,
						},
						null,
						'\t',
					)}\n`,
				},
			],
			manifestExtra: { host: config.host, database: config.database },
		};
	},
});
