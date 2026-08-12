import { describe, it } from 'vitest';
import { browseContract, fetchProbe } from '../../../testing/browseContract';
import type { BrowseContractFixture } from '../../../testing/browseContract';
import { trino } from './trino';

const host = process.env.MARIMOHUB_TEST_TRINO_HOST;
const port = Number(process.env.MARIMOHUB_TEST_TRINO_PORT ?? '8080');

if (host) {
	const config = trino.configSchema.parse({
		host,
		port,
		http_scheme: 'http',
		auth: { method: 'none' },
	});

	const setup = async (): Promise<BrowseContractFixture> => {
		const schemas = await trino.browse!.listNamespaces(config, fetchProbe(), {
			parent: ['tpch'],
			limit: 100,
			query_user: 'browse-contract',
		});
		const children = schemas.items.map((namespace) => namespace[1]);
		const sf1Index = children.indexOf('sf1');
		if (sf1Index === -1) throw new Error('Trino TPCH catalog does not contain the sf1 schema');
		children.splice(sf1Index, 1);
		children.unshift('sf1');
		return {
			hierarchy: 'two-level',
			root: 'tpch',
			children,
			grandchild: 'unused',
			table: 'nation',
			expectedColumns: [
				{ name: 'nationkey', type: 'bigint', nullable: true },
				{ name: 'name', type: 'varchar(25)', nullable: true },
				{ name: 'regionkey', type: 'bigint', nullable: true },
				{ name: 'comment', type: 'varchar(152)', nullable: true },
			],
			expectedPreview: {
				columns: ['nationkey', 'name', 'regionkey', 'comment'],
				minimumRows: 1,
			},
		};
	};

	browseContract('trino (live)', () => ({
		browse: trino.browse!,
		config,
		probe: fetchProbe(),
		setup,
		pageLimit: 2,
	}));
} else {
	describe.skip('Browse contract: trino (set MARIMOHUB_TEST_TRINO_HOST)', () => {
		it('skipped', () => {});
	});
}
