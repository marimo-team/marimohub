import { ValidationError } from '../../errors';

/**
 * Environment names that run attacker-controlled code before the process starts.
 * Integration kinds and user-authored variables share this list so their safety
 * policies cannot drift apart.
 */
export const CODE_EXECUTION_ENV = [
	'LD_PRELOAD',
	'LD_AUDIT',
	'LD_LIBRARY_PATH',
	'DYLD_INSERT_LIBRARIES',
	'DYLD_LIBRARY_PATH',
	'DYLD_FRAMEWORK_PATH',
	'PYTHONSTARTUP',
	'PYTHONPATH',
	'PYTHONHOME',
	'PYTHONUSERBASE',
	'NODE_OPTIONS',
	'BASH_ENV',
	'ENV',
] as const;

/** Shell basics whose meaning the sandbox depends on. */
export const SHELL_BASICS_ENV = ['PATH', 'HOME', 'PWD', 'LANG', 'IFS'] as const;

/**
 * User-authored variables cannot shadow sandbox credentials or activate process
 * startup hooks that are invisible in notebook source.
 */
const RESERVED_NAMES = new Set<string>([
	...SHELL_BASICS_ENV,
	...CODE_EXECUTION_ENV,
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
	'AWS_ENDPOINT_URL_S3',
	'AWS_REGION',
	// Hub controls the config location and these sandbox image settings.
	'MARIMO_CONFIG_PATH',
	'MARIMO_SKIP_UPDATE_CHECK',
	'MARIMO_VERSION',
	'_MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD',
]);

export function assertValidEnvironmentName(name: string): void {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
		throw new ValidationError(
			`Invalid environment variable name "${name}": must match ^[A-Z_][A-Z0-9_]*$ ` +
				'(uppercase letters, digits, and underscores; not starting with a digit).',
		);
	}
	if (RESERVED_NAMES.has(name) || name.startsWith('MARIMOHUB_')) {
		throw new ValidationError(`Environment variable name "${name}" is reserved.`);
	}
}
