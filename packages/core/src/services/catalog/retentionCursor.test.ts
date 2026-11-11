import { expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { readRetentionCursor, retentionBatch, writeRetentionCursor } from './retentionCursor';

it('preserves a competing cursor when a stale checkpoint loses CAS', async () => {
	const bucket = new MemoryBucket();
	const key = '_system/test-retention.json';
	const initial = await readRetentionCursor(bucket, key);
	await writeRetentionCursor(bucket, key, 'a', initial.etag);
	await writeRetentionCursor(bucket, key, 'z', initial.etag);
	expect((await readRetentionCursor(bucket, key)).after).toBe('a');
	const loaded = await readRetentionCursor(bucket, key);
	await writeRetentionCursor(bucket, key, 'b', loaded.etag);
	await writeRetentionCursor(bucket, key, 'z', loaded.etag);
	expect((await readRetentionCursor(bucket, key)).after).toBe('b');
});

it('wraps after removed cursor entries without mutating the catalog array', () => {
	const items = [{ key: 'c' }, { key: 'a' }];
	expect(retentionBatch(items, 'b', 1)).toEqual([{ key: 'c' }]);
	expect(retentionBatch(items, 'z', 1)).toEqual([{ key: 'a' }]);
	expect(items.map(({ key }) => key)).toEqual(['c', 'a']);
});

it('rejects corrupt and oversized cursors without accepting their scan position', async () => {
	const bucket = new MemoryBucket();
	const key = '_system/test-retention.json';
	await bucket.put(key, '{');
	await expect(readRetentionCursor(bucket, key)).rejects.toThrow();
	await bucket.put(key, 'x'.repeat(4097));
	await expect(readRetentionCursor(bucket, key)).rejects.toThrow('Retention cursor exceeds budget');
});

it('uses an explicitly present empty ETag as a CAS condition', async () => {
	const bucket = new MemoryBucket();
	const written = await bucket.put('existing', '');
	const put = vi.spyOn(bucket, 'put').mockResolvedValue(written);
	await writeRetentionCursor(bucket, 'cursor', 'next', '');
	expect(put).toHaveBeenCalledExactlyOnceWith('cursor', JSON.stringify({ after: 'next' }), {
		onlyIfEtagMatches: '',
	});
});
