import { S3Storage } from '@marimo-hub/storage-s3';
import { expect, it, vi } from 'vitest';
import { makeStorage } from './storage';

vi.mock('@marimo-hub/storage-s3', () => ({ S3Storage: vi.fn(function () {}) }));

it('passes the configured socket limit to the S3 adapter', () => {
	makeStorage({ MARIMOHUB_STORAGE_S3_BUCKET: 'hub', MARIMOHUB_STORAGE_S3_MAX_SOCKETS: ' 128 ' });
	expect(S3Storage).toHaveBeenCalledWith(expect.objectContaining({ maxSockets: 128 }));
});
