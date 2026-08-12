import { describe, it, expect } from 'vitest';
import {
	parseBool,
	parseEnum,
	parseEnumOr,
	parseIntEnv,
	parseList,
	parseSecondsEnv,
	readFolded,
	required,
	requiredVar,
} from './env';
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
	it.each(['true', 'True', ' TRUE '])('reads %o as true', (value) => {
		expect(parseBool({ F: value }, 'F')).toBe(true);
	});

	it.each(['false', 'False', ' FALSE ', '', '  ', undefined])('reads %o as false', (value) => {
		expect(parseBool({ F: value }, 'F')).toBe(false);
	});

	it.each(['1', '0', 'yes', 'no', 'truthy'])('rejects %o', (value) => {
		expect(() => parseBool({ F: value }, 'F')).toThrow(ConfigError);
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

describe('parseSecondsEnv', () => {
	it('uses a default and converts integer seconds to milliseconds', () => {
		expect(parseSecondsEnv({}, 'TIMEOUT', { dflt: 30 })).toBe(30_000);
		expect(parseSecondsEnv({ TIMEOUT: '2' }, 'TIMEOUT')).toBe(2_000);
	});

	it('supports an explicit zero only when allowed', () => {
		expect(parseSecondsEnv({ TIMEOUT: '0' }, 'TIMEOUT', { allowZero: true })).toBe(0);
		expect(() => parseSecondsEnv({ TIMEOUT: '0' }, 'TIMEOUT')).toThrow(ConfigError);
	});
});

describe('readFolded', () => {
	it('trims and lowercases a set value', () => {
		expect(readFolded({ M: '  EdiTor ' }, 'M')).toBe('editor');
	});

	it.each([undefined, '', '   '])('returns undefined for %o', (value) => {
		expect(readFolded({ M: value }, 'M')).toBeUndefined();
	});
});

describe('parseEnum', () => {
	const allowed = ['viewer', 'editor', 'admin'] as const;

	it('accepts an allowed value, case- and whitespace-insensitively', () => {
		expect(parseEnum({ M: ' Editor ' }, 'M', { allowed })).toBe('editor');
	});

	it('returns the fallback when unset or blank', () => {
		expect(parseEnum({}, 'M', { allowed, fallback: 'editor' })).toBe('editor');
		expect(parseEnum({ M: '  ' }, 'M', { allowed, fallback: 'editor' })).toBe('editor');
	});

	it('returns undefined when unset and no fallback is given', () => {
		expect(parseEnum({}, 'M', { allowed })).toBeUndefined();
	});

	it('maps an offValue to undefined (feature off)', () => {
		expect(
			parseEnum({ M: 'NONE' }, 'M', { allowed, fallback: 'editor', offValues: ['none'] }),
		).toBeUndefined();
	});

	it('throws a ConfigError listing the accepted tokens, echoing the raw value', () => {
		try {
			parseEnum({ M: 'Superadmin' }, 'M', { allowed, offValues: ['none'], docs: 'docs/x.md' });
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			const e = err as ConfigError;
			expect(e.message).toBe('Invalid M: Superadmin (expected viewer, editor, admin, none)');
			expect(e.opts.variable).toBe('M');
			expect(e.opts.docs).toBe('docs/x.md');
		}
	});
});

describe('parseEnumOr', () => {
	const modes = ['source', 'workspace'] as const;

	it('always resolves to a value: the fallback when unset, the parsed value otherwise', () => {
		expect(parseEnumOr({}, 'M', modes, 'source')).toBe('source');
		expect(parseEnumOr({ M: 'WORKSPACE' }, 'M', modes, 'source')).toBe('workspace');
	});

	it('throws on an invalid value', () => {
		expect(() => parseEnumOr({ M: 'always' }, 'M', modes, 'source')).toThrow(
			/Invalid M.*source, workspace/,
		);
	});
});
