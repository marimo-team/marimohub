import { describe, it, expect } from 'vitest';
import { required, requiredVar, parseList, parseBool, parseIntEnv } from './env';
import { ConfigError } from './errors';

describe('required', () => {
	it('returns the value when set', () => {
		expect(required({ FOO: 'bar' }, 'FOO')).toBe('bar');
	});

	it.each(['', undefined])('throws ConfigError when the value is %o', (value) => {
		expect(() => required({ FOO: value }, 'FOO')).toThrow(ConfigError);
		expect(() => required({ FOO: value }, 'FOO')).toThrow(/FOO/);
	});
});

describe('requiredVar', () => {
	it('returns the value when set', () => {
		expect(requiredVar({ FOO: 'bar' }, 'FOO', { remediation: 'set it' })).toBe('bar');
	});

	it('throws a ConfigError carrying the variable and remediation', () => {
		try {
			requiredVar({}, 'FOO', { remediation: 'set it', docs: 'docs/x.md' });
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).opts.variable).toBe('FOO');
			expect((err as ConfigError).opts.remediation).toBe('set it');
		}
	});
});

describe('parseList', () => {
	it('splits, trims, and drops empty items', () => {
		expect(parseList(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
	});

	it.each([undefined, '', '  ', ' , , '])('returns undefined for %o', (raw) => {
		expect(parseList(raw)).toBeUndefined();
	});
});

describe('parseBool', () => {
	it('is true only for the literal "true"', () => {
		expect(parseBool({ F: 'true' }, 'F')).toBe(true);
	});

	it.each(['True', 'TRUE', '1', 'yes', '', undefined])('is false for %o', (value) => {
		expect(parseBool({ F: value }, 'F')).toBe(false);
	});
});

describe('parseIntEnv', () => {
	it('parses an integer', () => {
		expect(parseIntEnv({ N: '42' }, 'N')).toBe(42);
	});

	it.each([undefined, ''])('returns undefined when unset (%o)', (value) => {
		expect(parseIntEnv({ N: value }, 'N')).toBeUndefined();
	});

	it.each(['1.5', 'abc', '10px'])('throws ConfigError on the non-integer %o', (value) => {
		expect(() => parseIntEnv({ N: value }, 'N')).toThrow(ConfigError);
	});
});
