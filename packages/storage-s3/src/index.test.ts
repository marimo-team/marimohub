import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { PreconditionFailedError } from '@marimo-hub/core';
import { bucketContract } from '@marimo-hub/core/testing/contract';
import { S3Storage, stripETag } from './index';

const CFG = {
	bucket: 'test-bucket',
	region: 'auto',
	forcePathStyle: true,
	credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
};

// ---------------------------------------------------------------------------
// Fake S3 transport. Rather than a live endpoint, spy on `S3Client.prototype.send`
// and dispatch the AWS SDK command objects against an in-memory, per-client store.
// This lets the SHARED bucket contract (CAS / create-if-absent / contention) run in
// CI against the real S3Storage code — the same coverage R2BucketAdapter gets via
// its fake R2 binding. `ignoreIfMatch` simulates a store that does NOT honor
// If-Match (to exercise the verifyConditionalWrites failure path).
// ---------------------------------------------------------------------------

interface Stored {
	body: Uint8Array;
	etag: string;
	lastModified: Date;
}

function namedError(name: string) {
	return Object.assign(new Error(name), { name });
}

function installFakeS3(opts: { ignoreIfMatch?: boolean } = {}) {
	// One store per client instance so each `new S3Storage(CFG)` is isolated, even
	// though the spy lives on the shared prototype.
	const stores = new WeakMap<object, { map: Map<string, Stored>; n: number }>();
	const calls: { name: string; input: Record<string, unknown> }[] = [];
	const toBytes = (v: unknown): Uint8Array =>
		typeof v === 'string' ? new TextEncoder().encode(v) : (v as Uint8Array);
	const storeFor = (client: object) => {
		let s = stores.get(client);
		if (!s) {
			s = { map: new Map<string, Stored>(), n: 0 };
			stores.set(client, s);
		}
		return s;
	};

	const spy = vi
		.spyOn(S3Client.prototype, 'send')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		.mockImplementation(async function (this: object, command: any) {
			const name = command.constructor.name;
			const input = (command.input ?? {}) as Record<string, any>;
			calls.push({ name, input });
			const store = storeFor(this);

			switch (name) {
				case 'PutObjectCommand': {
					const existing = store.map.get(input.Key);
					if (!opts.ignoreIfMatch && input.IfMatch !== undefined) {
						if (!existing || existing.etag !== stripETag(input.IfMatch))
							throw namedError('PreconditionFailed');
					} else if (input.IfNoneMatch === '*' && existing) {
						throw namedError('PreconditionFailed');
					}
					store.n += 1;
					const etag = `etag-${store.n}`;
					store.map.set(input.Key, {
						body: toBytes(input.Body),
						etag,
						lastModified: new Date(),
					});
					return { ETag: `"${etag}"` };
				}
				case 'GetObjectCommand': {
					const s = store.map.get(input.Key);
					if (!s) throw namedError('NoSuchKey');
					return {
						Body: {
							transformToString: async () => new TextDecoder().decode(s.body),
							transformToByteArray: async () => s.body,
						},
						ETag: `"${s.etag}"`,
						ContentLength: s.body.length,
						LastModified: s.lastModified,
					};
				}
				case 'HeadObjectCommand': {
					const s = store.map.get(input.Key);
					if (!s) throw namedError('NotFound');
					return {
						ETag: `"${s.etag}"`,
						ContentLength: s.body.length,
						LastModified: s.lastModified,
					};
				}
				case 'DeleteObjectCommand':
					store.map.delete(input.Key);
					return {};
				case 'DeleteObjectsCommand': {
					for (const o of input.Delete.Objects as { Key: string }[]) store.map.delete(o.Key);
					return {};
				}
				case 'ListObjectsV2Command': {
					const prefix: string = input.Prefix ?? '';
					const delimiter: string | undefined = input.Delimiter;
					const limit: number = input.MaxKeys ?? 1000;
					const after = [input.ContinuationToken, input.StartAfter]
						.filter((v): v is string => Boolean(v))
						.sort()
						.pop();
					const sorted = [...store.map.keys()].filter((k) => k.startsWith(prefix)).sort();
					const prefixes = new Set<string>();
					const keys: string[] = [];
					for (const key of sorted) {
						if (after && key <= after) continue;
						if (delimiter) {
							const rest = key.slice(prefix.length);
							const idx = rest.indexOf(delimiter);
							if (idx !== -1) {
								prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
								continue;
							}
						}
						keys.push(key);
					}
					const page = delimiter ? keys : keys.slice(0, limit);
					const truncated = !delimiter && keys.length > limit;
					return {
						Contents: page.map((k) => {
							const s = store.map.get(k)!;
							return {
								Key: k,
								ETag: `"${s.etag}"`,
								Size: s.body.length,
								LastModified: s.lastModified,
							};
						}),
						IsTruncated: truncated,
						NextContinuationToken: truncated ? page[page.length - 1] : undefined,
						CommonPrefixes: [...prefixes].sort().map((Prefix) => ({ Prefix })),
					};
				}
				default:
					throw new Error(`fake S3 transport: unhandled command ${name}`);
			}
		});
	return { calls, spy };
}

describe('stripETag', () => {
	it('strips surrounding double quotes', () => {
		expect(stripETag('"abc123"')).toBe('abc123');
		expect(stripETag('abc123')).toBe('abc123');
		expect(stripETag(undefined)).toBe('');
	});
});

// Full behavioral parity with MemoryBucket + R2BucketAdapter, now in CI.
describe('S3Storage against a fake S3 transport', () => {
	beforeEach(() => installFakeS3());
	afterEach(() => vi.restoreAllMocks());

	bucketContract('S3Storage (fake transport)', () => new S3Storage(CFG));
});

