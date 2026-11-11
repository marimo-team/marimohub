import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { readRetentionCursor, retentionBatch, writeRetentionCursor } from './retentionCursor';

afterEach(() => vi.restoreAllMocks());

it('preserves a competing cursor when a stale checkpoint loses CAS', async () => {
	const bucket = new MemoryBucket();
	const key = '_system/test-retention.json';
	const initial = await readRetentionCursor(bucket, key);
	await writeRetentionCursor(bucket, key, 'a', initial);
	await writeRetentionCursor(bucket, key, 'z', initial);
	expect((await readRetentionCursor(bucket, key)).after).toBe('a');
	const loaded = await readRetentionCursor(bucket, key);
	await writeRetentionCursor(bucket, key, 'b', loaded);
	await writeRetentionCursor(bucket, key, 'z', loaded);
	expect((await readRetentionCursor(bucket, key)).after).toBe('b');
});

it('wraps after removed cursor entries without mutating the catalog array', () => {
	const items = [{ key: 'c' }, { key: 'a' }];
	expect(retentionBatch(items, 'b', 1)).toEqual([{ key: 'c' }]);
	expect(retentionBatch(items, 'z', 1)).toEqual([{ key: 'a' }]);
	expect(items.map(({ key }) => key)).toEqual(['c', 'a']);
});

it.each([
	['corrupt', '{'],
	['schema-invalid', JSON.stringify({ after: 1 })],
	['oversized', 'x'.repeat(4097)],
])('restarts from a %s cursor and CAS-replaces it', async (_, body) => {
	const bucket = new MemoryBucket();
	const key = '_system/test-retention.json';
	const stored = await bucket.put(key, body);
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	const cursor = await readRetentionCursor(bucket, key);
	expect(cursor).toEqual({ after: '', etag: stored.etag, reset: true });
	expect(log).toHaveBeenCalledOnce();
	expect(log.mock.calls[0][0]).toContain('stored_object_skipped');
	await writeRetentionCursor(bucket, key, '', cursor);
	expect(await readRetentionCursor(bucket, key)).toEqual({
		after: '',
		etag: (await bucket.head(key))!.etag,
	});
});

it('skips rewriting an unchanged cursor', async () => {
	const bucket = new MemoryBucket();
	const key = '_system/test-retention.json';
	await writeRetentionCursor(bucket, key, 'a', await readRetentionCursor(bucket, key));
	const put = vi.spyOn(bucket, 'put');
	await writeRetentionCursor(bucket, key, 'a', await readRetentionCursor(bucket, key));
	expect(put).not.toHaveBeenCalled();
	await writeRetentionCursor(bucket, key, 'b', await readRetentionCursor(bucket, key));
	expect(put).toHaveBeenCalledOnce();
});

it('uses an explicitly present empty ETag as a CAS condition', async () => {
	const bucket = new MemoryBucket();
	const written = await bucket.put('existing', '');
	const put = vi.spyOn(bucket, 'put').mockResolvedValue(written);
	await writeRetentionCursor(bucket, 'cursor', 'next', { after: '', etag: '' });
	expect(put).toHaveBeenCalledExactlyOnceWith('cursor', JSON.stringify({ after: 'next' }), {
		onlyIfEtagMatches: '',
	});
});

it('round-trips next_at and rewrites a cursor whose deadline changed', async () => {
	const bucket = new MemoryBucket();
	const key = '_system/test-retention.json';
	await writeRetentionCursor(bucket, key, 'a', await readRetentionCursor(bucket, key), 10);
	const cursor = await readRetentionCursor(bucket, key);
	expect(cursor).toMatchObject({ after: 'a', next_at: 10 });
	const put = vi.spyOn(bucket, 'put');
	await writeRetentionCursor(bucket, key, 'a', cursor, 10);
	expect(put).not.toHaveBeenCalled();
	await writeRetentionCursor(bucket, key, 'a', cursor, 20);
	expect((await readRetentionCursor(bucket, key)).next_at).toBe(20);
});
