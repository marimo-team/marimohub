import { describe, expect, it } from 'vitest';
import {
	baseHrefFromUrl,
	basePathFromUrl,
	joinUrlPath,
	MARIMO_VERSION_PATTERN,
	normalizeBasePath,
	normalizeBaseUrl,
	parseAssetBaseUrl,
	parseHttpUrl,
} from './url';

describe('MARIMO_VERSION_PATTERN', () => {
	const exact = new RegExp(`^${MARIMO_VERSION_PATTERN}$`);
	it.each(['0.25.2', '0.25.2rc1', '0.25.2.dev1', '0.25.2.post1', '0.25.2-beta.1'])(
		'accepts release version %s',
		(version) => expect(exact.test(version)).toBe(true),
	);
	it.each(['0.25', '0.25.2-', '0.25.2..', '0.25.2.', '0.25.2.-1', 'v0.25.2', '0.25.2/x'])(
		'rejects malformed version %s',
		(version) => expect(exact.test(version)).toBe(false),
	);
});

describe('parseAssetBaseUrl', () => {
	it.each([
		undefined,
		'',
		'hub',
		'/assets',
		'http://cdn.example/dist',
		'javascript:alert(1)',
		'https://user:secret@cdn.example/dist',
		'https://cdn.example/dist?token=secret',
		'https://cdn.example/dist#secret',
	])('omits unsafe or unresolved asset bases: %s', (value) => {
		expect(parseAssetBaseUrl(value)).toBeUndefined();
	});

	it.each(['0.24.2', '{version}'])('accepts pinned or template version %s', (version) => {
		const value = `https://cdn.example/frontend@${version}/dist`;
		const parsed = parseAssetBaseUrl(value);
		expect(parsed?.origin).toBe('https://cdn.example');
		expect(decodeURIComponent(parsed!.pathname)).toBe(`/frontend@${version}/dist`);
	});

	it('returns independent URLs so callers can normalize paths without sharing mutations', () => {
		const value = 'https://cdn.example/dist';
		parseAssetBaseUrl(value)!.pathname += '/';
		expect(parseAssetBaseUrl(value)?.pathname).toBe('/dist');
	});
});

describe('normalizeBasePath', () => {
	it.each([
		['', '/'],
		['/', '/'],
		['///', '/'],
		['marimohub/', '/marimohub'],
		['/marimohub', '/marimohub'],
		['/marimohub/', '/marimohub'],
		['//marimohub/', '/marimohub'],
		['/team/marimohub///', '/team/marimohub'],
	] as const)('maps %j to %j', (pathname, expected) => {
		expect(normalizeBasePath(pathname)).toBe(expected);
	});
});

describe('basePathFromUrl', () => {
	it.each([
		['https://hub.example.com', '/'],
		['https://hub.example.com/', '/'],
		['https://hub.example.com/marimohub', '/marimohub'],
		['https://hub.example.com/marimohub/', '/marimohub'],
		['https://hub.example.com/marimohub///?ignored=1#ignored', '/marimohub'],
		['https://hub.example.com//cdn.example/app/', '/cdn.example/app'],
		['https://hub.example.com/team%20one/hub/', '/team%20one/hub'],
	] as const)('reads %s as %s', (value, expected) => {
		expect(basePathFromUrl(value)).toBe(expected);
	});

	it('accepts URL objects', () => {
		expect(basePathFromUrl(new URL('https://hub.example.com/nested/'))).toBe('/nested');
	});

	it.each(['not a URL', '/relative'])('rejects %j', (value) => {
		expect(() => basePathFromUrl(value)).toThrow(TypeError);
	});
});

describe('baseHrefFromUrl', () => {
	it.each([
		['https://hub.example.com', '/'],
		['https://hub.example.com/', '/'],
		['https://hub.example.com/marimohub', '/marimohub/'],
		['https://hub.example.com/marimohub/', '/marimohub/'],
		['https://hub.example.com/marimohub///', '/marimohub/'],
		['https://hub.example.com//cdn.example/app/', '/cdn.example/app/'],
	] as const)('maps %s to %s', (value, expected) => {
		expect(baseHrefFromUrl(value)).toBe(expected);
	});
});

