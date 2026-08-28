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

	it('rejects the primary marimo port for VS Code', () => {
		expect(() =>
			surfacesFromEnv({
				MARIMOHUB_SURFACES: 'marimo,vscode',
				MARIMOHUB_SURFACE_VSCODE_PORT: '2718',
			}),
		).toThrow(/MARIMOHUB_SURFACE_VSCODE_PORT/);
	});
});
