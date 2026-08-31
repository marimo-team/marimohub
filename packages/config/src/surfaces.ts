import type { SandboxConfig } from '@marimo-hub/api';
import { MARIMO_PORT, SECONDARY_SURFACE_IDS } from '@marimo-hub/core';
import { parseBool, parseEnumOr, parseIntEnv, parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const SURFACE_IDS = ['marimo', ...SECONDARY_SURFACE_IDS] as const;

type VscodeConfig = NonNullable<NonNullable<SandboxConfig['surfaces']>['vscode']>;
type OpenCodeConfig = NonNullable<NonNullable<SandboxConfig['surfaces']>['opencode']>;

function surfacePort(env: Env, variable: string, defaultPort: number): number {
	const port = parseIntEnv(env, variable) ?? defaultPort;
	if (port < 1 || port > 65_535 || port === MARIMO_PORT) {
		throw new ConfigError(`Invalid ${variable}: ${port}`, { variable });
	}
	return port;
}

function vscodeFromEnv(env: Env, port: number): VscodeConfig {
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

	return {
		flavor: parseEnumOr(
			env,
			'MARIMOHUB_SURFACE_VSCODE_FLAVOR',
			['code-server', 'openvscode'],
			'code-server',
		),
		start: parseEnumOr(env, 'MARIMOHUB_SURFACE_VSCODE_START', ['on-demand', 'eager'], 'on-demand'),
		port,
		settings,
		extensionGallery,
		embed: parseEnumOr(env, 'MARIMOHUB_SURFACE_VSCODE_EMBED', ['tab', 'iframe'], 'tab'),
		marimoWatch:
			env.MARIMOHUB_SURFACE_VSCODE_MARIMO_WATCH === undefined
				? true
				: parseBool(env, 'MARIMOHUB_SURFACE_VSCODE_MARIMO_WATCH'),
	};
}

function openCodeFromEnv(env: Env, port: number): OpenCodeConfig {
	return {
		start: parseEnumOr(
			env,
			'MARIMOHUB_SURFACE_OPENCODE_START',
			['on-demand', 'eager'],
			'on-demand',
		),
		port,
		embed: parseEnumOr(env, 'MARIMOHUB_SURFACE_OPENCODE_EMBED', ['tab', 'iframe'], 'tab'),
		marimoWatch:
			env.MARIMOHUB_SURFACE_OPENCODE_MARIMO_WATCH === undefined
				? true
				: parseBool(env, 'MARIMOHUB_SURFACE_OPENCODE_MARIMO_WATCH'),
	};
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
	if (!SECONDARY_SURFACE_IDS.some((id) => enabled.has(id))) return undefined;

	const vscodePort = enabled.has('vscode')
		? surfacePort(env, 'MARIMOHUB_SURFACE_VSCODE_PORT', 8443)
		: undefined;
	const openCodePort = enabled.has('opencode')
		? surfacePort(env, 'MARIMOHUB_SURFACE_OPENCODE_PORT', 4096)
		: undefined;
	if (vscodePort !== undefined && vscodePort === openCodePort) {
		throw new ConfigError(`VS Code and OpenCode cannot share sandbox port ${vscodePort}`, {
			variable: 'MARIMOHUB_SURFACES',
		});
	}
	const vscode = vscodePort === undefined ? undefined : vscodeFromEnv(env, vscodePort);
	const opencode = openCodePort === undefined ? undefined : openCodeFromEnv(env, openCodePort);

	return {
		...(vscode ? { vscode } : {}),
		...(opencode ? { opencode } : {}),
	};
}
