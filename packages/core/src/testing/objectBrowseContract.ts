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
	unicodeObject: string;
	emptyObject: string;
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

		it('rejects roots outside the configured integration scope', async () => {
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
