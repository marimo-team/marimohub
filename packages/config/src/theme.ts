import { DEFAULT_THEME_CONFIG, ThemeConfigSchema } from '@marimo-hub/core/theme';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import { ConfigError } from './errors';

const THEME_VARIABLES = {
	name: 'MARIMOHUB_THEME_NAME',
	favicon: 'MARIMOHUB_THEME_FAVICON',
	logo: 'MARIMOHUB_THEME_LOGO',
	logo_dark: 'MARIMOHUB_THEME_LOGO_DARK',
	primary_color: 'MARIMOHUB_THEME_PRIMARY_COLOR',
	secondary_color: 'MARIMOHUB_THEME_SECONDARY_COLOR',
} as const;

export type ThemeEnv = Partial<
	Record<(typeof THEME_VARIABLES)[keyof typeof THEME_VARIABLES], string>
>;

export function parseTheme(env: ThemeEnv): ThemeConfig {
	const values = { ...DEFAULT_THEME_CONFIG };
	for (const key of Object.keys(THEME_VARIABLES) as (keyof ThemeConfig)[]) {
		const value = env[THEME_VARIABLES[key]]?.trim();
		if (value) values[key] = value;
	}
	const result = ThemeConfigSchema.safeParse(values);
	if (!result.success) {
		const issue = result.error.issues[0];
		const variable = THEME_VARIABLES[issue.path[0] as keyof ThemeConfig];
		throw new ConfigError(`Invalid ${variable}: ${issue.message}`, {
			variable,
			remediation:
				'Use an HTTPS URL, a root-relative asset path, or an opaque hex color as appropriate.',
			docs: 'docs/theming.md',
		});
	}
	return result.data;
}
