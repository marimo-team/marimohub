import { afterEach, expect, it, vi } from 'vitest';
import { UserId } from '@marimo-hub/core/ids';
import type {
	ObjectBrowseContext,
	S3ObjectStoreSource,
} from '@marimo-hub/core/ports/object-browser';
import * as clients from './client';
import { S3ObjectBrowser } from './index';

afterEach(() => vi.restoreAllMocks());

it('uses a single attempt and long request timeout for uploads, retaining bounded connection timeouts', async () => {
	const read = { send: vi.fn(async () => ({})), destroy: vi.fn() };
	const upload = { send: vi.fn(async () => ({})), destroy: vi.fn() };
	const factories = vi
		.spyOn(clients, 'createS3ClientFactory')
		.mockReturnValueOnce(() => read)
		.mockReturnValueOnce(() => upload);
	const browser = new S3ObjectBrowser({
		mode: 'full',
		resolveHost: async () => [{ address: '1.1.1.1', family: 4 }],
		limits: { metadataTimeoutMs: 5_000, previewTimeoutMs: 10_000 },
	});
	const source: S3ObjectStoreSource = {
		provider: 's3',
		path_style: false,
		allow_write: true,
		auth: { method: 'static', access_key_id: 'key', secret_access_key: 'secret' },
	};
	const context: ObjectBrowseContext = {
		user_id: UserId.parse('user-1'),
		user_email: 'ada@example.com',
		allow_server_ambient: {},
	};
	await browser.listBuckets(source, context, { limit: 1 });
	await browser.putObject(source, context, {
		bucket: 'data',
		key: 'file',
		contentType: 'text/plain',
		size: 0,
		body: new Uint8Array(),
	});
	expect(factories.mock.calls[0][0]).toMatchObject({
		connectionTimeoutMs: 30_000,
		requestTimeoutMs: 30_000,
	});
	expect(factories.mock.calls[1][0]).toMatchObject({
		connectionTimeoutMs: 30_000,
		requestTimeoutMs: 3_600_000,
		maxAttempts: 1,
	});
	expect(read.send).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ input: { MaxBuckets: 1 } }),
		expect.anything(),
	);
	expect(upload.send).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ input: expect.objectContaining({ Key: 'file' }) }),
		expect.anything(),
	);
});
