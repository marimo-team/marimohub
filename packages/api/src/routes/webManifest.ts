import {
	DEFAULT_PWA_THEME_COLOR,
	DEFAULT_THEME_CONFIG,
	ThemeConfigSchema,
} from '@marimo-hub/core/theme';
import { baseHrefFromUrl } from '@marimo-hub/core/url';
import { createApp, resolvePublicBaseUrl } from '../shared';

const app = createApp();

app.get('/manifest.webmanifest', (c) => {
	const deps = c.get('deps');
	const theme = ThemeConfigSchema.parse(deps.theme ?? DEFAULT_THEME_CONFIG);
	const base = baseHrefFromUrl(resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl));
	c.header('Cache-Control', 'no-store');
	c.header('Content-Type', 'application/manifest+json');
	return c.body(
		JSON.stringify({
			id: base,
			name: theme.name,
			short_name: theme.name,
			description: 'Store, manage, and run marimo notebooks with your team.',
			start_url: base,
			scope: base,
			display: 'standalone',
			background_color: '#ffffff',
			theme_color: theme.primary_color ?? DEFAULT_PWA_THEME_COLOR,
			icons: [
				{
					src: theme.pwa_icon_192 ?? `${base}icons/icon-192.png`,
					sizes: '192x192',
					type: 'image/png',
					purpose: 'any',
				},
				{
					src: theme.pwa_icon_512 ?? `${base}icons/icon-512.png`,
					sizes: '512x512',
					type: 'image/png',
					// Custom artwork has no mask-safe padding guarantee.
					purpose: theme.pwa_icon_512 ? 'any' : 'any maskable',
				},
			],
			shortcuts: [
				{ name: 'Projects', url: `${base}projects`, description: 'Browse your notebook projects.' },
				{ name: 'Apps', url: `${base}apps`, description: 'Open published notebook apps.' },
			],
		}),
	);
});

app.get('/apple-touch-icon.png', (c) => {
	const deps = c.get('deps');
	const theme = ThemeConfigSchema.parse(deps.theme ?? DEFAULT_THEME_CONFIG);
	const base = baseHrefFromUrl(resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl));
	c.header('Cache-Control', 'no-store');
	return c.redirect(
		theme.apple_touch_icon ??
			theme.pwa_icon_192 ??
			theme.pwa_icon_512 ??
			`${base}icons/apple-touch-icon.png`,
		302,
	);
});

export default app;
