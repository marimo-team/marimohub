import { describe, expect, it } from 'vitest';
import { utf8Tail } from './text';

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
