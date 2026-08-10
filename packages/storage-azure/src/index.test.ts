import { Readable } from 'node:stream';
import type { ContainerClient } from '@azure/storage-blob';
import { PreconditionFailedError } from '@marimo-hub/core';
import { bucketContract } from '@marimo-hub/core/testing/contract';
import { describe, expect, it } from 'vitest';
import { AzureStorage } from './index';
import type { AzureStorageConfig } from './index';

interface StoredBlob {
	body: Uint8Array;
	etag: string;
	uploaded: Date;
	contentType?: string;
	metadata?: Record<string, string>;
}

interface UploadCall {
	key: string;
	options?: {
		conditions?: { ifMatch?: string; ifNoneMatch?: string };
		blobHTTPHeaders?: { blobContentType?: string };
		metadata?: Record<string, string>;
	};
}

function azureError(statusCode: number, code: string): Error {
	return Object.assign(new Error(code), { statusCode, code });
}

function makeFakeContainer(
	options: { ignoreConditions?: boolean; allowStaleMatches?: boolean } = {},
) {
	const store = new Map<string, StoredBlob>();
	const calls = {
		uploads: [] as UploadCall[],
		deletes: [] as string[],
	};
	const deleteFailures = new Set<string>();
	const issuedEtags = new Set<string>();
	let etag = 0;

	const blobItem = (key: string) => {
		const item = store.get(key)!;
		return {
			name: key,
			properties: {
				etag: item.etag,
				contentLength: item.body.length,
				lastModified: item.uploaded,
			},
		};
	};

	const listPages = (prefix: string, delimiter?: string) => ({
		byPage: ({
			continuationToken,
			maxPageSize,
		}: { continuationToken?: string; maxPageSize?: number } = {}) =>
			(async function* () {
				const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
				const entries = new Map<string, { kind: 'blob' | 'prefix'; key: string }>();
				for (const key of keys) {
					const rest = key.slice(prefix.length);
					const delimiterIndex = delimiter ? rest.indexOf(delimiter) : -1;
					if (delimiter && delimiterIndex >= 0) {
						const name = prefix + rest.slice(0, delimiterIndex + delimiter.length);
						entries.set(`prefix:${name}`, { kind: 'prefix', key: name });
					} else {
						entries.set(`blob:${key}`, { kind: 'blob', key });
					}
				}
				const ordered = [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
				let offset = Number(continuationToken ?? 0);
				const pageSize = maxPageSize ?? 5000;
				while (offset < ordered.length) {
					const pageEntries = ordered.slice(offset, offset + pageSize);
					offset += pageEntries.length;
					yield {
						segment: {
							blobItems: pageEntries
								.filter((entry) => entry.kind === 'blob')
								.map((entry) => blobItem(entry.key)),
							...(delimiter
								? {
										blobPrefixes: pageEntries
											.filter((entry) => entry.kind === 'prefix')
											.map((entry) => ({ name: entry.key })),
									}
								: {}),
						},
						continuationToken: offset < ordered.length ? String(offset) : undefined,
					};
				}
			})(),
	});

	const client = {
		getBlobClient(key: string) {
			return {
				async download() {
					const item = store.get(key);
					if (!item) throw azureError(404, 'BlobNotFound');
					return {
						etag: item.etag,
						contentLength: item.body.length,
						lastModified: item.uploaded,
						readableStreamBody: Readable.from([item.body]),
					};
				},
				async getProperties() {
					const item = store.get(key);
					if (!item) throw azureError(404, 'BlobNotFound');
					return {
						etag: item.etag,
						contentLength: item.body.length,
						lastModified: item.uploaded,
					};
				},
				async deleteIfExists() {
					calls.deletes.push(key);
					if (deleteFailures.has(key)) throw azureError(403, 'AuthorizationPermissionMismatch');
					return { succeeded: store.delete(key) };
				},
			};
		},
		getBlockBlobClient(key: string) {
			return {
				async uploadData(
					body: Uint8Array,
					uploadOptions?: UploadCall['options'],
				): Promise<{ etag: string; lastModified: Date }> {
					calls.uploads.push({ key, options: uploadOptions });
					const current = store.get(key);
					if (!options.ignoreConditions) {
						const ifMatch = uploadOptions?.conditions?.ifMatch;
						const ifNoneMatch = uploadOptions?.conditions?.ifNoneMatch;
						const staleMatchAllowed =
							options.allowStaleMatches && ifMatch !== undefined && issuedEtags.has(ifMatch);
						if (ifMatch !== undefined && current?.etag !== ifMatch && !staleMatchAllowed) {
							throw azureError(412, 'ConditionNotMet');
						}
						if (ifNoneMatch === '*' && current) {
							throw azureError(412, 'ConditionNotMet');
						}
					}
					const uploaded = new Date(1_700_000_000_000 + etag);
					const next = {
						body: new Uint8Array(body),
						etag: `"etag-${++etag}"`,
						uploaded,
						contentType: uploadOptions?.blobHTTPHeaders?.blobContentType,
						metadata: uploadOptions?.metadata,
					};
					store.set(key, next);
					issuedEtags.add(next.etag);
					return { etag: next.etag, lastModified: uploaded };
				},
			};
		},
		listBlobsFlat({ prefix = '' }: { prefix?: string } = {}) {
			return listPages(prefix);
		},
		listBlobsByHierarchy(delimiter: string, { prefix = '' }: { prefix?: string } = {}) {
			return listPages(prefix, delimiter);
		},
	} as unknown as ContainerClient;

	return { client, store, calls, deleteFailures };
}

bucketContract('AzureStorage (fake ContainerClient)', () => {
	const fake = makeFakeContainer();
	return new AzureStorage({ containerClient: fake.client });
});

describe('AzureStorage construction', () => {
	it('accepts an injected container client', () => {
		const fake = makeFakeContainer();
		expect(new AzureStorage({ containerClient: fake.client })).toBeInstanceOf(AzureStorage);
	});

	it('accepts an Azurite connection string', () => {
		expect(
			new AzureStorage({
				container: 'test',
				connectionString: 'UseDevelopmentStorage=true',
			}),
		).toBeInstanceOf(AzureStorage);
	});

	it('accepts an account URL and injected token credential', () => {
		expect(
			new AzureStorage({
				container: 'test',
				accountUrl: 'https://account.blob.core.windows.net',
				credential: { getToken: async () => null },
			}),
		).toBeInstanceOf(AzureStorage);
	});

	it('rejects missing and overlapping constructor modes', () => {
		expect(() => new AzureStorage({} as AzureStorageConfig)).toThrow(/exactly one/);
		expect(
			() =>
				new AzureStorage({
					container: 'test',
					connectionString: 'UseDevelopmentStorage=true',
					accountUrl: 'https://account.blob.core.windows.net',
				} as AzureStorageConfig),
		).toThrow(/exactly one/);
		expect(
			() =>
				new AzureStorage({
					container: '',
					accountUrl: 'https://account.blob.core.windows.net',
				}),
		).toThrow(/non-empty container/);
	});
});

describe('AzureStorage request mapping', () => {
	it('maps conditional writes, content type, and metadata', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });
		const first = await bucket.put('k', 'one');

		await bucket.put('k', 'two', {
			onlyIfEtagMatches: first.etag,
			httpMetadata: { contentType: 'text/plain' },
			customMetadata: { source: 'test' },
		});
		await bucket.put('new', 'value', { onlyIfNotExists: true });

		expect(fake.calls.uploads[1]?.options).toMatchObject({
			conditions: { ifMatch: first.etag },
			blobHTTPHeaders: { blobContentType: 'text/plain' },
			metadata: { source: 'test' },
		});
		expect(fake.calls.uploads[2]?.options?.conditions).toEqual({ ifNoneMatch: '*' });
	});

	it('wraps an unquoted caller ETag before sending If-Match', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });

		const error = await bucket
			.put('missing', 'value', { onlyIfEtagMatches: 'bogus-etag' })
			.catch((cause) => cause);
		expect(error).toBeInstanceOf(PreconditionFailedError);
		expect(error.message).toBe('ETag mismatch for key "missing"');
		expect(fake.calls.uploads[0]?.options?.conditions?.ifMatch).toBe('"bogus-etag"');
	});

	it('buffers a download once and returns repeatable body readers', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });
		await bucket.put('data.json', '{"value":"héllo"}');

		const body = await bucket.get('data.json');

		expect(await body?.text()).toBe('{"value":"héllo"}');
		expect(await body?.json()).toEqual({ value: 'héllo' });
		expect(new TextDecoder().decode(await body?.bytes())).toBe('{"value":"héllo"}');
	});
});