describe('S3Storage command mapping', () => {
	let fake: ReturnType<typeof installFakeS3>;
	beforeEach(() => {
		fake = installFakeS3();
	});
	afterEach(() => vi.restoreAllMocks());

	const puts = () => fake.calls.filter((c) => c.name === 'PutObjectCommand');

	it('maps onlyIfEtagMatches to a quoted If-Match (and no If-None-Match)', async () => {
		const s3 = new S3Storage(CFG);
		const first = await s3.put('cas', '1');
		await s3.put('cas', '2', { onlyIfEtagMatches: first.etag });

		const conditional = puts().at(-1)!;
		expect(conditional.input.IfMatch).toBe(`"${first.etag}"`);
		expect(conditional.input.IfNoneMatch).toBeUndefined();
	});

	it('maps onlyIfNotExists to If-None-Match: * (and no If-Match)', async () => {
		const s3 = new S3Storage(CFG);
		await s3.put('new', '1', { onlyIfNotExists: true });

		const call = puts().at(-1)!;
		expect(call.input.IfNoneMatch).toBe('*');
		expect(call.input.IfMatch).toBeUndefined();
	});

	it('passes content type and custom metadata through', async () => {
		const s3 = new S3Storage(CFG);
		await s3.put('k', 'v', {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: { author: 'me' },
		});
		const call = puts().at(-1)!;
		expect(call.input.ContentType).toBe('application/json');
		expect(call.input.Metadata).toEqual({ author: 'me' });
	});

	it('get returns a bare (unquoted) etag and the byte size', async () => {
		const s3 = new S3Storage(CFG);
		const put = await s3.put('k', 'héllo'); // multi-byte to check byte length
		const got = await s3.get('k');
		expect(got).not.toBeNull();
		expect(got!.etag).toBe(put.etag);
		expect(got!.etag).not.toContain('"');
		expect(got!.size).toBe(new TextEncoder().encode('héllo').length);
		expect(await got!.text()).toBe('héllo');
	});

	it('single-key delete uses DeleteObjectCommand', async () => {
		const s3 = new S3Storage(CFG);
		await s3.put('k', 'v');
		await s3.delete('k');
		expect(fake.calls.some((c) => c.name === 'DeleteObjectCommand')).toBe(true);
		expect(await s3.get('k')).toBeNull();
	});

	it('batches a >1000-key delete into chunks of 1000', async () => {
		const s3 = new S3Storage(CFG);
		const keys = Array.from({ length: 2500 }, (_, i) => `k/${i}`);
		await s3.delete(keys);

		const batches = fake.calls.filter((c) => c.name === 'DeleteObjectsCommand');
		expect(batches).toHaveLength(3);
		expect((batches[0].input.Delete as { Objects: unknown[] }).Objects).toHaveLength(1000);
		expect((batches[2].input.Delete as { Objects: unknown[] }).Objects).toHaveLength(500);
	});

	it('maps list options onto the ListObjectsV2 input', async () => {
		const s3 = new S3Storage(CFG);
		await s3.list({ prefix: 'p/', limit: 50, delimiter: '/', startAfter: 'p/0', cursor: 'tok' });
		const call = fake.calls.find((c) => c.name === 'ListObjectsV2Command')!;
		expect(call.input.Prefix).toBe('p/');
		expect(call.input.MaxKeys).toBe(50);
		expect(call.input.Delimiter).toBe('/');
		expect(call.input.StartAfter).toBe('p/0');
		expect(call.input.ContinuationToken).toBe('tok');
	});

	it('surfaces delimited prefixes from a list response', async () => {
		const s3 = new S3Storage(CFG);
		await s3.put('a/1', 'x');
		await s3.put('a/2', 'y');
		await s3.put('top', 'z');
		const res = await s3.list({ delimiter: '/' });
		expect(res.delimitedPrefixes).toContain('a/');
		expect(res.objects.map((o) => o.key)).toContain('top');
	});
});

describe('S3Storage error classification', () => {
	afterEach(() => vi.restoreAllMocks());

	it('translates a precondition failure on conditional put into PreconditionFailedError', async () => {
		installFakeS3();
		const s3 = new S3Storage(CFG);
		await s3.put('k', 'v1');
		await expect(s3.put('k', 'v2', { onlyIfEtagMatches: 'wrong' })).rejects.toBeInstanceOf(
			PreconditionFailedError,
		);
	});

	it('propagates a non-precondition error from put unchanged (not as PreconditionFailedError)', async () => {
		vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
			Object.assign(new Error('AccessDenied'), {
				name: 'AccessDenied',
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const s3 = new S3Storage(CFG);
		const err = await s3.put('k', 'v').catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(PreconditionFailedError);
		expect(err.name).toBe('AccessDenied');
	});

	it('propagates a non-NotFound error from get rather than returning null', async () => {
		vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
			Object.assign(new Error('AccessDenied'), {
				name: 'AccessDenied',
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const s3 = new S3Storage(CFG);
		await expect(s3.get('k')).rejects.toThrow('AccessDenied');
	});
});

describe('S3Storage.verifyConditionalWrites', () => {
	afterEach(() => vi.restoreAllMocks());

	it('resolves against a store that enforces atomic conditional writes', async () => {
		installFakeS3();
		const s3 = new S3Storage(CFG);
		await expect(s3.verifyConditionalWrites()).resolves.toBeUndefined();
	});

	it('throws when the store ignores If-Match (accepts a wrong-etag write)', async () => {
		installFakeS3({ ignoreIfMatch: true });
		const s3 = new S3Storage(CFG);
		await expect(s3.verifyConditionalWrites()).rejects.toThrow(/conditional writes/i);
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
		it('set MARIMOHUB_TEST_S3_ENDPOINT to run against a real S3/MinIO', () => {});
	});
}
