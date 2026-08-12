import { describe, expect, it } from 'vitest';
import { sqlIdentifier, sqlLiteral } from './sql';

describe('data-preview SQL helpers', () => {
	it.each([
		['plain_name', 'plain_name'],
		['select', '"select"'],
		['two.parts', '"two.parts"'],
		['sales"archive', '"sales""archive"'],
		['mixed Case', '"mixed Case"'],
		['emoji_🦆', '"emoji_🦆"'],
		['', '""'],
	])('formats the identifier %j', (input, expected) => {
		expect(sqlIdentifier(input)).toBe(expected);
	});

	it.each([
		['plain', "'plain'"],
		["lake's", "'lake''s'"],
		['back\\slash', "E'back\\\\slash'"],
		["x'); DROP TABLE secrets; --", "'x''); DROP TABLE secrets; --'"],
		['line\nfeed', "'line\nfeed'"],
		['', "''"],
	])('formats the literal %j', (input, expected) => {
		expect(sqlLiteral(input)).toBe(expected);
	});
});
