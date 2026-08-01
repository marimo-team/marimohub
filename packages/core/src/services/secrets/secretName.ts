import { ValidationError } from '../../errors';

/**
 * Env names that make a process run attacker-chosen code before its first line
 * — the dynamic linker's preload/audit hooks, the interpreter's startup and
 * module-search paths, the shell's startup file. Shared with the integration
 * bundler's own blocklist: the two lists differ in what they *permit*, but this
 * subset must never drift apart, so it lives in one place.
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
 * Env-var names a project secret may not use, for two reasons:
 *  - names the hub injects itself (WIF S3 creds, shell basics) — a secret must
 *    never shadow the sandbox's federated storage credentials; and
 *  - code-execution vectors (`LD_PRELOAD`, `PYTHONSTARTUP`, …) — these run code
 *    at process start, so allowing them would turn a project secret into a
 *    stealthier backdoor than a notebook cell (it isn't visible in the source).
 */
const RESERVED_NAMES = new Set<string>([
	...SHELL_BASICS_ENV,
	...CODE_EXECUTION_ENV,
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
	'AWS_ENDPOINT_URL_S3',
	'AWS_REGION',
]);

/** Prefixes the hub reserves for its own injected env (marimo config, WIF, etc.). */
const RESERVED_PREFIXES = ['MARIMO', 'MARIMOHUB_'];

/**
 * Assert `name` is a safe, non-reserved environment-variable name. Accepts only
 * POSIX-shell-safe upper-snake identifiers; rejects the hub's own injected names
 * and reserved prefixes. Throws {@link ValidationError} (→ 422) on a bad name.
 */
export function assertValidSecretName(name: string): void {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
		throw new ValidationError(
			`Invalid secret name "${name}": must match ^[A-Z_][A-Z0-9_]*$ ` +
				'(uppercase letters, digits, and underscores; not starting with a digit).',
		);
	}
	if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
		throw new ValidationError(
			`Secret name "${name}" is reserved and cannot be used for a project secret.`,
		);
	}
}
