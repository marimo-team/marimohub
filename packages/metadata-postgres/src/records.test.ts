import { describe, expect, it } from 'vitest';
import type { BucketObjectBody } from '@marimo-hub/core/ports/bucket';
import { body, matchesRecord } from './records';
import type { RecordRow } from './records';

const row: RecordRow = {
	key: 'key',
	etag: 'etag',
	size_bytes: '3',
	uploaded_at: new Date(0),
	http_metadata: { contentType: 'application/octet-stream' },
	custom_metadata: { owner: 'test' },
	body: Buffer.from([0, 128, 255]),
};

describe('transfer record comparison', () => {
	it('compares bytes and metadata independently of generated ETags and upload times', async () => {
		expect(
			await matchesRecord(row, { ...body(row), etag: 'new-etag', uploaded: new Date(1) }),
		).toBe(true);
	});
	it.each<[string, BucketObjectBody | null]>([
		['missing object', null],
		['changed binary content', body({ ...row, body: Buffer.from([0, 128, 254]) })],
		['shorter body', body({ ...row, body: Buffer.from([0, 128]) })],
		['different HTTP metadata', body({ ...row, http_metadata: { contentType: 'text/plain' } })],
		['missing custom metadata', body({ ...row, custom_metadata: null })],
		['different custom metadata', body({ ...row, custom_metadata: { owner: 'other' } })],
	])('rejects %s', async (_, candidate) => {
		expect(await matchesRecord(row, candidate)).toBe(false);
	});
	it('matches empty bodies with no metadata', async () => {
		const empty = {
			...row,
			body: Buffer.alloc(0),
			size_bytes: '0',
			http_metadata: null,
			custom_metadata: null,
		};
		expect(await matchesRecord(empty, body(empty))).toBe(true);
	});
});