describe('AzureStorage error handling', () => {
	it('returns null for missing get and head calls', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });
		expect(await bucket.get('missing')).toBeNull();
		expect(await bucket.head('missing')).toBeNull();
	});

	it('maps only 412 upload failures to PreconditionFailedError', async () => {
		const client = {
			getBlockBlobClient: () => ({
				uploadData: async () => {
					throw azureError(412, 'ConditionNotMet');
				},
			}),
		} as unknown as ContainerClient;
		const error = await new AzureStorage({ containerClient: client })
			.put('k', 'v')
			.catch((cause) => cause);
		expect(error).toBeInstanceOf(PreconditionFailedError);
		expect(error.message).toBe('Precondition not met for key "k"');

		const deniedClient = {
			getBlockBlobClient: () => ({
				uploadData: async () => {
					throw azureError(403, 'AuthorizationPermissionMismatch');
				},
			}),
		} as unknown as ContainerClient;
		await expect(
			new AzureStorage({ containerClient: deniedClient }).put('k', 'v'),
		).rejects.toMatchObject({ statusCode: 403 });
	});

	it('maps BlobAlreadyExists for create-if-absent writes to PreconditionFailedError', async () => {
		const client = {
			getBlockBlobClient: () => ({
				uploadData: async () => {
					throw azureError(409, 'BlobAlreadyExists');
				},
			}),
		} as unknown as ContainerClient;
		const bucket = new AzureStorage({ containerClient: client });

		const error = await bucket.put('k', 'v', { onlyIfNotExists: true }).catch((cause) => cause);
		expect(error).toBeInstanceOf(PreconditionFailedError);
		expect(error.message).toBe('Key "k" already exists');
		await expect(bucket.put('k', 'v')).rejects.toMatchObject({
			statusCode: 409,
			code: 'BlobAlreadyExists',
		});
	});

	it('propagates non-404 read failures', async () => {
		const deniedClient = {
			getBlobClient: () => ({
				download: async () => {
					throw azureError(403, 'AuthorizationPermissionMismatch');
				},
				getProperties: async () => {
					throw azureError(403, 'AuthorizationPermissionMismatch');
				},
			}),
		} as unknown as ContainerClient;
		const bucket = new AzureStorage({ containerClient: deniedClient });

		await expect(bucket.get('k')).rejects.toMatchObject({ statusCode: 403 });
		await expect(bucket.head('k')).rejects.toMatchObject({ statusCode: 403 });
	});

	it('attempts every delete and reports non-404 failures', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });
		await Promise.all(['a', 'b', 'c'].map((key) => bucket.put(key, key)));
		fake.deleteFailures.add('b');

		await expect(bucket.delete(['a', 'b', 'missing', 'c'])).rejects.toThrow(/Azure delete failed/);
		expect(fake.calls.deletes).toEqual(['a', 'b', 'missing', 'c']);
		expect(fake.store.has('a')).toBe(false);
		expect(fake.store.has('b')).toBe(true);
		expect(fake.store.has('c')).toBe(false);
	});
});

