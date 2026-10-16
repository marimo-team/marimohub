import { describe, expect, it } from 'vitest';
import { EtagRecordCache } from './etagRecordCache';

describe('EtagRecordCache', () => {
	it('misses unknown keys and mismatched ETags', () => {
		const cache = new EtagRecordCache<number>();
		expect(cache.get('a', 'v1')).toBeUndefined();
		expect(cache.has('a')).toBe(false);
		cache.set('a', 'v1', 1);
		expect(cache.has('a')).toBe(true);
		expect(cache.get('a', 'v2')).toBeUndefined();
		expect(cache.get('a', 'v1')).toBe(1);
	});

	it('returns the parsed value on an ETag match', () => {
		const cache = new EtagRecordCache<{ name: string }>();
		const value = { name: 'record' };
		cache.set('a', 'v1', value);
		expect(cache.get('a', 'v1')).toBe(value);
	});

	it('evicts the least recently used entry and refreshes matching reads', () => {
		const cache = new EtagRecordCache<number>(2);
		cache.set('a', 'v1', 1);
		cache.set('b', 'v1', 2);
		cache.set('c', 'v1', 3);
		expect(cache.get('a', 'v1')).toBeUndefined();
		expect(cache.get('b', 'v1')).toBe(2);
		cache.set('d', 'v1', 4);
		expect(cache.get('c', 'v1')).toBeUndefined();
		expect(cache.get('b', 'v1')).toBe(2);
		expect(cache.size).toBe(2);
	});

	it('does not refresh LRU order on an ETag mismatch', () => {
		const cache = new EtagRecordCache<number>(2);
		cache.set('a', 'v1', 1);
		cache.set('b', 'v1', 2);
		expect(cache.get('a', 'v2')).toBeUndefined();
		cache.set('c', 'v1', 3);
		expect(cache.get('a', 'v1')).toBeUndefined();
	});

	it('replaces a key without consuming another slot', () => {
		const cache = new EtagRecordCache<number>(2);
		cache.set('a', 'v1', 1);
		cache.set('b', 'v1', 2);
		cache.set('a', 'v2', 3);
		expect(cache.size).toBe(2);
		expect(cache.get('a', 'v1')).toBeUndefined();
		expect(cache.get('a', 'v2')).toBe(3);
		expect(cache.get('b', 'v1')).toBe(2);
	});

	it('deletes entries', () => {
		const cache = new EtagRecordCache<number>();
		cache.set('a', 'v1', 1);
		cache.delete('a');
		cache.delete('missing');
		expect(cache.get('a', 'v1')).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it('never matches an empty ETag', () => {
		const cache = new EtagRecordCache<number>();
		cache.set('a', '', 1);
		expect(cache.has('a')).toBe(false);
		expect(cache.get('a', '')).toBeUndefined();
	});

	it('drops an existing entry when overwritten with an empty ETag', () => {
		const cache = new EtagRecordCache<number>();
		cache.set('a', 'v1', 1);
		cache.set('a', '', 2);
		expect(cache.has('a')).toBe(false);
		expect(cache.get('a', 'v1')).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it.each([0, -1, 1.5, Infinity, Number.NaN])('rejects invalid capacity %s', (maxSize) => {
		expect(() => new EtagRecordCache(maxSize)).toThrow(RangeError);
	});
});
