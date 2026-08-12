import { describe, it } from 'vitest';
import { browseContract, fetchProbe } from '../../../testing/browseContract';
import type { BrowseContractFixture } from '../../../testing/browseContract';
import { clickhouse } from './clickhouse';

const host = process.env.MARIMOHUB_TEST_CLICKHOUSE_HOST;
const port = Number(process.env.MARIMOHUB_TEST_CLICKHOUSE_PORT ?? '8123');

if (host) {
	const config = clickhouse.configSchema.parse({
		host,
		port,
		secure: false,
		username: 'default',
	});

	const query = async (sql: string) => {
		const response = await fetch(`http://${host}:${port}/`, { method: 'POST', body: sql });
		if (!response.ok) throw new Error(`ClickHouse seed failed: HTTP ${response.status}`);
	};

	let database = '';
	const setup = async (): Promise<BrowseContractFixture> => {
		database = `mh_live_${Date.now().toString(36)}`;
		await query(`CREATE DATABASE ${database}`);
		await query(`CREATE TABLE ${database}.orders (id UInt64, name String) ENGINE = Memory`);
		await query(`INSERT INTO ${database}.orders VALUES (1, 'Ada')`);
		return {
			hierarchy: 'flat',
			root: database,
			children: ['unused-a', 'unused-b'],
			grandchild: 'unused',
			table: 'orders',
			tableNamespace: [database],
			expectedColumns: [
				{ name: 'id', type: 'UInt64', nullable: false },
				{ name: 'name', type: 'String', nullable: false },
			],
			expectedPreview: { columns: ['id', 'name'], rows: [[1, 'Ada']] },
		};
	};

	browseContract('clickhouse (live)', () => ({
		browse: clickhouse.browse!,
		config,
		probe: fetchProbe(),
		setup,
		teardown: async () => query(`DROP DATABASE IF EXISTS ${database}`),
	}));
} else {
	describe.skip('Browse contract: clickhouse (set MARIMOHUB_TEST_CLICKHOUSE_HOST)', () => {
		it('skipped', () => {});
	});
}
