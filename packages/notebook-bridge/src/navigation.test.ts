import { describe, expect, it } from 'vitest';
import { appNavigation, appNavigationHref } from './navigation';

const base = 'https://hub.example/prefix/app/';

describe('app link destinations', () => {
	it.each(['/app/', 'app/', base])(
		'recognizes %s links and preserves application parameters',
		(prefix) => {
			const destination = appNavigation(
				`${prefix}team/match?id=xyz&tag=one&tag=two&empty=&q=%E2%9C%93&provider=secret&access_token=secret&file=notebook.py#result`,
				base,
				['provider'],
			);
			expect(destination).toEqual({
				slug: 'team/match',
				entries: [
					['id', 'xyz'],
					['tag', 'one'],
					['tag', 'two'],
					['empty', ''],
					['q', '✓'],
				],
				hash: '#result',
			});
			expect(appNavigationHref(destination!, base)).toBe(
				`${base}team/match?id=xyz&tag=one&tag=two&empty=&q=%E2%9C%93#result`,
			);
		},
	);
	it.each([
		'/app/',
		'/app/../admin',
		'/app/%2e%2e/admin',
		'/app/match%2fother',
		'/app/match\\other',
		'//evil.example/app/match',
		'https://evil.example/app/match',
		'javascript:alert(1)',
		'/admin',
		'#app/match',
		'?next=/app/match',
		'./app/match',
		'/app/match\n',
		'/app/match#bad\nfragment',
		'/app/match#bad\n',
		'/app/UPPERCASE',
		`/app/${'x'.repeat(64)}`,
		`/app/match?large=${'x'.repeat(65537)}`,
		`/app/match?${Array.from({ length: 257 }, () => 'id=1').join('&')}`,
	])('leaves unsupported or malformed href %s alone', (href) => {
		expect(appNavigation(href, base, [])).toBeUndefined();
	});
});

it('accepts boundary lengths and rejects the next encoded byte or query pair', () => {
	const slug = 'a'.repeat(63);
	const hash = `#${'x'.repeat(8191)}`;
	const value = 'x'.repeat(65534);
	expect(appNavigation(`/app/${slug}?q=${value}${hash}`, base, [])).toEqual({
		slug,
		entries: [['q', value]],
		hash,
	});
	expect(appNavigation(`/app/${slug}?q=${value}x`, base, [])).toBeUndefined();
	expect(appNavigation(`/app/${slug}${hash}x`, base, [])).toBeUndefined();
	const pairs = Array.from({ length: 256 }, () => 'id=');
	expect(appNavigation(`/app/a?${pairs.join('&')}`, base, [])?.entries).toHaveLength(256);
	expect(appNavigation(`/app/a?${pairs.join('&')}&id=`, base, [])).toBeUndefined();
	expect(appNavigation(`/app/a?q=${'é'.repeat(11000)}`, base, [])).toBeUndefined();
});

it.each([
	['/app/match', '/app/match'],
	['/app/match?', '/app/match'],
	['/app/match#', '/app/match#'],
	['/app/match?q=a%2Bb&q=a+b&empty=#part%202', '/app/match?q=a%2Bb&q=a+b&empty=#part%202'],
	[
		'/app/match?id=a%26access_token%3Dvalue#id=fragment',
		'/app/match?id=a%26access_token%3Dvalue#id=fragment',
	],
])('round trips %s without interpreting parameter values as destinations', (href, expected) => {
	expect(appNavigationHref(appNavigation(href, base, [])!)).toBe(expected);
});

it.each([
	'/app/match/',
	'/app/team//match',
	'/app/-match',
	'/app/match-',
	'/app/./match',
	'/app/match%3fadmin',
	'/app/match%23admin',
	'/app/match%5cadmin',
	'/app/match\t',
	'https://hub.example.evil/prefix/app/match',
	'https://hub.example@evil/prefix/app/match',
	'https://hub.example/prefix/app/../admin',
	'data:text/html,/app/match',
	'/app/match#bad\u0000',
	'/app/match#bad\u007f',
])('rejects ambiguous destination %j', (href) => {
	expect(appNavigation(href, base, [])).toBeUndefined();
});
