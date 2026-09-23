import { z } from 'zod';

export function isThemeAssetUrl(value: string): boolean {
	if (/[\s\\]/u.test(value)) return false;
	if (value.startsWith('/')) return !value.startsWith('//');
	if (!/^https:\/\//i.test(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch {
		return false;
	}
}

const assetUrl = z.string().refine(isThemeAssetUrl, 'Expected an HTTPS URL or root-relative path');
const color = z.string().regex(/^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/, 'Expected #RGB or #RRGGBB');

export const DEFAULT_PWA_THEME_COLOR = '#0d9488';

export const ThemeConfigSchema = z.object({
	name: z.string().trim().min(1),
	favicon: assetUrl.nullable(),
	logo: assetUrl.nullable(),
	logo_dark: assetUrl.nullable(),
	primary_color: color.nullable(),
	secondary_color: color.nullable(),
	pwa_icon_192: assetUrl.nullable().default(null),
	pwa_icon_512: assetUrl.nullable().default(null),
	apple_touch_icon: assetUrl.nullable().default(null),
});

export type ThemeConfig = z.infer<typeof ThemeConfigSchema>;

export const ThemeResponseSchema = z.object({
	success: z.literal(true),
	data: ThemeConfigSchema,
});

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
	name: 'marimohub',
	favicon: null,
	logo: null,
	logo_dark: null,
	primary_color: null,
	secondary_color: null,
	pwa_icon_192: null,
	pwa_icon_512: null,
	apple_touch_icon: null,
};
