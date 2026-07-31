/** Shared env-reading primitives used by every `make*` config module. */
import { foldCase } from '@marimo-hub/core';
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

/** Read an env value case-folded (trimmed + lowercased); undefined when unset or blank. */
export function readFolded(env: Env, key: string): string | undefined {
	const folded = foldCase(env[key] ?? '');
	return folded === '' ? undefined : folded;
}

/** Options for {@link parseEnum}: the accepted set and how to handle unset/off/invalid. */
export interface EnumOptions<T extends string> {
	/** Case-folded accepted values; the result is narrowed to this union. */
	allowed: readonly T[];
	/** Returned when the var is unset/blank. Omit to return `undefined` when unset. */
	fallback?: T;
	/** Extra tokens (e.g. `none`) that deserialize to `undefined` — "feature off". */
	offValues?: readonly string[];
	/** ConfigError context carried on an invalid value. */
	docs?: string;
	remediation?: string;
}

/**
 * Deserialize an enum-valued env var. Case-folds the raw value, returns
 * `fallback` when unset/blank, maps any `offValues` to `undefined`, and
 * validates the rest against `allowed` — throwing a ConfigError that lists the
 * accepted tokens on a bad value. The original (un-folded) value is echoed in
 * the message so the operator sees exactly what they set.
 */
export function parseEnum<T extends string>(
	env: Env,
	key: string,
	opts: EnumOptions<T>,
): T | undefined {
	const value = readFolded(env, key);
	if (value === undefined) return opts.fallback;
	if (opts.offValues?.includes(value)) return undefined;
	if ((opts.allowed as readonly string[]).includes(value)) return value as T;
	const accepted = [...opts.allowed, ...(opts.offValues ?? [])].join(', ');
	throw new ConfigError(`Invalid ${key}: ${env[key]} (expected ${accepted})`, {
		variable: key,
		...(opts.remediation !== undefined ? { remediation: opts.remediation } : {}),
		...(opts.docs !== undefined ? { docs: opts.docs } : {}),
	});
}

/**
 * {@link parseEnum} for a var that always resolves to a value: `fallback` is
 * required and there are no `offValues`, so the result is never `undefined`.
 */
export function parseEnumOr<T extends string>(
	env: Env,
	key: string,
	allowed: readonly T[],
	fallback: T,
	opts: Pick<EnumOptions<T>, 'docs' | 'remediation'> = {},
): T {
	// Safe: a fallback is provided and no offValues are given, so parseEnum
	// never returns undefined here.
	return parseEnum(env, key, { allowed, fallback, ...opts }) as T;
}
