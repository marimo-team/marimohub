import { describe, expect, it } from 'vitest';
import {
	baseHrefFromUrl,
	basePathFromUrl,
	joinUrlPath,
	normalizeBasePath,
	normalizeBaseUrl,
	parseHttpUrl,
} from './url';

describe('normalizeBasePath', () => {
	it.each([
		['', '/'],
		['/', '/'],
		['///', '/'],
		['/marimohub', '/marimohub'],
		['/marimohub/', '/marimohub'],
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
