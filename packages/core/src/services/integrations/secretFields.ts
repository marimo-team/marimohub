// Encryption uses wildcard field paths rather than array indexes so envelopes
// remain valid when array entries are reordered.
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { SecretEnvelope } from '../../ports/secrets';

/** JSON Schema keyword used to mark secret-bearing fields. */
export const SECRET_MARK = 'x-marimohub-secret';

/**
 * A secret-bearing config field. Always exactly `z.string().min(1)` — the
 * schema-dialect test rejects any other constraints on a marked node, because
 * the keep-marker placeholder below must satisfy them.
 */
export const zSecret = () =>
	z
		.string()
		.min(1)
		.meta({ [SECRET_MARK]: true });

/** Prevents plaintext secrets from appearing in structural validation errors. */
const PLACEHOLDER = '__marimohub_secret__';

export type StoredSecretValue = { $secret: { kind: 'managed'; envelope: SecretEnvelope } };
export type RedactedSecretValue = { $secret: { set: true } };

export const REDACTED_SECRET: RedactedSecretValue = { $secret: { set: true } };

/** Schema path whose `'*'` segment spans every array item. */
export type SecretPath = string[];

function isSecretBox(value: unknown): value is { $secret: unknown } {
	return typeof value === 'object' && value !== null && '$secret' in value;
}

/** Whether an edit asks to retain the previously stored secret value. */
export function isKeepMarker(value: unknown): boolean {
	if (!isSecretBox(value)) return false;
	const inner = value.$secret;
	return typeof inner === 'object' && (inner as Record<string, unknown>)?.set === true;
}

function isStoredSecret(value: unknown): value is StoredSecretValue {
	if (!isSecretBox(value)) return false;
	const inner = value.$secret as Record<string, unknown> | null;
	const envelope =
		typeof inner === 'object' && inner !== null
			? (inner.envelope as Record<string, unknown> | null)
			: null;
	return (
		typeof inner === 'object' &&
		inner?.kind === 'managed' &&
		typeof envelope === 'object' &&
		envelope !== null &&
		typeof envelope.kek_id === 'string' &&
		envelope.alg === 'A256GCM' &&
		typeof envelope.iv === 'string' &&
		typeof envelope.ciphertext === 'string'
	);
}

/** Collects every marked secret path from a kind's JSON Schema. */
export function secretPaths(jsonSchema: Record<string, unknown>): SecretPath[] {
	const found: SecretPath[] = [];
	const walk = (node: unknown, path: SecretPath): void => {
		if (typeof node !== 'object' || node === null) return;
		const record = node as Record<string, unknown>;
		if (record[SECRET_MARK] === true) {
			// Dedupe: the same path can surface from several union branches.
			if (!found.some((p) => p.join('.') === path.join('.'))) found.push(path);
			return;
		}
		if (typeof record.properties === 'object' && record.properties !== null) {
			for (const [key, child] of Object.entries(record.properties)) {
				walk(child, [...path, key]);
			}
		}
		for (const unionKey of ['oneOf', 'anyOf'] as const) {
			const branches = record[unionKey];
			if (Array.isArray(branches)) for (const branch of branches) walk(branch, path);
		}
		if (record.items !== undefined) walk(record.items, [...path, '*']);
		// `additionalProperties` (kv-pair records) deliberately not walked: record
		// values cannot be secrets — the dialect keeps secrets on named fields.
	};
	walk(jsonSchema, []);
	return found;
}

function expandPath(value: unknown, path: SecretPath): (string | number)[][] {
	let concrete: { holder: unknown; path: (string | number)[] }[] = [{ holder: value, path: [] }];
	for (const segment of path) {
		const next: typeof concrete = [];
		for (const { holder, path: soFar } of concrete) {
			if (segment === '*') {
				if (Array.isArray(holder)) {
					holder.forEach((item, i) => next.push({ holder: item, path: [...soFar, i] }));
				}
			} else if (typeof holder === 'object' && holder !== null && segment in holder) {
				next.push({
					holder: (holder as Record<string, unknown>)[segment],
					path: [...soFar, segment],
				});
			}
		}
		concrete = next;
	}
	return concrete.map((c) => c.path);
}

