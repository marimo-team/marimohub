import { createContext, useContext, useMemo } from 'react';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/api/theme';

export const BrandingContext = createContext(DEFAULT_THEME_CONFIG);

export function useBranding() {
	const config = useContext(BrandingContext);
	return useMemo(
		() => ({
			...config,
			wordmark: config.name === DEFAULT_THEME_CONFIG.name ? 'MARIMOHUB' : config.name,
			hasCustomColors: Boolean(config.primary_color || config.secondary_color),
		}),
		[config],
	);
}
