import { describe, expect, it } from 'vitest';
import { icebergRestSqlReadiness } from './SqlReadinessChecklist';

const sqlReadyConfig = {
	uri: 'https://catalog.example.com/api',
	auth: { method: 'bearer_token', token: 'redacted' },
	access_delegation: 'none',
	storage: {
		scheme: 's3',
		endpoint: 'https://objects.example.com',
		credentials: { method: 'static', access_key_id: 'key', secret_access_key: 'secret' },
		force_virtual_addressing: false,
		anonymous: false,
		broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
	},
	tls: {},
	headers: {},
	extra_properties: {},
	runtime: {},
	rest: {
		snapshot_loading_mode: 'all',
		metrics_reporting_enabled: true,
		view_endpoints_supported: false,
		scan_planning_mode: 'client',
		namespace_separator: '%1F',
		table_cache_expire_after_write_ms: 300_000,
		table_cache_max_entries: 100,
	},
};

describe('icebergRestSqlReadiness', () => {
	it('accepts the brokered SQL profile', () => {
		expect(icebergRestSqlReadiness(sqlReadyConfig).every((check) => check.ready)).toBe(true);
	});

	it('returns every blocker instead of stopping after access delegation', () => {
		const checks = icebergRestSqlReadiness({
			...sqlReadyConfig,
			uri: 'https://catalog.example.com/api?tenant=demo',
			auth: { method: 'oauth2_client_credentials' },
			access_delegation: 'vended_credentials',
			storage: { scheme: 'catalog' },
			headers: { 'X-Custom': 'value' },
			runtime: { max_workers: 2 },
		});
		const blockers = checks.filter((check) => !check.ready).map((check) => check.label);

		expect(blockers).toContain('Use no catalog authentication or a bearer token');
		expect(blockers).toContain('Remove custom headers and extra properties');
		expect(blockers).toContain(
			'Use a catalog URL without query parameters or encoded path separators',
		);
		expect(blockers).toContain('Set access delegation to none');
		expect(blockers).toContain('Switch Storage to the s3 scheme');
		expect(blockers).toContain('Add at least one guarded S3 read location');
		expect(blockers).toContain('Keep PyIceberg runtime options at their defaults');
	});
});
