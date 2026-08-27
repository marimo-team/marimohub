import { describe, expect, it } from 'vitest';
import type { IntegrationId } from '../../../ids';
import type { DataQueryConnection } from './contracts';
import { redactConnectionSecrets } from './redaction';

function connection(overrides: Partial<DataQueryConnection> = {}): DataQueryConnection {
	return {
		files: [],
		vars: {},
		integration: { id: 'intg-1' as IntegrationId, name: 'lake', kind: 'test', version: 1 },
		...overrides,
	};
}

describe('redactConnectionSecrets', () => {
	it('scrubs var values, file contents, and string plan params', () => {
		const result = redactConnectionSecrets(
			'failed: token=var-secret file={"key":"file-secret"} param=param-secret',
			connection({
				files: [{ path: '/tmp/c.json', content: '{"key":"file-secret"}' }],
				vars: { TOKEN: 'var-secret' },
				plan: {
					setup: [{ text: 'SET s3_secret = ?', params: ['param-secret', 42, true, null] }],
					cleanup: [{ text: 'RESET s3_secret' }],
				},
			}),
		);
		expect(result).toBe('failed: token=[redacted] file=[redacted] param=[redacted]');
	});

	it('redacts longer secrets before shorter ones contained within them', () => {
		const result = redactConnectionSecrets(
			'both abcdef and abcd appeared',
			connection({ vars: { A: 'abcd', B: 'abcdef' } }),
		);
		expect(result).toBe('both [redacted] and [redacted] appeared');
	});

	it('scrubs every string in the plan http access, including nested credentials', () => {
		const result = redactConnectionSecrets(
			'HTTP 403 from https://objects.example.test with key AKIAEXAMPLE token session-token-value',
			connection({
				plan: {
					setup: [],
					httpAccess: {
						kind: 'iceberg-rest',
						catalog: { url: 'https://catalog.example.test', authorization: 'Bearer abc123' },
						storage: {
							kind: 's3',
							endpoint: 'https://objects.example.test',
							region: 'us-east-1',
							urlStyle: 'path',
							credentials: {
								method: 'static',
								accessKeyId: 'AKIAEXAMPLE',
								secretAccessKey: 'very-secret-access-key',
								sessionToken: 'session-token-value',
							},
							locations: [{ bucket: 'warehouse', prefix: 'tables' }],
						},
					},
				},
			}),
		);
		expect(result).not.toContain('AKIAEXAMPLE');
		expect(result).not.toContain('session-token-value');
		expect(result).not.toContain('objects.example.test');
		expect(result).toContain('HTTP 403');
	});

	it('treats secrets as literal text, not regular expressions', () => {
		const result = redactConnectionSecrets(
			'auth a+b$1(c) failed twice: a+b$1(c)',
			connection({ vars: { TOKEN: 'a+b$1(c)' } }),
		);
		expect(result).toBe('auth [redacted] failed twice: [redacted]');
	});

	it('skips values too short to be meaningful secrets', () => {
		const result = redactConnectionSecrets(
			'select 1 from t',
			connection({ vars: { REGION: 'us', MODE: 'r' } }),
		);
		expect(result).toBe('select 1 from t');
	});

	it('caps runaway messages', () => {
		const result = redactConnectionSecrets(`Parser Error: ${'x'.repeat(2_000)}`, connection());
		expect(result.length).toBeLessThanOrEqual(501);
		expect(result.endsWith('…')).toBe(true);
	});
});
