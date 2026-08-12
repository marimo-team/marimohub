import { describe, expect, it } from 'vitest';
import { parseHttpUrl } from './url';

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