function getAt(value: unknown, path: (string | number)[]): unknown {
	let cur = value;
	for (const seg of path) {
		if (typeof cur !== 'object' || cur === null) return undefined;
		cur = (cur as Record<string | number, unknown>)[seg];
	}
	return cur;
}

function setAt(value: unknown, path: (string | number)[], next: unknown): void {
	const parent = getAt(value, path.slice(0, -1));
	if (typeof parent === 'object' && parent !== null) {
		(parent as Record<string | number, unknown>)[path.at(-1) as string | number] = next;
	}
}

const dotted = (path: readonly (string | number)[]): string => path.join('.');

export interface SealContext {
	/** Encrypts plaintext under the wildcard schema path in `at`. */
	encrypt(plaintext: string, at: string): Promise<StoredSecretValue>;
}

/**
 * Authoring → stored. Validates the config against the kind's Zod schema (with
 * placeholders standing in for secrets, so plaintext never rides through Zod
 * error messages), encrypts provided values, and resolves keep-markers against
 * `previous` — matching array entries by their `name` sibling when present, so
 * a reordered list keeps the right values.
 */
export async function sealConfig(options: {
	schema: z.ZodType;
	paths: SecretPath[];
	authoring: Record<string, unknown>;
	previous?: Record<string, unknown>;
	seal: SealContext;
	/** Runs kind validation after secrets have been replaced with placeholders. */
	check?: (parsed: unknown) => void;
}): Promise<Record<string, unknown>> {
	const { schema, paths, authoring, previous, seal, check } = options;

	// 1. Structural validation on a placeholder-substituted copy.
	const sanitized = structuredClone(authoring);
	for (const path of paths) {
		for (const concrete of expandPath(sanitized, path)) {
			const value = getAt(sanitized, concrete);
			if (typeof value === 'string' || isKeepMarker(value)) {
				setAt(sanitized, concrete, PLACEHOLDER);
			} else if (value !== undefined) {
				// Anything else (e.g. a forged stored envelope) is rejected outright.
				throw new ValidationError(
					`Secret field "${dotted(concrete)}" must be a string or { $secret: { set: true } }.`,
				);
			}
		}
	}
	const parsed = schema.safeParse(sanitized);
	if (!parsed.success) {
		throw new ValidationError(`Invalid config: ${z.prettifyError(parsed.error)}`);
	}
	check?.(parsed.data);

	// 2. Swap sealed values into the parsed output (which has defaults applied
	//    and unknown keys stripped).
	const stored = parsed.data as Record<string, unknown>;
	for (const path of paths) {
		for (const concrete of expandPath(stored, path)) {
			if (getAt(stored, concrete) !== PLACEHOLDER) continue;
			const original = getAt(authoring, concrete);
			if (typeof original === 'string') {
				setAt(stored, concrete, await seal.encrypt(original, dotted(path)));
			} else {
				const kept = findPrevious(previous, path, concrete, stored);
				if (!kept) {
					throw new ValidationError(
						`Secret field "${dotted(concrete)}" has no stored value to keep — provide one.`,
					);
				}
				setAt(stored, concrete, kept);
			}
		}
	}
	return stored;
}

/**
 * Locate the previously-stored value a keep-marker refers to. Object paths map
 * 1:1; array entries are matched by their `name` sibling (identity survives
 * reorder/removal), falling back to the same index for name-less items.
 */
