import { z } from 'zod';
import type { DuckDBHttpAccess } from '../data-preview/programs';
import { sqlIdentifier, sqlLiteral } from '../data-preview/sql';
import { defineIntegration } from '../sdk';
import {
	exactObjectAccess,
	exactObjectAuthSchema,
	normalizeExactObjectUrl,
} from './binaryDatabase';

const configSchema = z
	.strictObject({
		url: z.string().min(1).describe('Exact HTTPS URL of one immutable DuckDB database file'),
		auth: exactObjectAuthSchema,
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
	return exactObjectAccess(normalizeDuckDBHttpUrl(config), config.auth);
}

export function normalizeDuckDBHttpUrl(
	config: Pick<DuckDBHttpConfig, 'url' | 'allow_non_duckdb_suffix'>,
): string {
	return normalizeExactObjectUrl({
		url: config.url,
		allowedSuffixes: ['.duckdb'],
		allowOtherSuffix: config.allow_non_duckdb_suffix,
		label: 'DuckDB database',
	});
}

const DUCKDB_HTTP_URL_ERROR =
	'DuckDB database URL must be an exact HTTPS object URL without credentials, query parameters, fragments, encoded separators or dot segments, or a trailing slash. The path must end in .duckdb unless the advanced suffix override is enabled.';
