import { describe, expect, it, vi } from 'vitest';
import { createProjectId, ObjectBrowseError, UserId } from '@marimo-hub/core';
import type { ObjectBrowseContext, S3ObjectStoreSource } from '@marimo-hub/core';
import type { S3ClientLike } from './client';
import { credentialsFor, endpointsMatch } from './client';
import { S3ObjectBrowser } from './index';

const source: S3ObjectStoreSource = {
	provider: 's3',
	configured_bucket: 'lake',
	region: 'us-east-1',
	endpoint: 'https://s3.example.com',
	path_style: true,
	auth: {
		method: 'static',
		access_key_id: 'access',
		secret_access_key: 'secret',
	},
};

const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('user-1'),
	user_email: 'ada@example.com',
	allow_server_ambient: {},
};

interface Sent {
	name: string;
	input: Record<string, unknown>;
	options?: { abortSignal?: AbortSignal };
}

function harness(
	responses: unknown[] | ((sent: Sent) => unknown),
	options: {
		mode?: 'metadata' | 'full';
		limits?: ConstructorParameters<typeof S3ObjectBrowser>[0]['limits'];
	} = {},
) {
	const sent: Sent[] = [];
	let destroyed = 0;
	const queue = Array.isArray(responses) ? [...responses] : undefined;
	const responder = Array.isArray(responses) ? undefined : responses;
	const client: S3ClientLike = {
		async send(command, commandOptions) {
			const value = command as { constructor: { name: string }; input: Record<string, unknown> };
			const call = { name: value.constructor.name, input: value.input, options: commandOptions };
			sent.push(call);
			const response = queue ? queue.shift() : await responder!(call);
			if (response instanceof Error) throw response;
			return response;
		},
		destroy() {
			destroyed += 1;
		},
	};
	return {
		browser: new S3ObjectBrowser({
			mode: options.mode ?? 'full',
			limits: options.limits,
			clientFactory: () => client,
		}),
		sent,
		destroyed: () => destroyed,
	};
}

