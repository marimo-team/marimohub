import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	ObjectBrowseContext,
	ObjectBrowser,
	ObjectEntry,
	ObjectStoreSource,
} from '../ports/objectBrowser';

export interface ObjectBrowseContractFixture {
	bucket: string;
	prefix: string;
	directObject: string;
	nestedObject: string;
	versionedObject: string;
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
			if (fixture) await opts.teardown?.(fixture)?.catch(() => {});
		});

		async function collect(
			load: (cursor?: string) => Promise<{ items: ObjectEntry[]; next_cursor: string | null }>,
		): Promise<ObjectEntry[]> {
			const items: ObjectEntry[] = [];
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

		it('lists the configured bucket without discovering unrelated buckets', async () => {
			const page = await opts.browser.listBuckets(opts.source, opts.context, { limit: 1 });
			expect(page).toEqual({
				items: [{ name: fixture.bucket, configured: true }],
				next_cursor: null,
			});
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

		it('searches progressively and preserves a continuation cursor', async () => {
			const first = await opts.browser.searchObjects(opts.source, opts.context, {
				bucket: fixture.bucket,
				prefix: fixture.prefix,
				query: 'contract',
				limit: 1,
			});
			expect(first.scanned).toBeGreaterThan(0);
			expect(first.items.length).toBeLessThanOrEqual(1);
			if (!first.complete) {
				expect(first.next_cursor).not.toBeNull();
				const second = await opts.browser.searchObjects(opts.source, opts.context, {
					bucket: fixture.bucket,
					prefix: fixture.prefix,
					query: 'contract',
					limit: 10,
					cursor: first.next_cursor!,
				});
				expect(second.scanned).toBeGreaterThan(0);
			}
		});

		it('streams an exact byte range and reports version identity', async () => {
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
			const versions = await opts.browser.listVersions(opts.source, opts.context, {
				bucket: fixture.bucket,
				key: fixture.versionedObject,
				limit: 10,
			});
			expect(
				versions.items.filter((item) => item.kind === 'version').length,
			).toBeGreaterThanOrEqual(2);
			expect(versions.items.every((item) => item.key === fixture.versionedObject)).toBe(true);
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
