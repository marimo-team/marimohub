import { describe } from 'vitest';
import { browseContract, fetchProbe } from '../../../testing/browseContract';
import type { BrowseContractFixture } from '../../../testing/browseContract';
import { databricks } from './databricks';

const configJson = process.env.MARIMOHUB_TEST_DATABRICKS_CONFIG;
const fixtureJson = process.env.MARIMOHUB_TEST_DATABRICKS_FIXTURE;

describe.skipIf(!configJson || !fixtureJson)('Databricks live catalog', () => {
	browseContract('Databricks', () => {
		let config;
		try {
			config = databricks.configSchema.parse(JSON.parse(configJson!));
		} catch {
			throw new Error('Invalid Databricks live-test configuration.');
		}
		return {
			config,
			browse: databricks.browse!,
			probe: fetchProbe(),
			setup: async () => JSON.parse(fixtureJson!) as BrowseContractFixture,
		};
	});
});
