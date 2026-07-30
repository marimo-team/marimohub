// Rendered config stays outside the workspace mount so credentials cannot be
// captured into a notebook version.
import { ValidationError } from '../../errors';
import type { IntegrationId, SessionId } from '../../ids';
import type { SessionRender } from '../../ports/integrations';
import type { RenderOutput } from './sdk';
import { stringify } from 'yaml';

/** Sandbox directory containing rendered integration files. */
export const INTEGRATIONS_DIR = '/tmp/marimohub-integrations';
/** Environment variable pointing notebook code to {@link INTEGRATIONS_DIR}. */
export const INTEGRATIONS_DIR_ENV = 'MARIMOHUB_INTEGRATIONS_DIR';

/**
 * Env names a kind may not emit: process-start code-execution vectors and shell
 * basics. Narrower than the project-secret blocklist on purpose — kinds are hub
 * code and legitimately set tool vars (`PYICEBERG_HOME`) and `MARIMOHUB_*`.
 */
const FORBIDDEN_ENV = new Set([
	'PATH',
	'HOME',
	'PWD',
	'LANG',
	'IFS',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'DYLD_INSERT_LIBRARIES',
	'PYTHONSTARTUP',
	'PYTHONPATH',
	'NODE_OPTIONS',
	'BASH_ENV',
	'ENV',
]);

const ENV_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

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
	const fileOwner = new Map<string, string>();
	const yamlFiles = new Map<string, { value: Record<string, unknown>; owners: string[] }>();
	const vars: Record<string, string> = {};
	const varOwner = new Map<string, string>();

	for (const item of rendered) {
		for (const file of item.output.files ?? []) {
			const path = normalizeRelativePath(file.path, item.name);
			const owner = fileOwner.get(path) ?? yamlFiles.get(path)?.owners[0];
			if (owner) {
				throw new ValidationError(
					`Integrations "${owner}" and "${item.name}" both render "${path}".`,
				);
			}
			fileOwner.set(path, item.name);
			files.push({ path: `${INTEGRATIONS_DIR}/${path}`, content: file.content });
		}
		for (const file of item.output.yamlFiles ?? []) {
			const path = normalizeRelativePath(file.path, item.name);
			const owner = fileOwner.get(path);
			if (owner) {
				throw new ValidationError(
					`Integrations "${owner}" and "${item.name}" both render "${path}".`,
				);
			}
			const existing = yamlFiles.get(path);
			if (existing) {
				existing.value = mergeYaml(existing.value, file.value, path);
				existing.owners.push(item.name);
			} else {
				yamlFiles.set(path, { value: structuredClone(file.value), owners: [item.name] });
			}
		}
		for (const [key, value] of Object.entries(item.output.env ?? {})) {
			assertValidEnvName(key, item.name);
			const owner = varOwner.get(key);
			// An identical value from two instances is tolerated (e.g. a shared
			// tool var like PYICEBERG_HOME); a differing one is ambiguous.
			if (owner && vars[key] !== value) {
				throw new ValidationError(
					`Integrations "${owner}" and "${item.name}" set env "${key}" to different values.`,
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
	vars[INTEGRATIONS_DIR_ENV] = INTEGRATIONS_DIR;

	return {
		files,
		vars,
		attachments: rendered.map(({ id, name, kind, version }) => ({ id, name, kind, version })),
	};
}

function mergeYaml(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	path: string,
): Record<string, unknown> {
	const merged = { ...left };
	for (const [key, value] of Object.entries(right)) {
		const previous = merged[key];
		if (previous === undefined) {
			merged[key] = structuredClone(value);
		} else if (isPlainObject(previous) && isPlainObject(value)) {
			merged[key] = mergeYaml(previous, value, `${path}:${key}`);
		} else if (JSON.stringify(previous) !== JSON.stringify(value)) {
			throw new ValidationError(`Rendered YAML fragments conflict at "${path}:${key}".`);
		}
	}
	return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortObject(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortObject);
	if (!isPlainObject(value)) return value;
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
		segments.some((s) => s === '' || s === '.' || s === '..')
	) {
		throw new ValidationError(
			`Integration "${instance}" rendered an invalid file path "${path}": ` +
				'paths must be relative, POSIX, and free of "." / ".." segments.',
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
