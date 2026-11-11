import { describe, expect, it } from 'vitest';
import { hasCacheDirective } from './responseUtils';

describe('hasCacheDirective', () => {
	it.each([
		['private, no-store', true],
		['NO-STORE', true],
		['private="Set-Cookie, Authorization", no-store', true],
		['foo="a, no-store, b"', false],
		['foo="a \\" no-store, b"', false],
		['no-store-later', false],
		[null, false],
	] as const)('%s -> %s', (cacheControl, expected) => {
		expect(hasCacheDirective(cacheControl, 'no-store')).toBe(expected);
	});

	it('matches a directive that carries an argument', () => {
		expect(hasCacheDirective('no-cache="Set-Cookie", max-age=0', 'no-cache')).toBe(true);
	});
});
