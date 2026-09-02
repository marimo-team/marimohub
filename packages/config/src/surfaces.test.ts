import { afterEach, describe, expect, it, vi } from 'vitest';
import { surfaceFromEnv, surfacePorts, surfacesFromEnv } from './surfaces';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('surfacesFromEnv', () => {
	it('keeps secondary surfaces disabled by default', () => {
		expect(surfacesFromEnv({})).toBeUndefined();
	});

	it('parses the VS Code surface configuration', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,vscode',
				MARIMOHUB_SURFACE_VSCODE_FLAVOR: 'openvscode',
				MARIMOHUB_SURFACE_VSCODE_PORT: '9443',
				MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON: '{"editor.fontSize":14}',
			}),
		).toEqual({
			vscode: {
				flavor: 'openvscode',
				start: 'on-demand',
				port: 9443,
				settings: { 'editor.fontSize': 14 },
				extensionGallery: 'openvsx',
				embed: 'tab',
			},
		});
	});

	it('warns once at boot when the experimental openvscode flavor is selected', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		surfacesFromEnv({ MARIMOHUB_SURFACES: 'marimo,vscode' });
		expect(warn).not.toHaveBeenCalled();

		surfacesFromEnv({
			MARIMOHUB_SURFACES: 'marimo,vscode',
			MARIMOHUB_SURFACE_VSCODE_FLAVOR: 'openvscode',
		});
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0][0])).toContain('openvscode is experimental');
	});

	it('parses OpenCode and both secondary surfaces', () => {
		expect(
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,vscode,opencode',
				MARIMOHUB_SURFACE_OPENCODE_START: 'eager',
				MARIMOHUB_SURFACE_OPENCODE_PORT: '5096',
				MARIMOHUB_SURFACE_OPENCODE_EMBED: 'iframe',
			}),
		).toEqual({
			vscode: expect.objectContaining({ port: 8443 }),
			opencode: {
				start: 'eager',
				port: 5096,
				embed: 'iframe',
			},
		});
	});

	it('uses the OpenCode defaults', () => {
		expect(surfacesFromEnv({ MARIMOHUB_SURFACES: 'marimo,opencode' })).toEqual({
			opencode: {
				start: 'on-demand',
				port: 4096,
				embed: 'tab',
			},
		});
	});

	it('rejects unknown surfaces and invalid settings JSON', () => {
		expect(() => surfacesFromEnv({ MARIMOHUB_SURFACES: 'jupyter' })).toThrow(/MARIMOHUB_SURFACES/);
		expect(() =>
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'vscode',
				MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON: '[]',
			}),
		).toThrow(/SETTINGS_JSON/);
		expect(() =>
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'vscode',
				MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY: 'ftp://gallery.example',
			}),
		).toThrow(/EXTENSION_GALLERY/);
	});

	it.each(['vscode', 'opencode'] as const)('rejects the primary marimo port for %s', (surface) => {
		const variable =
			surface === 'vscode' ? 'MARIMOHUB_SURFACE_VSCODE_PORT' : 'MARIMOHUB_SURFACE_OPENCODE_PORT';
		expect(() =>
			surfacesFromEnv({
				MARIMOHUB_SURFACES: `marimo,${surface}`,
				[variable]: '2718',
			}),
		).toThrow(new RegExp(variable));
	});

	it('rejects a shared secondary port', () => {
		expect(() =>
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,vscode,opencode',
				MARIMOHUB_SURFACE_VSCODE_PORT: '4096',
			}),
		).toThrow(/vscode and opencode cannot share sandbox port 4096/);
	});

	it('trims the surface list without enabling empty entries', () => {
		expect(
			surfacesFromEnv({
				MARIMOHUB_SURFACES: ' marimo, , opencode, ',
			}),
		).toEqual({
			opencode: expect.objectContaining({ port: 4096 }),
		});
	});

	it('ignores configuration for disabled surfaces', () => {
		expect(
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,vscode',
				MARIMOHUB_SURFACE_OPENCODE_PORT: '0',
			}),
		).toHaveProperty('vscode');
		expect(
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,opencode',
				MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON: '[]',
			}),
		).toHaveProperty('opencode');
	});
});

describe('surfaceFromEnv', () => {
	it('parses one surface by id with its own variables', () => {
		expect(
			surfaceFromEnv('opencode', {
				MARIMOHUB_SURFACE_OPENCODE_PORT: '5000',
				MARIMOHUB_SURFACE_VSCODE_PORT: '9443',
			}),
		).toEqual({ start: 'on-demand', port: 5000, embed: 'tab' });
	});
});

describe('surfacePorts', () => {
	it('lists enabled surface ports in registry order', () => {
		expect(surfacePorts(undefined)).toEqual([]);
		expect(
			surfacePorts(
				surfacesFromEnv({
					MARIMOHUB_SURFACES: 'opencode,vscode',
					MARIMOHUB_SURFACE_VSCODE_PORT: '9443',
				}),
			),
		).toEqual([9443, 4096]);
	});
});
