import { describe, expect, it } from 'vitest';
import {
	childSegment,
	isPathTag,
	isValidTagNamespace,
	MAX_TAG_NAMESPACE_LENGTH,
	tagInNamespace,
	tagsInNamespace,
} from './tagPaths';

describe('path tags', () => {
	it.each(['a', 'a/b', 'a.b_c-d/e1'])('accepts %j', (tag) => expect(isPathTag(tag)).toBe(true));
	it.each(['', 'A', 'a/', '/a', 'a//b', '-a', 'a b', 'a\n', 'a/B', 'a\r\n', 'café', 'ａ'])(
		'rejects %j',
		(tag) => {
			expect(isPathTag(tag)).toBe(false);
			expect(isValidTagNamespace(tag)).toBe(false);
			expect(tagInNamespace('a/b', tag)).toBe(false);
		},
	);
	it('bounds namespace length', () => {
		expect(isValidTagNamespace('a'.repeat(MAX_TAG_NAMESPACE_LENGTH))).toBe(true);
		expect(isValidTagNamespace('a'.repeat(MAX_TAG_NAMESPACE_LENGTH + 1))).toBe(false);
	});
	it.each([
		['dep1', true],
		['dep1/x', true],
		['dep10', false],
		['dep1-x', false],
		['Dep1', false],
		['dep1/Team A', false],
		['dep1/x\n', false],
	])('matches %j under dep1: %s', (tag, matches) =>
		expect(tagInNamespace(tag, 'dep1')).toBe(matches),
	);
	it.each([
		['a/b', true],
		['a/b/c', true],
		['a/bc', false],
		['a', false],
	])('matches %j under nested a/b: %s', (tag, matches) =>
		expect(tagInNamespace(tag, 'a/b')).toBe(matches),
	);
	it('matches any tag without relaxing the grammar', () => {
		expect(tagsInNamespace(['other', 'dep1/x'], 'dep1')).toBe(true);
		expect(tagsInNamespace(['dep10', 'dep1/X'], 'dep1')).toBe(false);
		expect(tagsInNamespace([], 'dep1')).toBe(false);
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
	])('finds the child of %j under %j', (tag, namespace, expected) =>
		expect(childSegment(tag, namespace)).toBe(expected),
	);
});
