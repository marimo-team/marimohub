import { z } from 'zod';

const emptyCatalogStorage = z.strictObject({
	scheme: z.literal('catalog'),
	vended_s3: z.strictObject({
		endpoint: z.literal('').optional(),
		region: z.literal('us-east-1').optional(),
		force_virtual_addressing: z.literal(false).optional(),
		allowed_locations: z.tuple([]).optional(),
	}),
});

export function normalizeIcebergRestStorage(value: unknown): unknown {
	// Older forms materialized the optional vended S3 block with only blank fields and defaults.
	return emptyCatalogStorage.safeParse(value).success ? { scheme: 'catalog' } : value;
}
