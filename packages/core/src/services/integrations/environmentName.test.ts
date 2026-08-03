import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { assertValidEnvironmentName, CODE_EXECUTION_ENV } from './environmentName';

describe('assertValidEnvironmentName', () => {
	it.each(['OPENAI_API_KEY', '_X', 'DB_PASSWORD_2'])('accepts %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).not.toThrow();
	});

	it.each([
		'lowercase',
		'HAS-DASH',
		'1STARTS_WITH_DIGIT',
		'',
		'HAS SPACE',
		'FOO\n',
		'FOO\nBAR',
		'\nFOO',
	])('rejects invalid name %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
	});

	it.each(CODE_EXECUTION_ENV)('rejects code-execution name %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
	});

	it.each([
		'PATH',
		'HOME',
		'PWD',
		'LANG',
		'IFS',
		'AWS_ACCESS_KEY_ID',
		'AWS_SECRET_ACCESS_KEY',
		'AWS_SESSION_TOKEN',
		'AWS_ENDPOINT_URL_S3',
		'AWS_REGION',
	])('rejects reserved name %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
	});

	it.each(['MARIMO', 'MARIMOS', 'MARIMO_CONFIG_PATH', 'MARIMO_SKIP_UPDATE_CHECK', 'MARIMOHUB_FOO'])(
		'rejects reserved prefix %s',
		(name) => {
			expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
		},
	);
});
