import { DEFAULT_THEME_CONFIG, ThemeResponseSchema } from '@marimo-hub/core/theme';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import { withBasePath } from './basePath';
import { generateThemePalette } from './themePalette';

export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'marimohub-theme';

export function getInitialTheme(): Theme {
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		if (stored === 'light' || stored === 'dark') return stored;
	} catch {
		// Storage can be disabled independently of the rest of the browser.
	}
	try {
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	} catch {
		return 'light';
	}
}

export function applyThemeMode(theme: Theme): void {
	document.documentElement.classList.toggle('dark', theme === 'dark');
	document.documentElement.style.colorScheme = theme;
}

export async function loadThemeConfig(): Promise<ThemeConfig> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ThemeConfig>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(DEFAULT_THEME_CONFIG);
		}, 2000);
	});
	const request = async () => {
		try {
			const response = await fetch(withBasePath('/api/v1/theme'), {
				signal: controller.signal,
				cache: 'no-store',
			});
			if (!response.ok) return DEFAULT_THEME_CONFIG;
			const parsed = ThemeResponseSchema.safeParse(await response.json());
			return parsed.success ? parsed.data.data : DEFAULT_THEME_CONFIG;
		} catch {
			return DEFAULT_THEME_CONFIG;
		}
	};
	try {
		return await Promise.race([request(), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export function applyThemeConfig(config: ThemeConfig): void {
	const palette = generateThemePalette(config);
	document.getElementById('deployment-theme')?.remove();
	document.documentElement.toggleAttribute('data-custom-theme', palette !== null);
	if (palette) {
		const style = document.createElement('style');
		style.id = 'deployment-theme';
		style.textContent = (['light', 'dark'] as const)
			.map((mode) => {
				const tokens = palette[mode];
				const selector = mode === 'dark' ? ':root.dark' : ':root';
				return `${selector}{${Object.entries(tokens)
					.map(([key, value]) => `--${key}:${value};`)
					.join('')}}`;
			})
			.join('\n');
		document.head.append(style);
	}
	document.title = config.name;
	if (config.favicon) {
		const icon =
			document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
		icon.rel = 'icon';
		icon.removeAttribute('type');
		icon.href = config.favicon;
		document.head.append(icon);
	}
}
