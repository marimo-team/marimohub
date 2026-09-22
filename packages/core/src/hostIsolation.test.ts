import { describe, expect, it } from 'vitest';
import { normalizeHostname } from './hostIsolation';

describe('normalizeHostname', () => {
	it.each([
		[' HUB.Example.COM.:8443 ', 'hub.example.com'],
		['127.0.0.1:8080', '127.0.0.1'],
		['[::1]:8080', '[::1]'],
		['[2001:db8::1]', '[2001:db8::1]'],
		['bücher.example', 'xn--bcher-kva.example'],
		['localhost', 'localhost'],
	])('normalizes %s', (input, expected) => {
		expect(normalizeHostname(input)).toBe(expected);
	});

	it.each([
		'',
		'https://hub.example.com',
		'//hub.example.com',
		'user@hub.example.com',
		'user:password@hub.example.com',
		'hub.example.com/',
		'hub.example.com/path',
		'hub.example.com?query',
		'hub.example.com#fragment',
		'hub.example.com\\path',
		'hub.exa\nmple.com',
		'hub.exa mple.com',
		'hub.example.com:',
		'hub.example.com:bad-port',
		'hub.example.com:65536',
		'::1',
	])('rejects invalid hostname %j', (input) => {
		expect(() => normalizeHostname(input)).toThrow(TypeError);
	});
});
