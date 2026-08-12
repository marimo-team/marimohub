import { stringify } from 'smol-toml';
import type { TomlTable, TomlValue } from 'smol-toml';
import { isRecord } from '../internal/validation';
import type { SessionEnv } from './runtime/SandboxProvisioner';

// Contributors (aiSessionConfig) type their tables against this re-export so
// the smol-toml dependency stays confined to this module.
export type { TomlTable };

export type MarimoConfigContributor = () => TomlTable;

const XDG_CONFIG_HOME = '/tmp/marimohub-config';
// marimo also writes logs to XDG_CACHE_HOME and recent-files/server state to
// XDG_STATE_HOME (`~/.cache`, `~/.local/state` by default). Redirect both to
// /tmp so ephemeral runtime state never lands under $HOME, where a deployment
// whose workdir overlaps the home directory would sweep it into the workspace
// capture and filesystem snapshots. Unlike XDG_CONFIG_HOME (forced — it
// carries policy config), these are fallbacks: an image that sets its own
// cache/state locations keeps them.
const XDG_CACHE_HOME = '/tmp/marimohub-cache';
const XDG_STATE_HOME = '/tmp/marimohub-state';

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
	return isRecord(value) && !(value instanceof Date);
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
		defaults: { XDG_CACHE_HOME, XDG_STATE_HOME },
	};
}
