import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { HUB_SANDBOX_ENV, SANDBOX_IMAGE_MARIMO_ENV } from '../runtime/sandboxEnvironment';
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
		'MARIMO_OUTPUT_MAX_BYTES',
		'MARIMO_SQL_DEFAULT_LIMIT',
		'MARIMO_CONFIG_PATH',
		'MARIMO_SKIP_UPDATE_CHECK_EXTRA',
		'MARIMO_VERSION_EXTRA',
		'XDG_DATA_HOME',
		'XDG_CONFIG_HOME_EXTRA',
		'MARIMO_',
		'__MARIMO_X',
	])('accepts %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).not.toThrow();
	});

	it.each([
		'lowercase',
		'marimo_OUTPUT_MAX_BYTES',
		'MARIMO_OUTPUT_MAX_BYTES ',
		'MARIMO_OUTPUT_MAX_BYTES\n',
		'MARIMO_OUTPUT_MAX_BYTES\0',
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
		'XDG_CONFIG_HOME',
		'XDG_CACHE_HOME',
		'XDG_STATE_HOME',
		...SANDBOX_IMAGE_MARIMO_ENV,
	])('rejects reserved name %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
	});

	it.each([
		'MARIMOHUB_',
		'MARIMOHUB_FOO',
		...HUB_SANDBOX_ENV,
		'_MARIMO_',
		'_MARIMO_DISABLE_AUTH_ON_VIRTUAL_FILES',
		'_MARIMO_APP_OVERLOAD_HTML_HEAD_FILE',
		'_MARIMO_CONFIG_OVERLOAD_RUNTIME_AUTO_INSTANTIATE',
	])('rejects reserved prefix %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).toThrow(ValidationError);
	});
});
