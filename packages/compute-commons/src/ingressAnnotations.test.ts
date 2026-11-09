import { describe, expect, it } from 'vitest';
import { parseIngressAnnotations, validateIngressAnnotations } from './ingressAnnotations';

describe('ingress annotation boundaries', () => {
	it.each(['', '  ', undefined, '{}'])('treats empty configuration as unset: %s', (raw) => {
		expect(parseIngressAnnotations(raw)).toBeUndefined();
	});

	it.each(['null', '[]', 'true', '{', '{"key":1}', '{"key":null}'])(
		'rejects malformed annotation maps: %s',
		(raw) => {
			expect(() => parseIngressAnnotations(raw)).toThrow();
		},
	);

	it('counts Unicode values in bytes at the Kubernetes limit', () => {
		const value = `${'é'.repeat((256 * 1024 - 2) / 2)}a`;
		expect(validateIngressAnnotations({ k: value })).toEqual({ k: value });
		expect(() => validateIngressAnnotations({ k: `${value}a` })).toThrow(/256 KiB/);
	});

	it('enforces DNS prefix and annotation name length boundaries', () => {
		const prefix = [63, 63, 63, 61].map((length) => 'a'.repeat(length)).join('.');
		const name = 'b'.repeat(63);
		expect(validateIngressAnnotations({ [`${prefix}/${name}`]: '' })).toBeDefined();
		expect(() => validateIngressAnnotations({ [`${prefix}a/${name}`]: '' })).toThrow(/DNS prefix/);
		expect(() => validateIngressAnnotations({ [`example.com/${name}b`]: '' })).toThrow(
			/annotation name/,
		);
		expect(() => validateIngressAnnotations({ [`${'a'.repeat(64)}.com/key`]: '' })).toThrow(
			/DNS prefix/,
		);
	});
});
