import { describe, expect, it } from 'vitest';
import { createIntegrationId } from '../../../ids';
import { ducklake, normalizeDuckLakeMetadataUrl } from './ducklake';
import { defaultRegistry } from './index';

const integration = {
	id: createIntegrationId(),
	name: 'warehouse lake',
	kind: 'ducklake',
	version: 1,
};

function parse(overrides: Record<string, unknown> = {}) {
	return ducklake.configSchema.parse({
		metadata: {
			type: 'duckdb',
			url: 'https://data.example.com/catalog/releases/42.ducklake',
			auth: { method: 'none' },
		},
		storage: {
			scheme: 's3',
			endpoint: 'https://s3.us-east-1.amazonaws.com',
			region: 'us-east-1',
			credentials: {
				method: 'static',
				access_key_id: 'parent-key',
				secret_access_key: 'parent-secret',
			},
			broker_read_locations: [{ bucket: 'warehouse', prefix: 'ducklake/data/' }],
		},
		...overrides,
	});
}

describe('ducklake schema', () => {
	it.each(['catalog.ducklake', 'catalog.duckdb'])('accepts DuckDB metadata in %s', (file) => {
		const config = parse({
			metadata: {
				type: 'duckdb',
				url: `https://data.example.com/${file}`,
				auth: { method: 'none' },
			},
		});
		expect(normalizeDuckLakeMetadataUrl(config.metadata)).toContain(file);
	});

	it.each([
		['insecure transport', 'http://data.example.com/catalog.ducklake'],
		['embedded credentials', 'https://user:password@data.example.com/catalog.ducklake'],
		['query parameters', 'https://data.example.com/catalog.ducklake?version=2'],
		['fragment', 'https://data.example.com/catalog.ducklake#snapshot'],
		['raw traversal', 'https://data.example.com/releases/../catalog.ducklake'],
		['encoded separator', 'https://data.example.com/releases%2Fcatalog.ducklake'],
		['trailing slash', 'https://data.example.com/catalog.ducklake/'],
		['unsupported suffix', 'https://data.example.com/catalog.sqlite'],
	] as const)('rejects metadata URLs with %s', (_label, url) => {
		expect(() => parse({ metadata: { type: 'duckdb', url, auth: { method: 'none' } } })).toThrow(
			/exact HTTPS object URL/,
		);
	});

	it('allows an explicit non-database suffix override', () => {
		const config = parse({
			metadata: {
				type: 'duckdb',
				url: 'https://data.example.com/releases/catalog.bin',
				auth: { method: 'none' },
				allow_non_database_suffix: true,
			},
		});
		expect(normalizeDuckLakeMetadataUrl(config.metadata)).toBe(
			'https://data.example.com/releases/catalog.bin',
		);
	});

	it('requires exactly one snapshot selector', () => {
		expect(parse({ snapshot: { version: 42 } }).snapshot).toEqual({ version: 42 });
		expect(parse({ snapshot: { timestamp: '2026-08-01T12:00:00Z' } }).snapshot).toEqual({
			timestamp: '2026-08-01T12:00:00Z',
		});
		expect(() => parse({ snapshot: { version: 42, timestamp: '2026-08-01T12:00:00Z' } })).toThrow(
			/only one/,
		);
	});

	it.each([
		['negative version', { version: -1 }],
		['fractional version', { version: 1.5 }],
		['timestamp without a time zone', { timestamp: '2026-08-01T12:00:00' }],
		['unknown selector', { version: 2, branch: 'main' }],
	] as const)('rejects a snapshot with %s', (_label, snapshot) => {
		expect(() => parse({ snapshot })).toThrow();
	});

	it('requires bounded origin-only HTTPS S3 storage', () => {
		expect(() => parse({ storage: { ...parse().storage, broker_read_locations: [] } })).toThrow(
			/at least one/,
		);
		expect(() =>
			parse({ storage: { ...parse().storage, endpoint: 'http://minio.example.com' } }),
		).toThrow(/origin-only HTTPS/);
		expect(() =>
			parse({ storage: { ...parse().storage, endpoint: 'https://s3.example.com/prefix' } }),
		).toThrow(/origin-only HTTPS/);
		expect(() => parse({ storage: { ...parse().storage, endpoint: 'https://127.0.0.1' } })).toThrow(
			/DNS endpoint/,
		);
		expect(() =>
			parse({
				storage: {
					...parse().storage,
					broker_read_locations: [{ bucket: 'warehouse_name', prefix: 'ducklake/data' }],
				},
			}),
		).toThrow(/DNS-compatible bucket names/);
		expect(() =>
			parse({
				storage: {
					...parse().storage,
					broker_read_locations: [{ bucket: 'warehouse', prefix: 'ducklake/../private' }],
				},
			}),
		).toThrow(/non-traversing prefix/);
		expect(() =>
			parse({
				storage: {
					...parse().storage,
					broker_read_locations: [
						{ bucket: 'warehouse', prefix: '/ducklake/data/' },
						{ bucket: 'warehouse', prefix: 'ducklake/data' },
					],
				},
			}),
		).toThrow(/duplicate bucket prefixes/);
	});

	it.each([
		{
			metadataUrl: 'https://warehouse.s3.example.com/ducklake/data/catalog.ducklake',
			endpoint: 'https://s3.example.com',
			force_virtual_addressing: true,
		},
		{
			metadataUrl: 'https://s3.example.com/warehouse/ducklake/data/catalog.ducklake',
			endpoint: 'https://s3.example.com',
			force_virtual_addressing: false,
		},
	])('rejects metadata and S3 route overlap', (overlap) => {
		const base = parse();
		expect(() =>
			parse({
				metadata: { ...base.metadata, url: overlap.metadataUrl },
				storage: {
					...base.storage,
					endpoint: overlap.endpoint,
					force_virtual_addressing: overlap.force_virtual_addressing,
				},
			}),
		).toThrow(/must not overlap/);
	});

	it('keeps route overlap checks segment-aware', () => {
		const base = parse();
		expect(() =>
			parse({
				metadata: {
					...base.metadata,
					url: 'https://warehouse.s3.us-east-1.amazonaws.com/ducklake/data-private/catalog.ducklake',
				},
			}),
		).not.toThrow();
	});

	it('preserves empty path segments when checking route overlap', () => {
		const base = parse();
		const metadata = {
			...base.metadata,
			url: 'https://warehouse.s3.us-east-1.amazonaws.com/ducklake//data/catalog.ducklake',
		};
		expect(() =>
			parse({
				metadata,
				storage: {
					...base.storage,
					broker_read_locations: [{ bucket: 'warehouse', prefix: 'ducklake//data' }],
				},
			}),
		).toThrow(/must not overlap/);
		expect(() => parse({ metadata })).not.toThrow();
	});

	it('marks metadata and S3 credentials as secrets', () => {
		expect(
			defaultRegistry()
				.secretPathsOf('ducklake')
				.map((path) => path.join('.'))
				.sort(),
		).toEqual([
			'metadata.auth.password',
			'metadata.auth.token',
			'storage.credentials.access_key_id',
			'storage.credentials.secret_access_key',
			'storage.credentials.session_token',
		]);
	});
});

