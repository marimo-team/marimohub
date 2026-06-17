import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query and re-render when it changes. SSR-safe: when
 * `window` is unavailable the hook reports `false` until the first effect runs.
 * Mirrors the `matchMedia` pattern in {@link ThemeContext}.
 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (typeof window === 'undefined') return false;
		return window.matchMedia(query).matches;
	});

	useEffect(() => {
		if (typeof window === 'undefined') return;
		const mql = window.matchMedia(query);
		const onChange = () => setMatches(mql.matches);
		// Sync once in case the query changed between render and effect.
		onChange();
		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	}, [query]);

	return matches;
}

/**
 * True on phone-width viewports. 767px matches the `max-md:` Tailwind utilities
 * and the `@media (max-width: 767px)` block in `index.css`, so JS and CSS agree.
 */
export function useIsMobile(): boolean {
	return useMediaQuery('(max-width: 767px)');
}
