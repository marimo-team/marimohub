import { z } from 'zod';
import { INTEGRATIONS_DIR } from '../bundle';
import { defineIntegration, envSegment, HOSTNAME_REGEX } from '../sdk';
import {
	caFields,
	DEFAULT_CA_PATH,
	discoveryEnvField,
	portField,
	SQL_CONNECTION_HINTS,
	sqlCredentials,
	validateCaFields,
} from './common';

// The shared host shape covers names and IPv4 literals only; a Postgres server
// may sit on a bare IPv6 address. The regex is the security boundary and nothing
// more: hex digits, colons and dotted-quad dots are the entire alphabet, so no
// host — well formed or not — can smuggle URL structure (scheme, port, path,
// userinfo, brackets, whitespace) into the rendered DSN. `isPgHost` then decides
// whether those characters actually spell an address. Splitting it this way is
// deliberate: counting groups around the single `::` and allowing the IPv4 tail
// in exactly the trailing position is where hand-rolled IPv6 alternations go
// wrong, and a wrong parser here costs a usability bug, never an injection.
const PG_HOST_REGEX = new RegExp(`${HOSTNAME_REGEX.source}|^[0-9A-Fa-f.:]+$`);

const IPV6_WORDS = 8;
const HEX_GROUP_REGEX = /^[0-9A-Fa-f]{1,4}$/;
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4_REGEX = new RegExp(String.raw`^${OCTET}(?:\.${OCTET}){3}$`);

/** 16-bit words a piece stands for, or `null` if it is not a legal piece. */
function pieceWords(piece: string, isTrailing: boolean): number | null {
	// `::ffff:192.0.2.128` and friends spell the low 32 bits as IPv4, which is how
	// a dual-stack address is normally written — but only as the final piece.
	if (isTrailing && piece.includes('.')) return IPV4_REGEX.test(piece) ? 2 : null;
	return HEX_GROUP_REGEX.test(piece) ? 1 : null;
}

function isIpv6Literal(host: string): boolean {
	const halves = host.split('::');
	// A zone id (`%eth0`) is excluded by the regex above: it has no unescaped
	// spelling inside a URL authority.
	if (halves.length > 2) return false;
	const compressed = halves.length === 2;
	let words = 0;
	for (const [halfIndex, half] of halves.entries()) {
		if (half === '') continue;
		const pieces = half.split(':');
		for (const [index, piece] of pieces.entries()) {
			const isTrailing = halfIndex === halves.length - 1 && index === pieces.length - 1;
			const count = pieceWords(piece, isTrailing);
			if (count === null) return false;
			words += count;
		}
	}
	// `::` stands for at least one omitted zero word, so a compressed address that
	// already spells all eight is not compressed at all.
	return compressed ? words < IPV6_WORDS : words === IPV6_WORDS;
}

function isPgHost(host: string): boolean {
	return host.includes(':') ? isIpv6Literal(host) : HOSTNAME_REGEX.test(host);
}

// A verifying sslmode with no `sslrootcert` makes libpq read
// `~/.postgresql/root.crt`, which no sandbox image ships, so the connection fails
// before reaching the server. libpq 16+ accepts `sslrootcert=system`, but that
// resolves through OpenSSL's compiled-in default paths, and psycopg2-binary
// bundles an OpenSSL whose defaults point at the wheel builder's scratch
// directory (`/host/tmp/libpq.build/certs`) — so `system` fails to verify too.
// Naming a bundle is what makes `verify-full` usable as the default.

// `require` encrypts but authenticates nothing: any server that completes the
// handshake is accepted, so it stays available as an explicit choice while new
// connections default to full verification.
const sslSchema = z
	.discriminatedUnion('mode', [
		z.strictObject({ mode: z.literal('disable') }),
		z.strictObject({ mode: z.literal('prefer') }),
		z.strictObject({ mode: z.literal('require') }),
		z.strictObject({ mode: z.literal('verify-ca'), ...caFields }),
		z.strictObject({ mode: z.literal('verify-full'), ...caFields }),
	])
	.default({ mode: 'verify-full' })
	.describe('libpq sslmode; `verify-full` checks the CA chain and the hostname');

const pgConfig = z.strictObject({
	host: z
		.string()
		.regex(PG_HOST_REGEX, {
			error: 'Hostname or IP literal only — no scheme, port, path, or credentials',
			abort: true,
		})
		.refine(isPgHost, 'Not a valid hostname or IP literal')
		.describe('Server hostname, e.g. db.internal'),
	port: portField(5432),
	database: z.string().min(1),
	...sqlCredentials,
	ssl: sslSchema,
	ambient_env: discoveryEnvField('PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, and PGSSLMODE'),
});

export const postgres = defineIntegration({
	kind: 'postgres',
	title: 'PostgreSQL',
	description: 'Direct Postgres connection for SQL cells and SQLAlchemy.',
	category: 'database',
	brand: { icon: 'postgresql', color: '#4169E1' },
	schemaVersion: 2,
	migrations: [
		{
			from: 1,
			to: 2,
			description: 'Replace the boolean ssl flag with an explicit libpq sslmode object.',
		},
	],
	configSchema: pgConfig,
	environmentVariables: [
		'PGHOST',
		'PGPORT',
		'PGDATABASE',
		'PGUSER',
		'PGPASSWORD',
		'PGSSLMODE',
		'PGSSLROOTCERT',
	],
	// The rendered URL uses the plain `postgresql://` scheme, which SQLAlchemy
	// resolves via psycopg2.
	requirements: ['sqlalchemy>=2', 'psycopg2-binary>=2.9'],
	uiHints: {
		...SQL_CONNECTION_HINTS,
		ssl: { group: 'Connection', order: 4 },
		'ssl.ca_bundle': { widget: 'textarea' },
		ambient_env: { group: 'Discovery', order: 60, widget: 'toggle' },
	},

	validate(config) {
		if ('ca_path' in config.ssl) validateCaFields(config.ssl, 'ssl');
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
		const verifies = config.ssl.mode === 'verify-ca' || config.ssl.mode === 'verify-full';
		let caPath: string | undefined;
		if (caBundle) {
			caPath = `${INTEGRATIONS_DIR}/postgres/${instanceName}-ca.pem`;
			files.push({ path: `postgres/${instanceName}-ca.pem`, content: caBundle });
		} else if (verifies) {
			caPath = ('ca_path' in config.ssl ? config.ssl.ca_path : undefined) ?? DEFAULT_CA_PATH;
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
			// libpq reads these TLS variables for parameters marimo's discovered
			// connection leaves unspecified, preserving the configured verification.
			discoveryEnv: config.ambient_env
				? {
						PGHOST: config.host,
						PGPORT: String(config.port),
						PGDATABASE: config.database,
						PGUSER: config.username,
						PGPASSWORD: config.password,
						PGSSLMODE: config.ssl.mode,
						...(caPath ? { PGSSLROOTCERT: caPath } : {}),
					}
				: {},
			files,
			manifestExtra: { host: config.host, database: config.database },
		};
	},
});
