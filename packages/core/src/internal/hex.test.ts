import { describe, expect, it } from 'vitest';
import { toHex } from './hex';

describe('toHex', () => {
	it('pads each byte to two chars, including leading zeros', () => {
		expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
	});

	it('renders an empty input as an empty string', () => {
		expect(toHex(new Uint8Array([]))).toBe('');
	});
});
