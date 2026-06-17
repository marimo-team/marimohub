import { describe, it, expect } from 'vitest';
import { ConfigError, isConfigError } from './errors';

describe('ConfigError', () => {
	it('renders a readable block with var/fix/docs', () => {
		const err = new ConfigError('MARIMOHUB_AUTH_BACKEND must be set', {
			variable: 'MARIMOHUB_AUTH_BACKEND',
			remediation: 'Set it to oidc, cloudflare-access, or dev.',
			docs: 'docs/configuration.md#auth',
		});
		const out = err.format();
		expect(out).toContain('✗ Configuration error: MARIMOHUB_AUTH_BACKEND must be set');
		expect(out).toContain('MARIMOHUB_AUTH_BACKEND');
		expect(out).toContain('Set it to oidc');
		expect(out).toContain('docs/configuration.md#auth');
	});

	it('omits rows for fields that are not provided', () => {
		const out = new ConfigError('bad').format();
		expect(out).toBe('✗ Configuration error: bad');
	});

	it('is detected by isConfigError', () => {
		expect(isConfigError(new ConfigError('x'))).toBe(true);
		expect(isConfigError(new Error('x'))).toBe(false);
		expect(isConfigError('x')).toBe(false);
	});
});