describe('ducklake query plan', () => {
	it('composes immutable metadata and guarded S3 without exposing credentials to SQL', () => {
		const config = parse({ snapshot: { version: 42 } });
		const plan = ducklake.query?.plan({ config, integration });

		expect(plan?.setup?.map(({ text }) => text)).toEqual([
			'LOAD httpfs',
			'LOAD parquet',
			'LOAD ducklake',
			expect.stringContaining('CREATE TEMPORARY SECRET'),
			expect.stringContaining('READ_ONLY, CREATE_IF_NOT_EXISTS false, SNAPSHOT_VERSION ?'),
		]);
		expect(plan?.setup?.at(-1)?.params).toEqual([42]);
		expect(plan?.httpAccess).toMatchObject({
			kind: 'ducklake',
			metadata: {
				kind: 'http-database',
				url: 'https://data.example.com/catalog/releases/42.ducklake',
			},
			storage: {
				endpoint: 'https://s3.us-east-1.amazonaws.com/',
				locations: [{ bucket: 'warehouse', prefix: 'ducklake/data' }],
			},
		});
		expect(JSON.stringify(plan?.setup)).not.toContain('parent-key');
		expect(JSON.stringify(plan?.setup)).not.toContain('parent-secret');
		expect(JSON.stringify(plan?.setup)).not.toContain('AUTOMATIC_MIGRATION');
		expect(plan?.cleanup?.map(({ text }) => text)).toEqual([
			expect.stringContaining('DROP SECRET'),
			'DETACH "warehouse lake"',
		]);
	});

	it('binds timestamp snapshots and omits snapshot options for the latest catalog', () => {
		const timestamp = '2026-08-01T12:00:00Z';
		const timestampPlan = ducklake.query?.plan({
			config: parse({ snapshot: { timestamp } }),
			integration,
		});
		const latestPlan = ducklake.query?.plan({ config: parse(), integration });

		expect(timestampPlan?.setup?.at(-1)).toMatchObject({
			text: expect.stringContaining('SNAPSHOT_TIME ?'),
			params: [timestamp],
		});
		expect(timestampPlan?.setup?.at(-1)?.text).not.toContain(timestamp);
		expect(latestPlan?.setup?.at(-1)?.text).not.toMatch(/SNAPSHOT_(?:TIME|VERSION)/);
		expect(latestPlan?.setup?.at(-1)?.params).toBeUndefined();
	});

	it('keeps metadata and session credentials in separate broker capabilities', () => {
		const base = parse();
		const config = parse({
			metadata: {
				...base.metadata,
				auth: { method: 'basic', username: 'catalog-user', password: 'catalog-password' },
			},
			storage: {
				...base.storage,
				credentials: {
					...base.storage.credentials,
					session_token: 'storage-session-token',
				},
			},
		});
		const plan = ducklake.query?.plan({ config, integration });

		expect(plan?.httpAccess).toMatchObject({
			metadata: { authorization: 'Basic Y2F0YWxvZy11c2VyOmNhdGFsb2ctcGFzc3dvcmQ=' },
			storage: { credentials: { sessionToken: 'storage-session-token' } },
		});
		expect(JSON.stringify(plan?.setup)).not.toContain('catalog-password');
		expect(JSON.stringify(plan?.setup)).not.toContain('storage-session-token');
	});

	it('rejects SQLite metadata until the pinned Wasm scanner can open virtual files', () => {
		const base = parse();
		expect(() =>
			parse({
				metadata: {
					...base.metadata,
					type: 'sqlite',
					url: 'https://data.example.com/catalog/releases/42.sqlite',
				},
			}),
		).toThrow();
	});
});
