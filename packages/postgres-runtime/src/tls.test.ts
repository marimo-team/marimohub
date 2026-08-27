import { describe, expect, it } from 'vitest';
import { postgresSslOptions, postgresTlsUnavailable } from './tls';

describe('PostgreSQL TLS modes', () => {
	it('uses plaintext only for disable', () => {
		expect(postgresSslOptions({ mode: 'disable' })).toBe(false);
	});

	it.each(['prefer', 'require'] as const)('%s encrypts without identity verification', (mode) => {
		expect(postgresSslOptions({ mode })).toEqual({ rejectUnauthorized: false });
	});

	it('verify-ca validates the CA but overrides hostname checking', () => {
		const options = postgresSslOptions({
			mode: 'verify-ca',
			ca: { kind: 'bundle', pem: 'test-ca' },
		});
		expect(options).toMatchObject({ ca: 'test-ca', rejectUnauthorized: true });
		expect(options && 'checkServerIdentity' in options).toBe(true);
	});

	it('verify-full validates the CA and leaves hostname checking enabled', () => {
		const options = postgresSslOptions({
			mode: 'verify-full',
			ca: { kind: 'bundle', pem: 'test-ca' },
		});
		expect(options).toEqual({ ca: 'test-ca', rejectUnauthorized: true });
	});

	it('uses Node trust roots when no custom CA bundle is configured', () => {
		expect(postgresSslOptions({ mode: 'verify-full', ca: { kind: 'system' } })).toEqual({
			rejectUnauthorized: true,
		});
	});

	it('rejects an oversized custom CA bundle', () => {
		expect(() =>
			postgresSslOptions({
				mode: 'verify-full',
				ca: { kind: 'bundle', pem: 'x'.repeat(1024 * 1024 + 1) },
			}),
		).toThrow('Invalid TLS configuration');
	});

	it.each([
		'The server does not support SSL connections',
		'SSL connections are not supported by this server',
		'TLS is unavailable',
	])('recognizes TLS-unavailable errors without an exact message match', (message) => {
		expect(postgresTlsUnavailable(new Error(message))).toBe(true);
	});

	it('does not treat certificate failures as permission to fall back to plaintext', () => {
		expect(postgresTlsUnavailable(new Error('certificate verification failed'))).toBe(false);
	});
});
