import { describe, it, expect } from 'vitest';
import { bucketContract } from '@marimo-hub/core/testing/contract';
import { S3Storage, stripETag } from './index';

describe('stripETag', () => {
	it('strips surrounding double quotes', () => {
		expect(stripETag('"abc123"')).toBe('abc123');
		expect(stripETag('abc123')).toBe('abc123');
		expect(stripETag(undefined)).toBe('');
	});
});

// Live contract: runs only when a real S3-compatible endpoint is configured.
// e.g. spin up MinIO and set MARIMOHUB_TEST_S3_ENDPOINT/_BUCKET/_KEY/_SECRET.
const endpoint = process.env.MARIMOHUB_TEST_S3_ENDPOINT;
if (endpoint) {
	bucketContract(
		'S3Storage (live)',
		() =>
			new S3Storage({
				bucket: process.env.MARIMOHUB_TEST_S3_BUCKET ?? 'marimohub-test',
				endpoint,
				region: process.env.MARIMOHUB_TEST_S3_REGION ?? 'auto',
				forcePathStyle: true,
				credentials: {
					accessKeyId: process.env.MARIMOHUB_TEST_S3_KEY ?? 'minioadmin',
					secretAccessKey: process.env.MARIMOHUB_TEST_S3_SECRET ?? 'minioadmin',
				},
			}),
	);
} else {
	describe.skip('S3Storage live contract', () => {
		it('set MARIMOHUB_TEST_S3_ENDPOINT to run against a real S3/MinIO', () => { });
	});
}