describe('S3ObjectBrowser listing and metadata', () => {
	it('returns the configured bucket without calling ListBuckets', async () => {
		const test = harness([]);
		await expect(test.browser.listBuckets(source, context, { limit: 10 })).resolves.toEqual({
			items: [{ name: 'lake', configured: true }],
			next_cursor: null,
		});
		expect(test.sent).toEqual([]);
		expect(test.destroyed()).toBe(0);
	});

	it('lists and paginates provider buckets when the integration is not scoped', async () => {
		const { configured_bucket: _configuredBucket, ...unscopedSource } = source;
		const first = harness([
			{
				Buckets: [{ Name: 'one', CreationDate: new Date('2026-08-01T00:00:00Z') }, {}],
				ContinuationToken: 'next bucket',
			},
		]);
		const page = await first.browser.listBuckets(unscopedSource, context, { limit: 2 });
		expect(page).toEqual({
			items: [{ name: 'one', created_at: '2026-08-01T00:00:00.000Z', configured: false }],
			next_cursor: expect.any(String),
		});
		expect(first.sent[0]).toMatchObject({
			name: 'ListBucketsCommand',
			input: { MaxBuckets: 2 },
		});

		const second = harness([{ Buckets: [] }]);
		await second.browser.listBuckets(unscopedSource, context, {
			limit: 2,
			cursor: page.next_cursor!,
		});
		expect(second.sent[0].input.ContinuationToken).toBe('next bucket');
	});

	it('rejects cursors for a configured singleton bucket and malformed list cursors', async () => {
		const test = harness([]);
		await expect(
			test.browser.listBuckets(source, context, { limit: 1, cursor: 'cursor' }),
		).rejects.toMatchObject({ code: 'invalid_cursor' });
		await expect(
			test.browser.listObjects(source, context, {
				bucket: 'lake',
				limit: 1,
				cursor: 'malformed',
			}),
		).rejects.toMatchObject({ code: 'invalid_cursor' });
		expect(test.sent).toEqual([]);
	});

	it('merges direct prefixes and objects and suppresses duplicate folder markers', async () => {
		const test = harness([
			{
				CommonPrefixes: [{ Prefix: 'events/daily/' }],
				Contents: [
					{ Key: 'events/daily/', Size: 0 },
					{
						Key: 'events/a ?#% ü.json',
						Size: 4,
						LastModified: new Date('2026-08-01T00:00:00Z'),
						ETag: 'etag',
					},
				],
				IsTruncated: true,
				NextContinuationToken: 'opaque/+token',
			},
		]);
		const page = await test.browser.listObjects(source, context, {
			bucket: 'lake',
			prefix: 'events/',
			limit: 10,
		});
		expect(page.items).toEqual([
			expect.objectContaining({ kind: 'object', key: 'events/a ?#% ü.json' }),
			{ kind: 'prefix', key: 'events/daily/', name: 'daily' },
		]);
		expect(page.next_cursor).toEqual(expect.any(String));
		expect(test.sent[0]).toMatchObject({
			name: 'ListObjectsV2Command',
			input: { Bucket: 'lake', Prefix: 'events/', Delimiter: '/' },
		});
		expect(test.destroyed()).toBe(1);
	});

	it('rejects request buckets outside the configured scope', async () => {
		const test = harness([]);
		await expect(
			test.browser.listObjects(source, context, { bucket: 'other', limit: 10 }),
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(test.sent).toEqual([]);
	});

	it('reports bounded partial searches and continues with the opaque upstream token', async () => {
		const first = harness(
			[
				{
					Contents: [
						{ Key: 'events/one.csv', Size: 1 },
						{ Key: 'events/two.json', Size: 2 },
					],
					IsTruncated: true,
					NextContinuationToken: 'next',
				},
			],
			{ limits: { searchMaxKeys: 2 } },
		);
		const page = await first.browser.searchObjects(source, context, {
			bucket: 'lake',
			prefix: 'events/',
			query: 'csv',
			limit: 10,
		});
		expect(page).toMatchObject({ scanned: 2, complete: false, next_cursor: expect.any(String) });
		expect(page.items.map((entry) => entry.key)).toEqual(['events/one.csv']);

		const second = harness([{ Contents: [], IsTruncated: false }]);
		await second.browser.searchObjects(source, context, {
			bucket: 'lake',
			query: 'csv',
			limit: 10,
			cursor: page.next_cursor!,
		});
		expect(second.sent[0].input.ContinuationToken).toBe('next');
	});

	it('stops a large multi-page scan exactly at the configured key budget', async () => {
		const objects = (offset: number, count: number) =>
			Array.from({ length: count }, (_, index) => ({
				Key: `events/${String(offset + index).padStart(5, '0')}.json`,
			}));
		const test = harness(
			[
				{
					Contents: objects(0, 1_000),
					IsTruncated: true,
					NextContinuationToken: 'page-2',
				},
				{
					Contents: objects(1_000, 1_000),
					IsTruncated: true,
					NextContinuationToken: 'page-3',
				},
				{
					Contents: objects(2_000, 500),
					IsTruncated: true,
					NextContinuationToken: 'page-4',
				},
			],
			{ limits: { searchMaxKeys: 2_500 } },
		);
		const page = await test.browser.searchObjects(source, context, {
			bucket: 'lake',
			query: 'missing',
			limit: 10,
		});
		expect(page).toMatchObject({
			items: [],
			scanned: 2_500,
			complete: false,
			next_cursor: expect.any(String),
		});
		expect(test.sent.map((call) => call.input.MaxKeys)).toEqual([1_000, 1_000, 500]);
	});

	it('scans in batches independent of the requested result count', async () => {
		const test = harness([
			{
				Contents: [{ Key: 'events/one.json' }, { Key: 'events/two.json' }],
				IsTruncated: false,
			},
		]);
		const page = await test.browser.searchObjects(source, context, {
			bucket: 'lake',
			query: 'missing',
			limit: 1,
		});
		expect(page).toMatchObject({ items: [], scanned: 2, complete: true });
		expect(test.sent).toHaveLength(1);
		expect(test.sent[0].input.MaxKeys).toBe(1_000);
	});

	it('resumes after the last examined key when a result stops within a batch', async () => {
		const first = harness([
			{
				Contents: [{ Key: 'events/match-one.csv' }, { Key: 'events/match-two.csv' }],
				IsTruncated: false,
			},
		]);
		const page = await first.browser.searchObjects(source, context, {
			bucket: 'lake',
			prefix: 'events/',
			query: 'match',
			limit: 1,
		});
		expect(page).toMatchObject({
			items: [expect.objectContaining({ key: 'events/match-one.csv' })],
			complete: false,
			next_cursor: expect.any(String),
		});

		const second = harness([{ Contents: [{ Key: 'events/match-two.csv' }], IsTruncated: false }]);
		const resumed = await second.browser.searchObjects(source, context, {
			bucket: 'lake',
			prefix: 'events/',
			query: 'match',
			limit: 1,
			cursor: page.next_cursor!,
		});
		expect(second.sent[0].input).toMatchObject({
			StartAfter: 'events/match-one.csv',
			ContinuationToken: undefined,
		});
		expect(resumed.items.map((item) => item.key)).toEqual(['events/match-two.csv']);
		expect(resumed.complete).toBe(true);
	});

	it('rejects a search cursor that mixes continuation modes', async () => {
		const test = harness([]);
		const cursor = Buffer.from(
			JSON.stringify({ v: 1, token: 'opaque', start_after: 'events/a' }),
		).toString('base64url');
		await expect(
			test.browser.searchObjects(source, context, {
				bucket: 'lake',
				query: 'a',
				limit: 1,
				cursor,
			}),
		).rejects.toMatchObject({ code: 'invalid_cursor' });
		expect(test.sent).toEqual([]);
	});

	it('aborts stalled metadata operations at the configured deadline', async () => {
		vi.useFakeTimers();
		try {
			const test = harness(
				(sent) =>
					new Promise((_resolve, reject) => {
						sent.options?.abortSignal?.addEventListener(
							'abort',
							() => reject(new DOMException('aborted', 'AbortError')),
							{ once: true },
						);
					}),
				{ limits: { metadataTimeoutMs: 25 } },
			);
			const operation = test.browser.listObjects(source, context, {
				bucket: 'lake',
				limit: 10,
			});
			const rejected = expect(operation).rejects.toMatchObject({ code: 'aborted' });
			await vi.advanceTimersByTimeAsync(25);
			await rejected;
			expect(test.destroyed()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('propagates caller cancellation to an in-flight metadata request', async () => {
		const parent = new AbortController();
		const test = harness(
			(sent) =>
				new Promise((_resolve, reject) => {
					sent.options?.abortSignal?.addEventListener(
						'abort',
						() => reject(new DOMException('aborted', 'AbortError')),
						{ once: true },
					);
				}),
		);
		const operation = test.browser.listObjects(
			source,
			{ ...context, signal: parent.signal },
			{
				bucket: 'lake',
				limit: 10,
			},
		);
		parent.abort();
		await expect(operation).rejects.toMatchObject({ code: 'aborted' });
		expect(test.destroyed()).toBe(1);
	});

	it('sanitizes malformed provider response shapes', async () => {
		const test = harness([{ Contents: { private_detail: 'signed request secret' } }]);
		let error: unknown;
		try {
			await test.browser.listObjects(source, context, { bucket: 'lake', limit: 10 });
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({
			code: 'unavailable',
			message: 'The object-store request failed.',
		});
		expect((error as Error).message).not.toContain('signed request secret');
		expect(test.destroyed()).toBe(1);
	});

	it('fails a non-advancing provider cursor', async () => {
		const test = harness([
			{ Contents: [], IsTruncated: true, NextContinuationToken: 'same' },
			{ Contents: [], IsTruncated: true, NextContinuationToken: 'same' },
		]);
		await expect(
			test.browser.searchObjects(source, context, {
				bucket: 'lake',
				query: 'missing',
				limit: 2,
				cursor: Buffer.from(JSON.stringify({ v: 1, token: 'same' })).toString('base64url'),
			}),
		).rejects.toMatchObject({ code: 'invalid_cursor' });
	});

	it('applies format, size, and modified-time filters and reports a complete search', async () => {
		const test = harness([
			{
				Contents: [
					{
						Key: 'events/match.csv',
						Size: 20,
						LastModified: new Date('2026-08-02T00:00:00.100Z'),
					},
					{
						Key: 'events/match.json',
						Size: 20,
						LastModified: new Date('2026-08-02T00:00:00Z'),
					},
					{
						Key: 'events/match-small.csv',
						Size: 1,
						LastModified: new Date('2026-08-02T00:00:00Z'),
					},
					{
						Key: 'events/match-old.csv',
						Size: 20,
						LastModified: new Date('2026-07-01T00:00:00Z'),
					},
				],
				IsTruncated: false,
			},
		]);
		const page = await test.browser.searchObjects(source, context, {
			bucket: 'lake',
			prefix: 'events/',
			query: 'MATCH',
			formats: ['csv'],
			min_size: 10,
			max_size: 30,
			modified_after: '2026-08-02T00:00:00.1Z',
			modified_before: '2026-08-02T00:00:00.1000Z',
			limit: 10,
		});
		expect(page).toMatchObject({
			items: [expect.objectContaining({ key: 'events/match.csv' })],
			scanned: 4,
			complete: true,
			next_cursor: null,
		});
	});

	it('keeps HEAD metadata when tag permission is denied', async () => {
		const denied = Object.assign(new Error('raw provider secret'), {
			name: 'AccessDenied',
			$metadata: { httpStatusCode: 403, requestId: 'request-1' },
		});
		const test = harness([
			{
				ContentLength: 12,
				ETag: 'etag',
				Metadata: { owner: 'data' },
				ChecksumSHA256: 'sum',
			},
			denied,
		]);
		await expect(
			test.browser.headObject(source, context, { bucket: 'lake', key: 'a.txt' }),
		).resolves.toMatchObject({
			size: 12,
			metadata: { owner: 'data' },
			tags_available: false,
			checksums: [{ algorithm: 'sha256', value: 'sum' }],
		});
	});

	it('retries HEAD without optional checksums when checksum retrieval is denied', async () => {
		const denied = Object.assign(new Error('kms key detail'), {
			name: 'AccessDenied',
			$metadata: { httpStatusCode: 403 },
		});
		const test = harness([denied, { ContentLength: 12, ETag: 'etag' }, { TagSet: [] }]);
		await expect(
			test.browser.headObject(source, context, { bucket: 'lake', key: 'encrypted.txt' }),
		).resolves.toMatchObject({ size: 12, etag: 'etag', checksums: [] });
		expect(test.sent.map((call) => call.name)).toEqual([
			'HeadObjectCommand',
			'HeadObjectCommand',
			'GetObjectTaggingCommand',
		]);
		expect(test.sent[0].input.ChecksumMode).toBe('ENABLED');
		expect(test.sent[1].input.ChecksumMode).toBeUndefined();
	});

	it('propagates non-permission tag failures and still destroys the client', async () => {
		const test = harness([
			{ ContentLength: 12 },
			Object.assign(new Error('raw provider detail'), {
				name: 'InternalError',
				$metadata: { httpStatusCode: 500 },
			}),
		]);
		await expect(
			test.browser.headObject(source, context, { bucket: 'lake', key: 'a.txt' }),
		).rejects.toMatchObject({ code: 'unavailable' });
		expect(test.destroyed()).toBe(1);
	});

	it('filters version listings to the exact key and retains delete markers', async () => {
		const test = harness([
			{
				Versions: [
					{ Key: 'a', VersionId: 'v1', IsLatest: false },
					{ Key: 'ab', VersionId: 'other', IsLatest: true },
				],
				DeleteMarkers: [{ Key: 'a', VersionId: 'v2', IsLatest: true }],
				IsTruncated: false,
			},
		]);
		const page = await test.browser.listVersions(source, context, {
			bucket: 'lake',
			key: 'a',
			limit: 10,
		});
		expect(page.items).toEqual([
			expect.objectContaining({ kind: 'version', version_id: 'v1' }),
			expect.objectContaining({ kind: 'delete-marker', version_id: 'v2' }),
		]);
	});

	it('carries both version markers across version pages', async () => {
		const first = harness([
			{
				Versions: [],
				IsTruncated: true,
				NextKeyMarker: 'a',
				NextVersionIdMarker: 'v2',
			},
		]);
		const page = await first.browser.listVersions(source, context, {
			bucket: 'lake',
			key: 'a',
			limit: 10,
		});
		expect(page.next_cursor).toEqual(expect.any(String));

		const second = harness([{ Versions: [], IsTruncated: false }]);
		await second.browser.listVersions(source, context, {
			bucket: 'lake',
			key: 'a',
			limit: 10,
			cursor: page.next_cursor!,
		});
		expect(second.sent[0].input).toMatchObject({ KeyMarker: 'a', VersionIdMarker: 'v2' });
	});

	it('maps provider failures without returning their raw message', async () => {
		const provider = Object.assign(new Error('secret signed header'), {
			name: 'InternalError',
			$metadata: { httpStatusCode: 500, requestId: 'safe-id' },
		});
		const test = harness([provider]);
		let error: unknown;
		try {
			await test.browser.listObjects(source, context, { bucket: 'lake', limit: 10 });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ObjectBrowseError);
		expect(error).toMatchObject({ code: 'unavailable', request_id: 'safe-id' });
		expect((error as Error).message).not.toContain('secret signed header');
	});
});

describe('S3ObjectBrowser previews and streams', () => {
	it('aborts a preview when its request deadline is exhausted', async () => {
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
		try {
			const test = harness(
				(sent) =>
					new Promise((_resolve, reject) => {
						sent.options?.abortSignal?.addEventListener(
							'abort',
							() => reject(new DOMException('aborted', 'AbortError')),
							{ once: true },
						);
					}),
				{ limits: { previewTimeoutMs: 25 } },
			);
			const operation = test.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'slow.csv',
				limit: 20,
				content_url: '/content',
			});
			const rejected = expect(operation).rejects.toMatchObject({ code: 'aborted' });
			deadline.abort(new DOMException('deadline exceeded', 'TimeoutError'));
			await rejected;
			expect(timeout).toHaveBeenCalledWith(25);
			expect(test.destroyed()).toBe(1);
		} finally {
			timeout.mockRestore();
		}
	});

	it('previews quoted CSV explicitly within row limits', async () => {
		const csv = new TextEncoder().encode('name,note\nAda,"hello, world"\nLin,"multi\nline"\n');
		const test = harness([
			{ ContentLength: csv.length, ContentType: 'text/csv', ETag: 'etag' },
			{ Body: body(csv) },
		]);
		await expect(
			test.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'people.csv',
				limit: 1,
				content_url: '/content?key=people.csv',
			}),
		).resolves.toMatchObject({
			kind: 'tabular',
			format: 'csv',
			columns: [{ name: 'name' }, { name: 'note' }],
			rows: [['Ada', 'hello, world']],
			truncated: true,
		});
	});

	it('normalizes JSON bigint-like nested data without interpreting prototype keys', async () => {
		const json = new TextEncoder().encode('[{"__proto__":"plain","nested":{"x":1}}]');
		const test = harness([
			{ ContentLength: json.length, ContentType: 'application/json' },
			{ Body: body(json) },
		]);
		const preview = await test.browser.previewObject(source, context, {
			bucket: 'lake',
			key: 'data.json',
			limit: 20,
			content_url: '/content',
		});
		expect(preview).toMatchObject({
			kind: 'tabular',
			columns: [{ name: '__proto__' }, { name: 'nested' }],
			rows: [['plain', '{"x":1}']],
		});
	});

	it('allows magic-verified raster images but not extension-spoofed HTML', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const image = harness([{ ContentLength: png.length }, { Body: body(png) }]);
		await expect(
			image.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'safe.bin',
				limit: 20,
				content_url: '/safe-image',
			}),
		).resolves.toMatchObject({ kind: 'image', format: 'png', content_url: '/safe-image' });

		const html = new TextEncoder().encode('<script>alert(1)</script>');
		const spoofed = harness([
			{ ContentLength: html.length, ContentType: 'text/html' },
			{ Body: body(html) },
		]);
		await expect(
			spoofed.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'unsafe.png',
				limit: 20,
				content_url: '/unsafe',
			}),
		).resolves.toMatchObject({ kind: 'unsupported' });
	});

	it('rejects malformed UTF-8 and distinguishes malformed from truncated JSON', async () => {
		const invalidText = harness([
			{ ContentLength: 1, ContentType: 'text/plain' },
			{ Body: body(new Uint8Array([0xff])) },
		]);
		await expect(
			invalidText.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'bad.txt',
				limit: 20,
				content_url: '/content',
			}),
		).rejects.toMatchObject({ code: 'unsupported' });

		const malformed = new TextEncoder().encode('{bad');
		const malformedJson = harness([
			{ ContentLength: malformed.length, ContentType: 'application/json' },
			{ Body: body(malformed) },
		]);
		await expect(
			malformedJson.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'bad.json',
				limit: 20,
				content_url: '/content',
			}),
		).rejects.toMatchObject({ code: 'unsupported', message: 'The JSON file is malformed.' });

		const truncatedJson = harness(
			[{ ContentLength: 100, ContentType: 'application/json' }, { Body: body(malformed) }],
			{ limits: { previewMaxBytes: malformed.length } },
		);
		await expect(
			truncatedJson.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'large.json',
				limit: 20,
				content_url: '/content',
			}),
		).resolves.toMatchObject({ kind: 'unsupported', detected_type: 'json' });
	});

	it('normalizes duplicate and blank semicolon-delimited headers', async () => {
		const csv = new TextEncoder().encode('\ufeffname;name;\nAda;Lovelace;math\n');
		const test = harness([
			{ ContentLength: csv.length, ContentType: 'text/csv' },
			{ Body: body(csv) },
		]);
		await expect(
			test.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'people.csv',
				limit: 20,
				content_url: '/content',
			}),
		).resolves.toMatchObject({
			kind: 'tabular',
			columns: [{ name: 'name' }, { name: 'name_2' }, { name: 'column_3' }],
			rows: [['Ada', 'Lovelace', 'math']],
		});
	});

	it('handles scalar JSON, malformed JSON Lines, and incomplete final JSON Lines records', async () => {
		const scalar = new TextEncoder().encode('42');
		const scalarTest = harness([
			{ ContentLength: scalar.length, ContentType: 'application/json' },
			{ Body: body(scalar) },
		]);
		await expect(
			scalarTest.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'scalar.json',
				limit: 20,
				content_url: '/content',
			}),
		).resolves.toMatchObject({ kind: 'text', format: 'json', text: '42' });

		const malformed = new TextEncoder().encode('{"ok":1}\n{bad}\n');
		const malformedTest = harness([
			{ ContentLength: malformed.length, ContentType: 'application/x-ndjson' },
			{ Body: body(malformed) },
		]);
		await expect(
			malformedTest.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'bad.jsonl',
				limit: 20,
				content_url: '/content',
			}),
		).rejects.toMatchObject({ code: 'unsupported' });

		const partial = new TextEncoder().encode('{"ok":1}\n{"partial"');
		const partialTest = harness(
			[
				{ ContentLength: partial.length + 20, ContentType: 'application/x-ndjson' },
				{ Body: body(partial) },
			],
			{ limits: { previewMaxBytes: partial.length } },
		);
		await expect(
			partialTest.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'partial.jsonl',
				limit: 20,
				content_url: '/content',
			}),
		).resolves.toMatchObject({
			kind: 'tabular',
			rows: [[1]],
			truncated: true,
		});
	});

	it('rejects empty, oversized, and non-image inline opens before streaming', async () => {
		const empty = harness([{ ContentLength: 0 }]);
		await expect(
			empty.browser.openObject(source, context, {
				bucket: 'lake',
				key: 'empty.png',
				inline: true,
			}),
		).rejects.toMatchObject({ code: 'unsupported' });
		expect(empty.sent).toHaveLength(1);

		const oversized = harness([{ ContentLength: 11 }], {
			limits: { inlineImageMaxBytes: 10 },
		});
		await expect(
			oversized.browser.openObject(source, context, {
				bucket: 'lake',
				key: 'large.png',
				inline: true,
			}),
		).rejects.toMatchObject({ code: 'unsupported' });
		expect(oversized.sent).toHaveLength(1);

		const text = new TextEncoder().encode('not image');
		const spoofed = harness([{ ContentLength: text.length, ETag: 'etag' }, { Body: body(text) }]);
		await expect(
			spoofed.browser.openObject(source, context, {
				bucket: 'lake',
				key: 'spoofed.png',
				inline: true,
			}),
		).rejects.toMatchObject({ code: 'unsupported' });
		expect(spoofed.sent).toHaveLength(2);
		expect(spoofed.destroyed()).toBe(1);
	});

	it('pins inline reads to the HEAD ETag and releases after normal stream completion', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const test = harness([
			{ ContentLength: png.length, ETag: 'head-etag' },
			{ Body: body(png) },
			{ Body: body(png), ContentLength: png.length, ETag: 'body-etag' },
		]);
		const opened = await test.browser.openObject(source, context, {
			bucket: 'lake',
			key: 'safe.png',
			inline: true,
		});
		expect(opened).toMatchObject({ status: 200, content_type: 'image/png', total_size: 8 });
		expect(test.sent[1].input).toMatchObject({ Range: 'bytes=0-7', IfMatch: 'head-etag' });
		expect(test.sent[2].input).toMatchObject({ IfMatch: 'head-etag', Range: undefined });
		expect(new Uint8Array(await new Response(opened.body).arrayBuffer())).toEqual(png);
		expect(test.destroyed()).toBe(1);
	});

	it('sanitizes a mid-stream provider disconnect and releases the client', async () => {
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(
					Object.assign(new Error('private socket and request detail'), { name: 'InternalError' }),
				);
			},
		});
		const test = harness([{ Body: failing, ContentLength: 1 }]);
		const opened = await test.browser.openObject(source, context, {
			bucket: 'lake',
			key: 'data.bin',
		});
		await expect(new Response(opened.body).arrayBuffer()).rejects.toMatchObject({
			code: 'unavailable',
			message: 'The object-store request failed.',
		});
		expect(test.destroyed()).toBe(1);
	});

	it('errors a partially-read streaming download when the caller disconnects', async () => {
		const parent = new AbortController();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
			},
			cancel,
		});
		const test = harness([{ Body: stream, ContentLength: 1 }]);
		const opened = await test.browser.openObject(
			source,
			{ ...context, signal: parent.signal },
			{
				bucket: 'lake',
				key: 'slow.bin',
			},
		);
		const reader = opened.body.getReader();
		await expect(reader.read()).resolves.toEqual({
			done: false,
			value: new Uint8Array([1, 2, 3]),
		});
		const pendingRead = reader.read();
		parent.abort();
		await expect(pendingRead).rejects.toMatchObject({
			code: 'aborted',
			message: 'The request was canceled.',
		});
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
		expect(test.destroyed()).toBe(1);
	});

	it('preserves streaming, range metadata, and releases the client on cancellation', async () => {
		let upstreamCanceled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
			},
			cancel() {
				upstreamCanceled = true;
			},
		});
		const test = harness([
			{
				Body: stream,
				ContentLength: 3,
				ContentRange: 'bytes 0-2/10',
				ContentType: 'application/octet-stream',
				ETag: 'etag',
			},
		]);
		const opened = await test.browser.openObject(source, context, {
			bucket: 'lake',
			key: 'data.bin',
			range: 'bytes=0-2',
			if_match: 'etag',
		});
		expect(opened).toMatchObject({ status: 206, content_range: 'bytes 0-2/10', total_size: 10 });
		expect(test.sent[0].input).toMatchObject({ Range: 'bytes=0-2', IfMatch: 'etag' });
		await opened.body.cancel();
		expect(upstreamCanceled).toBe(true);
		expect(test.destroyed()).toBe(1);
		opened.close();
		expect(test.destroyed()).toBe(1);
	});

	it('cancels an unread upstream body when close is called', async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise(() => {});
			},
			cancel,
		});
		const test = harness([{ Body: stream, ContentLength: 1 }]);
		const opened = await test.browser.openObject(source, context, {
			bucket: 'lake',
			key: 'unread.bin',
		});
		opened.close();
		opened.close();
		expect(cancel).toHaveBeenCalledOnce();
		expect(test.destroyed()).toBe(1);
	});
});