describe('normalizeBaseUrl', () => {
	it.each([
		['https://hub.example.com', 'https://hub.example.com'],
		['https://hub.example.com/', 'https://hub.example.com'],
		['https://hub.example.com///', 'https://hub.example.com'],
		['https://hub.example.com/marimohub', 'https://hub.example.com/marimohub'],
		['https://hub.example.com/marimohub/', 'https://hub.example.com/marimohub'],
		['https://hub.example.com/marimohub///?ignored=1#ignored', 'https://hub.example.com/marimohub'],
		['https://hub.example.com//cdn.example/app/', 'https://hub.example.com/cdn.example/app'],
		['https://hub.example.com/team%20one/hub/', 'https://hub.example.com/team%20one/hub'],
	] as const)('maps %s to %s', (value, expected) => {
		expect(normalizeBaseUrl(value)).toBe(expected);
	});

	it('rejects an invalid URL', () => {
		expect(() => normalizeBaseUrl('/relative')).toThrow(TypeError);
	});
});

describe('joinUrlPath', () => {
	it.each([
		['https://hub.example.com', 'api/v1/me', 'https://hub.example.com/api/v1/me'],
		['https://hub.example.com/', '/api/v1/me', 'https://hub.example.com/api/v1/me'],
		[
			'https://hub.example.com/marimohub',
			'/projects/proj-1',
			'https://hub.example.com/marimohub/projects/proj-1',
		],
		[
			'https://hub.example.com/marimohub///',
			'///projects/proj-1',
			'https://hub.example.com/marimohub/projects/proj-1',
		],
		[
			'https://hub.example.com//cdn.example/app/',
			'/api/v1/me',
			'https://hub.example.com/cdn.example/app/api/v1/me',
		],
	] as const)('joins %s and %s', (baseUrl, path, expected) => {
		expect(joinUrlPath(baseUrl, path)).toBe(expected);
	});

	it('drops query and fragment data from the base URL', () => {
		expect(joinUrlPath('https://hub.example.com/base/?stale=1#old', 'api/v1/me')).toBe(
			'https://hub.example.com/base/api/v1/me',
		);
	});

	it('preserves encoded path segments', () => {
		expect(joinUrlPath('https://hub.example.com/team%20one/', '/projects/project%201')).toBe(
			'https://hub.example.com/team%20one/projects/project%201',
		);
	});

	it('rejects an invalid base URL', () => {
		expect(() => joinUrlPath('/relative', '/api/v1/me')).toThrow(TypeError);
	});
});

describe('parseHttpUrl', () => {
	it.each([
		['https://example.com/path', 'https:'],
		['http://example.com:8080/path', 'http:'],
	] as const)('accepts %s', (value, protocol) => {
		const result = parseHttpUrl(value);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.url.protocol).toBe(protocol);
	});

	it('can restrict callers to HTTPS', () => {
		expect(parseHttpUrl('http://example.com', { protocols: ['https:'] })).toEqual({
			ok: false,
			issue: 'protocol',
		});
		expect(parseHttpUrl('https://example.com', { protocols: ['https:'] }).ok).toBe(true);
	});

	it.each([
		['not a URL', 'invalid'],
		['ftp://example.com/file', 'protocol'],
		['https://user@example.com/path', 'credentials'],
		['https://user:secret@example.com/path', 'credentials'],
	] as const)('classifies %s as %s', (value, issue) => {
		expect(parseHttpUrl(value)).toEqual({ ok: false, issue });
	});

	it('allows credentials only when explicitly requested', () => {
		const result = parseHttpUrl('https://user:secret@example.com/path', {
			allowCredentials: true,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.url.username).toBe('user');
			expect(result.url.password).toBe('secret');
		}
	});
});