describe('AzureStorage listing', () => {
	it('maps continuation tokens and limits', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });
		await Promise.all(['a', 'b', 'c'].map((key) => bucket.put(key, key)));

		const first = await bucket.list({ limit: 2 });
		const second = await bucket.list({ limit: 2, cursor: first.cursor });

		expect(first.objects.map((item) => item.key)).toEqual(['a', 'b']);
		expect(first).toMatchObject({ truncated: true, cursor: '2' });
		expect(second.objects.map((item) => item.key)).toEqual(['c']);
		expect(second.truncated).toBe(false);
	});

	it('maps hierarchy prefixes separately from blobs', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });
		await Promise.all(
			['projects/a/file', 'projects/b/file', 'projects/top'].map((key) => bucket.put(key, key)),
		);

		const result = await bucket.list({ prefix: 'projects/', delimiter: '/' });

		expect(result.objects.map((item) => item.key)).toEqual(['projects/top']);
		expect(result.delimitedPrefixes).toEqual(['projects/a/', 'projects/b/']);
	});

	it('advances through empty filtered pages to implement exclusive startAfter', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });
		await Promise.all(['a', 'b', 'c'].map((key) => bucket.put(key, key)));

		const result = await bucket.list({ limit: 1, startAfter: 'b' });

		expect(result.objects.map((item) => item.key)).toEqual(['c']);
		expect(result.truncated).toBe(false);
	});
});

