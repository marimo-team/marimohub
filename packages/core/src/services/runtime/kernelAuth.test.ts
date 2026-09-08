import { afterEach, describe, expect, it, vi } from 'vitest';
import { KERNEL_AUTH_TOKEN_PATTERN } from '../../schema';
import { createKernelAuthToken } from './kernelAuth';

describe('createKernelAuthToken', () => {
	afterEach(() => vi.restoreAllMocks());

	it('creates independent 256-bit URL-safe credentials', () => {
		const tokens = new Set(Array.from({ length: 100 }, () => createKernelAuthToken()));
		expect(tokens.size).toBe(100);
		for (const token of tokens) {
			expect(token).toMatch(KERNEL_AUTH_TOKEN_PATTERN);
		}
	});

	it('fills all 32 random bytes with the platform cryptographic source', () => {
		const random = vi.spyOn(crypto, 'getRandomValues');

		createKernelAuthToken();

		expect(random).toHaveBeenCalledOnce();
		expect(random.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
		expect(random.mock.calls[0][0]).toHaveLength(32);
	});

	it('fails instead of substituting a weak token when the cryptographic source fails', () => {
		vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(() => {
			throw new Error('entropy unavailable');
		});

		expect(() => createKernelAuthToken()).toThrow('entropy unavailable');
	});
});
