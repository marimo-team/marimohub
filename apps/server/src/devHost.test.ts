import { describe, expect, it, vi } from 'vitest';
import { isLoopbackHostname, resolveDevHostname } from './devHost';

describe('resolveDevHostname', () => {
	it.each([{}, { DEV_HOST: '' }, { DEV_HOST: '   ' }])(
		'binds to IPv4 loopback by default',
		(env: Record<string, string | undefined>) => {
			const warn = vi.fn();

			expect(resolveDevHostname(env, warn)).toBe('127.0.0.1');
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it.each([
		'127.0.0.1',
		'127.42.0.1',
		'localhost',
		'LOCALHOST.',
		'::1',
		'0:0:0:0:0:0:0:1',
		'::ffff:127.0.0.1',
		'::ffff:7f2a:1',
	])('accepts loopback host %s without warning', (host) => {
		const warn = vi.fn();

		expect(resolveDevHostname({ DEV_HOST: host }, warn)).toBe(host);
		expect(warn).not.toHaveBeenCalled();
	});

	it.each(['0.0.0.0', '128.0.0.1', '::', '::ffff:192.168.1.1', 'example.com'])(
		'rejects %s as a loopback hostname',
		(host) => expect(isLoopbackHostname(host)).toBe(false),
	);

	it('warns when the developer explicitly binds to a non-loopback host', () => {
		const warn = vi.fn();

		expect(resolveDevHostname({ DEV_HOST: '0.0.0.0' }, warn)).toBe('0.0.0.0');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('unauthenticated super-admin'));
	});
});
