/**
 * A configuration error the operator can act on. Unlike a bare `Error`, it carries
 * the offending `variable`, a `remediation` ("here's how to fix it"), and an
 * optional `docs` pointer, and renders them as a readable block via `format()` so
 * a misconfigured deploy fails with a clear message instead of a cryptic one-liner
 * buried in JSON logs. The entrypoint catches these and prints `format()` to stderr.
 *
 * These are deterministic — a restart won't fix them — so the entrypoint exits on
 * them. (Transient connectivity problems go through the non-fatal preflight path
 * instead; see `preflightChecks.ts`.)
 */
export interface ConfigErrorOptions {
	/** The env var at fault, e.g. `MARIMOHUB_AUTH_BACKEND`. */
	variable?: string;
	/** A concrete instruction for fixing it. */
	remediation?: string;
	/** A docs pointer, e.g. `docs/configuration.md#auth`. */
	docs?: string;
}

export class ConfigError extends Error {
	constructor(
		message: string,
		readonly opts: ConfigErrorOptions = {},
	) {
		super(message);
		this.name = 'ConfigError';
	}

	/** A multi-line, aligned block for stderr (not JSON). */
	format(): string {
		const lines = [`✗ Configuration error: ${this.message}`];
		const row = (label: string, value: string) => `  ${`${label}:`.padEnd(7)} ${value}`;
		if (this.opts.variable) lines.push(row('var', this.opts.variable));
		if (this.opts.remediation) lines.push(row('fix', this.opts.remediation));
		if (this.opts.docs) lines.push(row('docs', this.opts.docs));
		return lines.join('\n');
	}
}

/** True for a `ConfigError`, including across module-dup boundaries (name check). */
export function isConfigError(err: unknown): err is ConfigError {
	return err instanceof ConfigError || (err instanceof Error && err.name === 'ConfigError');
}