describe('AzureStorage conditional-write verification', () => {
	it('uses a unique key for each probe and removes both', async () => {
		const fake = makeFakeContainer();
		const bucket = new AzureStorage({ containerClient: fake.client });

		await expect(
			Promise.all([bucket.verifyConditionalWrites(), bucket.verifyConditionalWrites()]),
		).resolves.toBeDefined();
		const probeKeys = new Set(
			fake.calls.uploads
				.map((call) => call.key)
				.filter((key) => key.startsWith('_system/.cas-probe-')),
		);
		expect(probeKeys.size).toBe(2);
		expect([...fake.store.keys()].some((key) => key.startsWith('_system/.cas-probe-'))).toBe(false);
	});

	it('fails when the service ignores conditions and still removes its probe', async () => {
		const fake = makeFakeContainer({ ignoreConditions: true });
		const bucket = new AzureStorage({ containerClient: fake.client });

		await expect(bucket.verifyConditionalWrites()).rejects.toThrow(
			/Azure target does NOT enforce conditional writes/,
		);
		expect([...fake.store.keys()].some((key) => key.startsWith('_system/.cas-probe-'))).toBe(false);
	});

	it('fails when stale same-base ETags can produce multiple winners and removes its probe', async () => {
		const fake = makeFakeContainer({ allowStaleMatches: true });
		const bucket = new AzureStorage({ containerClient: fake.client });

		await expect(bucket.verifyConditionalWrites()).rejects.toThrow(
			/Azure target does NOT apply conditional writes atomically: 8/,
		);
		expect([...fake.store.keys()].some((key) => key.startsWith('_system/.cas-probe-'))).toBe(false);
	});
});

const liveContainer = process.env.MARIMOHUB_TEST_AZURE_CONTAINER;
const liveConnectionString = process.env.MARIMOHUB_TEST_AZURE_CONNECTION_STRING;
const liveAccountUrl = process.env.MARIMOHUB_TEST_AZURE_ACCOUNT_URL;
if (liveContainer && (liveConnectionString || liveAccountUrl)) {
	bucketContract('AzureStorage (live)', () =>
		liveConnectionString
			? new AzureStorage({ container: liveContainer, connectionString: liveConnectionString })
			: new AzureStorage({ container: liveContainer, accountUrl: liveAccountUrl! }),
	);
} else {
	describe.skip('AzureStorage live contract', () => {
		it('set the Azure test container and connection string or account URL', () => {});
	});
}
