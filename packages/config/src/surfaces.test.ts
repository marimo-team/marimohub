import { describe, expect, it } from 'vitest';
import { surfacesFromEnv } from './surfaces';

describe('surfacesFromEnv', () => {
	it('keeps secondary surfaces disabled by default', () => {
		expect(surfacesFromEnv({})).toBeUndefined();
	});

	it('parses the VS Code surface configuration', () => {
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
				marimoWatch: true,
			},
		});
	});

	it('parses OpenCode and both secondary surfaces', () => {
		expect(
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,vscode,opencode',
				MARIMOHUB_SURFACE_OPENCODE_START: 'eager',
				MARIMOHUB_SURFACE_OPENCODE_PORT: '5096',
				MARIMOHUB_SURFACE_OPENCODE_EMBED: 'iframe',
				MARIMOHUB_SURFACE_OPENCODE_MARIMO_WATCH: 'false',
			}),
		).toEqual({
			vscode: expect.objectContaining({ port: 8443 }),
			opencode: {
				start: 'eager',
				port: 5096,
				embed: 'iframe',
				marimoWatch: false,
			},
		});
	});

	it('uses the OpenCode defaults', () => {
		expect(surfacesFromEnv({ MARIMOHUB_SURFACES: 'marimo,opencode' })).toEqual({
			opencode: {
				start: 'on-demand',
				port: 4096,
				embed: 'tab',
				marimoWatch: true,
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
		).toThrow(/cannot share sandbox port/);
	});

	it.each([
		['MARIMOHUB_SURFACE_OPENCODE_START', 'sometimes'],
		['MARIMOHUB_SURFACE_OPENCODE_EMBED', 'window'],
		['MARIMOHUB_SURFACE_OPENCODE_MARIMO_WATCH', 'yes'],
		['MARIMOHUB_SURFACE_OPENCODE_PORT', '4096.5'],
		['MARIMOHUB_SURFACE_OPENCODE_PORT', '65536'],
	] as const)('rejects invalid OpenCode value %s=%s', (variable, value) => {
		expect(() =>
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,opencode',
				[variable]: value,
			}),
		).toThrow(new RegExp(variable));
	});

	it('trims surface names without enabling empty entries', () => {
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
