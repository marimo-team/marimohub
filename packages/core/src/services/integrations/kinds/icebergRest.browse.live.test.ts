import { describe, it } from 'vitest';
import { browseContract, fetchProbe } from '../../../testing/browseContract';
import type { BrowseContractFixture } from '../../../testing/browseContract';
import { icebergRest, resolveNamespaceSeparator } from './icebergRest';

/**
 * Live conformance for `iceberg_rest`, e.g.
 *
 *   docker run -d --rm -p 18181:8181 -e CATALOG_WAREHOUSE=file:///tmp/warehouse \
 *     apache/iceberg-rest-fixture
 *   MARIMOHUB_TEST_ICEBERG_REST_URI=http://127.0.0.1:18181 pnpm test -- icebergRest.browse.live
 *
 * Also runs against Lakekeeper/Polaris-style servers by pointing the URI (and
 * MARIMOHUB_TEST_ICEBERG_REST_TOKEN for bearer auth) at them.
 */
const uri = process.env.MARIMOHUB_TEST_ICEBERG_REST_URI;
const token = process.env.MARIMOHUB_TEST_ICEBERG_REST_TOKEN;

if (uri) {
	const config = icebergRest.configSchema.parse({
		uri,
		allow_insecure_transport: true,
		auth: token ? { method: 'bearer_token', token } : { method: 'none' },
	});
	const headers = {
		'Content-Type': 'application/json',
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};

	// Seeding must address paths the same way the client under test does: the
	// server can pin its own namespace separator via /v1/config (the fixture's
	// `latest` image overrides it to %2E; 1.10.0 declares none) and can require
	// a route prefix (Polaris/Lakekeeper style).
	let sep = '%1F';
	let base = '';

	const seed = async (route: string, body: unknown) => {
		const res = await fetch(`${uri}/v1/${base}${route}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`seed ${route}: HTTP ${res.status} ${await res.text()}`);
	};

	const setup = async (): Promise<BrowseContractFixture> => {
		const serverConfig = (await (await fetch(`${uri}/v1/config`, { headers })).json()) as {
			overrides?: Record<string, unknown>;
			defaults?: Record<string, unknown>;
		};
		// The client under test resolves the separator through the same function,
		// so seeding and browsing always address identical routes.
		sep = resolveNamespaceSeparator(
			config.rest.namespace_separator,
			serverConfig.overrides,
			serverConfig.defaults,
		);
		const prefix = [serverConfig.overrides?.prefix, serverConfig.defaults?.prefix].find(
			(value): value is string => typeof value === 'string' && value !== '',
		);
		if (prefix) base = `${prefix}/`;

		// Unique per run so reruns against a warm server do not collide.
		const root = `mh_live_${Date.now().toString(36)}`;
		await seed('namespaces', { namespace: [root], properties: {} });
		await seed('namespaces', { namespace: [root, 'eu'], properties: {} });
		await seed('namespaces', { namespace: [root, 'us'], properties: {} });
		await seed('namespaces', { namespace: [root, 'eu', 'north'], properties: {} });
		await seed(`namespaces/${root}${sep}eu/tables`, {
			name: 'orders',
			schema: {
				type: 'struct',
				'schema-id': 0,
				fields: [
					{ id: 1, name: 'id', required: true, type: 'long' },
					{ id: 2, name: 'ts', required: false, type: 'timestamptz', doc: 'event time' },
				],
			},
			'partition-spec': {
				'spec-id': 0,
				fields: [{ 'source-id': 2, 'field-id': 1000, name: 'ts_day', transform: 'day' }],
			},
			properties: {},
		});
		return {
			root,
			children: ['eu', 'us'],
			grandchild: 'north',
			table: 'orders',
			expectedColumns: [
				{ name: 'id', type: 'long', nullable: false },
				{ name: 'ts', type: 'timestamptz', nullable: true, comment: 'event time' },
			],
			expectedPartitioning: ['day(ts)'],
		};
	};

	const teardown = async ({ root }: BrowseContractFixture) => {
		await fetch(`${uri}/v1/${base}namespaces/${root}${sep}eu/tables/orders`, {
			method: 'DELETE',
			headers,
		}).catch(() => {});
		for (const ns of [`${root}${sep}eu${sep}north`, `${root}${sep}eu`, `${root}${sep}us`, root]) {
			await fetch(`${uri}/v1/${base}namespaces/${ns}`, { method: 'DELETE', headers }).catch(
				() => {},
			);
		}
	};

	browseContract('iceberg_rest (live)', () => ({
		browse: icebergRest.browse!,
		config,
		probe: fetchProbe(),
		setup,
		teardown,
	}));
} else {
	describe.skip('Browse contract: iceberg_rest (set MARIMOHUB_TEST_ICEBERG_REST_URI)', () => {
		it('skipped', () => {});
	});
}
