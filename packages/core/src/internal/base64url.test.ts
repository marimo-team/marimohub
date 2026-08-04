import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from './base64url';

describe('base64url', () => {
	it('round-trips at every len%3 boundary (0, 1, 2 trailing bytes)', () => {
		for (const len of [0, 1, 2, 3, 4, 5, 6]) {
			const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
			const encoded = toBase64Url(bytes);
			// padding-free + URL-safe alphabet only
			expect(encoded).not.toMatch(/[+/=]/);
			expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
		}
	});

	it('throws on invalid input rather than returning garbage', () => {
		// A single stray base64 char has no valid decoding.
		expect(() => fromBase64Url('a')).toThrow();
	});
});
