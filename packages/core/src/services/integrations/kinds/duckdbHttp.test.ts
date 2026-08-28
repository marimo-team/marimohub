import { describe, expect, it } from 'vitest';
import { createIntegrationId } from '../../../ids';
import { redactConfig } from '../secretFields';
import { duckdbHttp, normalizeDuckDBHttpUrl } from './duckdbHttp';
import { defaultRegistry } from './index';

const integration = {
	id: createIntegrationId(),
	name: 'remote analytics',
	kind: 'duckdb_http',
	version: 1,
};

function parse(overrides: Record<string, unknown> = {}) {
	return duckdbHttp.configSchema.parse({
		url: 'https://data.example.com/snapshots/analytics.duckdb',
		auth: { method: 'none' },
		...overrides,
	});
}

describe('duckdb_http schema', () => {
	it.each([
		{ method: 'none' },
		{ method: 'bearer_token', token: 'bearer-secret' },
		{ method: 'basic', username: 'reader', password: 'basic-secret' },
	])('accepts $method authentication', (auth) => {
		expect(parse({ auth })).toMatchObject({ auth });
	});

	it('rejects a colon in a Basic authentication username', () => {
		expect(() =>
			parse({ auth: { method: 'basic', username: 'reader:admin', password: 'basic-secret' } }),
		).toThrow(/username must not contain a colon/);
	});

	it.each([
		'http://data.example.com/analytics.duckdb',
		'https://reader:secret@data.example.com/analytics.duckdb',
		'https://data.example.com/analytics.duckdb?',
		'https://data.example.com/analytics.duckdb#',
		'https://data.example.com/analytics.duckdb?version=1',
		'https://data.example.com/analytics.duckdb#fragment',
		'https://data.example.com/snapshots/',
		'https://data.example.com/snapshots%2Fanalytics.duckdb',
		'https://data.example.com/snapshots%5canalytics.duckdb',
		'https://data.example.com/safe/../analytics.duckdb',
		'https://data.example.com/safe/./analytics.duckdb',
		'https://data.example.com/safe/%2E/analytics.duckdb',
		'https://data.example.com/safe/%2e%2e/analytics.duckdb',
		'https://data.example.com/safe/.%2E/analytics.duckdb',
		'https://data.example.com/safe/%252F/analytics.duckdb',
		'https://data.example.com/safe/%255C/analytics.duckdb',
		'https://data.example.com/safe/%252e%252e/analytics.duckdb',
		'https://data.example.com/analytics.duckdbx',
		'https://data.example.com/analytics.DUCKDB',
		'https://data.example.com/analytics.duckdв',
	])('rejects unsafe or ambiguous URL %s', (url) => {
		expect(() => parse({ url })).toThrow(/exact HTTPS object URL/);
	});

	it('normalizes Unicode hosts, paths, and percent escapes before authorizing the object', () => {
		const config = parse({ url: 'https://例え.テスト/cafe%CC%81%2Educkdb' });
		expect(normalizeDuckDBHttpUrl(config)).toBe('https://xn--r8jz45g.xn--zckzah/caf%C3%A9.duckdb');
	});

	it('preserves a literal percent sign while canonicalizing the object path', () => {
		const config = parse({ url: 'https://data.example.com/snapshots/100%25.duckdb' });
		expect(normalizeDuckDBHttpUrl(config)).toBe('https://data.example.com/snapshots/100%25.duckdb');
	});

	it('requires an explicit advanced override for a nonstandard suffix', () => {
		expect(() => parse({ url: 'https://data.example.com/snapshot.bin' })).toThrow();
		expect(
			parse({
				url: 'https://data.example.com/snapshot.bin',
				allow_non_duckdb_suffix: true,
			}),
		).toMatchObject({ allow_non_duckdb_suffix: true });
	});

	it('does not allow strong ETag enforcement to be disabled', () => {
		expect(() => parse({ require_strong_etag: false })).toThrow(/Unrecognized key/);
	});

	it('marks bearer tokens and Basic passwords as secret fields', () => {
		const registry = defaultRegistry();
		expect(
			registry
				.secretPathsOf('duckdb_http')
				.map((path) => path.join('.'))
				.sort(),
		).toEqual(['auth.password', 'auth.token']);
		const stored = {
			...parse({ auth: { method: 'none' } }),
			auth: {
				method: 'basic',
				username: 'reader',
				password: {
					$secret: {
						kind: 'managed',
						envelope: {
							kek_id: 'k',
							alg: 'A256GCM',
							iv: 'iv',
							ciphertext: 'secret-ciphertext',
						},
					},
				},
			},
		};
		expect(
			JSON.stringify(redactConfig(stored, registry.secretPathsOf('duckdb_http'))),
		).not.toContain('secret-ciphertext');
	});
});

describe('duckdb_http query plan', () => {
	it('uses a normalized read-only attach and keeps authorization out of SQL', () => {
		const config = parse({ auth: { method: 'bearer_token', token: 'bearer-secret' } });
		const plan = duckdbHttp.query?.plan({ config, integration });

		expect(plan).toEqual({
			engine: 'duckdb-wasm',
			setup: [
				{ text: 'LOAD httpfs' },
				{
					text: 'ATTACH \'https://data.example.com/snapshots/analytics.duckdb\' AS "remote analytics" (READ_ONLY)',
				},
			],
			cleanup: [{ text: 'DETACH "remote analytics"' }],
			httpAccess: {
				kind: 'http-database',
				url: 'https://data.example.com/snapshots/analytics.duckdb',
				authorization: 'Bearer bearer-secret',
			},
		});
		expect(JSON.stringify(plan?.setup)).not.toContain('bearer-secret');
	});

	it.each(['bearer\rsecret', 'bearer\nsecret'])(
		'rejects a bearer token containing a line break',
		(token) => {
			const config = parse({ auth: { method: 'bearer_token', token } });
			expect(() => duckdbHttp.query?.plan({ config, integration })).toThrow(/line break/);
		},
	);

	it('registers a query-only database descriptor with no runtime requirements', () => {
		const descriptor = defaultRegistry().describe('duckdb_http');
		expect(descriptor).toMatchObject({
			kind: 'duckdb_http',
			category: 'database',
			supports_browse: false,
			requirements: [],
		});
		expect(duckdbHttp.preview).toBeUndefined();
	});
});
