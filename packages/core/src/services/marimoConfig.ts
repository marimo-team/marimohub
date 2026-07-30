import { stringify } from 'smol-toml';
import type { TomlTable, TomlValue } from 'smol-toml';
import type { SessionEnv } from './runtime/SandboxProvisioner';

export type MarimoConfigContributor = () => TomlTable;

const XDG_CONFIG_HOME = '/tmp/marimohub-config';

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

// marimo's built-in sharing (HTML/WASM export, molab) publishes outside the deployment.
export const marimoSharingDisabled: MarimoConfigContributor = () => ({
	sharing: { html: false, wasm: false, molab: false },
});

export function marimoConfigToSessionEnv(
	contributors: readonly MarimoConfigContributor[],
): SessionEnv {
	return {
		files: [
			{
				path: `${XDG_CONFIG_HOME}/marimo/marimo.toml`,
				content: assembleMarimoToml(contributors),
			},
		],
		vars: { XDG_CONFIG_HOME },
	};
}
