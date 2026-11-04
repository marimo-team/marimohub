import { z } from 'zod';
import { ROLES } from './constants';
import { SessionLinkTemplatesSchema } from './sessionLinks';

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

export const ColorModeSchema = z.enum(['user', 'light', 'dark']);
export type ColorMode = z.infer<typeof ColorModeSchema>;

export const ThemeNavLinkSchema = z.object({
	label: z.string().trim().min(1).max(40),
	href: assetUrl,
	placement: z.enum(['header', 'help']).optional(),
	external: z.boolean().optional(),
	roles: z.array(z.enum(ROLES)).optional(),
});
export type ThemeNavLink = z.infer<typeof ThemeNavLinkSchema>;
export type ThemeLinkRole = NonNullable<ThemeNavLink['roles']>[number];

export const ThemeAnnouncementSchema = z.object({
	id: z.string().trim().min(1).max(100),
	text: z.string().trim().min(1).max(280),
	href: assetUrl.optional(),
	level: z.enum(['info', 'warning']).optional(),
	dismissible: z.boolean().optional(),
});

export const ThemeConfigSchema = z.object({
	nav_links: z.array(ThemeNavLinkSchema).max(12).optional(),
	docs_url: assetUrl.optional(),
	support_url: assetUrl.optional(),
	announcement: ThemeAnnouncementSchema.optional(),
	notebook_css: assetUrl.optional(),
	notebook_palette: z.enum(['off', 'accents', 'full']).default('off'),
	color_mode: ColorModeSchema.default('user'),
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

// Session templates can name private infrastructure and must not enter the public theme response.
export const DeploymentThemeConfigSchema = ThemeConfigSchema.extend({
	session_links: SessionLinkTemplatesSchema.optional(),
});
export type DeploymentThemeConfig = z.infer<typeof DeploymentThemeConfigSchema>;

export const ThemeResponseSchema = z.object({
	success: z.literal(true),
	data: ThemeConfigSchema,
});

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
	notebook_palette: 'off',
	color_mode: 'user',
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
