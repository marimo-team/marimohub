import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { ConfigError } from './errors';
import { parseTheme } from './theme';
import { createFromEnv } from './index';

describe('deployment theme configuration', () => {
	it.each([
		['MARIMOHUB_THEME_PWA_ICON_192', 'pwa_icon_192'],
		['MARIMOHUB_THEME_PWA_ICON_512', 'pwa_icon_512'],
		['MARIMOHUB_THEME_APPLE_TOUCH_ICON', 'apple_touch_icon'],
	] as const)('validates dedicated installation icon %s', (variable, field) => {
		expect(parseTheme({ [variable]: ' https://cdn.example.com/icon.png?v=2 ' })[field]).toBe(
			'https://cdn.example.com/icon.png?v=2',
		);
		expect(parseTheme({ [variable]: '/brand/icon.png' })[field]).toBe('/brand/icon.png');
		expect(parseTheme({ [variable]: ' ' })[field]).toBeNull();
		expect(() => parseTheme({ [variable]: 'javascript:alert(1)' })).toThrow(variable);
	});

	it('defaults empty and whitespace-only values', () => {
		expect(parseTheme({})).toEqual(DEFAULT_THEME_CONFIG);
		expect(parseTheme({ MARIMOHUB_THEME_NAME: '  ', MARIMOHUB_THEME_LOGO: '\t' })).toEqual(
			DEFAULT_THEME_CONFIG,
		);
	});

	it('trims partial overrides without inventing other values', () => {
		expect(
			parseTheme({
				MARIMOHUB_THEME_NAME: ' Research Hub ',
				MARIMOHUB_THEME_PRIMARY_COLOR: ' #ABC ',
			}),
		).toEqual({ ...DEFAULT_THEME_CONFIG, name: 'Research Hub', primary_color: '#ABC' });
	});

	it.each(['https://cdn.example.com/logo.svg?v=2', '/brand/logo.png', '/hub/brand/favicon.ico'])(
		'accepts an asset at %s',
		(url) => {
			expect(parseTheme({ MARIMOHUB_THEME_LOGO: url }).logo).toBe(url);
		},
	);

	it.each([
		'http://example.com/a.svg',
		'//example.com/a.svg',
		'/\\example.com/a.svg',
		'data:image/svg+xml,<svg/>',
		'javascript:alert(1)',
		'file:///logo.png',
		'./logo.svg',
		'logo.svg',
		'/a\nb.svg',
		'https://user:password@example.com/a.svg',
	])('rejects unsafe or ambiguous asset %s', (url) => {
		expect(() => parseTheme({ MARIMOHUB_THEME_LOGO: url })).toThrow(ConfigError);
		expect(() => parseTheme({ MARIMOHUB_THEME_LOGO: url })).toThrow('MARIMOHUB_THEME_LOGO');
	});

	it.each(['#ff0', '#FFFF00', '#000000', '#ffffff'])('accepts opaque color %s', (color) => {
		expect(parseTheme({ MARIMOHUB_THEME_PRIMARY_COLOR: color }).primary_color).toBe(color);
	});

	it.each([
		'red',
		'#1234',
		'#12345678',
		'rgb(1,2,3)',
		'#12',
		'#ggg',
		'var(--primary)',
		'#fff; color:red',
	])('rejects invalid color %s', (color) => {
		expect(() => parseTheme({ MARIMOHUB_THEME_SECONDARY_COLOR: color })).toThrow(
			'MARIMOHUB_THEME_SECONDARY_COLOR',
		);
	});

	it('wires theme through the Node composition root', () => {
		const deps = createFromEnv({
			MARIMOHUB_STORAGE_BACKEND: 'memory',
			MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
			MARIMOHUB_COMPUTE_BACKEND: 'none',
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_THEME_NAME: 'Research Hub',
			MARIMOHUB_THEME_LOGO_DARK: '/logo-dark.svg',
			MARIMOHUB_THEME_PWA_ICON_192: '/brand/192.png',
			MARIMOHUB_THEME_PWA_ICON_512: '/brand/512.png',
			MARIMOHUB_THEME_APPLE_TOUCH_ICON: '/brand/apple.png',
		});
		expect(deps.theme).toEqual({
			...DEFAULT_THEME_CONFIG,
			name: 'Research Hub',
			logo_dark: '/logo-dark.svg',
			pwa_icon_192: '/brand/192.png',
			pwa_icon_512: '/brand/512.png',
			apple_touch_icon: '/brand/apple.png',
		});
	});

	it('treats all whitespace-only settings as absent', () => {
		expect(
			parseTheme({
				MARIMOHUB_THEME_NAME: ' \t\n',
				MARIMOHUB_THEME_LOGO: ' \t\n',
				MARIMOHUB_THEME_LOGO_DARK: ' \t\n',
				MARIMOHUB_THEME_FAVICON: ' \t\n',
				MARIMOHUB_THEME_PRIMARY_COLOR: ' \t\n',
				MARIMOHUB_THEME_SECONDARY_COLOR: ' \t\n',
			}),
		).toEqual(DEFAULT_THEME_CONFIG);
	});

	it.each([
		['MARIMOHUB_THEME_LOGO', 'https://private:secret@example.com/logo.svg'],
		['MARIMOHUB_THEME_LOGO_DARK', 'data:image/svg+xml,<svg/>'],
		['MARIMOHUB_THEME_FAVICON', '//example.com/favicon.ico'],
		['MARIMOHUB_THEME_PRIMARY_COLOR', '#abcd'],
		['MARIMOHUB_THEME_SECONDARY_COLOR', 'transparent'],
	])('reports actionable errors for %s without echoing its value', (variable, value) => {
		let error: unknown;
		try {
			parseTheme({ [variable]: value });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ConfigError);
		expect(error).toMatchObject({
			opts: {
				variable,
				remediation: expect.any(String),
				docs: 'docs/theming.md',
			},
		});
		expect(String(error)).not.toContain(value);
	});

	it.each([
		'https://',
		'https://[invalid]/logo.svg',
		'https://example.com:99999/logo.svg',
		'https:/example.com/logo.svg',
		'https:example.com/logo.svg',
		'https://example.com/brand\\logo.svg',
		'/brand/lo\tgo.svg',
	])('rejects malformed URL %s', (url) => {
		expect(() => parseTheme({ MARIMOHUB_THEME_FAVICON: url })).toThrow(ConfigError);
	});

	it.each([
		'HTTPS://cdn.example.com/brand/logo.svg',
		'https://cdn.example.com/brand%20assets/logo.svg?v=2#mark',
		'/brand%20assets/logo.svg?v=2#mark',
	])('preserves valid encoded or versioned asset URLs: %s', (url) => {
		expect(parseTheme({ MARIMOHUB_THEME_LOGO_DARK: url }).logo_dark).toBe(url);
	});

	it('does not carry configuration between deployments or mutate the input', () => {
		const env = Object.freeze({ MARIMOHUB_THEME_NAME: ' First hub ' });
		const first = parseTheme(env);
		first.name = 'Changed by caller';
		expect(env.MARIMOHUB_THEME_NAME).toBe(' First hub ');
		expect(parseTheme({})).toEqual(DEFAULT_THEME_CONFIG);
		expect(parseTheme(env).name).toBe('First hub');
	});

	it('rejects invalid theme configuration before initializing adapters', () => {
		expect(() => createFromEnv({ MARIMOHUB_THEME_PRIMARY_COLOR: 'red' })).toThrow(
			'MARIMOHUB_THEME_PRIMARY_COLOR',
		);
	});
});
