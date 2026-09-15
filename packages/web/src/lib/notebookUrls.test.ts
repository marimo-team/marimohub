import { describe, expect, it } from 'vitest';
import { notebookFrameUrl, notebookQueryParams } from './notebookUrls';

describe('notebook URLs', () => {
	it('preserves repeated keys, empty values, Unicode, and encoded delimiters', () => {
		const search = '?id=123&tag=one&tag=two&empty=&bare&text=%E2%9C%93+a%2Bb%26c%3Dd%23e';
		const url = new URL(notebookFrameUrl('https://kernel.example/', search, 'light', false));
		expect([...url.searchParams]).toEqual([
			['id', '123'],
			['tag', 'one'],
			['tag', 'two'],
			['empty', ''],
			['bare', ''],
			['text', '✓ a+b&c=d#e'],
			['theme', 'light'],
		]);
	});

	it.each([
		'access_token',
		'refresh_token',
		'session_id',
		'auth_error',
		'theme',
		'show-code',
		'include-code',
		'kiosk',
		'vscode',
		'file',
		'view-as',
		'show-chrome',
	])('strips every occurrence of reserved %s, including encoded names', (key) => {
		const encoded = `%${key.charCodeAt(0).toString(16)}${key.slice(1)}`;
		const search = `?${key}=bad&${encoded}=worse&id=123`;
		expect([...notebookQueryParams(search)]).toEqual([['id', '123']]);
		expect(notebookFrameUrl('https://kernel.example/', search, 'dark', true)).toBe(
			'https://kernel.example/?id=123&theme=dark&show-code=false',
		);
	});

	it('preserves trusted parameters and cannot change the target through query values', () => {
		const url = new URL(
			notebookFrameUrl(
				'https://kernel.example/path?provider=one&provider=two&access_token=a%2Bb#cell',
				'?provider=evil&access_token=evil&id=123&url=https%3A%2F%2Fevil.example%2F&next=%2F%2Fevil.example',
				'dark',
				true,
			),
		);
		expect(url.origin).toBe('https://kernel.example');
		expect(url.pathname).toBe('/path');
		expect(url.hash).toBe('#cell');
		expect(url.searchParams.getAll('provider')).toEqual(['one', 'two']);
		expect(url.searchParams.getAll('access_token')).toEqual(['a+b']);
		expect(url.searchParams.get('id')).toBe('123');
	});

	it('resolves proxy URLs without losing the deployment prefix or fragment', () => {
		expect(
			notebookFrameUrl('/hub/proxy/signed-token/?provider=one#cell', '?id=123', 'light', true),
		).toBe(
			`${window.location.origin}/hub/proxy/signed-token/?provider=one&id=123&theme=light&show-code=false#cell`,
		);
	});

	it('applies hub display controls after trusted and outer parameters', () => {
		expect(
			notebookFrameUrl(
				'https://kernel.example/?theme=dark&show-code=true',
				'?theme=system&show-code=true',
				'light',
				true,
			),
		).toBe('https://kernel.example/?theme=light&show-code=false');
	});

	it('leaves an unparseable sandbox URL unchanged', () => {
		expect(notebookFrameUrl('http://[', '?id=123', 'light', true)).toBe('http://[');
	});

	it.each(['', '?', '?access_token=bad&session_id=bad&theme=dark'])(
		'adds no notebook parameters for an empty or entirely reserved query (%s)',
		(search) => {
			expect(notebookFrameUrl('/proxy/trusted/', search, 'light', true)).toBe(
				`${window.location.origin}/proxy/trusted/?theme=light&show-code=false`,
			);
			expect(notebookQueryParams(search).toString()).toBe('');
		},
	);

	it('keeps empty trusted values and rejects every conflicting incoming value', () => {
		const url = new URL(
			notebookFrameUrl(
				'https://kernel.example/?provider=&id=trusted',
				'?provider=evil&provider=worse&id=one&id=two&tag=one&tag=two',
				'light',
				false,
			),
		);
		expect(url.searchParams.getAll('provider')).toEqual(['']);
		expect(url.searchParams.getAll('id')).toEqual(['trusted']);
		expect(url.searchParams.getAll('tag')).toEqual(['one', 'two']);
	});

	it('treats hostile values and object-property names as URL data', () => {
		const params = new URLSearchParams([
			['id', '<script>alert(1)</script>&access_token=evil#fragment'],
			['__proto__', 'polluted'],
			['constructor', 'override'],
			['toString', 'override'],
		]);
		const url = new URL(
			notebookFrameUrl('https://kernel.example/path#trusted', params.toString(), 'light', true),
		);
		for (const [key, value] of params) expect(url.searchParams.get(key)).toBe(value);
		expect(url.searchParams.has('access_token')).toBe(false);
		expect(url.origin).toBe('https://kernel.example');
		expect(url.pathname).toBe('/path');
		expect(url.hash).toBe('#trusted');
	});

	it('tolerates malformed escapes without bypassing reserved-key filtering', () => {
		const url = new URL(
			notebookFrameUrl(
				'https://kernel.example/',
				'?id=%&text=%FF&%61ccess_token=evil&%2573ession_id=data',
				'light',
				true,
			),
		);
		expect(url.searchParams.get('id')).toBe('%');
		expect(url.searchParams.get('text')).toBe('\uFFFD');
		expect(url.searchParams.get('%73ession_id')).toBe('data');
		expect(url.searchParams.has('session_id')).toBe(false);
		expect(url.searchParams.has('access_token')).toBe(false);
	});
});
