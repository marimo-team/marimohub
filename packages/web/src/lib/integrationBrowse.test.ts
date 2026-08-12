import { describe, expect, it } from 'vitest';
import type { IntegrationBrowseCapability, IntegrationKind } from '@/types';
import { supportsTableBrowse, tableBrowseCapability } from './integrationBrowse';

const kind = {
	kind: 's3',
	title: 'S3',
	description: 'S3',
	category: 'storage',
	brand: { icon: 'aws', color: '#000000' },
	schema_version: 2,
	json_schema: { type: 'object', properties: {} },
	ui_hints: {},
	supports_test: true,
	supports_browse: true,
	browse_surfaces: ['objects'],
	requirements: [],
	secret_sources: { inline: false, references: [] },
} satisfies IntegrationKind;

describe('supportsTableBrowse', () => {
	it('uses the surface discriminator when it is present', () => {
		expect(supportsTableBrowse(kind)).toBe(false);
		expect(supportsTableBrowse({ ...kind, browse_surfaces: ['tables'] })).toBe(true);
	});

	it('rejects missing kinds and an explicitly empty surface list', () => {
		expect(supportsTableBrowse(undefined)).toBe(false);
		expect(supportsTableBrowse({ ...kind, browse_surfaces: [] })).toBe(false);
	});
});

describe('tableBrowseCapability', () => {
	it('uses the table surface when it is present', () => {
		const capability = {
			surfaces: { tables: { available: false, preview: false, reason: 'disabled' } },
			metadata: true,
			preview: true,
		} satisfies IntegrationBrowseCapability;
		expect(tableBrowseCapability(capability)).toEqual({
			available: false,
			preview: false,
			reason: 'disabled',
		});
	});

	it('handles missing capabilities and table surfaces', () => {
		expect(tableBrowseCapability(undefined)).toBeUndefined();
		expect(
			tableBrowseCapability({ surfaces: {}, metadata: false, preview: false }),
		).toBeUndefined();
	});
});
