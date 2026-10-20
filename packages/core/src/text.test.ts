import { describe, expect, it } from 'vitest';
import { utf8Head, utf8Tail } from './text';

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
		const size = encoder.encode(value).byteLength;
		for (let cap = 0; cap <= size; cap++) {
			const head = utf8Head(value, cap);
			const tail = utf8Tail(value, cap);
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
});
