import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	ObjectBucket,
	ObjectBrowseContext,
	ObjectBrowser,
	ObjectEntry,
	ObjectPage,
	ObjectStoreSource,
} from '../ports/objectBrowser';

export const OBJECT_BROWSE_PARQUET_FIXTURE = Uint8Array.from(
	atob(
		'UEFSMRUAFRwVICwVBBUAFQYVBgAADjQCAAAABAEBAAAAAgAAABUAFSgVLCwVBBUAFQYVBgAAFEwCAAAABAEDAAAAQWRhAwAAAExpbhUCGTw1ABgNZHVja2RiX3NjaGVtYRUEABUCJQIYAmlkJSIAFQwlAhgEbmFtZSUAABYEGRwZLCYAHBUCGRUAGRgCaWQVAhYEFj4WQiYIPBgEAgAAABgEAQAAABYAKAQCAAAAGAQBAAAAEREAAAAmABwVDBkVABkYBG5hbWUVAhYEFkoWTiZKPBgDTGluGANBZGEWACgDTGluGANBZGEREQAAABaIARYEJggWkAEAKChEdWNrREIgdmVyc2lvbiB2MS40LjMgKGJ1aWxkIGQxZGM4OGY5NTApANgAAABQQVIx',
	),
	(character) => character.charCodeAt(0),
);

export const OBJECT_BROWSE_CONTRACT_SEED = Object.freeze({
	direct: Object.freeze({
		path: 'contract.csv',
		body: 'name,value\nfirst,1\nsecond,2\n',
		contentType: 'text/csv',
	}),
	nested: Object.freeze({
		path: 'nested/contract.txt',
		body: 'nested contract',
		contentType: 'text/plain',
	}),
	unicode: Object.freeze({
		path: 'résumé-雪.txt',
		body: 'unicode contract',
		contentType: 'text/plain',
	}),
	empty: Object.freeze({
		path: 'empty.bin',
		body: '',
		contentType: 'application/octet-stream',
	}),
	parquet: Object.freeze({
		path: 'people.parquet',
		body: OBJECT_BROWSE_PARQUET_FIXTURE,
		contentType: 'application/vnd.apache.parquet',
	}),
	versioned: Object.freeze({
		path: 'versioned.txt',
		firstBody: 'version one',
		secondBody: 'version two',
		contentType: 'text/plain',
	}),
});

export interface ObjectBrowseContractFixture {
	bucket: string;
	prefix: string;
	directObject: string;
	nestedObject: string;
	unicodeObject: string;
	emptyObject: string;
	parquetObject: string;
	versionedObject: string;
	versions?: boolean;
}

export interface ObjectBrowseContractOptions {
	browser: ObjectBrowser;
	source: ObjectStoreSource;
	context: ObjectBrowseContext;
	setup(): Promise<ObjectBrowseContractFixture>;
	teardown?(fixture: ObjectBrowseContractFixture): Promise<void>;
}

