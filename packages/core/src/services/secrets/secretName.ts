import { ValidationError } from '../../errors';

/**
 * Env-var names a project secret may not use, for two reasons:
 *  - names the hub injects itself (WIF S3 creds, shell basics) — a secret must
 *    never shadow the sandbox's federated storage credentials; and
 *  - code-execution vectors (`LD_PRELOAD`, `PYTHONSTARTUP`, …) — these run code
 *    at process start, so allowing them would turn a project secret into a
 *    stealthier backdoor than a notebook cell (it isn't visible in the source).
 */
const RESERVED_NAMES = new Set([
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
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'DYLD_INSERT_LIBRARIES',
	'PYTHONSTARTUP',
	'PYTHONPATH',
	'NODE_OPTIONS',
	'BASH_ENV',
	'ENV',
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