describe('credential selection', () => {
	it('prefers static, then endpoint-compatible temporary credentials', () => {
		expect(credentialsFor(source, context)).toMatchObject({ accessKeyId: 'access' });
		const ambient = { ...source, auth: { method: 'ambient' as const } };
		const temporary = credentialsFor(ambient, {
			...context,
			federation: {
				provider: 's3',
				storage: { endpoint: 'https://s3.example.com/' },
				credentials: {
					accessKeyId: 'temporary',
					secretAccessKey: 'temporary-secret',
				},
			},
		});
		expect(temporary).toMatchObject({ accessKeyId: 'temporary' });
		expect(endpointsMatch('https://s3.example.com/a', 'https://s3.example.com/b')).toBe(true);
	});

	it('rejects endpoint mismatch and unacknowledged server ambient credentials', () => {
		const ambient = { ...source, auth: { method: 'ambient' as const } };
		expect(() =>
			credentialsFor(ambient, {
				...context,
				federation: {
					provider: 's3',
					storage: { endpoint: 'https://other.example.com' },
					credentials: {
						accessKeyId: 'temporary',
						secretAccessKey: 'temporary-secret',
					},
				},
			}),
		).toThrow(/not valid/);
		expect(() => credentialsFor(ambient, context)).toThrow(/not enabled/);
		expect(
			credentialsFor(ambient, { ...context, allow_server_ambient: { s3: true } }),
		).toBeUndefined();
	});
});

