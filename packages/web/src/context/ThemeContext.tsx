import { applyThemeMode, getInitialTheme, THEME_STORAGE_KEY } from '@/lib/theme';
import type { Theme } from '@/lib/theme';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type { Theme } from '@/lib/theme';

interface ThemeContextValue {
	theme: Theme;
	toggleTheme: () => void;
	setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(getInitialTheme);

	useEffect(() => {
		applyThemeMode(theme);
		try {
			localStorage.setItem(THEME_STORAGE_KEY, theme);
		} catch {
			// The mode still works when browser storage is disabled.
		}
	}, [theme]);

	const setTheme = useCallback((next: Theme) => setThemeState(next), []);
	const toggleTheme = useCallback(
		() => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark')),
		[],
	);
	const value = useMemo(() => ({ theme, toggleTheme, setTheme }), [setTheme, theme, toggleTheme]);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}
	return context;
}
