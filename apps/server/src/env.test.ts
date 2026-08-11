import { describe, expect, it } from 'vitest';
import { ConfigError } from '@marimo-hub/config';
import { validateServerEnv } from './env';

function getConfigError(run: () => unknown): ConfigError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return error as ConfigError;
	}
	throw new Error('Expected ConfigError');
}

describe('validateServerEnv', () => {
	it('preserves known and unknown variables unchanged', () => {
		const env = {
			PORT: '4321',
			MARIMOHUB_STATIC_ROOT: './public',
			MARIMOHUB_RUN_MAINTENANCE: 'false',
			MARIMOHUB_STORAGE_BACKEND: 'memory',
			OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
		};

		expect(validateServerEnv(env)).toBe(env);
	});

	it.each([
		['PORT', 'abc', 'expected an integer from 1 to 65535'],
		['PORT', '0', 'expected an integer from 1 to 65535'],
		['PORT', '65536', 'expected an integer from 1 to 65535'],
		['MARIMOHUB_STATIC_ROOT', '   ', 'expected a non-empty path'],
		['MARIMOHUB_RUN_MAINTENANCE', 'yes', 'expected true or false'],
	] as const)('rejects invalid %s=%s', (variable, value, message) => {
		const error = getConfigError(() => validateServerEnv({ [variable]: value }));

		expect(error.opts.variable).toBe(variable);
		expect(error.message).toContain(message);
	});

	it.each(['1', '65535'])('accepts PORT=%s', (value) => {
		expect(validateServerEnv({ PORT: value })).toEqual({ PORT: value });
	});
});
