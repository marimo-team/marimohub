import type { SandboxConfig } from '@marimo-hub/api';
import { MARIMO_PORT, SECONDARY_SURFACE_IDS } from '@marimo-hub/core';
import type { SecondarySurfaceId } from '@marimo-hub/core';
import { parseEnumOr, parseIntEnv, parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const SURFACE_IDS = ['marimo', ...SECONDARY_SURFACE_IDS] as const;

type SurfacesConfig = NonNullable<SandboxConfig['surfaces']>;
export type SurfaceConfig<K extends SecondarySurfaceId> = NonNullable<SurfacesConfig[K]>;

interface BaseSurfaceConfig {
	start: 'on-demand' | 'eager';
	port: number;
	embed: 'tab' | 'iframe';
}

interface SurfaceEnv<K extends SecondarySurfaceId> {
	defaultPort: number;
	variables: Record<keyof BaseSurfaceConfig, string>;
	build(base: BaseSurfaceConfig, env: Env): SurfaceConfig<K>;
}

function vscodeExtrasFromEnv(env: Env) {
	let settings: Record<string, unknown> = {};
	if (env.MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON) {
		try {
			const parsed: unknown = JSON.parse(env.MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON);
			if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
				throw new Error('Settings must be an object');
			}
			settings = parsed as Record<string, unknown>;
		} catch {
			throw new ConfigError('Invalid MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON: expected an object', {
				variable: 'MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON',
			});
		}
	}
	const extensionGallery = env.MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY?.trim() || 'openvsx';
	if (extensionGallery !== 'openvsx' && extensionGallery !== 'none') {
		try {
			const url = new URL(extensionGallery);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				throw new Error('Unsupported scheme');
			}
		} catch {
			throw new ConfigError(
				'Invalid MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY: expected openvsx, none, or an HTTP(S) URL',
				{ variable: 'MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY' },
			);
		}
	}
	const flavor = parseEnumOr(
		env,
		'MARIMOHUB_SURFACE_VSCODE_FLAVOR',
		['code-server', 'openvscode'],
		'code-server',
	);
	if (flavor === 'openvscode') {
		console.warn(
			'[marimohub] MARIMOHUB_SURFACE_VSCODE_FLAVOR=openvscode is experimental: no published marimo-sandbox image ships openvscode-server.',
		);
	}
	return { flavor, settings, extensionGallery };
}

const SURFACE_ENV: { [K in SecondarySurfaceId]: SurfaceEnv<K> } = {
	vscode: {
		defaultPort: 8443,
		variables: {
			start: 'MARIMOHUB_SURFACE_VSCODE_START',
			port: 'MARIMOHUB_SURFACE_VSCODE_PORT',
			embed: 'MARIMOHUB_SURFACE_VSCODE_EMBED',
		},
		build: (base, env) => ({ ...base, ...vscodeExtrasFromEnv(env) }),
	},
	opencode: {
		defaultPort: 4096,
		variables: {
			start: 'MARIMOHUB_SURFACE_OPENCODE_START',
			port: 'MARIMOHUB_SURFACE_OPENCODE_PORT',
			embed: 'MARIMOHUB_SURFACE_OPENCODE_EMBED',
		},
		build: (base) => base,
	},
};

function surfacePort(env: Env, variable: string, defaultPort: number): number {
	const port = parseIntEnv(env, variable) ?? defaultPort;
	if (port < 1 || port > 65_535 || port === MARIMO_PORT) {
		throw new ConfigError(`Invalid ${variable}: ${port}`, { variable });
	}
	return port;
}

export function surfaceFromEnv<K extends SecondarySurfaceId>(id: K, env: Env): SurfaceConfig<K> {
	const spec = SURFACE_ENV[id];
	const base: BaseSurfaceConfig = {
		start: parseEnumOr(env, spec.variables.start, ['on-demand', 'eager'], 'on-demand'),
		port: surfacePort(env, spec.variables.port, spec.defaultPort),
		embed: parseEnumOr(env, spec.variables.embed, ['tab', 'iframe'], 'tab'),
	};
	return spec.build(base, env);
}

function setSurface<K extends SecondarySurfaceId>(
	surfaces: SurfacesConfig,
	id: K,
	config: SurfaceConfig<K>,
): void {
	surfaces[id] = config;
}

export function surfacesFromEnv(env: Env): SandboxConfig['surfaces'] {
	const enabled = new Set(parseList(env.MARIMOHUB_SURFACES) ?? ['marimo']);
	for (const id of enabled) {
		if (!(SURFACE_IDS as readonly string[]).includes(id)) {
			throw new ConfigError(`Invalid MARIMOHUB_SURFACES entry: ${id}`, {
				variable: 'MARIMOHUB_SURFACES',
			});
		}
	}
	const ids = SECONDARY_SURFACE_IDS.filter((id) => enabled.has(id));
	if (ids.length === 0) return undefined;

	const surfaces: SurfacesConfig = {};
	const portOwners = new Map<number, SecondarySurfaceId>();
	for (const id of ids) {
		const config = surfaceFromEnv(id, env);
		const owner = portOwners.get(config.port);
		if (owner) {
			throw new ConfigError(
				`Surfaces ${owner} and ${id} cannot share sandbox port ${config.port}`,
				{ variable: 'MARIMOHUB_SURFACES' },
			);
		}
		portOwners.set(config.port, id);
		setSurface(surfaces, id, config);
	}
	return surfaces;
}

/** Ports of every enabled secondary surface, in registry order. */
export function surfacePorts(surfaces: SandboxConfig['surfaces']): number[] {
	return SECONDARY_SURFACE_IDS.flatMap((id) => surfaces?.[id]?.port ?? []);
}
