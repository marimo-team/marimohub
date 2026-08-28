import type { SandboxConfig } from '@marimo-hub/api';
import { MARIMO_PORT } from '@marimo-hub/core';
import { parseBool, parseEnumOr, parseIntEnv, parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const SURFACE_IDS = ['marimo', 'vscode'] as const;

export function surfacesFromEnv(env: Env): SandboxConfig['surfaces'] {
	const enabled = new Set(parseList(env.MARIMOHUB_SURFACES) ?? ['marimo']);
	for (const id of enabled) {
		if (!(SURFACE_IDS as readonly string[]).includes(id)) {
			throw new ConfigError(`Invalid MARIMOHUB_SURFACES entry: ${id}`, {
				variable: 'MARIMOHUB_SURFACES',
			});
		}
	}
	if (!enabled.has('vscode')) return undefined;

	const port = parseIntEnv(env, 'MARIMOHUB_SURFACE_VSCODE_PORT') ?? 8443;
	if (port < 1 || port > 65_535 || port === MARIMO_PORT) {
		throw new ConfigError(`Invalid MARIMOHUB_SURFACE_VSCODE_PORT: ${port}`, {
			variable: 'MARIMOHUB_SURFACE_VSCODE_PORT',
		});
	}
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
			if (url.protocol !== 'http:' && url.protocol !== 'https:')
				throw new Error('Unsupported scheme');
		} catch {
			throw new ConfigError(
				'Invalid MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY: expected openvsx, none, or an HTTP(S) URL',
				{ variable: 'MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY' },
			);
		}
	}

	return {
		vscode: {
			flavor: parseEnumOr(
				env,
				'MARIMOHUB_SURFACE_VSCODE_FLAVOR',
				['code-server', 'openvscode'],
				'code-server',
			),
			start: parseEnumOr(
				env,
				'MARIMOHUB_SURFACE_VSCODE_START',
				['on-demand', 'eager'],
				'on-demand',
			),
			port,
			settings,
			extensionGallery,
			embed: parseEnumOr(env, 'MARIMOHUB_SURFACE_VSCODE_EMBED', ['tab', 'iframe'], 'tab'),
			marimoWatch:
				env.MARIMOHUB_SURFACE_VSCODE_MARIMO_WATCH === undefined
					? true
					: parseBool(env, 'MARIMOHUB_SURFACE_VSCODE_MARIMO_WATCH'),
		},
	};
}
