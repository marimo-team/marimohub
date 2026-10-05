import { applyThemeMode, getInitialTheme, THEME_STORAGE_KEY } from '@/lib/theme';
import type { Theme } from '@/lib/theme';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode, SetStateAction } from 'react';
import { useBranding } from './BrandingContext';

export type { Theme } from '@/lib/theme';

interface ThemeContextValue {
	theme: Theme;
	isThemeForced: boolean;
	toggleTheme: () => void;
	setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
	const { force_mode: forcedTheme } = useBranding();
	const [preferredTheme, setPreferredTheme] = useState<Theme>(getInitialTheme);
	const theme = forcedTheme ?? preferredTheme;
	const isThemeForced = forcedTheme !== null;

	useEffect(() => {
		applyThemeMode(theme);
		if (isThemeForced) return;
		try {
			localStorage.setItem(THEME_STORAGE_KEY, theme);
		} catch {
			// The mode still works when browser storage is disabled.
		}
	}, [isThemeForced, theme]);

	const setTheme = useCallback(
		(next: SetStateAction<Theme>) => {
			if (!isThemeForced) setPreferredTheme(next);
		},
		[isThemeForced],
	);
	const toggleTheme = useCallback(() => {
		setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
	}, [setTheme]);
	const value = useMemo(
		() => ({ theme, isThemeForced, toggleTheme, setTheme }),
		[isThemeForced, setTheme, theme, toggleTheme],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}
	return context;
}
