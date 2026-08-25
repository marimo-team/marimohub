import { describe, expect, it, vi } from 'vitest';
import { resolveDevHostname } from './devHost';

describe('resolveDevHostname', () => {
	it.each([{}, { DEV_HOST: '' }, { DEV_HOST: '   ' }])(
		'binds to IPv4 loopback by default',
		(env: Record<string, string | undefined>) => {
			const warn = vi.fn();

			expect(resolveDevHostname(env, warn)).toBe('127.0.0.1');
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it.each(['127.0.0.1', 'localhost', '::1'])('accepts loopback host %s without warning', (host) => {
		const warn = vi.fn();

		expect(resolveDevHostname({ DEV_HOST: host }, warn)).toBe(host);
		expect(warn).not.toHaveBeenCalled();
	});

	it('warns when the developer explicitly binds to a non-loopback host', () => {
		const warn = vi.fn();

		expect(resolveDevHostname({ DEV_HOST: '0.0.0.0' }, warn)).toBe('0.0.0.0');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('unauthenticated super-admin'));
	});
});
