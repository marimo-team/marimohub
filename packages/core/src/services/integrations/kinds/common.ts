// Shared pieces for connection-shaped kinds: the sandbox contract they all
// render, URL assembly, and the TLS trust material several of them accept.
import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { UiHints } from '../../../ports/integrations';
import { parseHttpUrl } from '../../../url';
import { INTEGRATIONS_DIR } from '../bundle';
import { envSegment, HOSTNAME_REGEX } from '../sdk';
import type { RenderOutput } from '../sdk';
import { zSecret } from '../secretFields';

/** Bare server hostname for a kind that renders it into a URL authority. */
export const hostField = (description: string) =>
	z
		.string()
		.regex(HOSTNAME_REGEX, 'Hostname only — no scheme, port, path, or credentials')
		.describe(description);

export const portField = (fallback: number) => z.number().int().min(1).max(65535).default(fallback);

/** The credential pair a SQL database takes when it authenticates by password. */
export const sqlCredentials = {
	username: z.string().min(1),
	password: zSecret().describe('Password for the database user'),
};

/** Form layout shared by the host/port/database/username/password kinds. */
export const SQL_CONNECTION_HINTS: UiHints = {
	host: { group: 'Connection', order: 1 },
	port: { group: 'Connection', order: 2, widget: 'number' },
	database: { group: 'Connection', order: 3 },
	username: { group: 'Authentication', order: 10 },
	password: { group: 'Authentication', order: 11, widget: 'password' },
};

/**
 * An http(s) URL with no userinfo, so a configured endpoint cannot smuggle
 * credentials (or whitespace, which splits a request line) into anything the
 * hub renders or probes.
 */
