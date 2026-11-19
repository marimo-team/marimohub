import { describe, expect, it } from 'vitest';
import { isValidMetadataIdentifier } from './validation';

describe('metadata identifier validation', () => {
	it.each([
		['', 128, false],
		['a'.repeat(128), 128, true],
		['a'.repeat(129), 128, false],
		['龍'.repeat(42), 128, true],
		['龍'.repeat(43), 128, false],
		['🐍', 4, true],
		['🐍', 3, false],
		['\ud800', 128, false],
		['\udfff', 128, false],
		['a\0b', 128, false],
		['\ufeffa', 128, true],
		['a'.repeat(1024), 1024, true],
		['a'.repeat(1025), 1024, false],
	])('validates %j with a %i-byte limit', (value, maxBytes, expected) => {
		expect(isValidMetadataIdentifier(value, maxBytes)).toBe(expected);
	});
});
