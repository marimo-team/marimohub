import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { DuckDBHttpAccess } from '../data-preview/programs';
import { sqlIdentifier, sqlLiteral } from '../data-preview/sql';
import { basicAuthHeader, defineIntegration } from '../sdk';
import { zSecret } from '../secretFields';

const authSchema = z.discriminatedUnion('method', [
	z.strictObject({ method: z.literal('none') }),
	z.strictObject({ method: z.literal('bearer_token'), token: zSecret() }),
	z.strictObject({
		method: z.literal('basic'),
		username: z.string().min(1),
		password: zSecret(),
	}),
]);

const configSchema = z
	.strictObject({
		url: z.string().min(1).describe('Exact HTTPS URL of one immutable DuckDB database file'),
		auth: authSchema,
		allow_non_duckdb_suffix: z
			.boolean()
			.default(false)
			.describe('Allow a URL path that does not end in .duckdb'),
	})
	.superRefine((config, context) => {
		try {
			normalizeDuckDBHttpUrl(config);
		} catch (error) {
			context.addIssue({
				code: 'custom',
				path: ['url'],
				message: error instanceof Error ? error.message : DUCKDB_HTTP_URL_ERROR,
			});
		}
	});

type DuckDBHttpConfig = z.infer<typeof configSchema>;

export const duckdbHttp = defineIntegration({
	kind: 'duckdb_http',
	title: 'Remote DuckDB Database',
	description: 'Query one immutable DuckDB database file over guarded HTTPS.',
	category: 'database',
	brand: { color: '#FFF000' },
	schemaVersion: 1,
	configSchema,
	requirements: [],
	uiHints: {
		url: { group: 'Connection', order: 1 },
		auth: { group: 'Authentication', order: 10 },
		'auth.token': { widget: 'password' },
		'auth.password': { widget: 'password' },
		allow_non_duckdb_suffix: {
			group: 'Advanced',
			order: 30,
			advanced: true,
			widget: 'toggle',
		},
	},

	validate(config) {
		normalizeDuckDBHttpUrl(config);
	},

	query: {
		engine: 'duckdb-wasm',
		dialect: 'duckdb',
		readiness: () => [],
		available: () => ({ ok: true }),
		plan({ config, integration }) {
			const alias = sqlIdentifier(integration.name);
			const url = normalizeDuckDBHttpUrl(config);
			return {
				engine: 'duckdb-wasm',
				setup: [
					{ text: 'LOAD httpfs' },
					{
						// The pinned parser does not bind ATTACH parameters. The normalized URL is SQL-escaped here.
						text: `ATTACH ${sqlLiteral(url)} AS ${alias} (READ_ONLY)`,
					},
				],
				cleanup: [{ text: `DETACH ${alias}` }],
				httpAccess: httpAccess(config),
			};
		},
	},

	render() {
		return {};
	},
});

function httpAccess(config: DuckDBHttpConfig): DuckDBHttpAccess {
	const authHeader = authorization(config.auth);
	return {
		kind: 'http-database',
		url: normalizeDuckDBHttpUrl(config),
		...(authHeader ? { authorization: authHeader } : {}),
	};
}

function authorization(auth: DuckDBHttpConfig['auth']): string | undefined {
	switch (auth.method) {
		case 'none':
			return;
		case 'bearer_token':
			return `Bearer ${auth.token}`;
		case 'basic':
			return basicAuthHeader(auth.username, auth.password);
	}
}

export function normalizeDuckDBHttpUrl(
	config: Pick<DuckDBHttpConfig, 'url' | 'allow_non_duckdb_suffix'>,
): string {
	let url: URL;
	try {
		url = new URL(config.url);
	} catch {
		throw invalidUrl();
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		config.url.includes('\\') ||
		/%(?:2f|5c)/i.test(url.pathname)
	) {
		throw invalidUrl();
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname).normalize('NFC');
	} catch {
		throw invalidUrl();
	}
	if (path.endsWith('/') || (!config.allow_non_duckdb_suffix && !path.endsWith('.duckdb'))) {
		throw invalidUrl();
	}
	const canonicalPathname = path.split('/').map(encodeURIComponent).join('/');
	url.pathname = canonicalPathname;
	if (url.pathname !== canonicalPathname || hasEncodedPathSyntax(url.pathname)) {
		throw invalidUrl();
	}
	return url.toString();
}

function hasEncodedPathSyntax(pathname: string): boolean {
	let current = pathname;
	for (;;) {
		if (/%(?:2f|5c)/i.test(current)) return true;
		let decoded: string;
		try {
			decoded = decodeURIComponent(current);
		} catch {
			return false;
		}
		if (decoded === current) return false;
		if (
			decoded.includes('\\') ||
			decoded.split('/').some((part) => part === '.' || part === '..')
		) {
			return true;
		}
		current = decoded;
	}
}

function invalidUrl(): ValidationError {
	return new ValidationError(DUCKDB_HTTP_URL_ERROR);
}

const DUCKDB_HTTP_URL_ERROR =
	'DuckDB database URL must be an exact HTTPS object URL without credentials, query parameters, fragments, encoded separators or dot segments, or a trailing slash. The path must end in .duckdb unless the advanced suffix override is enabled.';
