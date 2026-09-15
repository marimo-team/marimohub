import { describe, expect, it } from 'vitest';
import { sha256, sha256Hex } from './sha256';

describe('sha256Hex', () => {
	it.each([
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		['ABC', 'b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78'],
		['marimo 🐍', 'bfd4dd3952ab518ba4f9e2ecb7bd1f31b0d4386fb168eb844cae0dc3b475917f'],
		[
			'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
		],
	])('hashes %j to its known lowercase digest', async (value, expected) => {
		expect(await sha256Hex(value)).toBe(expected);
	});
});

describe('sha256', () => {
	it('returns the raw digest bytes', async () => {
		expect(await sha256('abc')).toEqual(
			new Uint8Array([
				0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22,
				0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00,
				0x15, 0xad,
			]),
		);
	});
});
