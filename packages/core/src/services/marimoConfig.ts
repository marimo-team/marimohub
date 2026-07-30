import { stringify } from 'smol-toml';
import type { TomlTable, TomlValue } from 'smol-toml';
import type { SessionEnv } from './runtime/SandboxProvisioner';

export type MarimoConfigContributor = () => TomlTable;

export const DEFAULT_INJECTED_CONFIG_DIR = '/tmp/marimohub-config';

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
	);
}

function emptyTable(): TomlTable {
	return Object.create(null) as TomlTable;
}

export function serializeMarimoToml(table: TomlTable): string {
	return Object.keys(table).length === 0 ? '' : stringify(table);
}

function mergeInto(target: TomlTable, source: TomlTable): void {
	for (const [key, value] of Object.entries(source)) {
		const existing = Object.hasOwn(target, key) ? target[key] : undefined;
		if (isTomlTable(value)) {
			const merged = isTomlTable(existing) ? existing : emptyTable();
			target[key] = merged;
			mergeInto(merged, value);
		} else {
			target[key] = value;
		}
	}
}

export function assembleMarimoToml(contributors: readonly MarimoConfigContributor[]): string {
	const merged = emptyTable();
	for (const contribute of contributors) mergeInto(merged, contribute());
	return serializeMarimoToml(merged);
}

export const marimoNotebookDefaults: MarimoConfigContributor = () => ({
	display: { default_width: 'medium' },
	runtime: { default_sql_output: 'native' },
});

export function marimoConfigToSessionEnv(
	xdgPath: string,
	contributors: readonly MarimoConfigContributor[],
): SessionEnv {
	const dir = xdgPath.replace(/\/+$/, '');
	if (!dir.startsWith('/')) {
		throw new TypeError('XDG config path must be an absolute, non-root path');
	}
	return {
		files: [{ path: `${dir}/marimo/marimo.toml`, content: assembleMarimoToml(contributors) }],
		vars: { XDG_CONFIG_HOME: dir },
	};
}
