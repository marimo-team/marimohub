import { describe, expect, it } from 'vitest';
import { hmacSha256, timingSafeEqual } from './hmac';

describe('timingSafeEqual', () => {
	it('returns false on a length mismatch (never index out of the shorter array)', () => {
		expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
		expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([0]))).toBe(false);
	});

	it('returns true for equal contents and false for a single differing byte', () => {
		expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
		expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
	});
});

describe('hmacSha256', () => {
	it('is key-dependent: the same payload under different secrets does not match', async () => {
		const a = await hmacSha256('secret-a', 'payload');
		const b = await hmacSha256('secret-b', 'payload');
		expect(a).toHaveLength(32);
		expect(timingSafeEqual(a, b)).toBe(false);
	});

	it('is deterministic for the same secret + payload', async () => {
		const a = await hmacSha256('secret', 'payload');
		const b = await hmacSha256('secret', 'payload');
		expect(timingSafeEqual(a, b)).toBe(true);
	});
});