describe('capabilities and metadata-only mode', () => {
	it('reports credential failures without throwing', () => {
		const ambient = { ...source, auth: { method: 'ambient' as const } };
		const test = harness([]);
		expect(test.browser.capability(ambient, context)).toMatchObject({
			available: false,
			preview: false,
			download: false,
			search: 'none',
			versions: false,
			reason: expect.stringContaining('not enabled'),
		});
	});

	it('advertises and enforces metadata-only operation boundaries', async () => {
		const test = harness([], { mode: 'metadata' });
		expect(test.browser.capability(source, context)).toMatchObject({
			available: true,
			preview: false,
			download: false,
			preview_formats: [],
		});
		await expect(
			test.browser.previewObject(source, context, {
				bucket: 'lake',
				key: 'a.txt',
				limit: 20,
				content_url: '/content',
			}),
		).rejects.toMatchObject({ code: 'access_denied' });
		await expect(
			test.browser.openObject(source, context, { bucket: 'lake', key: 'a.txt' }),
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(test.sent).toEqual([]);
	});

	it('advertises preview formats and downloads only in full mode', () => {
		const test = harness([], { mode: 'full' });
		expect(test.browser.capability(source, context)).toMatchObject({
			available: true,
			preview: true,
			download: true,
			preview_formats: expect.arrayContaining(['csv', 'json', 'parquet']),
		});
	});
});

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
