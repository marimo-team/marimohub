import { describe, expect, it } from 'vitest';
import { createProjectId, ObjectBrowseError, UserId } from '@marimo-hub/core';
import type { ObjectBrowseContext } from '@marimo-hub/core';
import {
	decodeCursor,
	DEFAULT_OBJECT_BROWSER_LIMITS,
	detectRasterImage,
	encodeCursor,
	guardObjectStream,
	matchesObjectSearchFilters,
	previewObject,
	toWebStream,
} from './index';

const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('preview-user'),
	user_email: 'preview@example.com',
	allow_server_ambient: {},
};

describe('provider-neutral object-browser utilities', () => {
	it('round-trips opaque cursors and rejects malformed or unknown fields', () => {
		const cursor = encodeCursor({ token: 'opaque/値' });
		expect(decodeCursor(cursor, ['token'])).toEqual({ token: 'opaque/値' });
		expect(decodeCursor(encodeCursor({ v: 2, token: 'safe' }), ['token'])).toEqual({
			token: 'safe',
		});
		expect(() => decodeCursor('!', ['token'])).toThrow(/cursor/);
		expect(() => decodeCursor(encodeCursor({ secret: 'value' }), ['token'])).toThrow(/cursor/);
	});

	it('closes async iterators after a body read fails', async () => {
		const failure = new Error('provider failure');
		let returned = false;
		const body = toWebStream({
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						throw failure;
					},
					return: async () => {
						returned = true;
						return { done: true, value: undefined };
					},
				};
			},
		});
		await expect(body.getReader().read()).rejects.toBe(failure);
		expect(returned).toBe(true);
	});

	it('excludes objects without modification timestamps from bounded searches', () => {
		const entry = { kind: 'object' as const, key: 'record.csv', name: 'record.csv' };
		expect(
			matchesObjectSearchFilters(entry, {
				bucket: 'lake',
				query: 'record',
				limit: 10,
				modified_before: '2026-08-13T00:00:00Z',
			}),
		).toBe(false);
	});

	it('recognizes only raster magic bytes', () => {
		expect(detectRasterImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('png');
		expect(detectRasterImage(new TextEncoder().encode('<svg></svg>'))).toBeUndefined();
	});

	it('parses delimited data, normalizes duplicate headers, and ignores spoofed MIME', async () => {
		const bytes = new TextEncoder().encode('name,name\nAda,42\nGrace,43\n');
		const result = await preview(bytes, 'records.csv', 'application/octet-stream', 1);
		expect(result).toMatchObject({
			kind: 'tabular',
			format: 'csv',
			columns: [{ name: 'name' }, { name: 'name_2' }],
			rows: [['Ada', '42']],
			truncated: true,
		});
	});

	it('rejects active content and invalid UTF-8 without returning its bytes', async () => {
		const active = await preview(
			new TextEncoder().encode('<script>secret()</script>'),
			'page.txt',
			'text/html',
			10,
		);
		expect(active).toMatchObject({ kind: 'unsupported', detected_type: 'text/html' });
		await expect(
			preview(new Uint8Array([0xff, 0xfe]), 'bad.txt', 'text/plain', 10),
		).rejects.toMatchObject({ code: 'unsupported' });
	});

	it('sanitizes mid-stream failures', async () => {
		let reads = 0;
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
				else controller.error(new Error('provider secret'));
			},
		});
		const guarded = guardObjectStream(
			upstream,
			undefined,
			() => new ObjectBrowseError('unavailable', 'The provider stream failed.'),
		);
		const reader = guarded.body.getReader();
		await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([1, 2]) });
		await expect(reader.read()).rejects.toMatchObject({
			code: 'unavailable',
			message: 'The provider stream failed.',
		});
	});

	it('maps an abort during streaming and cancels the provider reader', async () => {
		let canceled = false;
		const upstream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise(() => {});
			},
			cancel() {
				canceled = true;
			},
		});
		const controller = new AbortController();
		const guarded = guardObjectStream(
			upstream,
			controller.signal,
			() => new ObjectBrowseError('unavailable', 'The provider stream failed.'),
		);
		const pending = guarded.body.getReader().read();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'aborted' });
		expect(canceled).toBe(true);
	});
});

async function preview(bytes: Uint8Array, key: string, contentType: string, limit: number) {
	return previewObject(
		{
			head: async () => ({
				total_bytes: bytes.byteLength,
				content_type: contentType,
				etag: 'etag',
			}),
			readRange: async (_request, start, end) => bytes.slice(start, end),
		},
		DEFAULT_OBJECT_BROWSER_LIMITS,
		context,
		{ bucket: 'lake', key, limit, content_url: '/content' },
	);
}
