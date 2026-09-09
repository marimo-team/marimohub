import { describe } from 'vitest';
import { z } from 'zod';
import type { BigQueryConnectionCapability } from '@marimo-hub/core';
import { browseContract, fetchProbe } from '@marimo-hub/core/testing/browse-contract';
import type { BrowseContractFixture } from '@marimo-hub/core/testing/browse-contract';
import { BigQueryDatabaseBrowser } from './index';

const configJson = process.env.MARIMOHUB_TEST_BIGQUERY_CONFIG;
const fixtureJson = process.env.MARIMOHUB_TEST_BIGQUERY_FIXTURE;
const sourceSchema = z.object({
	provider: z.literal('bigquery'),
	project_id: z.string(),
	credentials_json: z.string(),
});

describe.skipIf(!configJson || !fixtureJson)('BigQuery live catalog', () => {
	browseContract('BigQuery', () => {
		let config: BigQueryConnectionCapability;
		try {
			config = sourceSchema.parse(JSON.parse(configJson!));
		} catch {
			throw new Error('Invalid BigQuery live-test configuration.');
		}
		const probe = fetchProbe();
		const browser = new BigQueryDatabaseBrowser({ probe, mode: 'full' });
		return {
			config,
			probe,
			browse: {
				available: () => ({ ok: true }),
				snippet: () => '',
				listNamespaces: (source, _probe, request) => browser.listNamespaces(source, request),
				listTables: (source, _probe, namespace, request) =>
					browser.listTables(source, namespace, request),
				getTableSchema: (source, _probe, namespace, table, request) =>
					browser.getTableSchema(source, namespace, table, request),
				previewRows: (source, _probe, namespace, table, request) =>
					browser.previewRows(source, namespace, table, request),
			},
			setup: async () => JSON.parse(fixtureJson!) as BrowseContractFixture,
		};
	});
});
