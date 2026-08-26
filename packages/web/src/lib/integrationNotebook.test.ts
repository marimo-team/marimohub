import { describe, expect, it } from 'vitest';
import type { IntegrationEntry, IntegrationKind } from '@/types';
import { integrationNotebookInfo, supportsIntegrationDataPage } from './integrationNotebook';

const entry = {
	id: 'intg_spark',
	kind: 'pyspark',
	name: 'analytics-prod',
	enabled: true,
	current_version: 1,
	created_by: 'u_1',
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z',
	scope: 'project',
} satisfies IntegrationEntry;

const kind = {
	kind: 'pyspark',
	title: 'PySpark (Spark Connect)',
	description: 'Remote PySpark DataFrame sessions over Spark Connect.',
	category: 'engine',
	brand: { icon: 'apachespark', color: '#E25A1C' },
	schema_version: 1,
	json_schema: { type: 'object' },
	ui_hints: {},
	supports_test: false,
	supports_browse: false,
	browse_surfaces: [],
	secret_sources: { inline: false, references: [] },
	requirements: ['pyspark[connect]>=4.2'],
} satisfies IntegrationKind;

describe('integrationNotebookInfo', () => {
	it('builds a PySpark session from the rendered instance descriptor', () => {
		const info = integrationNotebookInfo(entry, kind);

		expect(info?.snippet).toContain('.joinpath("pyspark", "analytics-prod.json")');
		expect(info?.snippet).toContain('SparkSession.builder.remote');
		expect(info?.snippet).toContain('descriptor["spark_config"]');
		expect(info?.snippet).toContain('builder.appName(app_name)');
	});

	it('does not claim notebook guidance for unrelated integrations', () => {
		expect(
			integrationNotebookInfo({ ...entry, kind: 'custom_env' }, { ...kind, kind: 'custom_env' }),
		).toBeUndefined();
	});

	it('includes PySpark and browsable kinds on the project Data page', () => {
		expect(supportsIntegrationDataPage(kind)).toBe(true);
		expect(supportsIntegrationDataPage({ ...kind, kind: 's3', browse_surfaces: ['objects'] })).toBe(
			true,
		);
		expect(supportsIntegrationDataPage(undefined)).toBe(false);
	});
});
