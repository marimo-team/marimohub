import { describe, expect, it } from 'vitest';
import { normalizeIcebergRestStorage } from './icebergStorageUtils';

describe('normalizeIcebergRestStorage', () => {
	it.each([
		{},
		{ endpoint: '' },
		{ allowed_locations: [] },
		{ region: 'us-east-1', force_virtual_addressing: false },
		{ endpoint: '', region: 'us-east-1', force_virtual_addressing: false, allowed_locations: [] },
	])('omits an empty/default-only vended S3 block: %j', (vendedS3) => {
		expect(normalizeIcebergRestStorage({ scheme: 'catalog', vended_s3: vendedS3 })).toStrictEqual({
			scheme: 'catalog',
		});
	});

	it.each([
		null,
		[],
		'',
		{ endpoint: '', allowed_locations: [], unexpected: true },
		{ endpoint: '', region: 'eu-west-1', allowed_locations: [] },
		{ endpoint: '', force_virtual_addressing: true, allowed_locations: [] },
		{ endpoint: '', allowed_locations: [{ bucket: 'warehouse', prefix: '' }] },
		{ endpoint: 'not-a-url', allowed_locations: [] },
		{ endpoint: 'https://objects.example.com', allowed_locations: [] },
		{
			endpoint: 'https://objects.example.com',
			allowed_locations: [{ bucket: 'warehouse', prefix: 'production' }],
		},
	])('preserves configured or invalid vended S3 blocks for validation: %j', (vendedS3) => {
		const value = { scheme: 'catalog', vended_s3: vendedS3 };
		expect(normalizeIcebergRestStorage(value)).toBe(value);
	});

	it.each([
		undefined,
		null,
		'',
		false,
		0,
		[],
		{},
		{ scheme: 'catalog' },
		{ scheme: 'catalog', vended_s3: {}, unexpected: true },
		{ scheme: 's3', vended_s3: {} },
		{ scheme: 'gcs' },
	])('preserves unrelated or invalid storage values: %j', (value) => {
		expect(normalizeIcebergRestStorage(value)).toBe(value);
	});

	it('does not mutate the input and is idempotent', () => {
		const vendedS3 = Object.freeze({ endpoint: '', allowed_locations: Object.freeze([]) });
		const value = Object.freeze({ scheme: 'catalog', vended_s3: vendedS3 });
		const normalized = normalizeIcebergRestStorage(value);

		expect(normalized).toStrictEqual({ scheme: 'catalog' });
		expect(value.vended_s3).toBe(vendedS3);
		expect(normalizeIcebergRestStorage(normalized)).toBe(normalized);
	});
});