export const HTTP_URL_REGEX = /^https?:\/\/[^@\s/?#]+(?:[/?#]\S*)?$/;

/**
 * The same, minus a query or fragment: for a base URL the runtime appends a
 * path to, where `?`/`#` would push that path into the query string.
 */
export const SERVICE_URL_REGEX = /^https?:\/\/[^@\s/?#]+(?:\/[^\s?#]*)?$/;

/** RFC 9110 token grammar used by HTTP field names. */
export const HTTP_HEADER_NAME_REGEX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The shape above is what the form checks as you type; this is the one that
 * decides a save, because it can use the URL parser and a pattern cannot.
 *
 * - `https:///api` has an empty authority, which WHATWG parsing resolves to the
 *   host `api` — a different server than the operator typed, and one that would
 *   receive whatever credential the endpoint carries.
 * - `https://host:65536` and `https://%zz` fail to parse at all, so they would
 *   surface as a connection test dying inside {@link serviceUrl} rather than as
 *   the configuration error they are.
 * - Port 0 parses but cannot be connected to.
 */
function isUsableUrl(value: string): boolean {
	if (/^https?:\/\/\//.test(value)) return false;
	const parsed = parseHttpUrl(value);
	return parsed.ok && parsed.url.port !== '0';
}

export const httpUrlField = () =>
	z
		.string()
		.regex(HTTP_URL_REGEX, 'Must be an http(s) URL without embedded credentials')
		.refine(isUsableUrl, 'Not a reachable http(s) URL')
		.meta({
			format: 'uri',
			'x-marimohub-refinement': 'A valid http(s) URL with an authority, no userinfo, and no port 0',
		});

export function isInsecureHttpUrl(value: string | undefined): boolean {
	if (value === undefined) return false;
	try {
		return new URL(value).protocol === 'http:';
	} catch {
		return false;
	}
}

export function usesInsecureAuthenticatedS3({
	endpoint,
	authenticated,
	allowInsecureTransport,
}: {
	endpoint: string | undefined;
	authenticated: boolean;
	allowInsecureTransport: boolean;
}): boolean {
	return authenticated && !allowInsecureTransport && isInsecureHttpUrl(endpoint);
}

export const serviceUrlField = () =>
	z
		.string()
		.regex(SERVICE_URL_REGEX, 'Must be an http(s) URL with no credentials, query, or fragment')
		.refine(isUsableUrl, 'Not a reachable http(s) URL')
		.meta({
			format: 'uri',
			'x-marimohub-refinement':
				'A valid http(s) base URL with an authority, no userinfo, query, fragment, or port 0',
		});

/** Appends a path to a configured base URL, tolerating a trailing slash. */
export function serviceUrl(base: string, path: string): string {
	const url = new URL(base);
	url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
	return url.toString();
}

/** Region name only, so one can be interpolated into a rendered AWS endpoint. */
export const AWS_REGION_REGEX = /^[a-z0-9-]+$/;

/**
 * Rules both stores share: start and end alphanumeric, no adjacent dots, and
 * not shaped like an IPv4 address. Rejecting these at save time turns a typo
 * into a form error instead of a runtime failure the notebook hits later.
 *
 * Each store gets its own regex because the rest genuinely differs, and a
 * validator that rejects a real bucket is worse than one that misses a bad
 * name: GCS allows an underscore, and a dotted GCS name may run to 222
 * characters as long as every dot-separated part stays within 63.
 */
export const S3_BUCKET_REGEX = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/** `goog` and `google` are reserved by Google, so such a bucket cannot exist. */
export const GCS_BUCKET_REGEX = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;

export function isValidS3Bucket(value: string): boolean {
	return (
		value.length >= 3 &&
		value.length <= 63 &&
		S3_BUCKET_REGEX.test(value) &&
		!value.includes('..') &&
		!isIpv4Address(value)
	);
}

export function isIpv4Address(value: string): boolean {
	const octets = value.split('.');
	return (
		octets.length === 4 &&
		octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
	);
}

export function isIpAddressHost(hostname: string): boolean {
	return hostname.includes(':') || isIpv4Address(hostname);
}

export function isValidGcsBucket(value: string): boolean {
	return (
		value.length >= 3 &&
		value.length <= 222 &&
		GCS_BUCKET_REGEX.test(value) &&
		!value.includes('..') &&
		!value.startsWith('goog') &&
		!value.includes('google') &&
		value.split('.').every((part) => part.length <= 63) &&
		!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
	);
}

const BROKER_BUCKET_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/;

export const s3BrokerReadLocationSchema = z
	.strictObject({
		bucket: z.string().min(1).max(255),
		prefix: z.string().min(1),
	})
	.superRefine((location, context) => {
		const prefix = normalizeBrokerPrefix(location.prefix);
		if (hasUnpairedSurrogate(location.prefix)) {
			context.addIssue({
				code: 'custom',
				path: ['prefix'],
				message: 'S3 broker read location prefixes must contain valid Unicode text.',
			});
			return;
		}
		const unsafeBucket =
			!BROKER_BUCKET_REGEX.test(location.bucket) ||
			location.bucket === '.' ||
			location.bucket === '..';
		const unsafePrefix =
			!prefix ||
			location.prefix.includes('\\') ||
			/%2f|%5c/i.test(location.prefix) ||
			hasControlCharacter(location.prefix) ||
			prefix.split('/').some((segment) => segment === '.' || segment === '..');
		if (unsafeBucket || unsafePrefix) {
			context.addIssue({
				code: 'custom',
				message: 'S3 broker read locations require a valid bucket and non-traversing prefix.',
			});
		}
	});

export const s3BrokerReadLocationsSchema = z
	.array(s3BrokerReadLocationSchema)
	.superRefine((locations, context) => {
		const seen = new Set<string>();
		for (const [index, location] of locations.entries()) {
			const key = `${location.bucket}\0${normalizeBrokerPrefix(location.prefix)}`;
			if (seen.has(key)) {
				context.addIssue({
					code: 'custom',
					path: [index],
					message: 'S3 broker read locations must not contain duplicate bucket prefixes.',
				});
			}
			seen.add(key);
		}
	});

export function normalizeBrokerPrefix(prefix: string): string {
	return prefix.replaceAll(/^\/+|\/+$/g, '');
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 || codePoint === 127) return true;
	}
	return false;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index++;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/**
 * CA bundle shipped by the images built in this repo, which are Debian-based.
 * A deployment may run any base image (RHEL keeps its bundle under
 * `/etc/pki/tls/certs`) and the `local` compute backend runs on the developer's
 * own machine, so every verifying kind also takes a `ca_path` override.
 */
export const DEFAULT_CA_PATH = '/etc/ssl/certs/ca-certificates.crt';

/** Trust material for a kind that verifies its server's certificate chain. */
export const caFields = {
	ca_bundle: z
		.string()
		.min(1)
		.optional()
		.describe('PEM CA bundle to trust, written into the session'),
	ca_path: z
		.string()
		.min(1)
		.optional()
		.describe(
			`Absolute path to a CA bundle the runtime already ships (default ${DEFAULT_CA_PATH})`,
		),
};

export interface CaFields {
	ca_bundle?: string;
	ca_path?: string;
}

export function validateCaFields(trust: CaFields, field: string): void {
	if (trust.ca_bundle !== undefined && trust.ca_path !== undefined) {
		throw new ValidationError(`Set only one of ${field}.ca_bundle or ${field}.ca_path`);
	}
	// A client library resolves a relative path from the kernel's working
	// directory, which is not the one the operator had in mind when typing it.
	if (
		trust.ca_path !== undefined &&
		(!trust.ca_path.startsWith('/') || trust.ca_path.split('/').includes('..'))
	) {
		throw new ValidationError(`${field}.ca_path must be an absolute path with no ".." segment`);
	}
}

/**
 * Queues a rendered file and returns the absolute path notebook code reads it
 * from. Rendered paths are relative to the integrations dir; only the sandbox
 * sees the absolute one.
 */
export function renderFile(
	files: { path: string; content: string }[],
	path: string,
	content: string,
): string {
	files.push({ path, content });
	return `${INTEGRATIONS_DIR}/${path}`;
}

/** Absolute path to the bundle to verify against, writing a pasted PEM out first. */
export function resolveCaPath(options: {
	trust: CaFields;
	dir: string;
	instanceName: string;
	files: { path: string; content: string }[];
}): string {
	const { trust, dir, instanceName, files } = options;
	if (trust.ca_bundle === undefined) return trust.ca_path ?? DEFAULT_CA_PATH;
	return renderFile(files, `${dir}/${instanceName}-ca.pem`, trust.ca_bundle);
}

/** The keys an AWS SDK reads for a long-lived (or session) key pair. */
export const awsStaticCredentials = {
	access_key_id: zSecret(),
	secret_access_key: zSecret(),
	session_token: zSecret().optional(),
};

/**
 * Credentials for an AWS SDK. `ambient` leaves the SDK's own provider chain
 * alone — the instance profile, or the federated credentials the hub injects
 * when workload identity is enabled.
 */
export const awsAuthSchema = z
	.discriminatedUnion('method', [
		z.strictObject({ method: z.literal('ambient') }),
		z.strictObject({ method: z.literal('static'), ...awsStaticCredentials }),
	])
	.default({ method: 'ambient' });

/**
 * Shared wording for the `ambient_env` switch on kinds whose clients read
 * credentials from the vendor's standard variables and take no explicit
 * connection argument.
 */
export const AMBIENT_ENV_DESCRIPTION =
	'Also export the vendor-standard variables so libraries pick this up with no ' +
	'configuration. Only one integration per session can claim them.';

/**
 * The same switch for a kind whose client takes an explicit URL: the standard
 * names are what marimo's data-source discovery scans for, so setting them is
 * what turns an integration into a one-click connection in the notebook UI.
 * The bundler chooses one connection when multiple instances request the same
 * names; every instance remains available through its namespaced variables.
 */
export const discoveryEnvField = (names: string) =>
	z
		.boolean()
		.default(true)
		.describe(
			`Automatically offer this connection in marimo's data-source discovery by exporting ${names}. ` +
				'If multiple integrations request the same variables, one is discovered and every connection ' +
				'remains available through its notebook snippet.',
		);

type FieldValue = string | number | boolean | undefined;

export interface ConnectionRender {
	/** Env infix: `MARIMOHUB_<TOOL>_<NAME>_<FIELD>`. */
	tool: string;
	/** Directory for this kind's rendered files, relative to the integrations dir. */
	dir: string;
	instanceName: string;
	/** Connection fields; `undefined` entries are dropped. */
	fields: Record<string, FieldValue>;
	/** Fields whose value is secret — the descriptor names their variable instead. */
	secretFields?: readonly string[];
	/** Extra descriptor entries. Never secret: the file is meant to be readable. */
	descriptor?: Record<string, unknown>;
	files?: { path: string; content: string }[];
	/** Vendor-standard names this instance claims in addition to its own. */
	ambient?: Record<string, string | undefined>;
	/** Vendor-standard names used only for marimo data-source discovery. */
	discovery?: Record<string, string | undefined>;
	warnings?: string[];
	manifestExtra?: Record<string, unknown>;
}

/**
 * The contract every connection-shaped kind renders: one env var per field,
 * plus `<dir>/<name>.json` describing the connection. The descriptor mirrors
 * each field under its lower-cased name — except a secret one, which appears as
 * `<field>_env` naming the variable that holds it, so notebook code can
 * introspect the connection without the file carrying the credential.
 */
export function renderConnection(spec: ConnectionRender): RenderOutput {
	const prefix = `MARIMOHUB_${spec.tool}_${envSegment(spec.instanceName)}`;
	const secret = new Set(spec.secretFields ?? []);
	const env: Record<string, string> = {};
	const descriptor: Record<string, unknown> = {};

	for (const [field, value] of Object.entries(spec.fields)) {
		if (value === undefined) continue;
		const name = `${prefix}_${field}`;
		env[name] = String(value);
		if (secret.has(field)) descriptor[`${field.toLowerCase()}_env`] = name;
		else descriptor[field.toLowerCase()] = value;
	}

	const ambient = Object.entries(spec.ambient ?? {}).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	);
	for (const [name, value] of ambient) env[name] = value;
	const discovery = Object.fromEntries(
		Object.entries(spec.discovery ?? {}).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);

	return {
		env,
		...(Object.keys(discovery).length > 0 ? { discoveryEnv: discovery } : {}),
		...(spec.warnings && spec.warnings.length > 0 ? { warnings: spec.warnings } : {}),
		files: [
			...(spec.files ?? []),
			{
				path: `${spec.dir}/${spec.instanceName}.json`,
				content: `${JSON.stringify(
					{
						...descriptor,
						...(ambient.length > 0 ? { ambient_env: ambient.map(([name]) => name) } : {}),
						...spec.descriptor,
					},
					null,
					'\t',
				)}\n`,
			},
		],
		manifestExtra: spec.manifestExtra,
	};
}

/**
 * {@link renderConnection} for a SQL database reached by URL. Fixes the field
 * set those kinds share, and with it the rule that the URL is as secret as the
 * password it embeds — a kind that spelled its own field map could forget that.
 */
export function renderSqlConnection(options: {
	tool: string;
	dir: string;
	instanceName: string;
	url: string;
	config: {
		host: string;
		port: number;
		database: string;
		username: string;
		password?: string;
	};
	/** Fields beyond the shared set, e.g. a TLS mode the driver reads separately. */
	fields?: Record<string, FieldValue>;
	/** Driver-standard names this instance claims for marimo's discovery. */
	discovery?: Record<string, string | undefined>;
	warnings?: string[];
	descriptor?: Record<string, unknown>;
	files?: { path: string; content: string }[];
}): RenderOutput {
	const { config } = options;
	return renderConnection({
		tool: options.tool,
		dir: options.dir,
		instanceName: options.instanceName,
		fields: {
			URL: options.url,
			HOST: config.host,
			PORT: config.port,
			DATABASE: config.database,
			USER: config.username,
			PASSWORD: config.password,
			...options.fields,
		},
		secretFields: ['URL', 'PASSWORD'],
		discovery: options.discovery,
		warnings: options.warnings,
		descriptor: options.descriptor,
		files: options.files,
		manifestExtra: { host: config.host, database: config.database },
	});
}

export interface ConnectionUrl {
	scheme: string;
	host: string;
	port?: number;
	/** Path segments after the authority, percent-encoded here. */
	segments?: (string | undefined)[];
	/** An empty string renders as `user:@host`, which some drivers require. */
	username?: string;
	password?: string;
	query?: Record<string, string | undefined>;
}

/**
 * A driver connection URL. Credentials and path segments are percent-encoded
 * and an IPv6 literal is bracketed, so the result parses as a URL whatever the
 * configured values contain.
 */
export function connectionUrl(spec: ConnectionUrl): string {
	const auth =
		spec.username === undefined
			? ''
			: `${encodeURIComponent(spec.username)}:${encodeURIComponent(spec.password ?? '')}@`;
	const authority = spec.host.includes(':') ? `[${spec.host}]` : spec.host;
	const port = spec.port === undefined ? '' : `:${spec.port}`;
	const path = (spec.segments ?? [])
		.filter((segment): segment is string => segment !== undefined && segment !== '')
		.map((segment) => `/${encodeURIComponent(segment)}`)
		.join('');
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(spec.query ?? {})) {
		if (value !== undefined) query.set(key, value);
	}
	const search = query.size === 0 ? '' : `?${query}`;
	return `${spec.scheme}://${auth}${authority}${port}${path}${search}`;
}
