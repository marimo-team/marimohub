// Rendered config stays outside the workspace mount so credentials cannot be
// captured into a notebook version.
import { ValidationError } from '../../errors';
import type { IntegrationId, SessionId } from '../../ids';
import { isRecord } from '../../internal/validation';
import type { SessionRender } from '../../ports/integrations';
import type { RenderOutput } from './sdk';
import { CODE_EXECUTION_ENV, SHELL_BASICS_ENV } from './environmentName';
import { stringify } from 'yaml';

/** Sandbox directory containing rendered integration files. */
export const INTEGRATIONS_DIR = '/tmp/marimohub-integrations';
/** Environment variable pointing notebook code to {@link INTEGRATIONS_DIR}. */
export const INTEGRATIONS_DIR_ENV = 'MARIMOHUB_INTEGRATIONS_DIR';

/**
 * Env names a kind may not emit: process-start code-execution vectors and shell
 * basics. Narrower than the user-authored environment blocklist on purpose — kinds are hub
 * code and legitimately set tool vars (`PYICEBERG_HOME`) and `MARIMOHUB_*`.
 */
const FORBIDDEN_ENV = new Set<string>([...SHELL_BASICS_ENV, ...CODE_EXECUTION_ENV]);

const ENV_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

/** Owner label for the env vars and files the bundler itself contributes. */
const BUNDLER = 'marimohub';

/**
 * Instance names parameterize rendered file paths and env fragments, so they
 * are locked to a DNS-label-ish shape that maps cleanly onto both.
 */
const INSTANCE_NAME_REGEX = /^[a-z][a-z0-9-]{0,31}$/;

export function assertValidIntegrationName(name: string): void {
	if (!INSTANCE_NAME_REGEX.test(name)) {
		throw new ValidationError(
			`Invalid integration name "${name}": must match ${INSTANCE_NAME_REGEX} ` +
				'(lowercase letters, digits, and hyphens; starting with a letter).',
		);
	}
}

export interface RenderedIntegration {
	id: IntegrationId;
	name: string;
	kind: string;
	version: number;
	/** Requirements copied into the integration manifest. */
	requirements?: string[];
	output: RenderOutput;
}

export function bundleIntegrations(
	rendered: RenderedIntegration[],
	sessionId: SessionId,
): SessionRender {
	const files: SessionRender['files'] = [];
	const yamlFiles = new Map<string, MergedYaml>();
	const claimPath = pathClaimer();
	// Claimed up front so a kind emitting the bundler's own key gets the normal
	// collision error instead of having its value silently overwritten.
	const vars: Record<string, string> = { [INTEGRATIONS_DIR_ENV]: INTEGRATIONS_DIR };
	const varOwner = new Map<string, string>([[INTEGRATIONS_DIR_ENV, BUNDLER]]);

	for (const item of rendered) {
		for (const file of item.output.files ?? []) {
			const path = normalizeRelativePath(file.path, item.name);
			claimPath(path, item.name, false);
			files.push({ path: `${INTEGRATIONS_DIR}/${path}`, content: file.content });
		}
		for (const file of item.output.yamlFiles ?? []) {
			const path = normalizeRelativePath(file.path, item.name);
			claimPath(path, item.name, true);
			const existing = yamlFiles.get(path);
			if (existing) {
				existing.value = mergeYaml(existing.value, file.value, path, existing.owners, item.name);
			} else {
				const owners = new Map<string, string[]>();
				recordOwners(owners, '', file.value, item.name);
				yamlFiles.set(path, { value: structuredClone(file.value), owners });
			}
		}
		for (const [key, value] of Object.entries(item.output.env ?? {})) {
			assertValidEnvName(key, item.name);
			if (hasControlCharacter(value)) {
				throw new ValidationError(
					`Integration "${item.name}" emitted an environment value containing a control character.`,
				);
			}
			const owner = varOwner.get(key);
			// An identical value from two instances is tolerated (e.g. a shared
			// tool var like PYICEBERG_HOME); a differing one is ambiguous.
			if (owner && vars[key] !== value) {
				throw new ValidationError(
					`Integrations "${owner}" and "${item.name}" set the same environment variable to different values.`,
				);
			}
			varOwner.set(key, item.name);
			vars[key] = value;
		}
	}
	for (const [path, file] of [...yamlFiles].sort(([a], [b]) => a.localeCompare(b))) {
		files.push({
			path: `${INTEGRATIONS_DIR}/${path}`,
			content: stringify(sortObject(file.value)),
		});
	}

	const manifest = {
		session_id: sessionId,
		integrations: rendered.map((item) => ({
			name: item.name,
			kind: item.kind,
			version: item.version,
			...(item.requirements && item.requirements.length > 0
				? { requirements: item.requirements }
				: {}),
			...(item.output.manifestExtra ? { extra: item.output.manifestExtra } : {}),
		})),
	};
	files.push({
		path: `${INTEGRATIONS_DIR}/manifest.json`,
		content: `${JSON.stringify(manifest, null, '\t')}\n`,
	});

	return {
		files,
		vars,
		attachments: rendered.map(({ id, name, kind, version }) => ({ id, name, kind, version })),
	};
}

/**
 * Tracks rendered paths and the directories they imply. A path may be claimed
 * twice only when both claims are `shared` (YAML fragments, which the bundler
 * merges); anything else — including a file that sits on another file's path
 * prefix, which the sandbox could not materialize — is a collision.
 */
