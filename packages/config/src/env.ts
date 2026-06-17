/** Shared env-reading primitives used by every `make*` config module. */
import { ConfigError } from './errors';
import type { ConfigErrorOptions } from './errors';

export type Env = Record<string, string | undefined>;

/** Read a required env var or throw — the standard fail-fast for missing config. */
export function required(env: Env, key: string): string {
	const value = env[key];
	if (!value) throw new ConfigError(`Missing required env var: ${key}`, { variable: key });
	return value;
}

/**
 * Like `required`, but attaches remediation/docs so the failure tells the operator
 * exactly what to set and where to read more. Prefer this for vars whose absence is
 * a common deploy mistake.
 */
export function requiredVar(
	env: Env,
	key: string,
	opts: Omit<ConfigErrorOptions, 'variable'>,
): string {
	const value = env[key];
	if (!value) throw new ConfigError(`Missing required env var: ${key}`, { variable: key, ...opts });
	return value;
}

/** Split a comma-separated value into trimmed, non-empty items; undefined if unset/empty. */
export function parseList(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	const items = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/** A boolean flag: true only for the literal `"true"` (the project-wide convention). */
export function parseBool(env: Env, key: string): boolean {
	return env[key] === 'true';
}

/** An integer env value; undefined if unset/empty. Throws on a non-integer. */
export function parseIntEnv(env: Env, key: string): number | undefined {
	const raw = env[key];
	if (raw === undefined || raw === '') return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n))
		throw new ConfigError(`Invalid ${key}: ${raw} (expected an integer)`, { variable: key });
	return n;
}
