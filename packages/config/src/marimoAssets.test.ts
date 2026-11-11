import { expect, it } from 'vitest';
import { createFromEnv } from './index';
import { resolveMarimoAssetUrl } from './marimoAssets';

it.each([undefined, '', '  ', 'false', 'FALSE', ' FaLsE '])(
	'keeps bundled assets as the default: %s',
	(value) => {
		expect(resolveMarimoAssetUrl({ MARIMOHUB_COMPUTE_ASSET_URL: value })).toBeUndefined();
	},
);

it.each([
	'https://user:secret@cdn.example/assets',
	'https://cdn.example/assets?token=secret',
	'https://cdn.example/assets#fragment',
	'http://cdn.example/assets',
	'/assets',
	'ftp://cdn.example/assets',
	'true',
])('rejects unsafe explicit asset bases without echoing their values: %s', (value) => {
	expect(() => resolveMarimoAssetUrl({ MARIMOHUB_COMPUTE_ASSET_URL: value })).toThrow(
		'Invalid MARIMOHUB_COMPUTE_ASSET_URL',
	);
	try {
		resolveMarimoAssetUrl({ MARIMOHUB_COMPUTE_ASSET_URL: value });
	} catch (error) {
		expect(String(error)).not.toContain(value);
	}
});

it.each([
	['https://hub.example/', 'https://hub.example/_marimo/{version}'],
	['https://hub.example/team/hub/', 'https://hub.example/team/hub/_marimo/{version}'],
	['http://localhost:4321', 'http://localhost:4321/_marimo/{version}'],
])('resolves hub against %s before launch', (base, expected) => {
	const deps = createFromEnv({
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
		MARIMOHUB_COMPUTE_ASSET_URL: 'hub',
		MARIMOHUB_APP_BASE_URL: base,
	});
	expect(deps.sandbox.assetUrl).toBe(expected);
});

it.each([
	undefined,
	'hub.example',
	'/prefix',
	'ftp://hub.example',
	'https://u:p@hub.example',
	'https://hub.example?token=secret',
	'https://hub.example#fragment',
])('rejects an unsafe or missing public base: %s', (base) => {
	expect(() =>
		resolveMarimoAssetUrl({ MARIMOHUB_COMPUTE_ASSET_URL: 'hub', MARIMOHUB_APP_BASE_URL: base }),
	).toThrow('MARIMOHUB_APP_BASE_URL');
});

it('preserves explicit CDN version templates', () => {
	const template = 'https://cdn.example/frontend@{version}/dist';
	expect(resolveMarimoAssetUrl({ MARIMOHUB_COMPUTE_ASSET_URL: template })).toBe(template);
});
