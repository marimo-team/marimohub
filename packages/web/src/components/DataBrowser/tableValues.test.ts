import { describe, expect, it } from 'vitest';
import { formatCell, withOccurrenceKeys } from './tableValues';

describe('table values', () => {
	it('formats null, undefined, bigint, and cyclic values', () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect([null, undefined, 123n, 1, false, 'text', { a: 1 }, cyclic].map(formatCell)).toEqual([
			'null',
			'',
			'123',
			'1',
			'false',
			'text',
			'{"a":1}',
			'[unserializable]',
		]);
	});

	it('assigns deterministic occurrence keys to duplicate headers and rows without changing values', () => {
		const headers = ['value', 'value', 'other', 'value'];
		expect(withOccurrenceKeys(headers, (value) => value).map(({ key }) => key)).toEqual([
			'value:0',
			'value:1',
			'other:0',
			'value:2',
		]);
		const rows = [[123n], [123n], [null], [undefined]];
		const fingerprint = (row: unknown[]) => JSON.stringify(Array.from(row, formatCell));
		const keyed = withOccurrenceKeys(rows, fingerprint);
		expect(keyed).toEqual(withOccurrenceKeys(rows, fingerprint));
		expect(new Set(keyed.map(({ key }) => key)).size).toBe(4);
		keyed.forEach(({ item }, index) => expect(item).toBe(rows[index]));
	});

	it('lets callsites preserve dense preview cells and sparse SQL fingerprints', () => {
		const sparse: unknown[] = [];
		sparse.length = 2;
		sparse[1] = null;
		expect(Array.from(sparse, formatCell)).toEqual(['', 'null']);
		expect(JSON.stringify(sparse.map(formatCell))).toBe('[null,"null"]');
		expect(JSON.stringify(Array.from(sparse, formatCell))).toBe('["","null"]');
	});
});
