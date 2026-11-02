import { DEFAULT_THEME_CONFIG, ThemeConfigSchema } from '@marimo-hub/core/theme';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import { parseHttpUrl } from '@marimo-hub/core/url';
import { ConfigError } from './errors';

const THEME_VARIABLES = {
	nav_links: 'MARIMOHUB_THEME_NAV_LINKS',
	docs_url: 'MARIMOHUB_THEME_DOCS_URL',
	support_url: 'MARIMOHUB_THEME_SUPPORT_URL',
	announcement: 'MARIMOHUB_THEME_ANNOUNCEMENT',
	notebook_css: 'MARIMOHUB_THEME_NOTEBOOK_CSS',
	color_mode: 'MARIMOHUB_THEME_COLOR_MODE',
	name: 'MARIMOHUB_THEME_NAME',
	favicon: 'MARIMOHUB_THEME_FAVICON',
	logo: 'MARIMOHUB_THEME_LOGO',
	logo_dark: 'MARIMOHUB_THEME_LOGO_DARK',
	primary_color: 'MARIMOHUB_THEME_PRIMARY_COLOR',
	secondary_color: 'MARIMOHUB_THEME_SECONDARY_COLOR',
	pwa_icon_192: 'MARIMOHUB_THEME_PWA_ICON_192',
	pwa_icon_512: 'MARIMOHUB_THEME_PWA_ICON_512',
	apple_touch_icon: 'MARIMOHUB_THEME_APPLE_TOUCH_ICON',
} as const;

export type ThemeEnv = Partial<
	Record<(typeof THEME_VARIABLES)[keyof typeof THEME_VARIABLES], string>
> & { MARIMOHUB_APP_BASE_URL?: string };

export function parseTheme(env: ThemeEnv): ThemeConfig {
	const values: Partial<Record<keyof ThemeConfig, unknown>> = { ...DEFAULT_THEME_CONFIG };
	for (const key of Object.keys(THEME_VARIABLES) as (keyof ThemeConfig)[]) {
		const value = env[THEME_VARIABLES[key]]?.trim();
		if (!value) continue;
		if (key === 'nav_links' || key === 'announcement') {
			try {
				values[key] = JSON.parse(value);
			} catch {
				throw new ConfigError(`Invalid ${THEME_VARIABLES[key]}: expected JSON`, {
					variable: THEME_VARIABLES[key],
					remediation: 'Use valid JSON matching the theming guide.',
					docs: 'docs/theming.md',
				});
			}
		} else values[key] = value;
	}
	const result = ThemeConfigSchema.safeParse(values);
	if (!result.success) {
		const issue = result.error.issues[0];
		const variable = THEME_VARIABLES[issue.path[0] as keyof ThemeConfig];
		throw new ConfigError(`Invalid ${variable}: ${issue.message}`, {
			variable,
			remediation:
				variable === 'MARIMOHUB_THEME_COLOR_MODE'
					? 'Use user, light, or dark. Unset or blank means user.'
					: 'Use the URL, color, or JSON format described in the theming guide.',
			docs: 'docs/theming.md',
		});
	}
	const appBaseUrl = env.MARIMOHUB_APP_BASE_URL?.trim();
	if (result.data.notebook_css?.startsWith('/') && !appBaseUrl) {
		throw new ConfigError(
			'Root-relative MARIMOHUB_THEME_NOTEBOOK_CSS requires MARIMOHUB_APP_BASE_URL.',
			{
				variable: 'MARIMOHUB_THEME_NOTEBOOK_CSS',
				remediation: 'Set MARIMOHUB_APP_BASE_URL or use an absolute HTTPS CSS URL.',
				docs: 'docs/theming.md',
			},
		);
	}
	if (
		result.data.notebook_css?.startsWith('/') &&
		appBaseUrl &&
		(!/^https?:\/\//i.test(appBaseUrl) ||
			/[\s\\]/u.test(appBaseUrl) ||
			!parseHttpUrl(appBaseUrl).ok)
	) {
		throw new ConfigError(
			'Invalid MARIMOHUB_APP_BASE_URL for root-relative MARIMOHUB_THEME_NOTEBOOK_CSS.',
			{
				variable: 'MARIMOHUB_APP_BASE_URL',
				remediation: 'Use an absolute HTTP(S) URL without credentials.',
				docs: 'docs/theming.md',
			},
		);
	}
	return result.data;
}
