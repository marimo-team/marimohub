import { ValidationError } from '../../errors';
import { HUB_XDG_ENV, SANDBOX_IMAGE_MARIMO_ENV } from '../runtime/sandboxEnvironment';

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

/** Static AWS keys; SDK chains prefer them over the container provider. */
export const STATIC_AWS_CREDENTIAL_ENV = [
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
] as const;

/**
 * AWS container-provider inputs. SDKs prefer RELATIVE_URI over FULL_URI and
 * TOKEN_FILE over TOKEN, so any of them can redirect WIF endpoint delivery.
 */
export const AWS_CONTAINER_CREDENTIAL_ENV = [
	'AWS_CONTAINER_CREDENTIALS_FULL_URI',
	'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
	'AWS_CONTAINER_AUTHORIZATION_TOKEN',
	'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
] as const;

/**
 * AWS web-identity inputs. SDK chains try them before the container provider,
 * so they could bypass WIF endpoint delivery.
 */
export const WEB_IDENTITY_AWS_CREDENTIAL_ENV = [
	'AWS_ROLE_ARN',
	'AWS_WEB_IDENTITY_TOKEN_FILE',
	'AWS_ROLE_SESSION_NAME',
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
	...STATIC_AWS_CREDENTIAL_ENV,
	...AWS_CONTAINER_CREDENTIAL_ENV,
	...WEB_IDENTITY_AWS_CREDENTIAL_ENV,
	'AWS_ENDPOINT_URL_S3',
	'AWS_REGION',
	...HUB_XDG_ENV,
	...SANDBOX_IMAGE_MARIMO_ENV,
]);

/** Hub's own variables and marimo's private internals (e.g. `_MARIMO_DISABLE_AUTH_ON_VIRTUAL_FILES`). */
const RESERVED_PREFIXES = ['MARIMOHUB_', '_MARIMO_'] as const;

export function assertValidEnvironmentName(name: string): void {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
		throw new ValidationError(
			`Invalid environment variable name "${name}": must match ^[A-Z_][A-Z0-9_]*$ ` +
				'(uppercase letters, digits, and underscores; not starting with a digit).',
		);
	}
	if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
		throw new ValidationError(`Environment variable name "${name}" is reserved.`);
	}
}
