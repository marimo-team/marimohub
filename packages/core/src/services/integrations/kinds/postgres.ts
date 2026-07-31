import { z } from 'zod';
import { INTEGRATIONS_DIR } from '../bundle';
import { defineIntegration, envSegment, HOSTNAME_REGEX } from '../sdk';
import { zSecret } from '../secretFields';

// The shared host shape covers names and IPv4 literals only; a Postgres server
// may sit on a bare IPv6 address. Hex groups and colons only, so an address
// still cannot smuggle extra URL structure into the rendered DSN.
const HEX_GROUP = '[0-9A-Fa-f]{1,4}';
const IPV6_ALTERNATIVES = [
	`(?:${HEX_GROUP}:){7}${HEX_GROUP}`,
	`(?:${HEX_GROUP}:){1,7}:`,
	`(?:${HEX_GROUP}:){1,6}:${HEX_GROUP}`,
	`(?:${HEX_GROUP}:){1,5}(?::${HEX_GROUP}){1,2}`,
	`(?:${HEX_GROUP}:){1,4}(?::${HEX_GROUP}){1,3}`,
	`(?:${HEX_GROUP}:){1,3}(?::${HEX_GROUP}){1,4}`,
	`(?:${HEX_GROUP}:){1,2}(?::${HEX_GROUP}){1,5}`,
	`${HEX_GROUP}:(?::${HEX_GROUP}){1,6}`,
	`:(?:(?::${HEX_GROUP}){1,7}|:)`,
].join('|');
const PG_HOST_REGEX = new RegExp(`${HOSTNAME_REGEX.source}|^(?:${IPV6_ALTERNATIVES})$`);

// `require` encrypts but authenticates nothing: any server that completes the
// handshake is accepted, so it stays available as an explicit choice while new
// connections default to full verification.
const sslSchema = z
	.discriminatedUnion('mode', [
		z.object({ mode: z.literal('disable') }),
		z.object({ mode: z.literal('prefer') }),
		z.object({ mode: z.literal('require') }),
		z.object({
			mode: z.literal('verify-ca'),
			ca_bundle: z.string().min(1).optional(),
		}),
		z.object({
			mode: z.literal('verify-full'),
			ca_bundle: z.string().min(1).optional(),
		}),
	])
	.default({ mode: 'verify-full' })
	.describe('libpq sslmode; `verify-full` checks the CA chain and the hostname');

const pgConfig = z.object({
	host: z
		.string()
		.regex(PG_HOST_REGEX, 'Hostname or IP literal only — no scheme, port, path, or credentials')
		.describe('Server hostname, e.g. db.internal'),
	port: z.number().int().min(1).max(65535).default(5432),
	database: z.string().min(1),
	username: z.string().min(1),
	password: zSecret().describe('Password for the database user'),
	ssl: sslSchema,
});

export const postgres = defineIntegration({
	kind: 'postgres',
	title: 'PostgreSQL',
	description: 'Direct Postgres connection for SQL cells and SQLAlchemy.',
	category: 'database',
	schemaVersion: 2,
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
		ssl: { group: 'Connection', order: 4 },
		'ssl.ca_bundle': { widget: 'textarea' },
	},

	migrate(stored, fromVersion) {
		if (fromVersion !== 1 || typeof stored !== 'object' || stored === null) return stored;
		const next = structuredClone(stored) as Record<string, unknown>;
		// v1 `ssl` was a boolean: true rendered `sslmode=require`, false rendered
		// no sslmode at all (libpq's `prefer`). Carry both across verbatim rather
		// than silently tightening a live connection to full verification.
		if (next.ssl === true || next.ssl === undefined) next.ssl = { mode: 'require' };
		else if (next.ssl === false) next.ssl = { mode: 'prefer' };
		return next;
	},

	render({ config, instanceName }) {
		const seg = envSegment(instanceName);
		const auth = `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}`;
		const files: { path: string; content: string }[] = [];
		const caBundle = 'ca_bundle' in config.ssl ? config.ssl.ca_bundle : undefined;
		let caPath: string | undefined;
		if (caBundle) {
			caPath = `${INTEGRATIONS_DIR}/postgres/${instanceName}-ca.pem`;
			files.push({ path: `postgres/${instanceName}-ca.pem`, content: caBundle });
		}
		const query = new URLSearchParams({ sslmode: config.ssl.mode });
		if (caPath) query.set('sslrootcert', caPath);
		// IPv6 literals need brackets to be a legal URL authority.
		const authority = config.host.includes(':') ? `[${config.host}]` : config.host;
		const url =
			`postgresql://${auth}@${authority}:${config.port}` +
			`/${encodeURIComponent(config.database)}?${query}`;
		files.push({
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
					ssl: { mode: config.ssl.mode, ...(caPath ? { ca_path: caPath } : {}) },
				},
				null,
				'\t',
			)}\n`,
		});
		return {
			env: {
				[`MARIMOHUB_PG_${seg}_URL`]: url,
				[`MARIMOHUB_PG_${seg}_HOST`]: config.host,
				[`MARIMOHUB_PG_${seg}_PORT`]: String(config.port),
				[`MARIMOHUB_PG_${seg}_DATABASE`]: config.database,
				[`MARIMOHUB_PG_${seg}_USER`]: config.username,
				[`MARIMOHUB_PG_${seg}_PASSWORD`]: config.password,
			},
			files,
			manifestExtra: { host: config.host, database: config.database },
		};
	},
});
