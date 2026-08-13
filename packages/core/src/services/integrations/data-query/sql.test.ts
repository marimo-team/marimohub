import { describe, expect, it } from 'vitest';
import { singleDataQueryStatement } from './sql';

describe('singleDataQueryStatement', () => {
	it('accepts a single statement and strips a trailing semicolon', () => {
		expect(singleDataQueryStatement('select 1;')).toBe('select 1');
		expect(singleDataQueryStatement('  select 1  ')).toBe('select 1');
	});

	it('rejects multiple statements and empty input', () => {
		expect(() => singleDataQueryStatement('select 1; select 2')).toThrow('exactly one statement');
		expect(() => singleDataQueryStatement('   ;  ')).toThrow('exactly one statement');
	});

	it('ignores semicolons inside strings, comments, and dollar quotes', () => {
		expect(singleDataQueryStatement("select ';'")).toBe("select ';'");
		expect(singleDataQueryStatement('select ";" -- trailing; comment')).toBe(
			'select ";" -- trailing; comment',
		);
		expect(singleDataQueryStatement('select 1 /* a; /* nested; */ b; */')).toBe(
			'select 1 /* a; /* nested; */ b; */',
		);
		expect(singleDataQueryStatement('select $$a;b$$')).toBe('select $$a;b$$');
		expect(singleDataQueryStatement('select $tag$a;$other$;$tag$')).toBe(
			'select $tag$a;$other$;$tag$',
		);
	});

	it("treats '' as the escape in an ordinary string and backslash as a literal", () => {
		expect(singleDataQueryStatement("select 'a'';b'")).toBe("select 'a'';b'");
		expect(singleDataQueryStatement("select 'a\\'")).toBe("select 'a\\'");
		expect(() => singleDataQueryStatement("select 'a\\';'")).toThrow('exactly one statement');
	});

	it("honors backslash escapes inside an E'...' string", () => {
		expect(singleDataQueryStatement("SELECT E'\\';'")).toBe("SELECT E'\\';'");
		expect(singleDataQueryStatement("select e'\\';'")).toBe("select e'\\';'");
		expect(singleDataQueryStatement("SELECT E'a''b'")).toBe("SELECT E'a''b'");
	});

	it('does not treat a quote after an identifier ending in E as an escape string', () => {
		expect(() => singleDataQueryStatement("select CASE'\\';'")).toThrow('exactly one statement');
	});

	it('handles a pathological run of dollar signs quickly', () => {
		const input = '$'.repeat(32 * 1024);
		expect(singleDataQueryStatement(input)).toBe(input);
	});
});