export function objectBrowseContract(
	name: string,
	options: () => ObjectBrowseContractOptions,
): void {
	describe(`Object browse contract: ${name}`, () => {
		let opts: ObjectBrowseContractOptions;
		let fixture: ObjectBrowseContractFixture;

		beforeAll(async () => {
			opts = options();
			fixture = await opts.setup();
		}, 30_000);

		afterAll(async () => {
			if (fixture) await opts.teardown?.(fixture);
		});

		async function collect<T>(load: (cursor?: string) => Promise<ObjectPage<T>>): Promise<T[]> {
			const items: T[] = [];
			const cursors = new Set<string>();
			let cursor: string | undefined;
			for (let page = 0; page < 100; page++) {
				const result = await load(cursor);
				items.push(...result.items);
				if (result.next_cursor === null) return items;
				if (cursors.has(result.next_cursor)) throw new Error('object pagination cycled');
				cursors.add(result.next_cursor);
				cursor = result.next_cursor;
			}
			throw new Error('object pagination did not terminate');
		}

		it('lists the integration bucket', async () => {
			const buckets = await collect<ObjectBucket>((cursor) =>
				opts.browser.listBuckets(opts.source, opts.context, {
					limit: 1,
					...(cursor ? { cursor } : {}),
				}),
			);
			expect(buckets).toContainEqual(
				expect.objectContaining({
					name: fixture.bucket,
					configured: opts.source.configured_bucket === fixture.bucket,
				}),
			);
		});

		it('rejects roots outside the configured integration scope', async () => {
			if (!opts.source.configured_bucket) return;
			await expect(
				opts.browser.listObjects(opts.source, opts.context, {
					bucket: `${fixture.bucket}-outside`,
					limit: 1,
				}),
			).rejects.toMatchObject({ code: 'access_denied' });
		});

		it('rejects malformed cursors and invalid object identities', async () => {
			await expect(
				opts.browser.listObjects(opts.source, opts.context, {
					bucket: fixture.bucket,
					limit: 1,
					cursor: '!',
				}),
			).rejects.toMatchObject({ code: 'invalid_cursor' });
			await expect(
				opts.browser.headObject(opts.source, opts.context, {
					bucket: fixture.bucket,
					key: '',
				}),
			).rejects.toMatchObject({ code: 'not_found' });
		});

		it('lists only direct children with stable pagination and no duplicates', async () => {
			const items = await collect((cursor) =>
				opts.browser.listObjects(opts.source, opts.context, {
					bucket: fixture.bucket,
					prefix: fixture.prefix,
					limit: 1,
					...(cursor ? { cursor } : {}),
				}),
			);
			expect(items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: 'object', key: fixture.directObject }),
					expect.objectContaining({ kind: 'prefix', key: `${fixture.prefix}nested/` }),
				]),
			);
			expect(items.some((item) => item.key === fixture.nestedObject)).toBe(false);
			expect(new Set(items.map((item) => `${item.kind}:${item.key}`)).size).toBe(items.length);
		});

		it('reads exact metadata and a bounded preview', async () => {
			const detail = await opts.browser.headObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.directObject,
			});
			expect(detail).toMatchObject({
				bucket: fixture.bucket,
				key: fixture.directObject,
				content_type: 'text/csv',
			});
			const preview = await opts.browser.previewObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.directObject,
				limit: 1,
				content_url: '/unused',
			});
			expect(preview).toMatchObject({ kind: 'tabular', format: 'csv', truncated: true });
		});

		it('previews real Parquet bytes through provider range reads', async () => {
			const preview = await opts.browser.previewObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.parquetObject,
				limit: 20,
				content_url: '/unused',
			});
			expect(preview).toMatchObject({
				kind: 'tabular',
				format: 'parquet',
				columns: [{ name: 'id' }, { name: 'name' }],
				rows: [
					[1, 'Ada'],
					[2, 'Lin'],
				],
				truncated: false,
			});
		});

		it('handles Unicode keys and empty objects', async () => {
			await expect(
				opts.browser.headObject(opts.source, opts.context, {
					bucket: fixture.bucket,
					key: fixture.unicodeObject,
				}),
			).resolves.toMatchObject({ key: fixture.unicodeObject });
			const detail = await opts.browser.headObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.emptyObject,
			});
			expect(detail.size).toBe(0);
			const body = await opts.browser.openObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.emptyObject,
			});
			try {
				expect(await readAll(body.body)).toHaveLength(0);
			} finally {
				body.close();
			}
		});

		it('searches progressively and preserves a continuation cursor', async () => {
			const items: ObjectEntry[] = [];
			const cursors = new Set<string>();
			let cursor: string | undefined;
			let complete = false;
			for (let page = 0; page < 20; page++) {
				const result = await opts.browser.searchObjects(opts.source, opts.context, {
					bucket: fixture.bucket,
					prefix: fixture.prefix,
					query: 'contract',
					limit: 1,
					...(cursor ? { cursor } : {}),
				});
				expect(result.scanned).toBeGreaterThan(0);
				expect(result.items.length).toBeLessThanOrEqual(1);
				items.push(...result.items);
				if (result.complete) {
					complete = true;
					break;
				}
				expect(result.next_cursor).not.toBeNull();
				expect(cursors.has(result.next_cursor!)).toBe(false);
				cursors.add(result.next_cursor!);
				cursor = result.next_cursor!;
			}
			expect(items.map((item) => item.key)).toEqual(
				expect.arrayContaining([fixture.directObject, fixture.nestedObject]),
			);
			expect(complete).toBe(true);
			expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
		});

		it('streams exact and suffix byte ranges and reports version identity', async () => {
			const body = await opts.browser.openObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.directObject,
				range: 'bytes=0-3',
			});
			try {
				expect(body.status).toBe(206);
				expect(new TextDecoder().decode(await readAll(body.body))).toBe('name');
			} finally {
				body.close();
			}
			const suffix = await opts.browser.openObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.directObject,
				range: 'bytes=-4',
			});
			try {
				expect(suffix.status).toBe(206);
				expect(new TextDecoder().decode(await readAll(suffix.body))).toBe('d,2\n');
			} finally {
				suffix.close();
			}
			const versions = await opts.browser.listVersions(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.versionedObject,
				limit: 10,
			});
			if (fixture.versions !== false) {
				expect(
					versions.items.filter((item) => item.kind === 'version').length,
				).toBeGreaterThanOrEqual(2);
				expect(versions.items.every((item) => item.key === fixture.versionedObject)).toBe(true);
			} else {
				expect(versions).toEqual({ items: [], next_cursor: null });
			}
		});

		it('reports missing objects and invalid byte ranges without leaking provider details', async () => {
			await expect(
				opts.browser.headObject(opts.source, opts.context, {
					bucket: fixture.bucket,
					key: `${fixture.prefix}missing-object`,
				}),
			).rejects.toMatchObject({ code: 'not_found' });
			await expect(
				opts.browser.openObject(opts.source, opts.context, {
					bucket: fixture.bucket,
					key: fixture.directObject,
					range: 'bytes=999999999-',
				}),
			).rejects.toMatchObject({ code: 'range_not_satisfiable' });
			const detail = await opts.browser.headObject(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.directObject,
			});
			expect(detail.etag).toBeTruthy();
			await expect(
				opts.browser.openObject(opts.source, opts.context, {
					bucket: fixture.bucket,
					key: fixture.directObject,
					if_match: `not-${detail.etag}`,
				}),
			).rejects.toMatchObject({ code: 'precondition_failed' });
		});

		it('honors cancellation before provider metadata is read', async () => {
			const controller = new AbortController();
			controller.abort();
			await expect(
				opts.browser.listObjects(
					opts.source,
					{ ...opts.context, signal: controller.signal },
					{
						bucket: fixture.bucket,
						limit: 1,
					},
				),
			).rejects.toMatchObject({ code: 'aborted' });
		});
	});
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of stream) {
		chunks.push(chunk);
		length += chunk.length;
	}
	const value = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		value.set(chunk, offset);
		offset += chunk.length;
	}
	return value;
}
