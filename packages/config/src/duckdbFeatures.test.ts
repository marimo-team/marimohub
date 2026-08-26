import type { DuckDBHttpAccess } from '@marimo-hub/core';
import { describe, expect, it } from 'vitest';
import { duckDBHttpAccessBlocker, duckDBQueryGate, duckDBRolloutFeatures } from './duckdbFeatures';

const OBJECT_ACCESS = {
	kind: 's3-object-store',
	endpoint: 'https://objects.example.test',
	region: 'us-east-1',
	urlStyle: 'path',
	credentials: { method: 'anonymous' },
	locations: [{ bucket: 'warehouse', prefix: 'tables' }],
} as const satisfies DuckDBHttpAccess;

const OAUTH_ACCESS = {
	kind: 'iceberg-rest',
	catalog: {
		url: 'https://catalog.example.test',
		oauth2: {
			tokenEndpoint: 'https://identity.example.test/token',
			clientId: 'client',
			clientSecret: 'secret',
			scope: 'catalog',
			refreshMarginSeconds: 30,
		},
	},
	storage: {
		kind: 's3',
		endpoint: 'https://objects.example.test',
		region: 'us-east-1',
		urlStyle: 'path',
		credentials: { method: 'anonymous' },
		locations: [{ bucket: 'warehouse', prefix: 'tables' }],
	},
} as const satisfies DuckDBHttpAccess;

describe('DuckDB rollout features', () => {
	it('defaults both security-sensitive features off and accepts only on or off', () => {
		expect(duckDBRolloutFeatures({})).toEqual({ oauth: false, objectQueries: false });
		expect(
			duckDBRolloutFeatures({
				MARIMOHUB_DUCKDB_OAUTH: ' ON ',
				MARIMOHUB_DUCKDB_OBJECT_QUERIES: 'on',
			}),
		).toEqual({ oauth: true, objectQueries: true });
		expect(() => duckDBRolloutFeatures({ MARIMOHUB_DUCKDB_OAUTH: 'true' })).toThrow(
			'Invalid MARIMOHUB_DUCKDB_OAUTH: true (expected on, off)',
		);
		expect(() => duckDBRolloutFeatures({ MARIMOHUB_DUCKDB_OBJECT_QUERIES: 'enabled' })).toThrow(
			'Invalid MARIMOHUB_DUCKDB_OBJECT_QUERIES: enabled (expected on, off)',
		);
	});

	it('blocks only the matching broker capability while each gate is off', () => {
		expect(duckDBHttpAccessBlocker(OBJECT_ACCESS, { oauth: true, objectQueries: false })).toContain(
			'MARIMOHUB_DUCKDB_OBJECT_QUERIES=on',
		);
		expect(duckDBHttpAccessBlocker(OAUTH_ACCESS, { oauth: false, objectQueries: true })).toContain(
			'MARIMOHUB_DUCKDB_OAUTH=on',
		);
		expect(
			duckDBHttpAccessBlocker(OBJECT_ACCESS, { oauth: false, objectQueries: true }),
		).toBeUndefined();
		expect(
			duckDBHttpAccessBlocker(OAUTH_ACCESS, { oauth: true, objectQueries: false }),
		).toBeUndefined();
	});

	it('keeps unrelated Run SQL integrations enabled', () => {
		const gate = duckDBQueryGate({ oauth: false, objectQueries: false });

		expect(gate({ kind: 's3', config: {} })).toMatchObject({
			id: 'duckdb-object-queries',
			ready: false,
		});
		expect(
			gate({
				kind: 'iceberg_rest',
				config: { auth: { method: 'oauth2_client_credentials' } },
			}),
		).toMatchObject({ id: 'duckdb-oauth', ready: false });
		expect(
			gate({ kind: 'iceberg_rest', config: { auth: { method: 'bearer_token' } } }),
		).toBeUndefined();
		expect(gate({ kind: 'postgres', config: {} })).toBeUndefined();
	});
});
