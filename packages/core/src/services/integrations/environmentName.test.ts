import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { assertValidEnvironmentName, CODE_EXECUTION_ENV } from './environmentName';

describe('assertValidEnvironmentName', () => {
	it.each([
		'OPENAI_API_KEY',
		'_X',
		'DB_PASSWORD_2',
		'MARIMO',
		'MARIMOS',
		'MARIMOHUB',
		'MARIMOHUBX_SETTING',
		'APP_MARIMOHUB_SETTING',
		'MARIMO_STUDIO_TRUSTED_SERVER_RUNTIME',
		'MARIMO_LENS_ENABLED',
		'MARIMO_OUTPUT_MAX_BYTES',
		'MARIMO_CONFIG_PATH_SUFFIX',
		'MARIMO_SKIP_UPDATE_CHECK_EXTRA',
		'MARIMO_VERSION_EXTRA',
		'_MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD_EXTRA',
	])('accepts %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).not.toThrow();
	});

	it.each([
		'lowercase',
		'marimo_STUDIO_TRUSTED_SERVER_RUNTIME',
		'MARIMO_STUDIO_TRUSTED_SERVER_RUNTIME ',
		'MARIMO_STUDIO_TRUSTED_SERVER_RUNTIME\n',
		'MARIMO_STUDIO_TRUSTED_SERVER_RUNTIME\0',
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
		'MARIMO_CONFIG_PATH',
		'MARIMO_SKIP_UPDATE_CHECK',
		'MARIMO_VERSION',
		'_MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD',
	])('rejects reserved name %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
	});

	it.each(['MARIMOHUB_', 'MARIMOHUB_FOO', 'MARIMOHUB_INTEGRATIONS_DIR'])(
		'rejects reserved prefix %s',
		(name) => {
			expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
		},
	);
});
