import { describe, expect, it } from 'vitest';
import { decodeUtf8PreservingBom, utf8Head, utf8HeadBytes, utf8Tail } from './text';

describe('decodeUtf8PreservingBom', () => {
	it.each([
		{ name: 'empty input', value: '' },
		{ name: 'BOM only', value: '\ufeff' },
		{ name: 'plain UTF-8', value: '# café α 🐍\r\n' },
		{ name: 'BOM, CRLF, and Unicode', value: '\ufeff# café α 🐍\r\n' },
		{ name: 'repeated and embedded BOMs', value: '\ufeff\ufeff# a\ufeffb\n' },
	])('preserves $name in either mode', ({ value }) => {
		const bytes = new TextEncoder().encode(value);
		expect(decodeUtf8PreservingBom(bytes)).toBe(value);
		expect(decodeUtf8PreservingBom(bytes, { fatal: true })).toBe(value);
	});

	it.each([
		{ name: 'invalid continuation', bytes: [0xc3, 0x28], expected: '\ufffd(' },
		{
			name: 'BOM before invalid continuation',
			bytes: [0xef, 0xbb, 0xbf, 0xc3, 0x28],
			expected: '\ufeff\ufffd(',
		},
		{ name: 'truncated BOM', bytes: [0xef, 0xbb], expected: '\ufffd' },
	])('replaces $name by default and rejects it in strict mode', ({ bytes, expected }) => {
		const input = Uint8Array.from(bytes);
		expect(decodeUtf8PreservingBom(input)).toBe(expected);
		expect(decodeUtf8PreservingBom(input, { fatal: false })).toBe(expected);
		expect(() => decodeUtf8PreservingBom(input, { fatal: true })).toThrow(TypeError);
	});

	it('decodes only the supplied byte view without modifying it', () => {
		const bytes = new TextEncoder().encode('x\ufeffcafé🐍z');
		const original = new Uint8Array(bytes);
		const view = bytes.subarray(1, bytes.length - 1);
		expect(decodeUtf8PreservingBom(view)).toBe('\ufeffcafé🐍');
		expect(bytes).toEqual(original);
	});
});

describe('utf8Tail', () => {
	it('returns the suffix when the byte window starts on a code-point boundary', () => {
		expect(utf8Tail('aébc', 4)).toBe('ébc');
	});

	it.each([
		['2-byte', 'xé', 1],
		['3-byte', 'x€', 2],
		['4-byte', 'x😀', 3],
	])('drops a partial %s code point', (_label, value, maxBytes) => {
		expect(utf8Tail(value, maxBytes)).toBe('');
	});

	it('skips continuation bytes when the lead byte is before the window', () => {
		expect(utf8Tail('x€tail', 5)).toBe('tail');
	});

	it('returns an empty input unchanged', () => {
		expect(utf8Tail('', 5)).toBe('');
	});

	it('returns a value that already fits unchanged', () => {
		expect(utf8Tail('hé', 3)).toBe('hé');
	});
});

describe('UTF-8 byte budgets', () => {
	it.each(['é', '€', '😀'])('never cuts inside %s in either direction', (character) => {
		const encoder = new TextEncoder();
		const value = `a${character}z`;
		const encoded = encoder.encode(value);
		const size = encoded.byteLength;
		for (let cap = 0; cap <= size; cap += 0.25) {
			const head = utf8Head(value, cap);
			const tail = utf8Tail(value, cap);
			expect(utf8HeadBytes(encoded, cap)).toBe(head);
			expect(encoder.encode(head).byteLength).toBeLessThanOrEqual(cap);
			expect(encoder.encode(tail).byteLength).toBeLessThanOrEqual(cap);
			expect(value.startsWith(head)).toBe(true);
			expect(value.endsWith(tail)).toBe(true);
			expect(head).not.toContain('�');
			expect(tail).not.toContain('�');
		}
		expect(utf8Head(value, 0)).toBe('');
		expect(utf8Tail(value, 0)).toBe('');
		expect(utf8Head(value, size)).toBe(value);
		expect(utf8Head(value, size - 1)).toBe(`a${character}`);
		expect(utf8Head(value, size - 2)).toBe('a');
	});

	it.each([Number.NaN, -Infinity, -10, -0.5, 0, 0.5])(
		'returns no content for an unusable byte budget (%s)',
		(cap) => {
			expect(utf8Head('aé😀z', cap)).toBe('');
			expect(utf8HeadBytes(new TextEncoder().encode('aé😀z'), cap)).toBe('');
			expect(utf8Tail('aé😀z', cap)).toBe('');
		},
	);

	it.each([Infinity, Number.MAX_VALUE])('allows unbounded content (%s)', (cap) => {
		expect(utf8Head('aé😀z', cap)).toBe('aé😀z');
		expect(utf8HeadBytes(new TextEncoder().encode('aé😀z'), cap)).toBe('aé😀z');
		expect(utf8Tail('aé😀z', cap)).toBe('aé😀z');
	});

	it('decodes a byte view without reading outside it or mutating the source', () => {
		const encoded = new TextEncoder().encode('xé😀z');
		const original = new Uint8Array(encoded);
		const view = encoded.subarray(1, encoded.length - 1);
		expect(utf8HeadBytes(view, 5.5)).toBe('é');
		expect(utf8HeadBytes(view, Infinity)).toBe('é😀');
		expect(utf8HeadBytes(view.subarray(0, 0), Infinity)).toBe('');
		expect(encoded).toEqual(original);
	});
});