function pathClaimer(): (path: string, instance: string, shared: boolean) => void {
	const fileOwner = new Map<string, { owner: string; shared: boolean }>();
	const dirOwner = new Map<string, { owner: string; path: string }>();

	return (path, instance, shared) => {
		const asDirectory = dirOwner.get(path);
		if (asDirectory) {
			throw nestedPathError(instance, path, asDirectory.owner, asDirectory.path);
		}
		const claim = fileOwner.get(path);
		if (claim && !(claim.shared && shared)) {
			throw new ValidationError(
				`Integrations "${claim.owner}" and "${instance}" both render "${path}".`,
			);
		}
		const segments = path.split('/');
		for (let i = 1; i < segments.length; i++) {
			const dir = segments.slice(0, i).join('/');
			const dirClaim = fileOwner.get(dir);
			if (dirClaim) throw nestedPathError(dirClaim.owner, dir, instance, path);
			if (!dirOwner.has(dir)) dirOwner.set(dir, { owner: instance, path });
		}
		if (!claim) fileOwner.set(path, { owner: instance, shared });
	};
}

function nestedPathError(
	fileInstance: string,
	filePath: string,
	nestedInstance: string,
	nestedPath: string,
): ValidationError {
	return new ValidationError(
		`Integrations "${fileInstance}" and "${nestedInstance}" render conflicting paths: ` +
			`"${filePath}" is a file, but "${nestedPath}" needs it to be a directory.`,
	);
}

/**
 * A merged YAML file plus, per leaf key path, the integrations that put the
 * current value there. Blame is tracked per key rather than per file so a
 * conflict names only the integrations that set the disputed key.
 */
interface MergedYaml {
	value: Record<string, unknown>;
	owners: Map<string, string[]>;
}

/** Key-path separator; cannot appear in a YAML key. */
const KEY_SEP = '\u0000';

function recordOwners(
	owners: Map<string, string[]>,
	keyPath: string,
	value: unknown,
	owner: string,
): void {
	// An empty object has no leaves to attribute, so it is claimed as a leaf
	// itself — otherwise a later value replacing it would blame nobody.
	if (isRecord(value) && Object.keys(value).length > 0) {
		for (const [key, child] of Object.entries(value)) {
			recordOwners(owners, `${keyPath}${KEY_SEP}${key}`, child, owner);
		}
		return;
	}
	const existing = owners.get(keyPath);
	if (!existing) owners.set(keyPath, [owner]);
	else if (!existing.includes(owner)) existing.push(owner);
}

/** Everyone whose contribution is part of the value now being contradicted. */
function ownersOf(owners: Map<string, string[]>, keyPath: string): string[] {
	const found: string[] = [];
	const prefix = `${keyPath}${KEY_SEP}`;
	for (const [key, names] of owners) {
		if (key !== keyPath && !key.startsWith(prefix)) continue;
		for (const name of names) if (!found.includes(name)) found.push(name);
	}
	return found;
}

/**
 * Fail closed on disagreement rather than picking a winner: some PyIceberg root
 * properties (`legacy-current-snapshot-id`, `max-workers`) are process-wide, so
 * silently choosing one integration's value would change how the OTHER one
 * reads data. The message names the disagreeing integrations and both values
 * because this surfaces at session launch, where the admin has no other clue
 * which pair to reconcile.
 */
function mergeYaml(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	path: string,
	owners: Map<string, string[]>,
	rightOwner: string,
	keyPath = '',
): Record<string, unknown> {
	const merged = { ...left };
	for (const [key, value] of Object.entries(right)) {
		const previous = merged[key];
		const childPath = `${keyPath}${KEY_SEP}${key}`;
		if (previous === undefined) {
			merged[key] = structuredClone(value);
			recordOwners(owners, childPath, value, rightOwner);
		} else if (isRecord(previous) && isRecord(value)) {
			merged[key] = mergeYaml(previous, value, `${path}:${key}`, owners, rightOwner, childPath);
		} else if (JSON.stringify(previous) === JSON.stringify(value)) {
			recordOwners(owners, childPath, value, rightOwner);
		} else {
			const disputed = ownersOf(owners, childPath);
			throw new ValidationError(
				`Integrations "${disputed.join('", "')}" and "${rightOwner}" disagree on ` +
					`"${key}" in ${path}. This setting applies to the whole session, so the two ` +
					'cannot run together — align the value or disable one of them.',
			);
		}
	}
	return merged;
}

function sortObject(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortObject);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => [key, sortObject(child)]),
	);
}

function normalizeRelativePath(path: string, instance: string): string {
	const segments = path.split('/');
	if (
		path.startsWith('/') ||
		path.includes('\\') ||
		hasControlCharacter(path) ||
		segments.some((s) => s === '' || s === '.' || s === '..')
	) {
		throw new ValidationError(
			`Integration "${instance}" rendered an invalid file path ${JSON.stringify(path)}: paths must be ` +
				'relative, POSIX, free of control characters, and free of "." / ".." segments.',
		);
	}
	if (segments[0] === 'manifest.json') {
		throw new ValidationError(`Integration "${instance}" may not render "manifest.json".`);
	}
	return path;
}

function assertValidEnvName(name: string, instance: string): void {
	if (!ENV_NAME_REGEX.test(name) || FORBIDDEN_ENV.has(name)) {
		throw new ValidationError(
			`Integration "${instance}" emitted a forbidden or malformed env name "${name}".`,
		);
	}
}
