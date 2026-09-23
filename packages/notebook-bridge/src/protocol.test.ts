import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	compatible,
	exactOrigin,
	MAX_QUERY_BYTES,
	Connect,
	NAMESPACE,
	QUERY_CAPABILITY,
	QuerySnapshot,
	TitleSnapshot,
	MAX_TITLE_LENGTH,
	VERSION,
} from './protocol';
import type { HostApi, QueryResult } from './protocol';
import { mergeNotebookQuery, notebookQueryParams } from './query';

describe('v1 protocol', () => {
	it('bounds title snapshots and accepts empty titles', () => {
		expect(TitleSnapshot.safeParse({ revision: 1, title: '' }).success).toBe(true);
		expect(
			TitleSnapshot.safeParse({ revision: 1, title: 'x'.repeat(MAX_TITLE_LENGTH) }).success,
		).toBe(true);
		for (const title of [null, 1, 'x'.repeat(MAX_TITLE_LENGTH + 1)]) {
			expect(TitleSnapshot.safeParse({ revision: 1, title }).success).toBe(false);
		}
	});

	it('accepts additive fields and newer minors, but requires a shared capability and major', () => {
		const connect = Connect.parse({
			namespace: NAMESPACE,
			kind: 'connect',
			documentId: 'd',
			connectionId: 'c',
			version: { major: 1, minor: 100 },
			capabilities: [QUERY_CAPABILITY, 'future'],
			excludedKeys: [],
			extra: 'ignored',
		});
		expect(compatible(connect)).toBe(true);
		expect(compatible({ ...connect, version: { ...VERSION, major: 2 } })).toBe(false);
		expect(compatible({ ...connect, capabilities: ['future'] })).toBe(false);
	});
	it.each([
		null,
		{},
		{ revision: -1, entries: [] },
		{ revision: 1, entries: [['a', 3]] },
		{ revision: 1, entries: Array.from({ length: 257 }, () => ['a', 'b']) },
		{ revision: 1, entries: [['a', '🌱'.repeat(6_000)]] },
	])('rejects invalid or oversized snapshots: %j', (snapshot) => {
		expect(QuerySnapshot.safeParse(snapshot).success).toBe(false);
	});
	it('preserves ordered duplicates, empty values, unicode, and object-property names', () => {
		const entries: [string, string][] = [
			['tag', 'one'],
			['tag', 'two'],
			['empty', ''],
			['✓', '+&#'],
			['__proto__', 'x'],
		];
		const snapshot = QuerySnapshot.parse({ revision: 1, entries, future: true });
		expect(snapshot.entries).toEqual(entries);
		expect([...notebookQueryParams(new URLSearchParams(entries).toString())]).toEqual(entries);
	});
	it('removes every encoded reserved name and provider-owned key', () => {
		expect([
			...notebookQueryParams('?%61ccess_token=secret&access_token=again&provider=private&id=1', [
				'provider',
			]),
		]).toEqual([['id', '1']]);
	});
	it('replaces notebook parameters while preserving host-owned state', () => {
		expect(
			mergeNotebookQuery(
				'?old=1&theme=dark&provider=host',
				[
					['new', '2'],
					['access_token', 'evil'],
					['provider', 'evil'],
				],
				['provider'],
			),
		).toBe('?theme=dark&provider=host&new=2');
		expect(mergeNotebookQuery('?old=1', [], [])).toBe('');
	});
	it('keeps the public method statically typed', () => {
		expectTypeOf<Parameters<HostApi['replaceQuery']>[0]>().toEqualTypeOf<QuerySnapshot>();
		expectTypeOf<ReturnType<HostApi['replaceQuery']>>().toEqualTypeOf<QueryResult>();
	});
	it('accepts the exact pair and encoded byte limits, rejecting one additional byte', () => {
		expect(
			QuerySnapshot.safeParse({ revision: 1, entries: Array.from({ length: 256 }, () => ['', '']) })
				.success,
		).toBe(true);
		const value = 'x'.repeat(MAX_QUERY_BYTES - 2);
		expect(QuerySnapshot.safeParse({ revision: 1, entries: [['k', value]] }).success).toBe(true);
		expect(QuerySnapshot.safeParse({ revision: 1, entries: [['k', `${value}x`]] }).success).toBe(
			false,
		);
		const unicode = 'é'.repeat(10_922);
		expect(QuerySnapshot.safeParse({ revision: 1, entries: [['key', unicode]] }).success).toBe(
			true,
		);
		expect(QuerySnapshot.safeParse({ revision: 1, entries: [['keys', unicode]] }).success).toBe(
			false,
		);
	});
	it.each([Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid revision %s',
		(revision) => {
			expect(QuerySnapshot.safeParse({ revision, entries: [] }).success).toBe(false);
		},
	);
	it.each([
		'*',
		'null',
		'https://hub.example/',
		'https://hub.example/path',
		'https://hub.example?x=1',
		'https://user:password@hub.example',
		'data:text/html,hello',
		'http://hub.example:80',
	])('rejects a non-exact origin %s', (origin) => {
		expect(() => exactOrigin(origin)).toThrow();
	});
	it('preserves duplicate protected keys and treats encoded separators as query data', () => {
		expect(
			mergeNotebookQuery(
				'?theme=dark&theme=light&provider=a&provider=b&old=1',
				[
					['next', '&provider=evil#fragment?'],
					['', ''],
				],
				['provider'],
			),
		).toBe('?theme=dark&theme=light&provider=a&provider=b&next=%26provider%3Devil%23fragment%3F&=');
	});
});
