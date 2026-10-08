import { describe, expect, it } from 'vitest';
import { childSegment, isPathTag, tagMatchesPrefix, tagsMatchPrefix } from './tagPaths';

describe('path tags', () => {
	it.each(['a', 'a/b', 'a.b_c-d/e1'])('accepts %j', (tag) => expect(isPathTag(tag)).toBe(true));
	it.each(['', 'A', 'a/', '/a', 'a//b', '-a', 'a b', 'a\n', 'a/B', 'a\r\n'])(
		'rejects %j',
		(tag) => {
			expect(isPathTag(tag)).toBe(false);
			expect(tagMatchesPrefix('a/b', tag)).toBe(false);
		},
	);
	it.each([
		['dep1', true],
		['dep1/x', true],
		['dep10', false],
		['dep1-x', false],
		['Dep1', false],
		['dep1/Team A', false],
		['dep1/x\n', false],
	])('matches %j under dep1: %s', (tag, matches) =>
		expect(tagMatchesPrefix(tag, 'dep1')).toBe(matches),
	);
	it('matches any tag without relaxing the grammar', () => {
		expect(tagsMatchPrefix(['other', 'dep1/x'], 'dep1')).toBe(true);
		expect(tagsMatchPrefix(['dep10', 'dep1/X'], 'dep1')).toBe(false);
		expect(tagsMatchPrefix([], 'dep1')).toBe(false);
	});
	it.each([
		['a/b/c', undefined, 'a'],
		['a', undefined, 'a'],
		['a/b/c', 'a', 'b'],
		['a/b/c', 'a/b', 'c'],
		['a', 'a', undefined],
		['ab/c', 'a', undefined],
		['a/B', 'a', undefined],
		['a/b', '', undefined],
		['a/b', 'a/', undefined],
	])('finds the child of %j under %j', (tag, prefix, expected) =>
		expect(childSegment(tag, prefix)).toBe(expected),
	);
});