function findPrevious(
	previous: Record<string, unknown> | undefined,
	path: SecretPath,
	concrete: (string | number)[],
	current: Record<string, unknown>,
): StoredSecretValue | undefined {
	if (!previous) return undefined;
	const star = path.indexOf('*');
	if (star !== -1) {
		const itemPath = concrete.slice(0, star + 1);
		const rest = concrete.slice(star + 1);
		const item = getAt(current, itemPath);
		const name =
			typeof item === 'object' && item !== null
				? (item as Record<string, unknown>).name
				: undefined;
		const prevList = getAt(previous, concrete.slice(0, star));
		if (!Array.isArray(prevList)) return undefined;
		const match =
			typeof name === 'string'
				? prevList.find((p) => typeof p === 'object' && (p as { name?: unknown })?.name === name)
				: prevList[concrete[star] as number];
		const value = getAt(match, rest);
		return isStoredSecret(value) ? value : undefined;
	}
	const value = getAt(previous, concrete);
	return isStoredSecret(value) ? value : undefined;
}

/** Replaces stored secret envelopes with API-safe keep markers. */
export function redactConfig(
	stored: Record<string, unknown>,
	paths: SecretPath[],
): Record<string, unknown> {
	const redacted = structuredClone(stored);
	for (const path of paths) {
		for (const concrete of expandPath(redacted, path)) {
			if (isSecretBox(getAt(redacted, concrete))) {
				setAt(redacted, concrete, structuredClone(REDACTED_SECRET));
			}
		}
	}
	return redacted;
}

export function validateStoredConfig(options: {
	schema: z.ZodType;
	paths: SecretPath[];
	stored: Record<string, unknown>;
	check?: (parsed: unknown) => void;
}): void {
	const { schema, paths, stored, check } = options;
	const sanitized = structuredClone(stored);
	for (const path of paths) {
		for (const concrete of expandPath(sanitized, path)) {
			const value = getAt(sanitized, concrete);
			if (value === undefined) continue;
			if (!isStoredSecret(value)) {
				throw new ValidationError(
					`Secret field "${dotted(concrete)}" holds an unsupported stored shape.`,
				);
			}
			setAt(sanitized, concrete, PLACEHOLDER);
		}
	}
	const parsed = schema.safeParse(sanitized);
	if (!parsed.success) throw new ValidationError('Stored config does not match the kind schema.');
	check?.(parsed.data);
}

/**
 * Concrete paths of `{ $secret: … }` boxes sitting OUTSIDE the registered
 * secret paths — e.g. left behind by a migration that renamed a field. Redaction
 * only rewrites registered paths, so a stray box would otherwise flow into an
 * API response as raw ciphertext; callers reject configs that report any.
 */
export function findStraySecretBoxes(
	config: Record<string, unknown>,
	paths: SecretPath[],
): string[] {
	const allowed = new Set(paths.map((p) => p.join('.')));
	const strays: string[] = [];
	const walk = (value: unknown, concrete: (string | number)[]): void => {
		if (isSecretBox(value)) {
			const wildcard = concrete.map((seg) => (typeof seg === 'number' ? '*' : seg)).join('.');
			if (!allowed.has(wildcard)) strays.push(dotted(concrete));
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, i) => walk(item, [...concrete, i]));
		} else if (typeof value === 'object' && value !== null) {
			for (const [key, child] of Object.entries(value)) walk(child, [...concrete, key]);
		}
	};
	walk(config, []);
	return strays;
}

export interface OpenContext {
	/** Decrypts an envelope under the wildcard schema path in `at`. */
	decrypt(envelope: SecretEnvelope, at: string): Promise<string>;
}

/** Resolves stored secret envelopes for the server-side render path. */
export async function openConfig(options: {
	stored: Record<string, unknown>;
	paths: SecretPath[];
	open: OpenContext;
}): Promise<Record<string, unknown>> {
	const { stored, paths, open } = options;
	const resolved = structuredClone(stored);
	for (const path of paths) {
		for (const concrete of expandPath(resolved, path)) {
			const value = getAt(resolved, concrete);
			if (value === undefined) continue;
			if (!isStoredSecret(value)) {
				throw new ValidationError(
					`Secret field "${dotted(concrete)}" holds an unsupported stored shape.`,
				);
			}
			setAt(resolved, concrete, await open.decrypt(value.$secret.envelope, dotted(path)));
		}
	}
	return resolved;
}
