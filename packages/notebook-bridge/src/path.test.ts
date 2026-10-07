import { describe, expect, it } from 'vitest';
import { notebookPath, relativeNotebookPath, resolveNotebookPath, validNotebookPath } from './path';
import { mergeNotebookQuery, notebookQueryParams, shareableNotebookQuery } from './query';
import { QuerySnapshot } from './protocol';

describe('sandbox-relative paths', () => {
	it.each(['', 'studio/data/', 'pages/sales', 'files/a%20b.py', 'café/', 'files/100%25.py'])(
		'accepts %j',
		(path) => {
			expect(validNotebookPath(path)).toBe(true);
			expect(QuerySnapshot.safeParse({ revision: 1, entries: [], path }).success).toBe(true);
		},
	);
	it.each([
		'/studio/',
		'//evil.example/',
		'https://evil.example/',
		'javascript:alert(1)',
		'../admin',
		'a/../admin',
		'./view',
		'%2e%2e/admin',
		'a/%2E./admin',
		'%252e%252e/admin',
		'%25252e%25252e/admin',
		'a%2f..%2fadmin',
		'a\\..\\admin',
		'%5c%5cevil.example',
		'view?token=secret',
		'view#anchor',
		'view\n',
		'view%0a',
		'view%00',
		'view%7f',
		'view name',
		'%',
		'%ff',
		'a'.repeat(4097),
		'é'.repeat(683),
	])('rejects %j before URL normalization', (path) => {
		expect(validNotebookPath(path)).toBe(false);
		expect(QuerySnapshot.safeParse({ revision: 1, entries: [], path }).success).toBe(false);
		expect(
			resolveNotebookPath(new URL('https://sandbox.example/proxy/token/'), path),
		).toBeUndefined();
	});
	it('bounds the URL pathname rather than its query-string encoding', () => {
		expect(validNotebookPath('a'.repeat(4096))).toBe(true);
		expect(validNotebookPath('%C3%A9'.repeat(682))).toBe(true);
		expect(validNotebookPath('%C3%A9'.repeat(683))).toBe(false);
		const path = '+'.repeat(4096);
		expect(validNotebookPath(path)).toBe(true);
		const search = mergeNotebookQuery('', [], [], path);
		expect(search).toBe(`?__mh_path=${'%2B'.repeat(4096)}`);
		expect(notebookPath(search)).toBe(path);
	});
	it('removes only a complete trusted base prefix', () => {
		expect(relativeNotebookPath('/hub/proxy/token/studio/data/', '/hub/proxy/token/')).toBe(
			'studio/data/',
		);
		expect(relativeNotebookPath('/hub/proxy/token/', '/hub/proxy/token/')).toBe('');
		expect(relativeNotebookPath('/hub/proxy/token', '/hub/proxy/token/')).toBe('');
		expect(
			relativeNotebookPath('/hub/proxy/token-other/studio/', '/hub/proxy/token/'),
		).toBeUndefined();
		expect(relativeNotebookPath('/studio/data/', '/hub/proxy/token/')).toBeUndefined();
	});
	it('restores under the current base and keeps current credentials', () => {
		const base = new URL('https://new.example/hub/proxy/new?access_token=current#cell');
		expect(resolveNotebookPath(base, 'studio/data/')?.href).toBe(
			'https://new.example/hub/proxy/new/studio/data/?access_token=current#cell',
		);
		expect(base.pathname).toBe('/hub/proxy/new');
	});
	it('rejects duplicate metadata and separates shared queries from notebook queries', () => {
		const search = '?id=1&__mh_path=studio%2Fdata%2F&access_token=secret';
		expect(notebookPath(search)).toBe('studio/data/');
		expect([...notebookQueryParams(search)]).toEqual([['id', '1']]);
		expect([...shareableNotebookQuery(search)]).toEqual([
			['id', '1'],
			['__mh_path', 'studio/data/'],
		]);
		for (const query of ['?__mh_path=a&__mh_path=b', '?__mh_path=..%2Fadmin', '?__mh_path=']) {
			expect(shareableNotebookQuery(query).has('__mh_path')).toBe(false);
		}
	});
	it('updates path and query together, preserves old-peer paths, and clears the default view', () => {
		const initial = '?__mh_path=studio%2Fold%2F&id=old&theme=dark';
		const search = mergeNotebookQuery(
			initial,
			[
				['id', 'new'],
				['__mh_path', 'spoof'],
			],
			[],
			'studio/new/',
		);
		expect(new URLSearchParams(search)).toEqual(
			new URLSearchParams('theme=dark&id=new&__mh_path=studio%2Fnew%2F'),
		);
		expect(notebookPath(mergeNotebookQuery(search, [], []))).toBe('studio/new/');
		expect(mergeNotebookQuery(search, [], [], '')).toBe('?theme=dark');
	});
	it.each(['studio%2Fold%2F', '..%2Fadmin', 'a&__mh_path=b'])(
		'clears existing path metadata %j when a supplied path is invalid',
		(existing) => {
			const search = mergeNotebookQuery(
				`?__mh_path=${existing}&theme=dark&id=old`,
				[
					['id', 'new'],
					['__mh_path', 'spoof'],
				],
				[],
				'../admin',
			);
			expect(search).toBe('?theme=dark&id=new');
		},
	);
});
