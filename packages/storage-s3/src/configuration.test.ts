import { S3Client } from '@aws-sdk/client-s3';
import type * as AwsS3 from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from './index';

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
	...(await importOriginal<typeof AwsS3>()),
	S3Client: vi.fn(function () {}),
}));

describe('S3 connection pool', () => {
	beforeEach(() => vi.clearAllMocks());
	it.each([undefined, 32])('configures HTTP and HTTPS keep-alive pools: %s', (maxSockets) => {
		new S3Storage({ bucket: 'hub', maxSockets, requestTimeoutMs: 12_000 });
		expect(S3Client).toHaveBeenCalledWith(
			expect.objectContaining({
				requestHandler: expect.objectContaining({
					httpAgent: expect.objectContaining({ keepAlive: true, maxSockets: maxSockets ?? 256 }),
					httpsAgent: expect.objectContaining({ keepAlive: true, maxSockets: maxSockets ?? 256 }),
					connectionTimeout: 5_000,
					requestTimeout: 12_000,
					throwOnRequestTimeout: true,
				}),
			}),
		);
	});
	it.each([0, -1, 1.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid pool sizes: %s',
		(maxSockets) => {
			expect(() => new S3Storage({ bucket: 'hub', maxSockets })).toThrow(/maxSockets/);
			expect(S3Client).not.toHaveBeenCalled();
		},
	);
});
